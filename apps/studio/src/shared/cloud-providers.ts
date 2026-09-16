/**
 * 模型云服务商：共享预设目录与数据类型（bun 服务与 mainview UI 共用）。
 *
 * 预设只提供元信息（名称 / 厂商 / Base URL / 常见模型 / 品牌色）；
 * 用户添加的服务商落在 `cloud_providers` 表里，预设 id 即表主键。
 *
 * 每个模型条目带「用途分类」（生图 / TTS / ASR / 视频 / 对话…）：各功能页
 * （生图 / 语音 / OCR…）只列自己那一类的模型，用户不必再在页面里重填地址与密钥。
 */

import { classifyModelName, type ModelCategory } from "./modelscope";

/** 云模型的用途分类（与本地模型的 ModelCategory 同一套）。 */
export type CloudModelType = ModelCategory;

/**
 * 云服务商的模型条目：id 必填，name/group/remark 可选（兼容旧版纯 id 列表）。
 * `type` 是用户确认过的用途分类；没写就按 id 自动识别（`modelTypeOf`）。
 */
export type CloudModelEntry = {
  id: string;
  name?: string;
  group?: string;
  remark?: string;
  type?: CloudModelType;
};

/**
 * 生视频接口协议：视频 API 没有统一标准，各家路径与请求体都不一样，
 * 由服务商这一层记下「这家的视频接口长什么样」。
 * `""` = 只配了对话 / 生图等能力，生视频不可用。
 */
export type CloudVideoApi = "" | "minimax" | "seedance";

/**
 * 生音乐接口协议：与生视频同理 —— 音乐 API 也没有统一标准，各家是各家的形状。
 *
 * - `stepfun`：StepFun 阶跃星辰，**异步**（`/v1/audio/music/submit` 拿 task_id，
 *   `/v1/audio/music/query` 轮询，成片以 Base64 返回）。
 * - `minimax`：MiniMax，**同步**（`/v1/music_generation` 一次阻塞请求直接出音频，
 *   默认 hex 编码，`output_format: "url"` 时返回 24 小时有效的下载地址）。
 *
 * 两者一个是"提交 + 轮询"、一个是"长请求直接返回"，执行模型都不同 ——
 * 这正是必须按协议分派、而不能按厂商名硬编码的原因（见 bun/music-gen.ts）。
 * `""` = 这家不具备生音乐能力。
 */
export type CloudMusicApi = "" | "stepfun" | "minimax";

/** 服务商预设元信息。 */
export type CloudPreset = {
  id: string;
  /** 产品名 / 品牌名 */
  name: string;
  /** 服务商所属厂商/公司（展示用） */
  vendor: string;
  /** OpenAI 兼容接口 Base URL，已含 /v1 等路径前缀 */
  baseUrl: string;
  /** 该服务商常见对话模型 ID（预填模型列表用） */
  models: string[];
  /**
   * 预设模型的用途分类覆盖表（`models` 里按名字认不出用途的那些）。
   *
   * 自动识别只认命名特征：`stepaudio-3-realtime-preview` 既不含 `tts` 也不含 `asr`，
   * 会被归到 `other` —— 而 `other` 在对话选择器里是保留的（"认不出来的宁可多给"），
   * 用户会在一堆聊天模型里看到它。预设知道这些模型是干什么的，就在这里写死。
   */
  modelTypes?: Record<string, CloudModelType>;
  /** 简短备注（免费额度 / 需要额外操作等） */
  note?: string;
  /** 品牌主色（#rrggbb），列表徽章底色。 */
  color: string;
  /** 生视频接口协议（只有提供生视频能力的厂商才有）。 */
  videoApi?: CloudVideoApi;
  /** 生音乐接口协议（只有提供生音乐能力的厂商才有）。 */
  musicApi?: CloudMusicApi;
};

