import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

import { getSetting } from "./db/settings";
import { webSearch } from "./web-search";
import { listKnowledgeBases, recall } from "./knowledge";
import { audit } from "./skills/audit";

/**
 * Agent 可使用的工具集。
 *
 * 权限模型（对齐 PI-Desktop 的思路：特权操作必须显式放行）：
 * - 只读工具（read_file / list_dir / glob / grep / web_search）可访问工作区之外的
 *   绝对路径，因为"读"不产生副作用；
 * - 写操作（write_file / edit_file）与 shell（bash）只能作用于工作区目录内，
 *   且 shell 还受 AGENT_ALLOW_SHELL 开关控制。
 */

export type ToolContext = {
  /** Agent 的工作区根目录（所有相对路径的基准）。 */
  workspace: string;
  /** 是否允许执行 shell 命令。 */
  allowShell: boolean;
};

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

const MAX_OUTPUT_CHARS = 24_000;
const MAX_FILE_CHARS = 60_000;
const COMMAND_TIMEOUT_MS = 120_000;

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

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more chars)`;
}

/** 把用户/模型给的路径解析成绝对路径。相对路径基于工作区。 */
function resolvePath(workspace: string, input: string): string {
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
  // 本应用自己的数据目录：设置表里存着全部云端 API Key
  /Library\/Application Support\/omni-studio(\/|$)/,
];

function assertNotSecret(workspace: string, target: string): void {
  const root = path.resolve(workspace);
  if (target === root || target.startsWith(root + path.sep)) return;
  const normalized = target.replace(/\\/g, "/");
  if (SECRET_PATH_PATTERNS.some((re) => re.test(normalized))) {
    throw new Error(
      `Refusing to access a credential path outside the workspace: ${target}. ` +
        "Copy what you need into the workspace instead.",
    );
  }
}

/** 写操作必须落在工作区内。 */
function assertInsideWorkspace(workspace: string, target: string) {
  const root = path.resolve(workspace);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path outside workspace is not writable: ${target}`);
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text: truncate(text) }], details: {} };
}

function errorResult(message: string) {
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
        if (!existsSync(target)) return errorResult(`File not found: ${target}`);
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
        return textResult(hits.join("\n") || "(no matches)");
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
        assertInsideWorkspace(ctx.workspace, target);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, params.content, "utf8");
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
        assertInsideWorkspace(ctx.workspace, target);
        if (!existsSync(target)) return errorResult(`File not found: ${target}`);
        const original = readFileSync(target, "utf8");
        const occurrences = original.split(params.old_str).length - 1;
        if (occurrences === 0) return errorResult(`old_str not found in ${target}`);
        if (occurrences > 1 && !params.replace_all) {
          return errorResult(
            `old_str occurs ${occurrences} times in ${target}. Pass replace_all=true or make old_str unique.`,
          );
        }
        const next = params.replace_all
          ? original.split(params.old_str).join(params.new_str)
          : original.replace(params.old_str, params.new_str);
        writeFileSync(target, next, "utf8");
        return textResult(
          `Edited ${target} (${occurrences} replacement${occurrences > 1 ? "s" : ""})`,
        );
      } catch (e) {
        return errorResult(`edit_file failed: ${e instanceof Error ? e.message : String(e)}`);
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
      try {
        const proc = Bun.spawn([shell, "-c", params.command], {
          cwd: ctx.workspace,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PATH: augmentPath() },
        });
        if (signal) {
          signal.addEventListener("abort", () => proc.kill(), { once: true });
        }
        const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]).finally(() => clearTimeout(timer));
        const combined = [stdout, stderr].filter((s) => s.trim().length > 0).join("\n");
        return textResult(
          `$ ${params.command}\n${combined || "(no output)"}\n[exit ${exitCode}]`,
        );
      } catch (e) {
        return errorResult(`bash failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
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
        );
        if (hits.length === 0) {
          return textResult("没有检索到相关内容。");
        }
        const formatted = hits
          .map(
            (h, i) =>
              `[${i + 1}] 《${h.docName}》分块 ${h.seq}（${h.kbName}，相关度 ${h.score.toFixed(2)}）\n${h.content}`,
          )
          .join("\n\n");
        return textResult(`找到 ${hits.length} 条相关片段：\n\n${formatted}`);
      } catch (e) {
        return errorResult(`knowledge_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/** 只读工具集：Plan 模式下只用这些，保证"先出方案再动手"。 */
export function buildReadOnlyTools(ctx: ToolContext): BuiltTool[] {
  return [
    createReadFile(ctx),
    createListDir(ctx),
    createGlob(ctx),
    createGrep(ctx),
    createWebSearch(),
    createKnowledgeSearch(),
  ];
}

/** 完整工具集：Agent / Goal 模式下可用，包含写文件与 shell。 */
export function buildAgentTools(ctx: ToolContext): BuiltTool[] {
  return [
    ...buildReadOnlyTools(ctx),
    createWriteFile(ctx),
    createEditFile(ctx),
    createBash(ctx),
  ];
}
