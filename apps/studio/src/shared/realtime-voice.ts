/**
 * 实时语音通话（云端）的常量与厂商方言。
 *
 * 放在 shared 是因为**两个进程都要用**：主进程拿它们当默认配置，通话页要拿
 * `DEFAULT_REALTIME_MODEL` 去厂商模型清单里挑出对应的那张牌，采集团还要按厂商决定
 * 上行采样率。webview 不能从 `bun/realtime-voice.ts` 值导入 —— 那个模块（经
 * cloud-providers → db → paths）会在模块级调用 `os.homedir()`，而 webview 里没有
 * Node 内置模块，一加载就整页白屏。前端包只允许值导入 shared 与第三方依赖，
 * 类型导入不受此限。
 */

/** 可选的云端实时模型（qwen-audio-agent 默认即 plus 档）。 */
export const REALTIME_MODELS = [
  "qwen-audio-3.0-realtime-plus",
  "qwen-audio-3.0-realtime-flash",
  "qwen3.5-omni-flash-realtime",
  "qwen3.5-omni-plus-realtime",
] as const;

export const DEFAULT_REALTIME_BASE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
export const DEFAULT_REALTIME_MODEL = "qwen-audio-3.0-realtime-plus";
export const DEFAULT_REALTIME_VOICE = "longanqian";

/** 阶跃星辰（StepFun）实时语音模型：`stepaudio-3-realtime-preview` 是限免预览版。 */
export const STEPFUN_REALTIME_MODELS = [
  "stepaudio-3-realtime-preview",
  "stepaudio-2.5-realtime",
] as const;

export const STEPFUN_REALTIME_BASE_URL = "wss://api.stepfun.com/v1/realtime";
export const DEFAULT_STEPFUN_REALTIME_MODEL = "stepaudio-3-realtime-preview";
/** 阶跃官方默认音色（`linjiajiejie` 邻家姐姐，对话场景推荐档）。 */
export const DEFAULT_STEPFUN_REALTIME_VOICE = "linjiajiejie";

/**
 * 实时语音的协议方言。两家都走 OpenAI-Realtime 那套事件名（session.update /
 * input_audio_buffer.append / response.audio.delta），但**字段取值不一样**，
 * 按同一套发过去会以"连上了但没声音 / 语速不对"告终：
 *   - 音频格式：百炼写 `pcm`，阶跃写 `pcm16`；
 *   - 断句：百炼 `smart_turn` / `semantic_vad`，阶跃只有 `server_vad`；
 *   - 采样率：百炼上行 16k，阶跃上行 24k（喂错会被当成另一种语速）。
 */
export type RealtimeDialect = "dashscope" | "stepfun";

/**
 * 从厂商地址（HTTP 或 ws）认出实时语音方言。
 *
 * 地址优先：自建中转把阶跃 / 百炼的地址原样透传时也认得出。认不出地址再看模型名
 * （用户手填了中转地址但模型仍是 `stepaudio-*` / `qwen-*`），最后按百炼处理 ——
 * 那是本功能最初的实现，不能把老配置的默认行为改掉。
 */
export function realtimeDialectFor(opts: {
  baseUrl?: string | null;
  model?: string | null;
}): RealtimeDialect {
  const base = (opts.baseUrl ?? "").trim();
  if (base) {
    let host = "";
    try {
      host = new URL(base.replace(/^ws/i, "http")).host;
    } catch {
      host = "";
    }
    if (/\.stepfun\.com$/i.test(host)) return "stepfun";
    if (/^(dashscope|bailian)\.aliyuncs\.com$/i.test(host)) return "dashscope";
  }
  const model = (opts.model ?? "").trim().toLowerCase();
  if (/stepaudio|step-audio|step-1o-audio/.test(model)) return "stepfun";
  return "dashscope";
}

