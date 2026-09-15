import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

import { applyPatch } from "./apply-patch";
import { isInsideWorkspace } from "./permissions";
import {
  explainSandboxDenial,
  logSandboxDegraded,
  sandboxActive,
  wrapShellCommand,
} from "./agent-sandbox";
import { contextUsage, describeContextUsage } from "./agent-context";
import { getSetting } from "./db/settings";
import { isOmniDataPath } from "./paths";
import { killProcessTree } from "./runtimes/proc";
import { webSearch } from "./web-search";
import { listKnowledgeBases, recall } from "./knowledge";
import { readSkillFile, skillsPromptSection } from "./agent-skills";
import { capToolResultText, isSpillPath } from "./agent-spill";
import { audit } from "./skills/audit";
import { logEvent } from "./app-log";

/**
 * Agent 可使用的工具集。
 *
 * 权限模型（对齐 PI-Desktop 的思路：特权操作必须显式放行）：
 * - 只读工具（read_file / list_dir / glob / grep / web_search）可访问工作区之外的
 *   绝对路径，因为"读"不产生副作用；
 * - 写操作（write_file / edit_file / apply_patch）与 shell（bash）只能作用于工作区目录内，
 *   且 shell 还受 AGENT_ALLOW_SHELL 开关控制。
 */

export type ToolContext = {
  /** Agent 的工作区根目录（所有相对路径的基准）。 */
  workspace: string;
  /** 是否允许执行 shell 命令。 */
  allowShell: boolean;
  /**
   * 当前模型是否接受图片输入（决定要不要给 view_image 工具，见 chat-model 的探测）。
   * 不确定时不要开：把图片塞进纯文本模型的请求会被服务端直接 400。
   */
  vision?: boolean;
  /**
   * 工作区之外已授权的目录（权限弹窗里「始终允许」写入的 + 设置页手工添加的）。
   * 命中这些目录的读写不再被路径层拦住（授权弹窗已经收过用户确认）。
   */
  authorizedFolders?: string[];
  /** 当前会话 / 消息：待办、提问、产出物登记都要带上归属。 */
  conversationId?: number;
  messageId?: number | null;
  /** 写待办清单（agent.ts 注入，落库 + 推送 UI）。 */
  onTodoWrite?: (todos: { content: string; status?: string; priority?: string }[]) => void;
  /** 向用户提问并等待答复（agent.ts 注入）。 */
  askUser?: (
    questions: { question: string; header?: string; options?: { label: string; description?: string }[]; multiple?: boolean }[],
  ) => Promise<string[][]>;
  /** 派子智能体执行子任务，返回它的最终答复（agent.ts 注入）。 */
  spawnSubagent?: (opts: {
    description: string;
    prompt: string;
    subagentType: string;
  }) => Promise<string>;
  /** 登记产出物（agent.ts 注入）。 */
  recordArtifact?: (filePath: string, tool: string) => void;
  /** bash 命令超时（毫秒），默认 120 秒；测试 / 特殊场景可以调小。 */
  commandTimeoutMs?: number;
  /**
   * 系统提示的 token 估算（agent.ts 注入）：`get_context_remaining` 在
   * 没有实测用量时用它把系统提示算进占用，否则会低估一大截。
   */
  systemPromptTokens?: number;
  /**
   * 沙箱升级（agent.ts 注入）：命令被沙箱拦下后，问用户要不要**跳过沙箱重跑一次**。
   * 返回 null = 允许重试；返回字符串 = 拒绝原因（原样回给模型）。
   * 无人值守（自动化 / `omi agent run`）不注入 —— 没人可问，就如实报告被拦。
   */
  escalateSandbox?: (input: { command: string; output: string }) => Promise<string | null>;
  /** 打一个探索打点（agent.ts 注入，见 checkpoint / rewind）。 */
  onCheckpoint?: (goal: string) => ToolOutcome;
  /** 收网点：用结论替换掉打点之后的中间过程（agent.ts 注入）。 */
  onRewind?: (input: { report: string; revertFiles: boolean }) => Promise<ToolOutcome>;
  /** Goal 模式的目标操作（agent.ts 注入，见 bun/agent-goals.ts）。 */
  onGoal?: (input: { op: string; objective?: string; acceptance?: string; outcome?: string }) => ToolOutcome;
  /** Plan 模式唯一能写的东西：把方案写到数据目录里（agent.ts 注入）。 */
  onWritePlan?: (content: string) => ToolOutcome;
};

/**
 * 工具结果的形状：`textResult` / `errorResult` 的并集。
 * 主进程里自己实现工具回调（checkpoint / rewind）时用它，避免手搓一套字段
 * —— 内核的 `AgentToolResult` 并没有 `isError`，失败是 `details.error` 表达的。
 */
export type ToolOutcome = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };

/**
 * 各个工具的 schema 不同，无法直接放进同一个 `AgentTool<any>[]`
 * （`Static<any>` 解析成 unknown，会把 execute 的入参反向约束掉）。
 * 这里把 execute 的入参放宽成 any，既保留每个工具内部的精确类型，
 * 又能组装成异构数组交给 Pi Agent。
 */
export type BuiltTool = Omit<AgentTool<any>, "execute"> & {
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<any>,
  ) => Promise<AgentToolResult<any>>;
};

/**
 * 报错要给出**下一步动作**，不能只说"找不到"。
 *
 * 弱模型拿到一句 `File not found: /x/y` 之后最常见的两种反应是：原样再试一次，
 * 或者干脆换去猜别的文件。把"怎么找"直接写在错误里，比让它自己悟便宜得多。
 */
const NOT_FOUND_HINT =
  "。先别重试同一个路径：用 list_dir 看父目录里到底有什么、或用 glob 按文件名片段找（例如 `**/*名字*`），" +
  "确认真实路径后再读。";

/** 编辑类工具的"定位失败"提示：旧内容匹配不上，通常是文件已经变了。 */
const EDIT_MISMATCH_HINT =
  "。文件内容与你手上的不一致（可能在上次读之后被改过，或你自己记错了）。" +
  "先 read_file 把当前内容读回来，用读到的原文重新组织这次替换；不要反复猜同一段文本。";

/**
 * 空结果也要给出下一步。
 *
 * "没找到"不等于"不存在"：可能是关键词太窄、大小写不对、或搜错了目录。
 * 直接告诉模型怎么换姿势，比让它把同样的搜索再发一遍便宜（本地模型尤其爱这么干）。
 */
const NO_MATCH_HINT =
  "(no matches)。没搜到不代表不存在，换个姿势再试一次：" +
  "① 关键词放宽或只用其中一段（正则里少用 `.*`）；② 检查大小写与中英文标点；" +
  "③ 确认 path 是你要找的那棵目录树（用 list_dir 看一眼）。" +
  "三样都试过还没有，再下「确实没有」的结论。";

