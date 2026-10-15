/**
 * 转写工作台右侧的纯逻辑：时间格式化、说话人配色、实时片段合并、稿内查找、字号档位。
 * 没有 UI / 没有 electrobun，单测直接覆盖（实时合并那条最容易出错，也最容易被改坏）。
 */
import type { AsrSegment } from "../../../../bun/asr";

/** 媒体时间轴时钟：m:ss 或 h:mm:ss。 */
export function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function buildSrt(segments: AsrSegment[], hasSpeakers: boolean, speakerLabel: string): string {
  return segments
    .map((s, i) => {
      const label = hasSpeakers && s.speaker != null ? `[${speakerLabel} ${s.speaker + 1}] ` : "";
      return `${i + 1}\n${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}\n${label}${s.text}`;
    })
    .join("\n\n");
}

/**
 * 每句话说话人的配色（静态 tailwind 类，保证 JIT 能拾取）：
 * `bar` 给时间轴色块，`dot` 给逐句行与图例上的小圆点。
 * 说话人 id 对数组长度取模，保证任意人数都有可用配色。
 */
export const SPEAKER_STYLES = [
  { bar: "bg-sky-500", dot: "bg-sky-500" },
  { bar: "bg-rose-500", dot: "bg-rose-500" },
  { bar: "bg-amber-500", dot: "bg-amber-500" },
  { bar: "bg-emerald-500", dot: "bg-emerald-500" },
  { bar: "bg-violet-500", dot: "bg-violet-500" },
  { bar: "bg-cyan-500", dot: "bg-cyan-500" },
  { bar: "bg-orange-500", dot: "bg-orange-500" },
  { bar: "bg-fuchsia-500", dot: "bg-fuchsia-500" },
] as const;

export function speakerStyle(speaker: number) {
  const i = ((speaker % SPEAKER_STYLES.length) + SPEAKER_STYLES.length) % SPEAKER_STYLES.length;
  return SPEAKER_STYLES[i]!;
}

/**
 * 合并两次实时轮询的分段：按开始时间相近去重，后到的（更完整、更精确的）
 * 结果替换旧片段，保持按时间排序。实时转写每次都会重转整段已录音频，因此
 * 之前已展示的片段可能被修正，这里用时间相似度做锚点去重。
 */
export function mergeSegments(prev: AsrSegment[], next: AsrSegment[]): AsrSegment[] {
  if (prev.length === 0) return [...next];
  const out = [...prev];
  for (const seg of next) {
    const idx = out.findIndex((p) => Math.abs(p.start - seg.start) < 1.2);
    if (idx >= 0) out[idx] = seg;
    else out.push(seg);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 稿内查找：命中的句子连同**它在原数组里的下标**一起返回（点进列表要能定位回音频）。 */
export function searchSegments(
  segments: AsrSegment[],
  query: string,
): { index: number; seg: AsrSegment }[] {
  const q = query.trim().toLowerCase();
  const all = segments.map((seg, index) => ({ index, seg }));
  if (!q) return all;
  return all.filter(({ seg }) => seg.text.toLowerCase().includes(q));
}

/**
 * 字号档位：只作用在稿件正文上（时间戳与说话人跟着走一档），
 * 让长稿一屏能多看几句、短稿能看清字。
 */
export const TEXT_SCALES = [
  { id: "s", className: "text-xs", meta: "text-[10px]" },
  { id: "m", className: "text-[13px]", meta: "text-[10px]" },
  { id: "l", className: "text-[15px]", meta: "text-[11px]" },
  { id: "xl", className: "text-[17px]", meta: "text-xs" },
] as const;

export type TextScaleId = (typeof TEXT_SCALES)[number]["id"];

export function textScale(id: TextScaleId) {
  return TEXT_SCALES.find((s) => s.id === id) ?? TEXT_SCALES[1]!;
}
