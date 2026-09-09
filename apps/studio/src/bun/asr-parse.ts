/**
 * ASR 分段时间戳 / 说话人解析（纯函数，无依赖，便于单测）。
 *
 * 各家 OpenAI 兼容服务的 verbose_json 分段结构略有差异：
 * - OpenAI / Groq / whisper.cpp server：segments[].start/end 单位是秒（float）
 * - 部分国内服务：单位是毫秒（int）
 * - 部分服务：speaker / speaker_id / spk 字段表示说话人
 * 这里统一做归一化。
 */

export type AsrSegment = {
  start: number; // seconds
  end: number;
  text: string;
  /** 说话人编号（0 起），服务端返回时才存在。 */
  speaker?: number;
};

type RawSegment = {
  start?: unknown;
  end?: unknown;
  from?: unknown;
  to?: unknown;
  text?: string;
  speaker?: unknown;
  speaker_id?: unknown;
  spk?: unknown;
  offsets?: { from?: unknown; to?: unknown };
};

export type SegSource = {
  text?: string;
  segments?: RawSegment[];
};

export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 归一化分段。时间大于 1200 视为毫秒（部分服务），否则按秒（OpenAI /
 * whisper.cpp server 约定）。
 */
export function normalizeSegments(raw: SegSource): AsrSegment[] {
  const list = (raw.segments ?? []).filter((s) => typeof s?.text === "string" && s.text.trim());
  if (list.length === 0) return [];

  const acc: AsrSegment[] = [];
  for (const s of list) {
    const rawStart = num(s.start) ?? num(s.from) ?? num(s.offsets?.from) ?? 0;
    const rawEnd = num(s.end) ?? num(s.to) ?? num(s.offsets?.to) ?? rawStart;
    const rawSpeaker = num(s.speaker) ?? num(s.speaker_id) ?? num(s.spk);
    const unit = rawEnd > 1200 || rawStart > 1200 ? 1000 : 1;
    acc.push({
      start: rawStart / unit,
      end: rawEnd / unit,
      text: s.text!.trim(),
      ...(rawSpeaker !== undefined ? { speaker: rawSpeaker } : {}),
    });
  }
  return acc;
}