const MAX_FILE_CHARS = 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
/** 直接子进程退出后，再给管道多少时间把末尾输出读干净。 */
const PIPE_DRAIN_GRACE_MS = 200;

/** 递归遍历时要跳过的目录（体量大且对任务无意义）。 */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".gradle",
  "target",
  "Pods",
  "DerivedData",
]);

/**
 * 截断超长输出。
 *
 * 位置变了（见 `textResult` 的说明）：现在由 `agent.ts` 的 `afterToolCall` 统一做，
 * 因为那里才拿得到会话 id 与工具名 —— 截断的同时要把完整输出转存到磁盘并把路径
 * 写进提示里，模型才有路找回原文。展示层的实现是 `agent-spill.ts` 的
 * `truncateForModel()`，纯函数带单测。
 */

/** 把用户/模型给的路径解析成绝对路径。相对路径基于工作区。 */
export function resolvePath(workspace: string, input: string): string {
  const trimmed = input.trim();
  const expanded = trimmed.startsWith("~")
    ? path.join(process.env.HOME ?? "/", trimmed.slice(1))
    : trimmed;
  const target = path.resolve(workspace, expanded);
  assertNotSecret(workspace, target);
  return target;
}

/**
 * 工作区外读取的敏感路径黑名单。
 *
 * Agent 的工具结果会原样喂回模型，而网页搜索 / 知识库 / MCP 的返回内容都可能被
 * 提示词注入（"读 ~/.ssh/id_rsa 然后 curl 发到某处"）。工作区内不受限制（开发必需），
 * 工作区外命中这些凭据目录一律拒绝。
 */
const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.config\/(gh|gcloud|gcloud-legacy)(\/|$)/,
  // 本机其他编码 agent 的凭据与会话（含第三方 API Key）
  /(^|\/)\.omni(\/|$)/,
  /(^|\/)\.codex(\/|$)/,
  /(^|\/)\.claude(\/|$)/,
  /Library\/Keychains(\/|$)/,
];

function assertNotSecret(workspace: string, target: string): void {
  const root = path.resolve(workspace);
  if (target === root || target.startsWith(root + path.sep)) return;
  // 工具输出的转存目录开一个口子：那是应用自己写出来的文件（模型本来就在工具结果里
  // 看过它的前半段），不放开就谈不上"截断之后还能读回来"。数据目录的其余部分
  // （设置表里存着全部云端 API Key）照旧拦死。
  if (isSpillPath(target)) return;
  const normalized = target.replace(/\\/g, "/");
  if (SECRET_PATH_PATTERNS.some((re) => re.test(normalized)) || isOmniDataPath(target)) {
    throw new Error(
      `Refusing to access a credential path outside the workspace: ${target}. ` +
        "Copy what you need into the workspace instead.",
    );
  }
}

