/**
 * 项目指令（对齐 Codex 的 AGENTS.md 机制）。
 *
 * 应用里原来只有「记忆」注入 —— 那是跨会话的事实；而项目的**约定**
 * （怎么跑测试、用什么包管理器、哪些目录别动）在仓库里是写成 AGENTS.md 的，
 * 参照 Codex 的做法逐级发现并拼进系统提示：
 *
 * 1. 从工作区向上找到项目根（默认以 `.git` 为标记，与 Codex 的
 *    `project_root_markers` 一致）；找不到标记时只看工作区本身，不再向上翻；
 * 2. 从项目根向下到工作区，逐级收集 `AGENTS.md`，按「根 → 工作区」顺序拼接
 *    （越靠后的越具体，与 Codex 的拼接顺序一致）；
 * 3. 同一目录里 `AGENTS.override.md` 优先于 `AGENTS.md`（Codex 的本地覆盖文件）；
 * 4. 用户级指令放在最前：`<数据目录>/AGENTS.md`，等价于 Codex 的 `$CODEX_HOME/AGENTS.md`；
 * 5. 总量按上限截断（本地模型上下文小，默认 8KB，可用设置调大调小），
 *    截断处写明"后面还有内容被截掉了"，模型不会以为文件就这么多。
 *
 * 这里只做「找文件 + 拼字符串」，不碰权限：读的是工作区内的约定文件，
 * 和 read_file 一样属于只读访问。
 */
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";

import { getSetting } from "./db/settings";
import { getDataDir } from "./paths";

/** 默认的项目指令文件名。 */
export const PROJECT_DOC_FILENAME = "AGENTS.md";
/** 同目录下的本地覆盖文件（优先于 AGENTS.md，便于临时改约定而不动仓库文件）。 */
export const PROJECT_DOC_OVERRIDE_FILENAME = "AGENTS.override.md";
/** 项目根标记：向上找到含这些条目的目录就停下。 */
export const PROJECT_ROOT_MARKERS = [".git"];
/** 项目指令默认上限（字节）。本地模型上下文普遍只有 8k，默认给得比 Codex 保守。 */
export const DEFAULT_PROJECT_DOC_MAX_BYTES = 8 * 1024;

export type InstructionFile = {
  /** 绝对路径。 */
  path: string;
  contents: string;
  /** user = 数据目录下的全局指令；project = 工作区所在的仓库链路。 */
  source: "user" | "project";
};

/** 用户级指令文件：`<数据目录>/AGENTS.md`（对齐 Codex 的 `$CODEX_HOME/AGENTS.md`）。 */
export function userInstructionsPath(): string {
  return getDataDir(PROJECT_DOC_FILENAME);
}

/**
 * 向上找项目根：返回第一个含标记条目（默认 `.git`）的目录；一路到文件系统根都没有则返回 null。
 * 目录本身也算（工作区自己就是仓库根时不会再多翻一层）。
 */