/**
 * MiniMax 生视频模型（video-gen 与预设共用，避免两处写死两份）。
 *
 * 用的是 MiniMax 公开接口里的真实模型 id：Hailuo 系（2.3 / 02）支持
 * duration 6/10 秒与 resolution 档位；T2V-01 / I2V-01 那代没有这两个参数，
 * 且 I2V-* 必须带首帧图（video-gen 里按模型名决定发不发这些字段）。
 * 以前这里写的 "MiniMax-H3" 是 OmniLabs 那边自造的名字，MiniMax 侧不认。
 */
export const MINIMAX_VIDEO_MODELS = [
  "MiniMax-Hailuo-2.3",
  "MiniMax-Hailuo-02",
  "T2V-01",
  "T2V-01-Director",
  "I2V-01",
  "I2V-01-Director",
];

/** 火山方舟 Seedance 生视频模型。 */
export const SEEDANCE_VIDEO_MODELS = [
  "doubao-seedance-1-0-lite-t2v-250428",
  "doubao-seedance-1-0-lite-i2v-250428",
  "doubao-seedance-1-0-pro-t2v-250528",
  "doubao-seedance-1-0-pro-i2v-250528",
];

/**
 * StepFun 阶跃星辰生音乐模型（stepfun 协议）。
 *
 * `stepaudio-3-music-preview` 是官方文档里唯一给出的 model_id，且是**固定值** ——
 * 提交时它不接受别的取值，所以这里也只放这一个，用户不必去猜。
 */
export const STEPFUN_MUSIC_MODELS = ["stepaudio-3-music-preview"];

/**
 * MiniMax 生音乐模型（minimax 协议）。
 *
 * 当前文档的枚举：`music-3.0` / `music-2.6` / `music-cover`（另有已下线的 -free 档）。
 * `music-cover` 是「参考歌曲 → 翻唱」，需要额外的音频输入。
 */
export const MINIMAX_MUSIC_MODELS = ["music-3.0", "music-2.6", "music-cover"];

/**
 * 云服务商预设：国内主流原厂 + 国外三大原厂（OpenAI / Anthropic / Google）
 * + 聚合商。含聚合商：中转/聚合也是合法的云服务来源。
 */
