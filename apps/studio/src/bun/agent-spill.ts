/**
 * 工具输出转存（对齐 OMP 的「超限转存 artifact + 尾部提示读回」）。
 *
 * 之前 `textResult()` 一截了之：超过 24000 字符的部分**直接消失**，
 * 模型和用户都没有找回来的路。弱模型看到半截输出最常见的反应是拿它当完整内容
 * 往下推 —— 这正是"看起来答了、其实基于残缺信息"的典型来源。
 *
 * 现在：超限的输出先落盘到数据目录（`tool-output/<会话>/…`，**不在工作区里**），
 * 截断提示里带上绝对路径，模型需要细节时用 `read_file`（支持 offset/limit 分页）
 * 就能把原文读回来 —— 不新增工具，也不占用当轮窗口。
 *
 * 为什么走「落盘 + 提示路径」而不是自造 `artifact://` 协议：`read_file` 本来就
 * 接受绝对路径，模型学一次就会用；多一套 URI 只是多一个它可能记错的形状。
 *
 * 转存目录会随着长任务里的每次大输出增长，所以有两道清理：写入时按会话保留最近
 * `MAX_SPILLS_PER_CONVERSATION` 个，删除会话时整个目录一起清（见 `agent.ts`）。
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getDataDir } from "./paths";

/** 单条工具结果进入模型上下文的上限（字符）。 */
export const MAX_TOOL_OUTPUT_CHARS = 24_000;

/**
 * 工具结果在内存里的硬上限（字符）。
 *
 * 这是**防呆**而不是展示上限：`bash` 的输出在读完之前不知道有多大，
 * 一条 `yes` 之类的命令能吐出几百 MB。超过这个量直接丢尾部（并且说明原因），
 * 免得把主进程的内存和事件流一起拖垮。
 */
export const MAX_TOOL_RESULT_CHARS = 2_000_000;

/** 每个会话保留的转存文件数（够回看最近几十次大输出，又不至于无限增长）。 */
export const MAX_SPILLS_PER_CONVERSATION = 40;

/** 转存根目录：数据目录下的 tool-output/（工作区一行都不碰）。 */
export function spillRoot(): string {
  return getDataDir("tool-output");
}

export function conversationSpillDir(conversationId: number): string {
  return path.join(spillRoot(), String(conversationId));
}

/**
 * 这个路径是不是转存目录里的？
 *
 * 有两处要用它开一个**窄口子**（转存文件在数据目录里，而数据目录是双重设防的）：
 * - `agent-tools.ts` 的凭据黑名单：不放开就"存了却读不回来"；
 * - `permissions.ts` 的"工作区之外读取要授权"：不放开就变成**每读一次弹一次窗**。
 *
 * 口子的边界很明确：只认这个子目录，数据目录的其余部分（设置表里存着全部云端
 * API Key）照旧拦死；而且这些文件本来就是应用自己从工具结果里写出来的
 * （用户已经授权过那次工具调用）。
 *
 * 判定必须**解开软链接**：`tool-output/<会话>/x` 若是个指向 `~/.ssh/id_rsa` 的软链，
 * 光看字面路径会放行 —— 于是凭据拦截、工具结果凭据检查、工作区外读取授权三道门
 * 一起被绕过（bash 工具自己就能建这个软链）。所以走 `safeJoin` 同一套判据：
 * 目录不参与"先建软链再读"的假设，真实路径不在 root 底下就不算。
 */
export function isSpillPath(target: string): boolean {
  const root = path.resolve(spillRoot());
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;
  // 存在的路径按真实路径判；还不存在的（写之前）沿父目录往上找到第一个存在的祖先。
  try {
    if (!existsSync(root)) return false;
    const realRoot = realpathSync(root);
    let probe = resolved;
    while (!existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
    const realProbe = realpathSync(probe);
    return realProbe === realRoot || realProbe.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/** 工具名进文件名前先消毒：路径片段（`..`）/ 分隔符一律不留在文件名里。 */
function safeToolName(toolName: string): string {
  const cleaned = toolName
    .replace(/\.{2,}/g, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40);
  return cleaned || "tool";
}

/** 保留最近 N 个转存文件，其余删掉（按文件名排序即可 —— 名字以时间戳开头）。 */
export function pruneSpills(dir: string, keep = MAX_SPILLS_PER_CONVERSATION): number {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".txt"));
  } catch {
    return 0;
  }
  if (names.length <= keep) return 0;
  let removed = 0;
  for (const name of names.sort().slice(0, names.length - keep)) {
    try {
      rmSync(path.join(dir, name));
      removed += 1;
    } catch {
      // 删不掉就算了：转存文件不该让工具结果失败。
    }
  }
  return removed;
}