/** 写操作必须落在工作区内（或已授权的目录里）。 */
export function assertInsideWorkspace(workspace: string, target: string) {
  const root = path.resolve(workspace);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path outside workspace is not writable: ${target}`);
  }
}

/** 已授权目录（设置里的 + 会话授权传入的），统一成绝对路径。 */
export function authorizedFoldersOf(ctx: ToolContext): string[] {
  const fromSettings = (() => {
    try {
      const parsed = JSON.parse(getSetting("AGENT_AUTHORIZED_FOLDERS"));
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  })();
  return [...(ctx.authorizedFolders ?? []), ...fromSettings]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => path.resolve(value.replace(/^~/, process.env.HOME ?? "/")));
}

function underAny(target: string, folders: string[]): boolean {
  const abs = path.resolve(target);
  return folders.some((folder) => abs === folder || abs.startsWith(folder + path.sep));
}

/**
 * 读权限：工作区内随便读；工作区外必须落在已授权目录里。
 * 凭据路径（SECRET_PATH_PATTERNS）始终拒绝，授权也不放行。
 *
 * 唯一的例外是工具输出的转存目录（`agent-spill.ts`）：那是应用自己从工具结果里
 * 写出来的文件，用户已经授权过产生它的那次工具调用，内容模型本来也看过前半段。
 * 不放行的话，"截断之后用 read_file 读回原文"会变成每读一次弹一次授权窗 ——
 * 提示词里那句建议就成了空话。范围只有这一个子目录。
 */
export function assertReadable(ctx: ToolContext, target: string): void {
  const root = path.resolve(ctx.workspace);
  const abs = path.resolve(target);
  if (abs === root || abs.startsWith(root + path.sep)) return;
  if (isSpillPath(abs)) return;
  if (underAny(abs, authorizedFoldersOf(ctx))) return;
  throw new Error(
    `需要授权才能访问工作区之外的路径：${abs}。` +
      "请在授权弹窗里允许，或把需要的文件复制进工作区。",
  );
}

/** 写权限：工作区内或已授权目录。 */
export function assertWritable(ctx: ToolContext, target: string): void {
  const root = path.resolve(ctx.workspace);
  const abs = path.resolve(target);
  if (abs === root || abs.startsWith(root + path.sep)) return;
  if (underAny(abs, authorizedFoldersOf(ctx))) return;
  throw new Error(`Path outside workspace is not writable without permission: ${abs}`);
}

/**
 * 工具结果的**展示层截断**搬到了 `agent.ts` 的 `afterToolCall`（那里同时做超限转存）。
 *
 * 这里只留一道内存防呆：`bash` 的输出在读完之前不知道有多大，一条 `yes` 能吐出
 * 几百 MB —— 超过硬上限直接丢尾部并说明原因，免得把事件流和数据库一起拖垮。
 * 也就是说：工具结果在内存里可以是长的，**进入模型上下文之前**才被裁到 24k 字符
 * （并落盘一份完整版，见 `agent-spill.ts`）。
 */
export function textResult(text: string) {
  return { content: [{ type: "text" as const, text: capToolResultText(text) }], details: {} };
}

export function errorResult(message: string) {
  // Agent 的工具失败 = 用户看到的「它说做不了」：统一日志里留一份，
  // 事后能回答"当时是哪个工具、报的什么"，而不是只能靠界面上的只言片语。
  logEvent({
    level: "warn",
    source: "agent",
    event: "agent.tool.failed",
    message: message.slice(0, 500),
  });
  return { content: [{ type: "text" as const, text: message }], details: { error: message } };
}

/** 递归收集目录下的文件路径（受 IGNORED_DIRS 与深度限制）。 */
function walkDir(root: string, maxDepth = 8): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(name) || name.startsWith(".")) continue;
        visit(full, depth + 1);
      } else if (stat.isFile()) {
        out.push(full);
      }
    }
  };
  visit(root, 0);
  return out;
}

/** 简易 glob：`**` 匹配任意层级，`*` 匹配非分隔符字符，`?` 匹配单个字符。 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

function createReadFile(ctx: ToolContext): BuiltTool {
  return {
    name: "read_file",
    label: "Read file",
    description:
      "Read a text file from disk. Use an absolute path or a path relative to the workspace. " +
      "Returns the content with line numbers, truncated for very large files.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path, or path relative to the workspace." }),
      offset: Type.Optional(Type.Number({ description: "1-based line number to start from." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
    }),
    execute: async (_toolCallId, params: { path: string; offset?: number; limit?: number }) => {
      try {
        const target = resolvePath(ctx.workspace, params.path);
        assertReadable(ctx, target);
        if (!existsSync(target)) return errorResult(`File not found: ${target}${NOT_FOUND_HINT}`);
        const raw = readFileSync(target, "utf8");
        const lines = raw.split("\n");
        const start = Math.max(0, (params.offset ?? 1) - 1);
        const end = params.limit ? start + params.limit : lines.length;
        const slice = lines.slice(start, end);
        const numbered = slice
          .map((line, i) => `${String(start + i + 1).padStart(5, " ")} | ${line}`)
          .join("\n");
        return textResult(numbered.slice(0, MAX_FILE_CHARS));
      } catch (e) {
        return errorResult(`read_file failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function createListDir(ctx: ToolContext): BuiltTool {
  return {
    name: "list_dir",
    label: "List directory",
    description:
      "List files and directories. Directories are suffixed with '/'. Useful to explore an unfamiliar project.",
    parameters: Type.Object({
      path: Type.String({ description: "Directory to list (default: workspace root)." }),
    }),
    execute: async (_toolCallId, params: { path?: string }) => {
      try {
        const target = resolvePath(ctx.workspace, params.path?.trim() ? params.path : ".");
        assertReadable(ctx, target);
        if (!existsSync(target)) return errorResult(`Not found: ${target}`);
        const entries = readdirSync(target, { withFileTypes: true })
          .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return textResult(entries.join("\n") || "(empty directory)");
      } catch (e) {
        return errorResult(`list_dir failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function createGlob(ctx: ToolContext): BuiltTool {
  return {
    name: "glob",
    label: "Find files",
    description:
      "Find files whose path matches a glob pattern, e.g. `**/*.ts` or `src/**/*.test.ts`. " +
      "Searched from the workspace root or the given directory.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, e.g. `**/*.ts`." }),
      path: Type.Optional(Type.String({ description: "Directory to search from." })),
    }),
    execute: async (_toolCallId, params: { pattern: string; path?: string }) => {
      try {
        const root = resolvePath(ctx.workspace, params.path?.trim() ? params.path : ".");
        assertReadable(ctx, root);
        if (!existsSync(root)) return errorResult(`Not found: ${root}`);
        const re = globToRegExp(params.pattern.replace(/^\.\//, ""));
        const matches = walkDir(root)
          .map((full) => path.relative(root, full))
          .filter((rel) => re.test(rel))
          .sort()
          .slice(0, 500);
        return textResult(matches.join("\n") || "(no matches)");
      } catch (e) {
        return errorResult(`glob failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function createGrep(ctx: ToolContext): BuiltTool {
  return {
    name: "grep",
    label: "Search content",
    description:
      "Search file contents with a regular expression and return matching lines with file:line. " +
      "Faster than reading every file when you need to locate a symbol.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression to search for." }),
      path: Type.Optional(Type.String({ description: "Directory or file to search in." })),
      include: Type.Optional(
        Type.String({ description: "Optional glob filter, e.g. `*.ts`." }),
      ),
    }),
    execute: async (
      _toolCallId,
      params: { pattern: string; path?: string; include?: string },
    ) => {
      try {
        const target = resolvePath(ctx.workspace, params.path?.trim() ? params.path : ".");
        assertReadable(ctx, target);
        if (!existsSync(target)) return errorResult(`Not found: ${target}`);
        let re: RegExp;
        try {
          re = new RegExp(params.pattern);
        } catch {
          return errorResult(`Invalid regular expression: ${params.pattern}`);
        }
        const includeRe = params.include ? globToRegExp(`**/${params.include}`) : null;
        const files = statSync(target).isDirectory() ? walkDir(target) : [target];
        const hits: string[] = [];
        for (const file of files) {
          if (hits.length >= 200) break;
          if (includeRe) {
            const rel = path.relative(target, file);
            if (!includeRe.test(rel) && !globToRegExp(params.include!).test(path.basename(file))) {
              continue;
            }
          }
          let content: string;
          try {
            content = readFileSync(file, "utf8");
          } catch {
            continue; // binary or unreadable
          }
          content.split("\n").forEach((line, i) => {
            if (hits.length >= 200) return;
            if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trimEnd()}`);
          });
        }
        return textResult(hits.join("\n") || NO_MATCH_HINT);
      } catch (e) {
        return errorResult(`grep failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function createWriteFile(ctx: ToolContext): BuiltTool {
  return {
    name: "write_file",
    label: "Write file",
    description:
      "Create or overwrite a file inside the workspace with the given content. " +
      "Parent directories are created automatically. Prefer `edit_file` for surgical changes.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the workspace, or absolute inside it." }),
      content: Type.String({ description: "Full file content to write." }),
    }),
    execute: async (_toolCallId, params: { path: string; content: string }) => {
      try {
        const target = resolvePath(ctx.workspace, params.path);
        assertWritable(ctx, target);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, params.content, "utf8");
        ctx.recordArtifact?.(target, "write_file");
        return textResult(`Wrote ${params.content.length} chars to ${target}`);
      } catch (e) {
        return errorResult(`write_file failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function createEditFile(ctx: ToolContext): BuiltTool {
  return {
    name: "edit_file",
    label: "Edit file",
    description:
      "Replace an exact string inside a file inside the workspace. `old_str` must appear " +
      "exactly once unless `replace_all` is true. Read the file first to get the exact text.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the workspace, or absolute inside it." }),
      old_str: Type.String({ description: "Exact text to replace (including whitespace)." }),
      new_str: Type.String({ description: "Replacement text." }),
      replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence." })),
    }),
    execute: async (
      _toolCallId,
      params: { path: string; old_str: string; new_str: string; replace_all?: boolean },
    ) => {
      try {
        const target = resolvePath(ctx.workspace, params.path);
        assertWritable(ctx, target);
        if (!existsSync(target)) return errorResult(`File not found: ${target}${NOT_FOUND_HINT}`);
        const original = readFileSync(target, "utf8");
        const occurrences = original.split(params.old_str).length - 1;
        if (occurrences === 0) return errorResult(`old_str not found in ${target}${EDIT_MISMATCH_HINT}`);
        if (occurrences > 1 && !params.replace_all) {
          return errorResult(
            `old_str occurs ${occurrences} times in ${target}. Pass replace_all=true or make old_str unique.` +
              "（更稳的做法：把 old_str 扩到上下几行，让它只匹配一处。）",
          );
        }
        const next = params.replace_all
          ? original.split(params.old_str).join(params.new_str)
          : original.replace(params.old_str, params.new_str);
        writeFileSync(target, next, "utf8");
        ctx.recordArtifact?.(target, "edit_file");
        return textResult(
          `Edited ${target} (${occurrences} replacement${occurrences > 1 ? "s" : ""})`,
        );
      } catch (e) {
        return errorResult(`edit_file failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/**
 * apply_patch（对齐 Codex）：一次调用完成多文件的新增 / 修改 / 删除 / 重命名，
 * 解析与应用规则见 apply-patch.ts。相比连续调用 edit_file，它的价值在于
 * 「一处匹配不上就整体不动」—— 模型不会留下改了一半的仓库。
 */
function createApplyPatch(ctx: ToolContext): BuiltTool {
  return {
    name: "apply_patch",
    label: "Apply patch",
    description:
      "Apply a multi-file patch. Wrap hunks between '*** Begin Patch' and '*** End Patch'. " +
      "Use '*** Add File: <path>' (every content line prefixed with '+'), " +
      "'*** Update File: <path>' (optional '*** Move to: <new path>', then '@@' sections with " +
      "context lines prefixed by a space, removals by '-', additions by '+'), and " +
      "'*** Delete File: <path>'. Prefer this over several edit_file calls: it is atomic — " +
      "if any section fails to match, nothing is written and you get a precise error.",
    parameters: Type.Object({
      patch: Type.String({
        description: "The full patch text, starting with '*** Begin Patch' and ending with '*** End Patch'.",
      }),
    }),
    execute: async (_toolCallId, params: { patch: string }) => {
      const resolve = (rawPath: string) => {
        const target = resolvePath(ctx.workspace, rawPath);
        assertWritable(ctx, target);
        return target;
      };
      const result = applyPatch(params.patch, {
        resolve,
        fs: {
          read: (target) => {
            if (!existsSync(target)) return null;
            if (statSync(target).isDirectory()) {
              throw new Error(`Refusing to patch a directory: ${target}`);
            }
            return readFileSync(target, "utf8");
          },
          write: (target, contents) => {
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, contents, "utf8");
          },
          remove: (target) => {
            if (existsSync(target)) unlinkSync(target);
          },
        },
      });
      if (!result.ok) return errorResult(result.error);
      for (const change of result.changes) ctx.recordArtifact?.(change.path, "apply_patch");
      return textResult(result.summary);
    },
  };
}

/**
 * request_permissions（对齐 Codex 的同名工具）：模型带着**理由**申请访问工作区之外的路径。
 *
 * 关键点：这个工具**必须经过授权闸门**（`permissions.ts` 把它翻译成
 * external_directory 请求）—— 它能跑起来本身就意味着用户刚点了允许（或策略本就放行）。
 * 所以工具体内不再自己发起一次询问：那样会先问一次工具、再问一次目录，用户要点两次；
 * 而如果把它放进免授权名单，模型就能拿到一句假的"已授权"。
 *
 * 相比"先撞一次墙再看报错"，它的价值是让用户在卡片上看到**意图**（要哪个目录、拿去做什么），
 * 而不是一条冷冰冰的路径拒绝；被拒时模型也会拿到明确的拒绝理由。
 */
function createRequestPermissions(ctx: ToolContext): BuiltTool {
  return {
    name: "request_permissions",
    label: "Request access",
    description:
      "Ask the user to grant access to a path outside the workspace (for example a sibling " +
      "repository or a data folder). Always explain why you need it. The user approves or denies " +
      "on a card in the conversation; once approved you may read/write that path in this session.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path (or path outside the workspace) you need access to." }),
      reason: Type.String({ description: "One sentence: what you will do with it." }),
    }),
    execute: async (_toolCallId, params: { path: string; reason: string }) => {
      const target = params.path?.trim();
      if (!target) return errorResult("request_permissions needs a path.");
      // 工作区内的路径本来就能访问，走到这里说明模型多问了一次。
      if (isInsideWorkspace(ctx.workspace, path.resolve(ctx.workspace, target))) {
        return textResult(`${target} is already inside the workspace — no approval needed.`);
      }
      return textResult(
        `Access granted for ${target}. Proceed with the operation; if a workspace rule was added, ` +
          "further reads/writes under it will not ask again.",
      );
    },
  };
}

/**
 * get_context_remaining（对齐 Codex 的同名工具）：让模型自己能看到还剩多少窗口。
 * 本地模型窗口小，长任务里"该继续读文件还是先收尾"应当由它自己判断 ——
 * 而不是等压缩真的发生（那时中间历史已经被裁掉了）。
 */
function createContextRemaining(ctx: ToolContext): BuiltTool {
  return {
    name: "get_context_remaining",
    label: "Context left",
    description:
      "Report how much of the context window is still free for this session. " +
      "Call it before starting a large read (many files, a big directory) when the task has " +
      "already been running for a while, or when you are unsure whether you can afford one more step.",
    parameters: Type.Object({}),
    execute: async () => {
      if (ctx.conversationId === undefined) {
        return errorResult("Context usage is only available inside a conversation.");
      }
      const usage = contextUsage(ctx.conversationId, {
        systemPromptTokens: ctx.systemPromptTokens,
      });
      return textResult(describeContextUsage(usage));
    },
  };
}

/** view_image 支持的图片类型（按扩展名判；本地模型走的是服务端的 mtmd / vision 前端）。 */export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/** 单张图片上限：base64 会再膨胀 1/3，再大就该先压缩（或用 bash 里的 sips / magick）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * view_image（对齐 Codex 的同名工具）：把本地图片作为图片内容块交回模型，
 * 让视觉模型能"看"截图 / 设计稿 / 生成结果。仅在当前模型看起来支持图片输入时
 * 才会注册这个工具（纯文本模型收到图片块会被服务端拒绝）。
 */
function createViewImage(ctx: ToolContext): BuiltTool {
  return {
    name: "view_image",
    label: "View image",
    description:
      "Read an image file from disk and attach it to the conversation so you can see it " +
      "(screenshots, diagrams, generated images). Use this whenever the task depends on " +
      "what an image actually shows.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the workspace, or absolute." }),
    }),
    execute: async (_toolCallId, params: { path: string }) => {
      try {
        const target = resolvePath(ctx.workspace, params.path);
        assertReadable(ctx, target);
        if (!existsSync(target)) return errorResult(`Image not found: ${target}`);
        const mediaType = IMAGE_MEDIA_TYPES[path.extname(target).toLowerCase()];
        if (!mediaType) {
          return errorResult(
            `Unsupported image type: ${path.extname(target) || "(no extension)"}. ` +
              `Supported: ${Object.keys(IMAGE_MEDIA_TYPES).join(", ")}`,
          );
        }
        const size = statSync(target).size;
        if (size > MAX_IMAGE_BYTES) {
          return errorResult(
            `Image is too large (${Math.round(size / 1024 / 1024)}MB, limit ` +
              `${MAX_IMAGE_BYTES / 1024 / 1024}MB). Downscale it first (e.g. ` +
              `\`sips -Z 1568 "${target}" --out /tmp/small.png\`) and view the smaller copy.`,
          );
        }
        const data = readFileSync(target).toString("base64");
        return {
          content: [
            { type: "text" as const, text: `Attached image: ${target} (${mediaType}, ${size} bytes)` },
            { type: "image" as const, data, mimeType: mediaType },
          ],
          details: {},
        };
      } catch (e) {
        return errorResult(`view_image failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function createBash(ctx: ToolContext): BuiltTool {
  return {
    name: "bash",
    label: "Run command",
    description:
      "Run a shell command inside the workspace and return stdout+stderr. " +
      "Use for builds, tests, git, and package managers. Long-running or interactive commands are not suitable.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
    }),
    execute: async (_toolCallId, params: { command: string }, signal?: AbortSignal) => {
      if (!ctx.allowShell) {
        return errorResult(
          "Shell access is disabled. Enable it in the Agent workspace settings to allow commands.",
        );
      }
      const shell = process.env.SHELL || "/bin/zsh";
      // 执行过的每条命令都入库留痕：模型可能被注入内容诱导执行破坏性命令，
      // 出事后要能查到"谁在什么时候跑了什么"。
      audit("agent_shell", `${ctx.workspace}: ${params.command}`);
      const timeoutMs = ctx.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
      // 命令沙箱（对齐 Codex 的 workspace-write）：开启后把命令跑在平台沙箱里，
      // 「写到工作区外」与「读凭据目录」由内核拦下，而不是靠命令黑名单。
      const wrapped = wrapShellCommand(params.command, {
        workspace: ctx.workspace,
        shell,
        authorizedFolders: authorizedFoldersOf(ctx),
      });
      if (wrapped.degradedReason) logSandboxDegraded(wrapped.degradedReason);
      try {
        /**
         * - `detached`：独立进程组，超时 / 停止时能整组杀掉。只杀 shell 的话，
         *   命令自己拉起的后台进程会活下来，而它继承了 stdout —— 读输出的那一端
         *   就永远等不到管道关闭（下面 readOutputBounded 说明了这个坑）。
         * - `stdin: "ignore"`：别让 `pip install`、`git commit` 这类等输入的命令
         *   把整轮 Agent 挂在这里。
         */
        const proc = Bun.spawn(wrapped.cmd, {
          cwd: ctx.workspace,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          detached: true,
          env: { ...process.env, PATH: augmentPath() },
        });
        let killed: "timeout" | "abort" | null = null;
        const killGroup = (reason: "timeout" | "abort") => {
          if (killed) return;
          killed = reason;
          killProcessTree(proc, "SIGKILL");
        };
        const timer = setTimeout(() => killGroup("timeout"), timeoutMs);
        const onAbort = () => killGroup("abort");
        signal?.addEventListener("abort", onAbort, { once: true });
        // 已经中断过时 addEventListener 不会再触发，补一次。
        if (signal?.aborted) onAbort();
        try {
          const [stdout, stderr] = await Promise.all([
            readOutputBounded(proc.stdout, proc.exited),
            readOutputBounded(proc.stderr, proc.exited),
          ]);
          const exitCode = await proc.exited;
          const combined = [stdout, stderr].filter((s) => s.trim().length > 0).join("\n");
          const note =
            killed === "timeout"
              ? `\n[命令超过 ${Math.round(timeoutMs / 1000)} 秒，已连同子进程一起终止]`
              : killed === "abort"
                ? "\n[命令已随本次运行停止一并终止]"
                : "";
          // 沙箱拦截时只回一句 "operation not permitted" 谁都看不懂，补一句人话。
          // 带上实际后端：Landlock 拒写只回裸的 "Permission denied"，只有确认走的是
          // Landlock 才敢把它算成沙箱拦截（否则普通文件权限问题会被误报）。
          const sandboxNote =
            exitCode !== 0 && sandboxActive()
              ? explainSandboxDenial(combined, { backend: wrapped.backend })
              : null;
          if (sandboxNote) {
            /**
             * 沙箱升级（对齐 Codex 的 sandbox_approval）：命令**因为沙箱**失败时，
             * 问用户要不要跳过沙箱重跑一次 —— 而不是让模型自己撞墙或干脆绕路。
             * 只试一次；被拒绝时把拒绝原因一并回给模型，它知道"别再绕了"。
             */
            const escalation = ctx.escalateSandbox
              ? await ctx.escalateSandbox({ command: params.command, output: combined })
              : null;
            if (escalation === null && ctx.escalateSandbox) {
              audit("agent_shell", `${ctx.workspace}: [跳过沙箱重试] ${params.command}`);
              const retried = Bun.spawn([shell, "-c", params.command], {
                cwd: ctx.workspace,
                stdout: "pipe",
                stderr: "pipe",
                stdin: "ignore",
                detached: true,
                env: process.env,
              });
              const [retryOut, retryErr] = await Promise.all([
                readOutputBounded(retried.stdout, retried.exited),
                readOutputBounded(retried.stderr, retried.exited),
              ]);
              const retryCode = await retried.exited;
              const retryCombined = [retryOut, retryErr].filter((part) => part.trim().length > 0).join("\n");
              return textResult(
                `$ ${params.command}\n[沙箱拦下（${sandboxNote}），已按你的授权跳过沙箱重试]\n` +
                  `${retryCombined || "(no output)"}\n[exit ${retryCode}]${note}`,
              );
            }
            return textResult(
              `$ ${params.command}\n${combined || "(no output)"}\n[exit ${exitCode}]${note}\n${sandboxNote}` +
                (escalation ? `\n跳过沙箱重试被拒绝：${escalation}` : ""),
            );
          }
          return textResult(
            `$ ${params.command}\n${combined || "(no output)"}\n[exit ${exitCode}]${note}`,
          );
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      } catch (e) {
        return errorResult(`bash failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/**
 * 读子进程的输出，但**不以管道 EOF 为结束条件**。
 *
 * 命令里的 `xxx &`、后台服务会把 stdout 管道一并继承过去；直接
 * `await new Response(proc.stdout).text()` 就会一直等不到 EOF —— 工具、乃至整轮
 * Agent 都永久卡在这一行（超时定时器早就跑完了，救不回来），表现就是"一直在执行中"。
 * 所以这里改成：直接子进程一退出，再宽限 PIPE_DRAIN_GRACE_MS 把已有输出读完就收工。
 */
async function readOutputBounded(
  stream: ReadableStream<Uint8Array> | number | undefined,
  exited: Promise<number>,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) text += decoder.decode(value, { stream: true });
      }
    } catch {
      // 管道被取消 / 关闭：保留已经读到的部分
    }
  })();
  await Promise.race([pump, exited.then(() => Bun.sleep(PIPE_DRAIN_GRACE_MS))]);
  await reader.cancel().catch(() => {
    // 已经结束的流
  });
  return text;
}