/**
 * 从云厂商的 HTTP 地址推出实时通话的 WebSocket 地址（认得出才推，认不出返回 null）。
 *
 * 实时接口不在 OpenAI 兼容面上（百炼的 `api-ws/v1/realtime`、阶跃的 `/v1/realtime`），
 * 所以没法像生图 / TTS 那样直接拿 `provider.baseUrl` 用。以前的做法是让用户在页面上
 * 手填一个 wss 地址 —— 换厂商不会跟着换，填错只表现为"连不上"。这里把已知厂商的推导
 * 规则写下来：选了百炼 / 阶跃就自动用它的实时端点；自建中转（认不出的主机）仍保留手填值。
 *
 * 放在 shared 是因为通话页（webview）切换厂商时要立刻显示推导结果。
 */
export function realtimeBaseUrlForProvider(providerBaseUrl: string | null | undefined): string | null {
  const base = (providerBaseUrl ?? "").trim();
  if (!base) return null;
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    return null;
  }
  if (/\.stepfun\.com$/i.test(host)) return STEPFUN_REALTIME_BASE_URL;
  if (!/^(dashscope|bailian)\.aliyuncs\.com$/i.test(host)) return null;
  return `wss://${host}/api-ws/v1/realtime`;
}

/**
 * 这个模型名看着像实时语音模型吗（用来把厂商清单里混进来的对话 / 生图模型挡在下拉外）。
 *
 * 实时接口只吃 realtime / omni 两族，加上"独立一段 audio"的老型号
 * （`step-1o-audio`、`step-audio-2`）—— 注意是整段 audio，`stepaudio-3-tts` 这种
 * 拼在词里的不算（那是 TTS，不是实时语音）。把对话 / 生图模型一起列出来，用户选了之后
 * 只会等到连接时报一句看不懂的错。
 */
export function isRealtimeModelId(id: string): boolean {
  return /realtime|omni|(^|[-_])audio([-_]|$)/i.test(id);
}

/** 上行音频采样率（PCM16）：两家不同，喂错会被当成另一种语速。 */
export function realtimeInputRate(dialect: RealtimeDialect): number {
  return dialect === "stepfun" ? 24000 : 16000;
}

/** 下行音频采样率（PCM16）：两家都是 24k，播放端用它建 AudioBuffer。 */
export const REALTIME_OUTPUT_RATE = 24000;

/** 没配过音色时该用的默认音色（跟随方言，不能把百炼的音色发给阶跃）。 */
export function realtimeDefaultVoice(dialect: RealtimeDialect): string {
  return dialect === "stepfun" ? DEFAULT_STEPFUN_REALTIME_VOICE : DEFAULT_REALTIME_VOICE;
}

/** 没配过模型时该用的默认模型（跟随方言）。 */
export function realtimeDefaultModel(dialect: RealtimeDialect): string {
  return dialect === "stepfun" ? DEFAULT_STEPFUN_REALTIME_MODEL : DEFAULT_REALTIME_MODEL;
}

/** 方言对应的实时端点（用户没手填地址时的兜底）。 */
export function realtimeBaseUrl(dialect: RealtimeDialect): string {
  return dialect === "stepfun" ? STEPFUN_REALTIME_BASE_URL : DEFAULT_REALTIME_BASE_URL;
}

/**
 * 这个地址是不是"厂商预设端点"（而不是用户自己填的中转地址）。
 *
 * 用来判断存下来的地址还算不算数：切换厂商后必须跟着换地址，但**只看是否等于百炼的
 * 默认值时，从阶跃切到百炼会把阶跃的 wss 地址当成"用户自填"保留** —— 界面显示新厂商、
 * 实际连的还是上一家。所以预设端点是一个集合，不是单个默认值。
 */
export function isPresetRealtimeEndpoint(url: string | null | undefined): boolean {
  const v = (url ?? "").trim();
  return v === DEFAULT_REALTIME_BASE_URL || v === STEPFUN_REALTIME_BASE_URL;
}

/** 方言的模型候选（厂商清单里一条实时模型都没有时，至少能选到这几个）。 */
export function realtimeModelsFor(dialect: RealtimeDialect): readonly string[] {
  return dialect === "stepfun" ? STEPFUN_REALTIME_MODELS : REALTIME_MODELS;
}