export const CLOUD_PRESETS: readonly CloudPreset[] = [
  {
    id: "omnilabs",
    name: "OmniLabs",
    vendor: "OmniLabs 多模态平台",
    baseUrl: "https://omnilabs.vibeadmin.cn/v1",
    models: [],
    note: "统一接入 TTS / ASR / LLM / OCR，32+ 开源模型、44 个免费大模型",
    color: "#6366f1",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    vendor: "深度求索",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "deepseek-chat 指向最新版，官方 API 性价比高",
    color: "#2563eb",
  },
  {
    id: "qwen-dashscope",
    name: "通义千问 (Qwen)",
    vendor: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long", "qwen-flash"],
    note: "阿里云百炼，qwen-plus/turbo 有免费额度",
    color: "#f59e0b",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    vendor: "智谱 AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4-plus", "glm-4-flash", "glm-4-air"],
    note: "注册送 tokens，GLM-4-Flash 免费",
    color: "#0ea5e9",
  },
  {
    id: "moonshot",
    name: "Kimi",
    vendor: "月之暗面",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-latest", "moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
    color: "#111827",
  },
  {
    id: "doubao",
    name: "豆包 (Doubao)",
    vendor: "字节跳动火山引擎",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [
      "doubao-seed-1-6-250618",
      "doubao-1-5-pro-32k-250115",
      "doubao-1-5-lite-32k-250115",
      ...SEEDANCE_VIDEO_MODELS,
    ],
    note: "火山方舟：对话需创建接入点填 Endpoint ID 后缀；生视频（Seedance）直接用模型 ID",
    color: "#14b8a6",
    videoApi: "seedance",
  },
  {
    id: "baidu",
    name: "文心一言",
    vendor: "百度千帆",
    baseUrl: "https://qianfan.baidubce.com/v2",
    models: ["ernie-4.5-turbo-128k", "ernie-4.5-8k", "ernie-3.5-8k", "ernie-speed-8k"],
    color: "#2932e1",
  },
  {
    id: "hunyuan",
    name: "腾讯混元",
    vendor: "腾讯云",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbos-latest", "hunyuan-turbo-latest", "hunyuan-pro", "hunyuan-lite"],
    color: "#0052d9",
  },
  {
    id: "minimax",
    name: "MiniMax",
    vendor: "MiniMax 稀宇科技",
    baseUrl: "https://api.minimax.chat/v1",
    models: ["MiniMax-M1", "MiniMax-Text-01", ...MINIMAX_VIDEO_MODELS, ...MINIMAX_MUSIC_MODELS],
    modelTypes: Object.fromEntries(MINIMAX_MUSIC_MODELS.map((id) => [id, "music" as const])),
    note: "对话走 OpenAI 兼容接口；生视频走 MiniMax 自己的 /v1/video_generation 与 /v1/query/video_generation（海外站把地址换成 https://api.minimax.io/v1）；生音乐走 /v1/music_generation。音乐接口对 2026-08-20 之后的新账号已停售，老账号与转售方仍可用",
    color: "#e11d48",
    videoApi: "minimax",
    musicApi: "minimax",
  },
  {
    id: "spark",
    name: "讯飞星火",
    vendor: "科大讯飞",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    models: ["4.0Ultra", "generalv3.5", "generalv3", "lite"],
    note: "需开通开放平台并启用对应服务",
    color: "#8b5cf6",
  },
  {
    id: "sensenova",
    name: "商汤商量",
    vendor: "商汤科技 SenseNova",
    baseUrl: "https://api.sensenova.cn/compatible-mode/v1",
    models: ["SenseNova-V6-5", "SenseChat-5", "SenseChat-Turbo"],
    note: "日日新平台 OpenAI 兼容接口",
    color: "#be123c",
  },
  {
    id: "baichuan",
    name: "百川大模型",
    vendor: "百川智能",
    baseUrl: "https://api.baichuan-ai.com/v1",
    models: ["Baichuan4-Turbo", "Baichuan4-Air", "Baichuan4"],
    note: "搜索增强 + 超长上下文（192k）",
    color: "#7c3aed",
  },
  {
    id: "skywork",
    name: "天工 Skywork",
    vendor: "昆仑万维",
    baseUrl: "https://api.tiangong.cn/v1",
    models: ["Sky-Chat-3.0", "Skywork-13B"],
    note: "接口地址/模型以天工模型开放平台最新文档为准",
    color: "#0284c7",
  },
  {
    id: "lingyiwanwu",
    name: "零一万物",
    vendor: "01.AI",
    baseUrl: "https://api.lingyiwanwu.com/v1",
    models: ["yi-large", "yi-lightning"],
    color: "#10b981",
  },
  {
    id: "stepfun",
    name: "阶跃星辰",
    vendor: "StepFun",
    baseUrl: "https://api.stepfun.com/v1",
    /**
     * 对话 + 语音两条线：StepAudio 3 的 TTS / ASR / 实时语音三件套都挂在这一个厂商行下，
     * 语音页、ASR 页、通话页各自按用途取自己的模型（`providerModelsOfType`）。
     * 实时语音模型不在 OpenAI 兼容面上（`/v1/realtime` WebSocket），选它时地址由
     * `realtimeBaseUrlForProvider` 从 baseUrl 推导，不需要用户手填。
     */
    models: [
      "step-1-8k",
      "step-1-flash",
      "stepaudio-3-tts",
      "stepaudio-3-asr-max",
      "stepaudio-3-realtime-preview",
      "stepaudio-2.5-tts",
      "stepaudio-2.5-asr",
      "stepaudio-2.5-realtime",
      ...STEPFUN_MUSIC_MODELS,
    ],
    modelTypes: {
      // 对话（这几个名字里没有任何可识别的用途特征）
      "step-1-8k": "chat",
      "step-1-flash": "chat",
      // 实时语音不属于 TTS / ASR 任何一类（它自己就是一条双向语音会话），标 other。
      // other 在本地模型里是"认不出、按能用处理"，对话列表那边另有 realtime 过滤
      // （chat-model.ts：实时语音模型不进对话选择器）。
      "stepaudio-3-realtime-preview": "other",
      "stepaudio-2.5-realtime": "other",
      // 生音乐：`stepaudio-3-music-preview` 里的 `music` 分类器能认出来，
      // 但显式写死更稳 —— 预设知道它是什么，就不该让分类器的规则变动影响到它。
      "stepaudio-3-music-preview": "music",
    },
    note: "语音线含 StepAudio 3 TTS / ASR / 实时对话，实时语音有免费预览版；生音乐走 /v1/audio/music 的提交 + 轮询",
    color: "#a855f7",
    musicApi: "stepfun",
  },
  {
    id: "openai",
    name: "OpenAI",
    vendor: "GPT 系列",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini"],
    note: "需海外网络环境与境外支付方式",
    color: "#10a37f",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    vendor: "Claude 系列",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4", "claude-opus-4", "claude-haiku-4"],
    note: "官方 OpenAI SDK 兼容层（chat completions 核心功能）；需海外网络环境",
    color: "#d97757",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    vendor: "Google AI",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    note: "官方 OpenAI 兼容端点；需海外网络环境",
    color: "#4285f4",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    vendor: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-235B-A22B-Instruct", "deepseek-ai/DeepSeek-R1"],
    note: "聚合多家开源模型，很多免费/低价",
    color: "#64748b",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    vendor: "第三方聚合",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-5", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro"],
    note: "汇聚主流模型，需充值/绑卡",
    color: "#0f172a",
  },
];