/**
 * GUI 启动的进程 PATH 往往缺少 Homebrew / nvm 等目录，导致 node、git、brew 找不到。
 * 补上常见路径，保证工具调用不会莫名其妙地 "command not found"。
 */
function augmentPath(): string {
  const extra = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    `${process.env.HOME ?? ""}/.nvm/versions/node/*/bin`,
    `${process.env.HOME ?? ""}/.bun/bin`,
    `${process.env.HOME ?? ""}/.cargo/bin`,
  ];
  return [...extra, process.env.PATH ?? ""].join(":");
}

function createWebSearch(): BuiltTool {
  return {
    name: "web_search",
    label: "Web search",
    description:
      "Search the web for up-to-date information (docs, releases, error messages) and return titles, URLs and snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query — prefer keywords over full sentences." }),
    }),
    execute: async (_toolCallId, params: { query: string }) => {
      try {
        if (getSetting("WEB_SEARCH_ENABLED") !== "1") {
          return errorResult("Web search is disabled in settings.");
        }
        const result = await webSearch(params.query);
        if (!result.ok || result.results.length === 0) {
          return errorResult(`Web search failed: ${result.error ?? "no results"}`);
        }
        const formatted = result.results
          .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
          .join("\n\n");
        return textResult(`Provider: ${result.provider}\n\n${formatted}`);
      } catch (e) {
        return errorResult(`web_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/**
 * 本地知识库检索：Agent / Plan / Goal 三模式都可用（只读）。
 * 不指定 kb 时检索全部知识库；命中返回来源文档名 + 分块内容。
 */
function createKnowledgeSearch(): BuiltTool {
  return {
    name: "knowledge_search",
    label: "Knowledge search",
    description:
      "Search the user's local knowledge bases (documents / notes / web pages imported in OmniStudio). " +
      "Use it when the task may relate to materials the user stored locally, before searching the web.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query — natural language is fine." }),
      kb: Type.Optional(
        Type.String({ description: "Knowledge base name to restrict the search to. Omit for all." }),
      ),
      top_k: Type.Optional(Type.Number({ description: "Max chunks to return (default 6)." })),
    }),
    execute: async (_toolCallId, params: { query: string; kb?: string; top_k?: number }) => {
      try {
        const kbs = listKnowledgeBases();
        if (kbs.length === 0) {
          return textResult("用户还没有创建任何知识库。");
        }
        let targets = kbs;
        if (params.kb?.trim()) {
          const lowered = params.kb.trim().toLowerCase();
          targets = kbs.filter((k) => k.name.toLowerCase() === lowered);
          if (targets.length === 0) {
            return textResult(
              `没有名为「${params.kb}」的知识库。可用：${kbs.map((k) => k.name).join("、")}`,
            );
          }
        }
        const { hits } = await recall(
          targets.map((k) => k.id),
          params.query,
          params.top_k,
          { actor: "agent" },
        );
        if (hits.length === 0) {
          return textResult("没有检索到相关内容。");
        }
        const formatted = hits
          .map(
            (h, i) =>
              `[${i + 1}] 《${h.docName}》分块 ${h.seq}（${h.kbName}，相关度 ${h.score.toFixed(2)}）\n` +
              (h.modality
                ? // 与 kb-mcp.ts 的 mediaHitTag 同款：防空正文媒体命中呈现为空行
                  `[${h.modality === "image" ? "图片" : h.modality === "audio" ? "音频" : "视频"}] ${h.docName}` +
                  (h.content ? `\n${h.content}` : "")
                : h.content),
          )
          .join("\n\n");
        return textResult(`找到 ${hits.length} 条相关片段：\n\n${formatted}`);
      } catch (e) {
        return errorResult(`knowledge_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/**
 * 待办清单：Agent 把多步任务拆成清单并持续更新状态，UI 在输入框上方显示进度。
 * 这是让"长任务看起来在推进"的关键（对齐 OpenWork 的 todowrite）。
 */
function createTodoWrite(ctx: ToolContext): BuiltTool {
  return {
    name: "todo_write",
    label: "Update todo list",
    description:
      "Create or update the task list for the current work. Pass the FULL list every time " +
      "(it replaces the previous one). Keep at most one item in_progress. " +
      "Use it for multi-step work so the user can see progress.",
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: "What this step does (short, imperative)." }),
          status: Type.Optional(
            Type.String({ description: "pending | in_progress | completed | cancelled" }),
          ),
          priority: Type.Optional(Type.String({ description: "high | medium | low" })),
        }),
      ),
    }),
    execute: async (_toolCallId, params: { todos: { content: string; status?: string; priority?: string }[] }) => {
      if (!ctx.onTodoWrite) return errorResult("Todo list is not available in this mode.");
      ctx.onTodoWrite(params.todos ?? []);
      const done = (params.todos ?? []).filter((t) => t.status === "completed").length;
      return textResult(`Todo list updated (${done}/${params.todos?.length ?? 0} done).`);
    },
  };
}

