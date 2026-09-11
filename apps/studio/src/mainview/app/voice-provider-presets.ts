/**
 * 语音页（TTS 合成 / ASR 识别）「OpenAI 兼容服务」的内置服务商预设。
 * 选择预设后 Base URL 自动带出（仍可手动修改）；
 * 各预设携带已知的音频模型 ID，作为模型下拉的「内置」候选，
 * 列表末尾的「自定义」才需要手动输入完整地址。
 *
 * 地址与 `setup-screen/constants.ts` 的 REMOTE_PROVIDERS 保持一致。
 */
export type VoiceProviderPreset = {
  id: string;
  /** 服务商名称 */
  label: string;
  /** OpenAI 兼容接口 Base URL，已含 /v1 等路径前缀 */
  baseUrl: string;
  /** 已知 TTS 模型 ID（内置到下拉，仍可「获取模型」拉取全量） */
  ttsModels: string[];
  /** 已知 ASR 模型 ID */
  asrModels: string[];
  note?: string;
};

/** 默认服务地址：线上 OmniLabs 多模态平台（TTS / ASR / LLM / OCR 统一接入）。 */
export const DEFAULT_VOICE_BASE_URL = "https://omnilabs.vibeadmin.cn/v1";

export const VOICE_PROVIDER_PRESETS: readonly VoiceProviderPreset[] = [
  {
    id: "omnilabs",
    label: "OmniLabs",
    baseUrl: DEFAULT_VOICE_BASE_URL,
    ttsModels: [],
    asrModels: [],
    note: "线上多模态平台，统一接入 TTS / ASR / LLM / OCR，点击「获取模型」拉取全量",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    ttsModels: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
    asrModels: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
  },
  {
    id: "doubao",
    label: "豆包 (Doubao)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    ttsModels: [],
    asrModels: [],
    note: "火山方舟接入点按 Endpoint ID 配置，模型列表请点击「获取模型」拉取",
  },
  {
    id: "qwen-dashscope",
    label: "通义千问 (Qwen)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ttsModels: ["qwen-tts"],
    asrModels: ["paraformer-realtime-v2", "paraformer-v2"],
    note: "阿里云百炼，qwen-tts 等模型可在百炼开通后使用",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    ttsModels: [],
    asrModels: [],
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    ttsModels: [],
    asrModels: [],
    note: "注册送 tokens，音频模型以控制台开通为准",
  },
  {
    id: "moonshot",
    label: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    ttsModels: [],
    asrModels: [],
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    ttsModels: [],
    asrModels: [],
  },
  {
    id: "baidu",
    label: "文心一言",
    baseUrl: "https://qianfan.baidubce.com/v2",
    ttsModels: [],
    asrModels: [],
  },
  {
    id: "spark",
    label: "讯飞星火",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    ttsModels: [],
    asrModels: [],
    note: "需开通开放平台并启用对应服务",
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    ttsModels: ["speech-02-turbo", "speech-01-turbo"],
    asrModels: [],
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    ttsModels: [],
    asrModels: [],
    note: "聚合多家开源模型，很多免费/低价",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    ttsModels: [],
    asrModels: [],
    note: "汇聚主流模型，需充值/绑卡",
  },
  {
    id: "custom",
    label: "自定义",
    baseUrl: "",
    ttsModels: [],
    asrModels: [],
    note: "手动填写完整 Base URL（含 /v1），任何标准 OpenAI 兼容协议服务均可",
  },
];

/** 根据已保存的 Base URL 反查匹配的服务商预设；匹配不到返回 null（自定义）。 */
export function matchVoiceProvider(baseUrl: string): VoiceProviderPreset | null {
  const url = baseUrl.trim().replace(/\/+$/, "");
  if (!url) return null;
  return (
    VOICE_PROVIDER_PRESETS.find((p) => p.baseUrl && p.baseUrl.replace(/\/+$/, "") === url) ??
    null
  );
}
