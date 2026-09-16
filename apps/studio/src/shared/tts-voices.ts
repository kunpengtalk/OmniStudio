/**
 * 云厂商的官方音色目录（TTS 页与实时通话页共用）。
 *
 * 音色名是各家自己的 id（`cixingnansheng` / `longanqian`…），页面上的自由输入框
 * 对"知道填什么"的人是够用的，对不知道的人就是一道坎：填错只会在合成时收到一句
 * 上游的 "invalid voice"。凡是平台提供了官方音色清单的厂商，就在这里写下来，
 * 让选择器直接把可选项摆出来。
 *
 * 放在 shared：主进程要用它给"没配过音色"的请求兜底（否则百炼的 longanqian 会被
 * 原样发给阶跃），webview 要用它渲染音色下拉。
 */

export type VendorVoice = {
  id: string;
  /** 中文名（官方清单里的名称）。 */
  label: string;
};

/** 认得出的语音厂商（认不出的返回 null，页面保持自由输入）。 */
export type AudioVendorId = "stepfun" | null;

/**
 * 阶跃星辰官方音色（开放平台「官方音色清单」，TTS 与实时通话共用同一套 id）。
 *
 * 只收 `stepaudio-*` / `step-tts-*` 全系支持的常用项 —— 官方清单 37 条里有几条
 * 仅个别模型支持，列出来反而会选到不支持的组合。
 */
export const STEPFUN_VOICES: readonly VendorVoice[] = [
  { id: "linjiajiejie", label: "邻家姐姐" },
  { id: "linjiameimei", label: "邻家妹妹" },
  { id: "cixingnansheng", label: "磁性男声" },
  { id: "wenrounansheng", label: "温柔男声" },
  { id: "qingchunshaonv", label: "清纯少女" },
  { id: "yuanqishaonv", label: "元气少女" },
  { id: "jilingshaonv", label: "机灵少女" },
  { id: "tianmeinvsheng", label: "甜美女声" },
  { id: "wenrounvsheng", label: "温柔女声" },
  { id: "jingdiannvsheng", label: "经典女声" },
  { id: "elegantgentle-female", label: "气质温婉" },
  { id: "livelybreezy-female", label: "活力轻快" },
  { id: "zixinnansheng", label: "自信男声" },
  { id: "boyinnansheng", label: "播音男声" },
  { id: "qingniandaxuesheng", label: "青年大学生" },
  { id: "zhengpaiqingnian", label: "正派青年" },
  { id: "ruyananshi", label: "儒雅男士" },
  { id: "wenrougongzi", label: "温柔公子" },
  { id: "youyanvsheng", label: "优雅女声" },
  { id: "lengyanyujie", label: "冷艳御姐" },
  { id: "zhixingjiejie", label: "知性姐姐" },
  { id: "wenjingxuejie", label: "文静学姐" },
  { id: "shuangkuaijiejie", label: "爽快姐姐" },
];

/**
 * 阶跃 TTS 默认音色：官方文档各语言示例用的都是它（磁性男声）。
 */
export const DEFAULT_STEPFUN_TTS_VOICE = "cixingnansheng";

/** 这套 OpenAI 兼容音色名是 OpenAI / 部分聚合商的默认值，换厂商后原样发出去必定被拒。 */
const OPENAI_COMPAT_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
]);

export function isOpenAiCompatVoice(voice: string): boolean {
  return OPENAI_COMPAT_VOICES.has(voice.trim().toLowerCase());
}

/**
 * 认厂商：先看服务商 id（预设 id 就是厂商），再看地址主机。
 *
 * 两者都认是因为用户可以自建一行 `custom-*` 指向阶跃的地址 —— 只看 id 的话，
 * 这行的音色目录与默认值都会落空。
 */
export function audioVendorFor(opts: {
  providerId?: string | null;
  baseUrl?: string | null;
}): AudioVendorId {
  if ((opts.providerId ?? "").trim() === "stepfun") return "stepfun";
  const base = (opts.baseUrl ?? "").trim();
  if (!base) return null;
  try {
    const host = new URL(base).host;
    if (/\.stepfun\.com$/i.test(host)) return "stepfun";
  } catch {
    return null;
  }
  return null;
}

/** 厂商的官方音色目录（认不出返回空数组 = 页面保持自由输入）。 */
export function vendorVoices(vendor: AudioVendorId): readonly VendorVoice[] {
  return vendor === "stepfun" ? STEPFUN_VOICES : [];
}

/** 厂商的默认音色（TTS 用；实时通话的默认值见 shared/realtime-voice.ts）。 */
export function defaultVoiceForVendor(vendor: AudioVendorId): string {
  return vendor === "stepfun" ? DEFAULT_STEPFUN_TTS_VOICE : "alloy";
}

/**
 * 这次合成该用哪个音色。
 *
 * 显式传入的、用户存过的都尊重；只有当存下来的是**别家的占位默认值**
 * （`alloy` 这类 OpenAI 兼容音色名）而当前厂商有官方目录时才替换 —— 否则
 * "换了厂商但没改音色"会稳定地报 invalid voice，而用户觉得自己什么都没动。
 */
export function resolveTtsVoice(opts: {
  requested?: string | null;
  configured?: string | null;
  vendor: AudioVendorId;
}): string {
  const requested = (opts.requested ?? "").trim();
  if (requested) return requested;
  const configured = (opts.configured ?? "").trim();
  const fallback = defaultVoiceForVendor(opts.vendor);
  if (!configured) return fallback;
  if (opts.vendor && vendorVoices(opts.vendor).length > 0 && isOpenAiCompatVoice(configured)) {
    return fallback;
  }
  return configured;
}