/** 反问用户：需要澄清意图 / 让用户做选择时用，答案会作为工具结果回到上下文。 */
function createAskUser(ctx: ToolContext): BuiltTool {
  return {
    name: "ask_user",
    label: "Ask the user",
    description:
      "Ask the user one or more questions and wait for the answer. Use it when the task is " +
      "ambiguous or a decision must be made by the user (choices, preferences, credentials). " +
      "Prefer concrete options; the user can always type a custom answer.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          header: Type.Optional(Type.String({ description: "Short label for the question." })),
          question: Type.String({ description: "The question to ask." }),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                label: Type.String(),
                description: Type.Optional(Type.String()),
              }),
            ),
          ),
          multiple: Type.Optional(Type.Boolean({ description: "Allow selecting several options." })),
        }),
      ),
    }),
    execute: async (
      _toolCallId,
      params: {
        questions: {
          header?: string;
          question: string;
          options?: { label: string; description?: string }[];
          multiple?: boolean;
        }[];
      },
    ) => {
      if (!ctx.askUser) return errorResult("Asking the user is not available in this mode.");
      const questions = (params.questions ?? []).filter((q) => q?.question?.trim());
      if (questions.length === 0) return errorResult("No question provided.");
      const answers = await ctx.askUser(questions);
      if (answers.length === 0) {
        return textResult("The user did not answer (dismissed or timed out). Continue sensibly and say what you assumed.");
      }
      const formatted = questions
        .map((q, i) => `Q: ${q.question}\nA: ${(answers[i] ?? []).join("、") || "(no answer)"}`)
        .join("\n\n");
      return textResult(formatted);
    },
  };
}

