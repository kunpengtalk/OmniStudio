/**
 * TTS「参考音频」能力判定 + 请求字段约定。
 * 前端（决定右侧是否显示参考音频上传）与主进程（把参考音频内联进请求体）共用，
 * 故放在 shared 下，两侧都可 import（与 shared/server-info.ts 用法一致）。
 */

/**
 * 参考音频内联进 OpenAI 兼容 /audio/speech 请求体的字段名。
 * 线上 OmniLabs 约定：值为**裸 base64 字符串**（不含 data: 头）。之后要改只改这里。
 */
export const TTS_REFERENCE_AUDIO_FIELD = "reference_audio";

/** 咱们线上多模态平台主机：该平台 TTS 默认支持参考音频。 */
export const OMNI_BASE_HOST = "omnilabs.vibeadmin.cn";

/** 常见支持参考音频 / 声音克隆的 TTS 模型名片段（按小写包含匹配）。命中即视为支持。 */
const REF_AUDIO_MODEL_PATTERNS = [
  "qwen3-tts",
  "qwen-tts",
  "fish",
  "cosyvoice",
  "f5-tts",
  "f5_tts",
  "gpt-sovits",
  "so-vits",
  "index-tts",
  "omnivoice",
];

/**
 * 自动检测某云端模型是否支持「参考音频」。返回的是**默认值**，UI 里可被手动开关覆盖。
 * 规则：配置地址是线上 OmniLabs → 支持；否则按模型名包含匹配内置清单；都不命中 → 不支持。
 */
export function detectReferenceAudioSupport(
  model: string | undefined | null,
  base: string | undefined | null,
): boolean {
  if (base && base.includes(OMNI_BASE_HOST)) return true;
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return false;
  return REF_AUDIO_MODEL_PATTERNS.some((p) => m.includes(p));
}
