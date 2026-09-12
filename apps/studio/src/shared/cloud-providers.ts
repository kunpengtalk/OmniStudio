/**
 * 模型云服务商：共享预设目录与数据类型（bun 服务与 mainview UI 共用）。
 *
 * 预设只提供元信息（名称 / 厂商 / Base URL / 常见模型 / 品牌色）；
 * 用户添加的服务商落在 `cloud_providers` 表里，预设 id 即表主键。
 */

/** 云服务商的模型条目：id 必填，name/group/remark 可选（兼容旧版纯 id 列表）。 */
export type CloudModelEntry = { id: string; name?: string; group?: string; remark?: string };

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
  /** 简短备注（免费额度 / 需要额外操作等） */
  note?: string;
  /** 品牌主色（#rrggbb），列表徽章底色。 */
  color: string;
};

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
    models: ["doubao-seed-1-6-250618", "doubao-1-5-pro-32k-250115", "doubao-1-5-lite-32k-250115"],
    note: "需在火山方舟开通并创建接入点，填 Endpoint ID 后缀",
    color: "#14b8a6",
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
    models: ["MiniMax-M1", "MiniMax-Text-01"],
    color: "#e11d48",
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
    models: ["step-1-8k", "step-1-flash"],
    color: "#a855f7",
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

/** RPC 返回的服务商行（cloud_providers 表的脱壳）。 */
export type CloudProviderInfo = {
  id: string;
  name: string;
  vendor: string;
  baseUrl: string;
  apiKey: string;
  models: CloudModelEntry[];
  createdAt: number;
  updatedAt: number;
};

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
          };
        }
        return null;
      })
      .filter((x): x is CloudModelEntry => x !== null);
  } catch {
    return [];
  }
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
