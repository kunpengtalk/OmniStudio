/**
 * 「保存到笔记」：把一条 AI 消息变成一条笔记草稿。
 *
 * 对话与 Agent 两条消息渲染是各自独立的实现（见 app/chat/message.tsx 与
 * app/agent/message.tsx 顶部注释），但"这段文字该以什么标题、多大一段正文存进笔记"
 * 只该有一份规则 —— 于是放在这里，两边都调它。
 *
 * 三条取舍：
 *   - **正文原样存**：消息里就是 Markdown，笔记页也按 Markdown 渲染，不在这里改写；
 *   - **标题从内容里取**：先看有没有 `# 标题`，再看首行够不够短；取走首行当标题时
 *     正文里就不重复留那一行（否则卡片上标题与摘要一模一样）；
 *   - **纯函数**：时间与标签由调用方给，方便测。
 */

export interface NoteDraft {
  title: string;
  body: string;
  tags: string[];
  /** 归属日期 `YYYY-MM-DD`（本地时区）。 */
  day: string;
}

/** 标题最大长度：再长就不是标题了，卡片上也会被截断。 */
const TITLE_MAX = 60;
/** 首行短于这个长度才允许被"取走当标题"。 */
const TITLE_FROM_FIRST_LINE_MAX = 60;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 首行里的行内标记（加粗 / 代码 / 链接）剥掉，标题不该带着 `**`。 */
function stripInlineMarkers(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .trim();
}

/**
 * 消息正文 → 笔记草稿。内容为空（或只有空白）时返回 null —— 调用方据此禁用动作。
 */
export function noteDraftFromMessage(
  content: string,
  tag: string,
  now: Date = new Date(),
): NoteDraft | null {
  const text = String(content ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return null;

  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  const first = lines[firstIndex] ?? "";
  const rest = lines.slice(firstIndex + 1).join("\n");

  const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(first);
  const restHasContent = rest.trim().length > 0;
  const headingTitle = heading ? stripInlineMarkers(heading[1] ?? "").slice(0, TITLE_MAX) : "";

  if (headingTitle && restHasContent) {
    // 标题行被拿去当标题，正文里就不再重复它
    return { title: headingTitle, body: rest.trim(), tags: [tag], day: localDay(now) };
  }
  if (headingTitle) {
    // 整条消息就是一行标题：正文保持原文，别把内容改没了
    return { title: headingTitle, body: text, tags: [tag], day: localDay(now) };
  }

  const plainFirst = stripInlineMarkers(first);
  if (restHasContent && plainFirst.length > 0 && plainFirst.length <= TITLE_FROM_FIRST_LINE_MAX) {
    return { title: plainFirst, body: rest.trim(), tags: [tag], day: localDay(now) };
  }

  // 单行消息（或首行太长）：标题与正文都来自同一段文字，正文保持完整。
  return { title: plainFirst.slice(0, TITLE_MAX), body: text, tags: [tag], day: localDay(now) };
}
