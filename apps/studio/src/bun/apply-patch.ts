/**
 * apply_patch（对齐 Codex 的补丁工具）。
 *
 * 为什么值得照搬：本地小模型一次改多个文件时，`edit_file` 的 old_str/new_str
 * 要求"带货真价实的原文"，一轮下来往往要连发五六个工具调用，任何一次不匹配就断链。
 * Codex 的做法是让模型发一段**补丁**（`*** Begin Patch` 包裹的 V4A 文本），
 * 工具侧负责：
 *   1. 解析出 add / update / delete 三类改动的文件清单；
 *   2. 在文件里定位每个 `@@` 片段（先精确匹配，再逐步放宽到忽略空白与
 *      Unicode 标点差异 —— 与 Codex 的 seek_sequence 逐级放宽一致）；
 *   3. **一次性原子落盘**：任何一处匹配不上就整体不动，模型拿到明确报错重发；
 *   4. 返回 Codex 同款的 `A/M/D` 摘要，模型据此判断"改没改成功"。
 *
 * 补丁格式（与 Codex 的 Lark 文法一致）：
 *   *** Begin Patch
 *   *** Add File: path          每个内容行以 + 开头
 *   *** Update File: path       `*** Move to: newpath` 可重命名
 *   @@ 可选的小标题             片段定位（可省略，省略时按隐式片段处理）
 *    上下文行（前缀一个空格，也接受无前缀，宽松解析）
 *   -删除行
 *   +新增行
 *   *** End of File            该片段贴着文件末尾匹配
 *   *** Delete File: path
 *   *** End Patch
 *
 * 这一层不碰权限也不碰工作区：路径怎么解析、允不允许写，由调用方（agent-tools）
 * 通过 `resolve` 回调决定，本模块只负责"补丁语义"。
 */

export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
export const MOVE_TO_MARKER = "*** Move to: ";
export const EOF_MARKER = "*** End of File";

/** 解析 / 应用失败的统一错误类型：消息直接回给模型，要能照着改。 */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export type PatchLine = { type: "context" | "add" | "remove"; text: string };

export type PatchHunk = {
  /** `@@` 后面的小标题（类名 / 函数名），只用于人工阅读与报错定位。 */
  context?: string;
  lines: PatchLine[];
  /** `*** End of File`：该片段从文件末尾开始匹配。 */
  endOfFile?: boolean;
};

export type PatchOp =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: PatchHunk[] };

export type PatchChange = {
  kind: "add" | "modify" | "delete";
  /** 补丁里写的原始路径（摘要按它展示，与 Codex 的 A/M/D 一致）。 */
  rawPath: string;
  /** 解析后的绝对路径。 */
  path: string;
};

export type PatchApplyResult =
  | { ok: true; changes: PatchChange[]; summary: string }
  | { ok: false; error: string };

/**
 * 去掉模型常见的包装：代码围栏（``` / ```diff）、heredoc（<<EOF … EOF）、
 * 首尾空行。Codex 的宽松模式也接受 heredoc —— 本地模型更常加的是围栏。
 */
