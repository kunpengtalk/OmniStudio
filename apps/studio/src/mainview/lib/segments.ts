/**
 * ASR 逐句片段的播放定位工具（纯函数，无 UI / electrobun 依赖）。
 */
import type { AsrSegment } from "../../bun/asr";

/**
 * 当前播放位置对应的句索引（start <= t < end；t 落在句间空隙时归前一句，返回 -1 表示未开始）。
 * 段数最多几千，4Hz 的 timeupdate 下线性扫完全够，无需二分。
 */
export function findActiveSegment(segments: AsrSegment[], t: number): number {
  if (segments.length === 0 || !Number.isFinite(t) || t < 0) return -1;
  let active = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.start <= t) active = i;
    else break;
    if (t < s.end) return i;
  }
  return active;
}

/**
 * 把「单独一句」的识别结果对回整场录音的时间轴。
 *
 * 自动听写是一句一句送检的（见 `shared/asr-vad.ts`），所以引擎返回的时间戳全都从
 * **这一句的 0 秒**开始；直接塞进逐句列表会让每句都落在 0:00，而且去重逻辑
 * （按起点相近判定同一句）会把它们合并成一条。
 *
 * 上游没给分段（有些服务只回整段文本）时，就按这一句的起止造一条，保证列表里
 * 仍然是「一句一行」而不是一大段。
 */
export function offsetUtteranceSegments(
  segments: AsrSegment[],
  text: string,
  utterance: { startSec: number; endSec: number },
): AsrSegment[] {
  const start = Math.max(0, utterance.startSec);
  const end = Math.max(start, utterance.endSec);
  const usable = segments.filter((s) => (s.text ?? "").trim().length > 0);
  if (usable.length === 0) {
    const body = text.trim();
    return body ? [{ start, end, text: body }] : [];
  }
  return usable.map((s) => {
    const segStart = start + Math.max(0, s.start);
    // 引擎有时会回超出这一句长度的结尾（补静音 / 幻觉），夹回句内，时间轴才不会互相重叠。
    const segEnd = Math.min(Math.max(segStart, start + s.end), end);
    return {
      ...s,
      start: segStart,
      end: Math.max(segStart, segEnd),
    };
  });
}
