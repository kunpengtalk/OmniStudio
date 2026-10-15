/**
 * ASR 转写「整理稿」：把逐句原文（时间戳 + 说话人）加工成一份 Markdown 纪要。
 * 纯函数、无 UI / electrobun 依赖，组件与测试都从这里取。
 */
import type { AsrSegment } from "../../bun/asr";

/** 媒体时间轴时钟：m:ss 或 h:mm:ss（与 voice/asr-result 的 fmtClock 同规则）。 */
function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 拼接逐句文本：CJK 边界不加空格，西文边界加一个空格。 */
function smartJoin(parts: string[]): string {
  let out = "";
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    if (!out) {
      out = s;
      continue;
    }
    const a = out[out.length - 1]!;
    const b = s[0]!;
    const cjk = (ch: string) => /[\u3000-\u9fff\uff00-\uffef]/.test(ch);
    out += cjk(a) || cjk(b) ? s : ` ${s}`;
  }
  return out;
}

/**
 * 整理稿（Markdown）：
 * - 有说话人：连续同一说话人的句子聚合为一轮，`**说话人 N** · 时间段` 领起；
 * - 无说话人：按句间停顿（>2.5s）或每 6 句分成自然段，`**[mm:ss]**` 领起；
 * - 首行是元信息（时长 / 句数 / 说话人数）的引用块。
 * 纯展示加工，不经过模型 —— 同一份输入永远得到同一份纪要。
 */
export function buildMinutesMarkdown(
  segments: AsrSegment[],
  hasSpeakers: boolean,
  speakerLabel: string,
): string {
  if (segments.length === 0) return "";
  const total = segments[segments.length - 1]!.end;
  const speakerCount = hasSpeakers ? new Set(segments.map((s) => s.speaker ?? 0)).size : 1;
  const meta = `> ${fmtClock(total)} · ${segments.length} 句${
    hasSpeakers && speakerCount > 1 ? ` · ${speakerCount} 个说话人` : ""
  }`;

  const rounds: { speaker: number | null; start: number; end: number; texts: string[] }[] = [];
  for (const s of segments) {
    const last = rounds[rounds.length - 1];
    const sameRound =
      last &&
      (hasSpeakers
        ? last.speaker === (s.speaker ?? 0)
        : s.start - last.end < 2.5 && last.texts.length < 6);
    if (sameRound && last) {
      last.end = s.end;
      last.texts.push(s.text);
    } else {
      rounds.push({ speaker: hasSpeakers ? (s.speaker ?? 0) : null, start: s.start, end: s.end, texts: [s.text] });
    }
  }

  const body = rounds
    .map((r) => {
      const head = hasSpeakers
        ? `**${speakerLabel} ${(r.speaker ?? 0) + 1}** · \`${fmtClock(r.start)} – ${fmtClock(r.end)}\``
        : `**\`${fmtClock(r.start)}\`**`;
      return `${head}\n\n${smartJoin(r.texts)}`;
    })
    .join("\n\n");

  return `${meta}\n\n${body}`;
}