export function stripPatchWrapper(patch: string): string {
  let lines = patch.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  // ``` / ```diff 开头，``` 结尾
  if (lines[0] && /^```[a-zA-Z]*\s*$/.test(lines[0].trim())) {
    lines = lines.slice(1);
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    if (lines.length && lines[lines.length - 1]!.trim().startsWith("```")) lines.pop();
  }
  // <<EOF / <<'EOF' / <<"EOF" 开头，EOF 结尾
  if (lines[0] && /^<<-?['"]?EOF['"]?$/.test(lines[0].trim())) {
    const body = lines.slice(1);
    const last = body[body.length - 1];
    if (last !== undefined && last.trim().endsWith("EOF") && body.length >= 3) {
      lines = body.slice(0, -1);
      while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    }
  }
  return lines.join("\n");
}

/** 解析补丁文本；语法错误一律抛 PatchError（消息面向模型）。 */
export function parsePatch(patch: string): PatchOp[] {
  const text = stripPatchWrapper(patch);
  const lines = text.split("\n");
  if (!lines.length || lines[0]!.trim() !== BEGIN_PATCH_MARKER) {
    throw new PatchError(
      `Invalid patch: The first line of the patch must be '${BEGIN_PATCH_MARKER}'`,
    );
  }
  if (lines[lines.length - 1]!.trim() !== END_PATCH_MARKER) {
    throw new PatchError(
      `Invalid patch: The last line of the patch must be '${END_PATCH_MARKER}'`,
    );
  }

  const ops: PatchOp[] = [];
  let index = 1;
  const end = lines.length - 1;

  while (index < end) {
    const raw = lines[index]!;
    const line = raw.trim();
    if (!line) {
      index += 1;
      continue;
    }
    if (line.startsWith(ADD_FILE_MARKER)) {
      const path = line.slice(ADD_FILE_MARKER.length).trim();
      if (!path) throw new PatchError("Invalid patch: Add File requires a path");
      index += 1;
      const body: string[] = [];
      while (index < end && !isSectionMarker(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      // 末尾的空行是排版（`*** End Patch` 前留一行），不算内容。
      while (body.length && !body[body.length - 1]!.trim()) body.pop();
      const contents: string[] = [];
      for (const contentLine of body) {
        if (!contentLine.startsWith("+")) {
          throw new PatchError(
            `Invalid patch: every line of an Add File body must start with '+', got: ${JSON.stringify(contentLine)}`,
          );
        }
        contents.push(contentLine.slice(1));
      }
      ops.push({ kind: "add", path, contents: `${contents.join("\n")}\n` });
      continue;
    }
    if (line.startsWith(DELETE_FILE_MARKER)) {
      const path = line.slice(DELETE_FILE_MARKER.length).trim();
      if (!path) throw new PatchError("Invalid patch: Delete File requires a path");
      ops.push({ kind: "delete", path });
      index += 1;
      continue;
    }
    if (line.startsWith(UPDATE_FILE_MARKER)) {
      const path = line.slice(UPDATE_FILE_MARKER.length).trim();
      if (!path) throw new PatchError("Invalid patch: Update File requires a path");
      index += 1;
      let moveTo: string | undefined;
      if (index < end && lines[index]!.trim().startsWith(MOVE_TO_MARKER)) {
        moveTo = lines[index]!.trim().slice(MOVE_TO_MARKER.length).trim();
        if (!moveTo) throw new PatchError("Invalid patch: Move to requires a path");
        index += 1;
      }
      const hunks: PatchHunk[] = [];
      let current: PatchHunk | null = null;
      const ensureHunk = (): PatchHunk => {
        if (!current) {
          current = { lines: [] };
          hunks.push(current);
        }
        return current;
      };
      while (index < end) {
        const hunkLine = lines[index]!;
        const trimmed = hunkLine.trim();
        if (isSectionMarker(hunkLine)) break;
        if (trimmed === "@@" || trimmed.startsWith("@@ ")) {
          current = { lines: [], context: trimmed === "@@" ? undefined : trimmed.slice(3).trim() };
          hunks.push(current);
          index += 1;
          continue;
        }
        if (trimmed === EOF_MARKER) {
          ensureHunk().endOfFile = true;
          index += 1;
          continue;
        }
        ensureHunk().lines.push(parseBodyLine(hunkLine));
        index += 1;
      }
      // `*** End Patch` 前多一个空行很常见，但那不是"空上下文行"：留在片段里会
      // 把定位模式多出一行，匹配直接失败。收尾时统一去掉（片段内部的空行保留）。
      const cleaned = trimTrailingBlankLines(hunks);
      if (!cleaned.length) {
        throw new PatchError(`Invalid patch: Update File '${path}' has no changes`);
      }
      ops.push({ kind: "update", path, moveTo, hunks: cleaned });
      continue;
    }
    throw new PatchError(
      `Invalid patch: unexpected line in patch body: ${JSON.stringify(raw.trim())}`,
    );
  }

  if (!ops.length) throw new PatchError("Invalid patch: no file changes found");
  return ops;
}

/**
 * 去掉片段末尾的空上下文行（只去末尾：片段中间的空行是合法的空上下文）。
 * 全部是空行的片段直接丢掉（模型写了个空 `@@`）。
 */
function trimTrailingBlankLines(hunks: PatchHunk[]): PatchHunk[] {
  const cleaned: PatchHunk[] = [];
  for (const hunk of hunks) {
    const lines = [...hunk.lines];
    while (
      lines.length &&
      lines[lines.length - 1]!.type === "context" &&
      !lines[lines.length - 1]!.text.trim()
    ) {
      lines.pop();
    }
    if (!lines.length) continue;
    cleaned.push({ ...hunk, lines });
  }
  return cleaned;
}

/** 是不是一个文件段落的起始行（`*** Add/Update/Delete File:` 或结束标记）。 */
function isSectionMarker(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith(ADD_FILE_MARKER) ||
    trimmed.startsWith(UPDATE_FILE_MARKER) ||
    trimmed.startsWith(DELETE_FILE_MARKER) ||
    trimmed.startsWith(MOVE_TO_MARKER) ||
    trimmed === END_PATCH_MARKER
  );
}

/**
 * 片段体的一行。严格文法要求前缀 ` ` / `+` / `-`，这里对**无前缀**的行按上下文处理
 * （Codex 的宽松解析同样允许），但对 `+` / `-` 不做猜测：少一个符号就会改错文件。
 */
function parseBodyLine(line: string): PatchLine {
  if (line.startsWith("+")) return { type: "add", text: line.slice(1) };
  if (line.startsWith("-")) return { type: "remove", text: line.slice(1) };
  if (line.startsWith(" ")) return { type: "context", text: line.slice(1) };
  if (!line.trim()) return { type: "context", text: "" };
  return { type: "context", text: line };
}

/** 补丁影响到的所有原始路径（含 Move to 的目标）：权限判定与展示用。 */
export function patchTouchedPaths(ops: PatchOp[]): string[] {
  const paths = new Set<string>();
  for (const op of ops) {
    paths.add(op.path);
    if (op.kind === "update" && op.moveTo) paths.add(op.moveTo);
  }
  return [...paths];
}

/** 把 Unicode 标点归一化成 ASCII，用于最后一级宽容匹配（同 Codex 的 normalise）。 */
function normaliseLine(text: string): string {
  return text
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

/**
 * 在 lines 里从 start 起找 pattern，逐级放宽：
 * 精确 → 忽略行尾空白 → 忽略首尾空白 → Unicode 标点归一化。
 * endOfFile=true 时先从"贴着文件末尾"的位置试（Codex 的 eof 语义）。
 */
export function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  endOfFile = false,
): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;
  const searchStart =
    endOfFile && lines.length >= pattern.length
      ? Math.max(start, lines.length - pattern.length)
      : start;
  const last = lines.length - pattern.length;
  const matchers: ((line: string, expected: string) => boolean)[] = [
    (line, expected) => line === expected,
    (line, expected) => line.trimEnd() === expected.trimEnd(),
    (line, expected) => line.trim() === expected.trim(),
    (line, expected) => normaliseLine(line) === normaliseLine(expected),
  ];
  for (const match of matchers) {
    for (let i = searchStart; i <= last; i += 1) {
      let ok = true;
      for (let p = 0; p < pattern.length; p += 1) {
        if (!match(lines[i + p]!, pattern[p]!)) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return null;
}

type HunkApplication = { start: number; end: number; replacement: string[] };

/**
 * 把一个 update 片段落到文件上：定位 + 用「文件里的原文上下文 + 补丁里的新增行」
 * 拼出替换块（模糊匹配命中时保留文件原有写法，不会把整段空格重写）。
 */
export function applyHunk(lines: string[], hunk: PatchHunk, from: number): HunkApplication {
  const pattern = hunk.lines.filter((line) => line.type !== "add").map((line) => line.text);
  const start = seekSequence(lines, pattern, from, hunk.endOfFile === true);
  if (start === null) {
    const preview = pattern.slice(0, 8).join("\n");
    throw new PatchError(
      "Invalid Context: failed to find the lines below in the target file" +
        `${hunk.context ? ` (near '${hunk.context}')` : ""}:\n${preview}`,
    );
  }
  const replacement: string[] = [];
  let offset = 0;
  for (const line of hunk.lines) {
    if (line.type === "add") {
      replacement.push(line.text);
      continue;
    }
    const original = lines[start + offset] ?? line.text;
    offset += 1;
    if (line.type === "context") replacement.push(original);
  }
  return { start, end: start + pattern.length, replacement };
}

export type PatchFileSystem = {
  /** 读文件；不存在返回 null。 */
  read: (path: string) => string | null;
  write: (path: string, contents: string) => void;
  remove: (path: string) => void;
};

export type ApplyPatchOptions = {
  /** 把补丁里的路径解析成绝对路径（调用方在这里做越界检查，抛错即整体不落盘）。 */
  resolve: (rawPath: string) => string;
  fs: PatchFileSystem;
};

/** 应用前的文件快照：先全部读出来算好结果，确认无误再统一落盘（原子）。 */
function updateContents(path: string, hunks: PatchHunk[], fs: PatchFileSystem): string {
  const original = fs.read(path);
  if (original === null) {
    throw new PatchError(`Failed to update file: ${path} does not exist`);
  }
  const hadTrailingNewline = original.endsWith("\n");
  const lines = original.split("\n");
  // 末尾换行会split出一个空串，参与匹配会让"文件末尾"这类定位算错位。
  if (hadTrailingNewline) lines.pop();

  let cursor = 0;
  const applications: HunkApplication[] = [];
  for (const hunk of hunks) {
    const application = applyHunk(lines, hunk, cursor);
    applications.push(application);
    cursor = application.end;
  }
  const next: string[] = [];
  let index = 0;
  for (const application of applications) {
    next.push(...lines.slice(index, application.start), ...application.replacement);
    index = application.end;
  }
  next.push(...lines.slice(index));
  return `${next.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

/**
 * 应用补丁：全部改动先在内存里算完，任一环节失败则**一个字节都不写**。
 * 成功后返回 Codex 同款摘要：
 *   Success. Updated the following files:
 *   A path
 *   M path
 *   D path
 */
export function applyPatch(patch: string, options: ApplyPatchOptions): PatchApplyResult {
  let ops: PatchOp[];
  try {
    ops = parsePatch(patch);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const { fs } = options;
  const pending: { change: PatchChange; write?: { path: string; contents: string }; remove: string[] }[] = [];
  try {
    for (const op of ops) {
      const target = options.resolve(op.path);
      if (op.kind === "add") {
        if (fs.read(target) !== null) {
          throw new PatchError(
            `Failed to add file: ${op.path} already exists (use an Update File hunk instead)`,
          );
        }
        pending.push({
          change: { kind: "add", rawPath: op.path, path: target },
          write: { path: target, contents: op.contents },
          remove: [],
        });
        continue;
      }
      if (op.kind === "delete") {
        if (fs.read(target) === null) {
          throw new PatchError(`Failed to delete file: ${op.path} does not exist`);
        }
        pending.push({
          change: { kind: "delete", rawPath: op.path, path: target },
          remove: [target],
        });
        continue;
      }
      const contents = updateContents(target, op.hunks, fs);
      const destination = op.moveTo ? options.resolve(op.moveTo) : target;
      if (op.moveTo && fs.read(destination) !== null) {
        throw new PatchError(`Failed to move file: ${op.moveTo} already exists`);
      }
      pending.push({
        change: { kind: "modify", rawPath: op.moveTo ?? op.path, path: destination },
        write: { path: destination, contents },
        remove: op.moveTo ? [target] : [],
      });
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // 落盘阶段：逐条写 / 删，中途失败要能**回滚**。
  //
  // 匹配阶段确实是原子的（全部算完再落盘，任一段对不上就整体不写），但落盘本身还会失败：
  // 磁盘满、权限、只读挂载。此时前面的文件已经改了 —— 而工具说明对模型的承诺是
  // "任何一段失败就什么都不写"，模型会据此认为仓库没动，实际却改了一半，
  // 接着在错误的前提上继续干活。所以每一笔改动前先留一份原内容，失败时倒着撤回去。
  const undo: (() => void)[] = [];
  try {
    for (const item of pending) {
      const write = item.write;
      if (write) {
        const previous = fs.read(write.path);
        fs.write(write.path, write.contents);
        undo.push(() => (previous === null ? fs.remove(write.path) : fs.write(write.path, previous)));
      }
      for (const path of item.remove) {
        const previous = fs.read(path);
        if (previous === null) continue;
        fs.remove(path);
        undo.push(() => fs.write(path, previous));
      }
    }
  } catch (error) {
    const failures: string[] = [];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (rollbackError) {
        failures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error:
        `Failed to write the patch: ${reason}. ` +
        (failures.length
          ? `Rollback was incomplete for ${failures.length} path(s): ${failures.join("; ")}`
          : "All changes were rolled back; the workspace is unchanged."),
    };
  }

  const lines = ["Success. Updated the following files:"];
  for (const item of pending) {
    if (item.change.kind === "add") lines.push(`A ${item.change.rawPath}`);
  }
  for (const item of pending) {
    if (item.change.kind === "modify") lines.push(`M ${item.change.rawPath}`);
  }
  for (const item of pending) {
    if (item.change.kind === "delete") lines.push(`D ${item.change.rawPath}`);
  }
  return { ok: true, changes: pending.map((item) => item.change), summary: lines.join("\n") };
}