/** 子智能体：把一块独立调研 / 执行交给子任务，主上下文只收它的结论。 */
/**
 * `goal`：Goal 模式的目标管理。
 *
 * 为什么需要一个工具而不是全靠提示词：目标要**跨回合**存在。Goal 模式会自动续跑，
 * 每次续跑都是一次新的请求 —— 目标、验收标准、跑到哪了，必须落在库里，
 * 不然模型第二轮就只剩"继续"两个字可以依据。
 */
function createGoalTool(ctx: ToolContext): BuiltTool {
  return {
    name: "goal",
    label: "Goal",
    description:
      "Manage the current goal (Goal mode). " +
      "`create` sets the objective and acceptance criteria — call it FIRST, before doing any work, " +
      "and use ask_user if the criteria are not clear yet. " +
      "`get` reports objective, status and budget usage. " +
      "`complete` finishes the goal — pass the evidence in outcome (files, commands, output). " +
      "`abandon` gives up with a reason — use it when genuinely blocked instead of claiming success.",
    parameters: Type.Object({
      op: Type.String({ description: "create | get | complete | abandon" }),
      objective: Type.Optional(Type.String({ description: "create: what must be achieved, in one sentence." })),
      acceptance: Type.Optional(
        Type.String({
          description: "create: how we will know it is done (concrete, checkable). Agree it with the user first.",
        }),
      ),
      outcome: Type.Optional(
        Type.String({ description: "complete: the evidence. abandon: why it cannot be done." }),
      ),
    }),
    execute: async (_toolCallId, params: { op: string; objective?: string; acceptance?: string; outcome?: string }) => {
      if (!ctx.onGoal) return errorResult("Goal 工具只在 Goal 模式下可用。");
      return ctx.onGoal(params);
    },
  };
}