/** 删除会话时清掉它的转存目录。 */
export function clearConversationSpills(conversationId: number): void {
  try {
    rmSync(conversationSpillDir(conversationId), { recursive: true, force: true });
  } catch {
    // 同上：清理失败不影响会话删除。
  }
}

export type SpillResult = { path: string; bytes: number; truncated: boolean };

/**
 * 把超限的工具输出写到磁盘，返回文件路径。
 *
 * 写不进去就返回 null（磁盘满 / 权限异常）—— 那时截断提示退化成旧文案，
 * 工具结果本身照常返回，不能因为"存不下"就让整次工具调用失败。
 */
export function spillToolOutput(input: {
  conversationId: number;
  toolName: string;
  text: string;
  /** 覆盖写盘上限（测试用）。 */
  maxBytes?: number;
}): SpillResult | null {
  const maxBytes = input.maxBytes ?? MAX_TOOL_RESULT_CHARS;
  try {
    const dir = conversationSpillDir(input.conversationId);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${safeToolName(input.toolName)}.txt`);
    const body = input.text.length > maxBytes ? input.text.slice(0, maxBytes) : input.text;
    writeFileSync(file, body, "utf8");
    pruneSpills(dir);
    return {
      path: file,
      bytes: Buffer.byteLength(body, "utf8"),
      truncated: body.length < input.text.length,
    };
  } catch {
    return null;
  }
}

/**
 * 内存防呆：超大输出先砍到硬上限（并说明砍过），避免把整个字符串带进事件流与数据库。
 * 这不负责"展示层截断"，那一步在 `truncateForModel()` 里。
 */
export function capToolResultText(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return (
    `${text.slice(0, max)}\n\n…（输出过大：这里只保留了前 ${max} 个字符，` +
    `后面约 ${text.length - max} 个字符在进入上下文之前就被丢弃了。` +
    `请改用更精确的命令或把它重定向到文件后再分页读取。）`
  );
}

/**
 * 展示层截断：返回给模型的那段文本。纯函数（转存由调用方做），便于单测。
 *
 * 三条信息缺一不可：**被截了**、**还差多少**、**去哪儿找原文**。只留一个省略号的话，
 * 模型会把半截内容当成完整结果往下推。
 */
export function truncateForModel(
  text: string,
  opts: { maxChars?: number; spillPath?: string | null } = {},
): { text: string; truncated: boolean } {
  const max = opts.maxChars ?? MAX_TOOL_OUTPUT_CHARS;
  if (text.length <= max) return { text, truncated: false };
  const rest = text.length - max;
  const lines = [
    `${text.slice(0, max)}`,
    "",
    `…（输出被截断：这里只显示了前 ${max} 个字符，后面还有约 ${rest} 个字符没有显示，**不要**把上面当成完整内容。`,
  ];
  if (opts.spillPath) {
    lines.push(
      `完整输出已经存到 ${opts.spillPath}，需要细节时用 read_file 读它（支持 offset / limit 分页，不会一次吃满窗口）。`,
    );
  }
  lines.push(
    "只想看关键部分也可以缩小范围重试：读文件用 offset/limit 分页，找内容用 grep 精确定位，跑命令时用 head/tail/管道收窄输出。）",
  );
  return { text: lines.join("\n"), truncated: true };
}

/** 转存目录总占用（设置页 / 诊断用）。 */
export function spillUsage(): { files: number; bytes: number; dir: string } {
  const dir = spillRoot();
  let files = 0;
  let bytes = 0;
  const walk = (target: string) => {
    if (!existsSync(target)) return;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      const full = path.join(target, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else {
          files += 1;
          bytes += statSync(full).size;
        }
      } catch {
        // 单个文件读不到不影响整体统计。
      }
    }
  };
  walk(dir);
  return { files, bytes, dir };
}