export function getPreset(id: string): CloudPreset | undefined {
  return CLOUD_PRESETS.find((p) => p.id === id);
}

/**
 * 预设的模型清单 → 落库用的模型条目（把 `modelTypes` 里的显式用途带上）。
 *
 * 单一真源：新建厂商、迁移旧激活厂商、给存量厂商补新预设模型三处都走这里 ——
 * 各写一份的话，同一份预设会随入口不同而带上 / 丢掉用途分类。
 */
export function presetModelEntries(preset: CloudPreset): CloudModelEntry[] {
  return preset.models.map((id) => {
    const type = preset.modelTypes?.[id];
    return type ? { id, type } : { id };
  });
}

/** RPC 返回的服务商行（cloud_providers 表的脱壳）。 */
export type CloudProviderInfo = {
  id: string;
  name: string;
  vendor: string;
  baseUrl: string;
  apiKey: string;
  models: CloudModelEntry[];
  /**
   * 已启用（设置页里「启动」过，密钥校验通过）。可以同时启用多个厂商；
   * 各功能页（生图 / 语音 / OCR…）只列已启用厂商的模型。
   */
  enabled: boolean;
  /** 生视频接口协议（""=不具备生视频能力）。 */
  videoApi: CloudVideoApi;
  /** 生音乐接口协议（""=不具备生音乐能力）。 */
  musicApi: CloudMusicApi;
  createdAt: number;
  updatedAt: number;
};

/** 是不是合法的模型用途分类（解析旧 JSON / RPC 入参时用）。 */
export function isCloudModelType(value: unknown): value is CloudModelType {
  return (
    value === "chat" ||
    value === "embedding" ||
    value === "rerank" ||
    value === "tts" ||
    value === "asr" ||
    value === "image" ||
    value === "video" ||
    value === "music" ||
    value === "other"
  );
}

export function isCloudVideoApi(value: unknown): value is CloudVideoApi {
  return value === "" || value === "minimax" || value === "seedance";
}

export function isCloudMusicApi(value: unknown): value is CloudMusicApi {
  return value === "" || value === "stepfun" || value === "minimax";
}

/**
 * 模型条目的用途分类：用户显式指定的优先，否则按 id 自动识别。
 * `other` = 没认出来 —— 各功能页把它当"不确定"，是否列出由调用方决定。
 */
export function modelTypeOf(entry: CloudModelEntry): CloudModelType {
  return entry.type ?? classifyModelName(entry.id);
}