/**
 * `write_plan`：Plan 模式**唯一**能写的东西。
 *
 * 把方案写进数据目录（不是工作区），并登记成产出物 —— 右侧面板能预览，切回 Agent 模式后
 * 模型手里也还留着那份方案（否则只能去历史正文里捞）。这是"Plan 模式一行都不许改工作区"
 * 与"方案要能留下来、能被批准"之间的那个折中。
 */
export function createWritePlan(ctx: ToolContext): BuiltTool {
  return {
    name: "write_plan",
    label: "Write plan",
    description:
      "Write the implementation plan to a plan file (outside the workspace) and show it to the user. " +
      "This is the ONLY way to save something in Plan mode — the workspace stays untouched. " +
      "Write the full plan in one call, replacing any previous version. " +
      "After writing it, summarise the plan briefly in your reply and stop; the user approves or asks for changes.",
    parameters: Type.Object({
      content: Type.String({
        description:
          "The plan in Markdown. It must be executable by someone who was not in this conversation: " +
          "goal, files to touch (with paths), step-by-step changes, risks, and how to verify. " +
          "Every path you name must have been read in this session — mark anything unverified as such.",
      }),
    }),
    execute: async (_toolCallId, params: { content: string }) => {
      if (!ctx.onWritePlan) return errorResult("写方案需要会话上下文（这个模式下拿不到）。");
      if (!params.content?.trim()) return errorResult("方案内容不能为空。");
      return ctx.onWritePlan(params.content);
    },
  };
}

/**
 * `task` 的子智能体类型。
 *
 * - `explore`：只读调研，自己读一堆文件，只回一段能自包含的结论；
 * - `general`：全能力（仍然受权限策略约束），用于"这一块独立做完"的活；
 * - `review`：**审阅当前工作区的改动**。和另外两种的区别是它不需要模型描述要审什么 ——
 *   工作区里未提交的 diff 由主进程直接喂给它（对齐 oh-my-pi 的 reviewer 子智能体：
 *   按"能证明的影响 + 确实是这次引入的"给结论，而不是泛泛地说"建议加注释"）。
 */
const SUBAGENT_TYPES = ["explore", "general", "review"] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];

function normalizeSubagentType(raw: string | undefined): SubagentType {
  const value = raw?.trim();
  return (SUBAGENT_TYPES as readonly string[]).includes(value ?? "") ? (value as SubagentType) : "general";
}

