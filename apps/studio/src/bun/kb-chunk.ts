/**
 * Markdown 感知切片器（带溯源）：知识库摄取与检索共用。
 *
 * 与旧版「只吐字符串」的区别是每个分块都带上标题路径与在原文中的字符偏移：
 * - 标题路径参与检索加权（命中标题 ≈ 命中主题）与上下文增强（嵌入时前置）；
 * - 字符偏移让引用能精确回到来源位置，而不是只知道「在某文档的某块」。
 *
 * 零主进程依赖（只用正则与字符串）：`omi` CLI 直连 SQLite 时也要能跑。
 */

export type KbChunkPiece = {
  content: string;
  /** 标题路径，如 "退款政策 > 部分退款"；无标题层级时为 null。 */
  headingPath: string | null;
  /** 在来源正文中的起始偏移（UTF-16 code unit，闭区间）。 */
  charStart: number;
  /** 结束偏移（开区间）。 */
  charEnd: number;
};

const HEADING_RE = /^(#{1,6})\s+\S/;
const FENCE_RE = /^\s*```/;

type Line = { text: string; start: number };

/** 按行切开并保留每行在原文中的起始偏移（\r 计入行内容但不计入偏移推进）。 */
function toLines(text: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  for (const raw of text.split("\n")) {
    lines.push({ text: raw.endsWith("\r") ? raw.slice(0, -1) : raw, start: pos });
    pos += raw.length + 1;
  }
  return lines;
}

type Segment = { text: string; start: number; end: number; headingPath: string | null };

/**
 * 切成「段落段」：空行分段，标题行强制起新段（标题跟内容走），
 * 代码围栏内的 `#` 不当标题、围栏内的空行不断段。
 */
function toSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const headings: string[] = [];
  let buf: Line[] = [];
  let inFence = false;

  const flush = () => {
    if (buf.length === 0) return;
    const first = buf[0]!;
    const last = buf[buf.length - 1]!;
    const raw = buf.map((l) => l.text).join("\n");
    const content = raw.trim();
    if (content) {
      const lead = raw.length - raw.trimStart().length;
      const trail = raw.length - raw.trimEnd().length;
      segments.push({
        text: content,
        start: first.start + lead,
        end: last.start + last.text.length - trail,
        headingPath: headings.filter(Boolean).length > 0 ? headings.filter(Boolean).join(" > ") : null,
      });
    }
    buf = [];
  };

  for (const line of toLines(text)) {
    if (FENCE_RE.test(line.text)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence) {
      const m = HEADING_RE.exec(line.text);
      if (m) {
        // 标题开启新的一段：先把上一段收掉，再把标题行放进新段（标题跟内容走）
        flush();
        const level = m[1]!.length;
        headings.length = Math.max(0, level - 1);
        headings[level - 1] = line.text.replace(/^#+\s*/, "").trim();
      } else if (line.text.trim() === "") {
        flush();
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return segments;
}

/** 超长段的字符滑窗硬切；用 code unit 切片，只在代理对中间回退一格。 */
function hardSplit(text: string, size: number, step: number): { content: string; offset: number }[] {
  const out: { content: string; offset: number }[] = [];
  for (let i = 0; i < text.length; i += step) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end);
      if (code >= 0xdc00 && code <= 0xdfff) end++;
    }
    const raw = text.slice(i, end);
    const content = raw.trim();
    if (content) out.push({ content, offset: i + (raw.length - raw.trimStart().length) });
    if (end >= text.length) break;
  }
  return out;
}

/**
 * 切分文本为带溯源信息的分块：
 * 1) 空行分段、Markdown 标题分节（标题跟内容走），代码围栏整体不拆；
 * 2) 段内贪心打包到 chunkSize；
 * 3) 单段超长（长文/代码）时按字符滑窗硬切，带 overlap 保证边界语义连续。
 */
export function splitIntoChunksWithMeta(text: string, chunkSize = 800, overlap = 120): KbChunkPiece[] {
  const segments = toSegments(text);
  if (segments.length === 0) return [];
  const size = Math.max(200, chunkSize);
  const step = Math.max(1, size - Math.min(overlap, Math.floor(size / 2)));

  const chunks: KbChunkPiece[] = [];
  let buf: Segment[] = [];
  let bufLen = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const content = buf.map((s) => s.text).join("\n\n").trim();
    if (content) {
      chunks.push({
        content,
        headingPath: buf[0]!.headingPath,
        charStart: buf[0]!.start,
        charEnd: buf[buf.length - 1]!.end,
      });
    }
    buf = [];
    bufLen = 0;
  };

  for (const seg of segments) {
    if (seg.text.length > size) {
      flush();
      for (const piece of hardSplit(seg.text, size, step)) {
        chunks.push({
          content: piece.content,
          headingPath: seg.headingPath,
          charStart: seg.start + piece.offset,
          charEnd: seg.start + piece.offset + piece.content.length,
        });
      }
      continue;
    }
    if (buf.length > 0 && bufLen + 2 + seg.text.length > size) flush();
    bufLen += (buf.length > 0 ? 2 : 0) + seg.text.length;
    buf.push(seg);
  }
  flush();
  return chunks;
}

/** 只要正文的兼容封装（旧调用点与冒烟脚本使用）。 */
export function splitIntoChunks(text: string, chunkSize = 800, overlap = 120): string[] {
  return splitIntoChunksWithMeta(text, chunkSize, overlap).map((c) => c.content);
}

/**
 * 上下文增强文本：嵌入与关键词索引都吃这一份（展示仍用 content）。
 * 「文档名 › 标题路径」把孤立分块放回它所在的语境，
 * 显著减少「分块本身没说清主语」导致的漏召回（contextual retrieval）。
 */
export function contextText(docName: string, headingPath: string | null, content: string): string {
  const head = [docName, headingPath].filter(Boolean).join(" › ");
  return head ? `${head}\n${content}` : content;
}

/** 分块正文的 SHA-256：重新索引时用来判断能否复用旧向量。 */
export function chunkContentHash(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}
