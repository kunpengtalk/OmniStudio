import type { AsrSegment } from "../../../bun/asr";
import { TRANSLATION_SOURCE_AUTO } from "../../../shared/translate";

export type AsrEngineMode = "whisper" | "audiocpp" | "api";


/** 段落键：whisper 对同一段音频前缀的 start 时间戳稳定，可作增量翻译的锚点。 */
export const segKey = (s: AsrSegment) => s.start.toFixed(2);

/** 翻译语言码 → whisper 识别语言码（zh-CN → zh；auto 透传）。 */
export function asrLangOf(code: string): string {
  if (code === TRANSLATION_SOURCE_AUTO) return "auto";
  return code.split("-")[0]!;
}

/** whisper 识别语言码 → 翻译源语言码（恢复上次选择用）。 */
export function translateLangOf(code: string): string {
  if (code === "zh") return "zh-CN";
  if (code === "en" || code === "ja" || code === "ko") return code;
  return TRANSLATION_SOURCE_AUTO;
}

/** 麦克风小电平条（同传状态栏用，条数少、更紧凑）。 */
export function LevelBars({ level }: { level: number }) {
  const BARS = 13;
  return (
    <div className="flex h-4 items-end gap-[2px]" aria-hidden>
      {Array.from({ length: BARS }).map((_, i) => {
        const weight = Math.sin((i / (BARS - 1)) * Math.PI);
        const h = Math.max(2, Math.round(Math.max(0.08, level) * weight * 16));
        return (
          <span
            key={i}
            className="w-[2px] rounded-sm bg-primary/70 transition-all duration-100"
            style={{ height: h }}
          />
        );
      })}
    </div>
  );
}