function createTaskTool(ctx: ToolContext): BuiltTool {
  return {
    name: "task",
    label: "Delegate to subagent",
    description:
      "Delegate a self-contained sub-task to a subagent that has its own context window, then " +
      "returns only its final answer. Use it for broad exploration (\"find every place X is used\") " +
      "or work that would flood your own context with tool output. The subagent cannot ask the user.\n" +
      "- subagent_type=explore: read-only search over the workspace.\n" +
      "- subagent_type=general: full tools (default), for doing a self-contained piece of work.\n" +
      "- subagent_type=review: review the CURRENT uncommitted workspace changes. You do not need to " +
      "describe what changed — the diff is handed to the reviewer; just say what to focus on.",
    parameters: Type.Object({
      description: Type.String({ description: "Short (3-5 words) description of the sub-task." }),
      prompt: Type.String({ description: "Full, self-contained instructions for the subagent." }),
      subagent_type: Type.Optional(
        Type.String({ description: "explore (read-only) | general (full tools, default) | review (review current changes)" }),
      ),
    }),
    execute: async (
      _toolCallId,
      params: { description: string; prompt: string; subagent_type?: string },
      signal?: AbortSignal,
    ) => {
      if (!ctx.spawnSubagent) return errorResult("Subagents are not available in this mode.");
      void signal;
      const subagentType = normalizeSubagentType(params.subagent_type);
      try {
        const summary = await ctx.spawnSubagent({
          description: params.description,
          prompt: params.prompt,
          subagentType,
        });
        return textResult(summary || "(subagent returned no output)");
      } catch (e) {
        return errorResult(`task failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/** 抓网页正文：只做 GET + 去标签，够模型读文档 / 排错，不做浏览器自动化。 */
function createWebFetch(): BuiltTool {
  return {
    name: "web_fetch",
    label: "Fetch web page",
    description:
      "Fetch a URL and return its readable text (HTML tags stripped). Use it to read a page " +
      "found by web_search, or any docs URL. Only http/https.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL (http/https)." }),
    }),
    execute: async (_toolCallId, params: { url: string }) => {
      try {
        const url = new URL(params.url.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return errorResult("Only http/https URLs are supported.");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const res = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: { "User-Agent": "OmniStudio-Agent/1.0", Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
        }).finally(() => clearTimeout(timer));
        if (!res.ok) return errorResult(`Fetch failed: HTTP ${res.status}`);
        const contentType = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        const text = contentType.includes("html") ? htmlToText(raw) : raw;
        return textResult(`URL: ${res.url}\n\n${text}`);
      } catch (e) {
        return errorResult(`web_fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/** 极简 HTML → 文本：去掉脚本样式与标签，压缩空白。够读文档，不需要完整解析器。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 只读工具集：Plan 模式下只用这些，保证"先出方案再动手"。 */
/**
 * checkpoint / rewind：给"大范围调研"用的打点与收网（对齐 oh-my-pi 的同名机制）。
 *
 * 场景：为了定位一个问题要读十几个文件，读完之后真正有用的只有三五句结论，
 * 那些中间过程却会一直占着窗口（本地 8k 窗口下尤其致命）。
 * 打点 → 探索 → `rewind` 交结论 = 把中间过程**整段换掉**。
 *
 * 和别的压缩手段的区别：不走模型摘要，所以没有"摘要写歪了"的漂移风险 ——
 * 留下的就是你亲手写的那份结论。
 */
function createCheckpoint(ctx: ToolContext): BuiltTool {
  return {
    name: "checkpoint",
    label: "Checkpoint",
    description:
      "Mark the start of a large exploration, then call `rewind` with your findings when it is done. " +
      "Everything between checkpoint and rewind is dropped from context and replaced by your findings, " +
      "so use it before reading many files to answer one question. " +
      "Do NOT use it for ordinary work (edits you want to keep, or a task you are about to finish).",
    parameters: Type.Object({
      goal: Type.String({ description: "What you are about to investigate, in one short sentence." }),
    }),
    execute: async (_toolCallId, params: { goal: string }) => {
      if (!ctx.onCheckpoint) return errorResult("Checkpoint is not available in this mode.");
      return ctx.onCheckpoint(params.goal ?? "");
    },
  };
}

function createRewind(ctx: ToolContext): BuiltTool {
  return {
    name: "rewind",
    label: "Rewind",
    description:
      "Finish an exploration started with `checkpoint`: everything read since the checkpoint is dropped and " +
      "replaced by the report you write here. The report must be self-contained — it is the ONLY thing that " +
      "survives, so include paths, line numbers, causes and the conclusion. " +
      "Set revert_files=true only when you created scratch files during the exploration and want them undone.",
    parameters: Type.Object({
      report: Type.String({
        description:
          "Your findings: conclusion first, then the evidence (file:line, command output). " +
          "Must stand alone without the exploration it replaces.",
      }),
      revert_files: Type.Optional(
        Type.Boolean({
          description:
            "Also restore the workspace to its state at the checkpoint (undoes files YOU changed during the " +
            "exploration). Default false — leave it false unless you made throwaway changes.",
        }),
      ),
    }),
    execute: async (_toolCallId, params: { report: string; revert_files?: boolean }) => {
      if (!ctx.onRewind) return errorResult("Rewind is not available in this mode.");
      return ctx.onRewind({ report: params.report ?? "", revertFiles: params.revert_files === true });
    },
  };
}

/**
 * think：不给答案的"草稿纸"（对齐 oh-my-pi 的 think 工具）。
 *
 * 我们的模型默认 `reasoning: false`（见 `buildModel()`：不强行注入 reasoning 参数），
 * 也就是说**没有原生推理通道** —— 模型想推理只能在正文里"想出声"，那些过程会留在
 * 对话记录里、也会挤占本轮上下文。给它一个把推理写进去、只回一个空壳的工具，
 * 正文就能保持干净（工具结果本身几乎不占 token）。
 *
 * 注意：这不是"隐藏思考"。写进来的内容仍会进上下文（它是一条工具调用），
 * 只是不会出现在给用户看的正文里。
 */
function createThink(): BuiltTool {
  return {
    name: "think",
    label: "Think",
    description:
      "A private scratchpad for reasoning that should not appear in your visible answer: weighing options, " +
      "planning a multi-step approach, double-checking an assumption, or working out why something failed. " +
      "Nothing happens as a result — use it when thinking in the open would clutter the reply. " +
      "For short reasoning just answer directly; do not call this every turn.",
    parameters: Type.Object({
      thoughts: Type.String({ description: "The reasoning to record. Be specific; this is for you, not the user." }),
    }),
    execute: async (_toolCallId, params: { thoughts: string }) => {
      if (!params.thoughts?.trim()) return textResult("------");
      // 回一个空壳：内容已经进了 transcript，这里再复述一遍纯属浪费窗口。
      return textResult("------");
    },
  };
}

/**
 * read_skill：按需读取用户安装的 Skills（对齐 oh-my-pi 的渐进披露）。
 *
 * 系统提示里只列了「名字: 描述」，正文要靠这个工具取 —— 技能可能有几千字，
 * 全塞进系统提示会直接吃掉本地窗口。不带 name 时返回清单，便于模型自己找。
 */
function createReadSkill(): BuiltTool {
  return {
    name: "read_skill",
    label: "Read skill",
    description:
      "Read a user-installed Skill (a SKILL.md instruction file) by name, or list the available skills " +
      "when called without a name. Skills often contain the exact procedure the user wants for a task: " +
      "when the current task matches a skill listed in your system prompt, read it BEFORE acting. " +
      "Use `file` to read a script or template inside the skill directory (path relative to that directory).",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Skill id as listed in the system prompt. Omit to list all skills." }),
      ),
      file: Type.Optional(
        Type.String({
          description:
            "Optional path of a file inside the skill directory (e.g. 'scripts/run.py'). " +
            "Defaults to SKILL.md.",
        }),
      ),
    }),
    execute: async (_toolCallId, params: { name?: string; file?: string }) => {
      const name = params.name?.trim();
      const file = params.file;
      if (!name) {
        const section = skillsPromptSection();
        return textResult(section ?? "这台机器上还没有安装任何 Skill。");
      }
      const result = readSkillFile(name, file);
      if (!result.ok) return errorResult(result.reason);
      const header = `# Skill: ${result.name}\n（技能目录：${result.path}）`;
      const tail = result.truncated ? "\n\n…（内容过长已截断，需要更多请用 file 参数读取技能目录里的具体文件）" : "";
      return textResult(`${header}\n\n${result.text}${tail}`);
    },
  };
}

export function buildReadOnlyTools(ctx: ToolContext): BuiltTool[] {
  return [
    createReadFile(ctx),
    createListDir(ctx),
    createGlob(ctx),
    createGrep(ctx),
    // 看图是只读的，但只在模型真的能收图片时才给（见 ToolContext.vision）。
    ...(ctx.vision ? [createViewImage(ctx)] : []),
    createWebSearch(),
    createWebFetch(),
    createKnowledgeSearch(),
    createReadSkill(),
    createThink(),
    createCheckpoint(ctx),
    createRewind(ctx),
    createTodoWrite(ctx),
    createAskUser(ctx),
    createContextRemaining(ctx),
    createRequestPermissions(ctx),
  ];
}

/** 完整工具集：Agent / Goal 模式下可用，包含写文件与 shell。 */
export function buildAgentTools(ctx: ToolContext): BuiltTool[] {
  return [
    ...buildReadOnlyTools(ctx),
    createWriteFile(ctx),
    createEditFile(ctx),
    createApplyPatch(ctx),
    createWritePlan(ctx),
    createGoalTool(ctx),
    createBash(ctx),
    createTaskTool(ctx),
  ];
}