export function findProjectRoot(
  workspace: string,
  markers: string[] = PROJECT_ROOT_MARKERS,
): string | null {
  let dir = path.resolve(workspace);
  // 标记为空 = 关闭向上查找（与 Codex 的「空标记列表禁用父级遍历」一致）。
  if (markers.length === 0) return null;
  for (;;) {
    if (markers.some((marker) => existsSync(path.join(dir, marker)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 项目根 → 工作区的目录链（含两端）；没有项目根时只有工作区自己。 */
export function instructionDirs(workspace: string, markers?: string[]): string[] {
  const start = path.resolve(workspace);
  const root = findProjectRoot(start, markers);
  if (!root || root === start) return [start];
  const chain: string[] = [start];
  let dir = start;
  while (dir !== root) {
    const parent = path.dirname(dir);
    // findProjectRoot 保证 root 是 start 的祖先；这里只是防御异常输入。
    if (parent === dir) break;
    chain.push(parent);
    dir = parent;
  }
  return chain.reverse();
}

/** 单个目录里该用哪个指令文件：override 优先于 AGENTS.md。 */
export function instructionFileIn(dir: string): string | null {
  const override = path.join(dir, PROJECT_DOC_OVERRIDE_FILENAME);
  if (existsSync(override) && isReadableFile(override)) return override;
  const plain = path.join(dir, PROJECT_DOC_FILENAME);
  if (existsSync(plain) && isReadableFile(plain)) return plain;
  return null;
}

function isReadableFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 单个文件读取上限：超过就只读前一段（每轮都要装载，不能让一个大文件拖住回合）。 */
const MAX_INSTRUCTION_READ_BYTES = 256 * 1024;

/** 读单个指令文件；读不出来 / 内容为空时返回 null（辅助上下文，不该让整轮 Agent 起不来）。 */
function readInstructionFile(
  target: string,
  source: InstructionFile["source"],
): InstructionFile | null {
  if (!isReadableFile(target)) return null;
  try {
    const size = statSync(target).size;
    const contents =
      size > MAX_INSTRUCTION_READ_BYTES
        ? Buffer.from(readFileSync(target).subarray(0, MAX_INSTRUCTION_READ_BYTES)).toString("utf8")
        : readFileSync(target, "utf8");
    return contents.trim() ? { path: target, contents, source } : null;
  } catch {
    return null;
  }
}

/** 用户级指令文件（不存在 / 为空时返回 null）。 */
export function userInstructionFile(target = userInstructionsPath()): InstructionFile | null {
  return readInstructionFile(target, "user");
}

/**
 * 收集要注入的项目指令：用户级在前，项目链路（根 → 工作区）在后。
 * 文件读不出来（权限 / 编码）时跳过而不是抛错 —— 指令缺失不该让整轮 Agent 起不来。
 */
export function discoverInstructionFiles(
  workspace: string,
  opts: { userFile?: string; markers?: string[] } = {},
): InstructionFile[] {
  const files: InstructionFile[] = [];
  const user = userInstructionFile(opts.userFile ?? userInstructionsPath());
  if (user) files.push(user);
  for (const dir of instructionDirs(workspace, opts.markers)) {
    const file = instructionFileIn(dir);
    if (!file) continue;
    const loaded = readInstructionFile(file, "project");
    if (loaded) files.push(loaded);
  }
  return files;
}

/** 按上限截断；被截掉时在结尾写明，模型不会把"截断"当成文件末尾。 */
export function truncateInstructions(
  files: InstructionFile[],
  maxBytes: number,
): { files: InstructionFile[]; truncated: boolean } {
  if (maxBytes <= 0) return { files, truncated: false };
  let remaining = maxBytes;
  const kept: InstructionFile[] = [];
  let truncated = false;
  for (const file of files) {
    const size = Buffer.byteLength(file.contents, "utf8");
    if (size <= remaining) {
      kept.push(file);
      remaining -= size;
      continue;
    }
    if (remaining > 0) {
      const slice = Buffer.from(file.contents, "utf8").subarray(0, remaining);
      // 别把多字节字符切成半个：截断处往前收到最后一个完整字符。
      const text = new TextDecoder("utf-8").decode(slice).replace(/\uFFFD+$/, "");
      kept.push({ ...file, contents: text });
    }
    truncated = true;
    break;
  }
  return { files: kept, truncated };
}

/** 段落去重的最小长度：比这短的行（"用 bun。"）删不删都省不下什么，还容易误伤。 */
const MIN_DEDUPE_CHARS = 40;

function isHeading(block: string): boolean {
  return /^#{1,6}\s/.test(block.trimStart());
}

/**
 * 把一段 markdown 切成"块"：空行分段，但**代码围栏内部不切**
 * （``` / ~~~ 里的空行是代码的一部分，切开会把半截代码当成独立段落）。
 */
export function splitInstructionBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join("\n").trim());
      current = [];
    }
  };
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (line.trim().startsWith(fence)) fence = null;
    }
    if (fence === null && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks.filter((block) => block.length > 0);
}

function blockKey(block: string): string {
  return block.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 段落级去重（对齐 OMP 的 rulebook 段落去重）。
 *
 * monorepo 里很常见：子包的 `AGENTS.md` 把根目录那几条原样抄一遍
 * （"跑测试用 bun test"、"提交前跑 lint"）。对本地小窗口来说这些重复是纯开销，
 * 而且会把真正属于这一层的内容挤出 8KB 上限。
 *
 * 三条规矩，都是从"宁可少删"出发的：
 * 1. **只在更具体的那一层删** —— 越靠前的文件越是上位约定，永远原样保留；
 * 2. 标题算作段落的一部分：`## 测试` + 它的正文一起重复才整段删，
 *    否则会留下一个空标题挂在后面（比不删更容易误导模型）；
 * 3. 删掉的位置留一行说明 —— 用户翻系统提示时不会以为内容丢了。
 */
export function dedupeInstructionSections(files: InstructionFile[]): InstructionFile[] {
  const seen = new Set<string>();
  const result: InstructionFile[] = [];
  for (const [index, file] of files.entries()) {
    const blocks = splitInstructionBlocks(file.contents);
    // 第一个文件不参与去重（它没有"上层"可比），直接把它自己记进 seen。
    if (index === 0) {
      for (const block of blocks) seen.add(blockKey(block));
      result.push(file);
      continue;
    }
    const duplicate = (block: string): boolean => {
      const key = blockKey(block);
      if (!seen.has(key)) return false;
      // 短行与标题只在"整段都被抄走"时才有意义，这里先看长度：
      return isHeading(block) || block.length >= MIN_DEDUPE_CHARS;
    };
    const kept: string[] = [];
    let dropped = 0;
    for (let cursor = 0; cursor < blocks.length; ) {
      if (duplicate(blocks[cursor]!)) {
        let end = cursor;
        while (end < blocks.length && duplicate(blocks[end]!)) end += 1;
        const run = blocks.slice(cursor, end);
        // 只有"标题 + 正文"整段重复才删；光标题重复（下面正文是本层特有的）就留着。
        if (run.some((block) => !isHeading(block))) {
          dropped += run.length;
          cursor = end;
          continue;
        }
      }
      kept.push(blocks[cursor]!);
      cursor += 1;
    }
    for (const block of blocks) seen.add(blockKey(block));
    if (dropped === 0) {
      result.push(file);
      continue;
    }
    const note = `（这个文件里有 ${dropped} 段与上层 AGENTS.md 重复，已省略；要看原文直接读 ${file.path}。）`;
    result.push({ ...file, contents: kept.length ? `${kept.join("\n\n")}\n\n${note}` : note });
  }
  return result;
}

/** 项目指令上限：设置里可调，非法值回落到默认。 */
export function projectDocMaxBytes(): number {
  const raw = Number(getSetting("AGENT_PROJECT_DOC_MAX_BYTES"));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PROJECT_DOC_MAX_BYTES;
  // 下限 512 字节：再小就只剩一句半，没有意义；上限 256KB 防止把本地模型窗口塞爆。
  return Math.min(256 * 1024, Math.max(512, Math.floor(raw)));
}

/** 项目指令开关（设置里关掉后，系统提示里不再出现这一段）。 */
export function projectDocEnabled(): boolean {
  return getSetting("AGENT_PROJECT_DOC") !== "0";
}

export type ProjectInstructions = {
  files: InstructionFile[];
  truncated: boolean;
  /** 拼好的系统提示段落；没有任何文件时为空字符串。 */
  section: string;
  tokensEstimate: number;
};

/**
 * 拼成系统提示里的一段。顺序：用户级 → 项目根 → … → 工作区。
 * 文案明确「这是项目约定、优先级高于通用准则，但与用户当前要求冲突时听用户的」——
 * 与 Codex 对 AGENTS.md 的定位一致（它比工具说明更贴近项目，但都不是最高指令）。
 */
export function formatInstructions(files: InstructionFile[], truncated: boolean): string {
  if (files.length === 0) return "";
  const lines = [
    "# 项目指令（AGENTS.md）",
    "",
    "以下是项目里已有的 AGENTS.md 约定，是这个仓库的真实规则（怎么跑测试、用什么工具、哪些地方别动）。",
    "请把它们当作本项目的默认做法执行；与用户当前的要求冲突时，以用户当前要求为准。",
  ];
  for (const file of files) {
    lines.push("", `## ${file.path}`, "", file.contents.trimEnd());
  }
  if (truncated) {
    lines.push(
      "",
      "（以上项目指令因体积超限被截断，后面还有内容没有展示；需要时用 read_file 直接读取原文件。）",
    );
  }
  return lines.join("\n");
}

/**
 * 装载并拼好本工作区的项目指令。禁用 / 没有文件时返回空段。
 * `workspace` 为空（未配置工作区）时只注入用户级指令。
 */
export function loadProjectInstructions(workspace: string): ProjectInstructions {
  if (!projectDocEnabled()) return { files: [], truncated: false, section: "", tokensEstimate: 0 };
  // 没有工作区时只注入用户级指令（工作区根就是数据目录的话会把同一个文件读两遍）。
  const found = workspace
    ? discoverInstructionFiles(workspace)
    : [userInstructionFile()].filter((file): file is InstructionFile => file !== null);
  // 先去重再截断：去重省下的字节要留给真正属于这一层的内容，
  // 否则子包的约定会被"抄来的重复段落"挤到 8KB 之外（截断是按顺序从后往前砍的）。
  const { files, truncated } = truncateInstructions(
    dedupeInstructionSections(found),
    projectDocMaxBytes(),
  );
  const section = formatInstructions(files, truncated);
  return {
    files,
    truncated,
    section,
    // 粗估：CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token。只用于日志 / 状态展示。
    tokensEstimate: Math.ceil(section.length / 3),
  };
}