/** 解析 CLOUD_MODELS 等旧 JSON 列表（兼容纯 id 字符串数组与对象数组）。 */
export function parseCloudModels(raw: string | undefined | null): CloudModelEntry[] {
  try {
    const arr: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x): CloudModelEntry | null => {
        if (typeof x === "string") return { id: x };
        if (x && typeof x === "object" && typeof (x as Record<string, unknown>).id === "string") {
          const o = x as Record<string, unknown>;
          return {
            id: o.id as string,
            name: typeof o.name === "string" ? o.name : undefined,
            group: typeof o.group === "string" ? o.group : undefined,
            remark: typeof o.remark === "string" ? o.remark : undefined,
            type: isCloudModelType(o.type) ? o.type : undefined,
          };
        }
        return null;
      })
      .filter((x): x is CloudModelEntry => x !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 按用途挑选服务商 / 模型（各功能页共用同一套判定）
// ---------------------------------------------------------------------------

/** 该服务商里属于指定用途的模型（条目显式分类优先，否则按 id 自动识别）。 */
export function providerModelsOfType(
  provider: CloudProviderInfo,
  type: CloudModelType,
): CloudModelEntry[] {
  return provider.models.filter((m) => modelTypeOf(m) === type);
}

/**
 * 把服务商地址规整成"带版本段"的形式（`https://host/v1`），用于拼 OpenAI 兼容端点。
 *
 * 服务商的 baseUrl 有的带 `/v1`（预设都是这样），有的只有域名，还有的自建网关把
 * 版本段写成别的（`/api/paas/v4`）。直接 `base + "/v1/audio/..."` 会在前两种上分别
 * 得到正确结果和 `/v1/v1/audio/...` —— 后者是稳定 404，且报错来自上游网关，看不出
 * 是地址拼错了。这里只在**没有版本段**时才补 `/v1`。
 */
export function normalizeApiBase(base: string): string {
  let b = base.trim().replace(/\/+$/, "");
  if (b && !/\/v\d+$/i.test(b)) b = `${b}/v1`;
  return b;
}

/**
 * 本机地址（localhost / 127.0.0.1 / 局域网 IP）：这类 OpenAI 兼容端点
 * （Ollama、LM Studio、自建网关）通常不需要密钥，校验时不做「必须有 Key」的要求。
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * 某个用途下可用的服务商：已启用（设置页里"启动"过）+ 至少有一个该用途的模型。
 * 功能页（生图 / TTS / ASR / 生视频 / OCR / 生音乐）用它决定下拉框里出现哪些厂商。
 *
 * `requireVideoApi` / `requireMusicApi` 是额外的一道门：光有该用途的模型还不够，
 * 厂商行上必须记着对应的接口协议 —— 生视频与生音乐都没有统一标准，协议缺失时
 * 选它也调不通（见 shared/cloud-providers.ts 顶部的 CloudMusicApi 说明）。
 */
export function providersForType(
  providers: readonly CloudProviderInfo[],
  type: CloudModelType,
  opts: { requireVideoApi?: boolean; requireMusicApi?: boolean } = {},
): CloudProviderInfo[] {
  return providers.filter((p) => {
    if (!p.enabled) return false;
    if (opts.requireVideoApi && !p.videoApi) return false;
    if (opts.requireMusicApi && !p.musicApi) return false;
    return providerModelsOfType(p, type).length > 0;
  });
}

/** 服务商地址 + 密钥是否齐备（本机端点允许空 Key）。 */
export function providerConfigured(provider: Pick<CloudProviderInfo, "baseUrl" | "apiKey">): boolean {
  const base = provider.baseUrl.trim();
  if (!base) return false;
  const key = provider.apiKey.trim();
  return key !== "" || isLocalBaseUrl(base);
}

/** 自定义服务商的徽章底色：按名称散列到一组低调的品牌色。 */
const CUSTOM_COLORS = ["#6366f1", "#0ea5e9", "#f59e0b", "#10b981", "#f43f5e", "#8b5cf6", "#14b8a6"];
export function providerColor(id: string, name: string, isCustom: boolean): string {
  if (!isCustom) {
    const preset = getPreset(id);
    if (preset) return preset.color;
  }
  let h = 0;
  const key = name || id;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return CUSTOM_COLORS[h % CUSTOM_COLORS.length]!;
}
