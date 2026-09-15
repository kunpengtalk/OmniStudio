/**
 * 用量统计的共享形状：主进程往里写，设置页「数据 → 使用统计」读出来展示。
 *
 * 记录粒度是**一次上游请求** —— 对话的一次回答、Agent 的每一步、网关转发的一个请求、
 * 一次生图。聚合维度只有两个：**模型**与**厂商**（本地是推理引擎名，云端是服务商名），
 * 外加「渠道」（谁发起的）。这三个字段都在记录时由调用方给出 —— 事后从模型名反推
 * 厂商只能靠猜（同一个 `gpt-4o` 可能来自好几家聚合站），所以宁可调用方多传一个字段。
 *
 * 口径说明：
 * - **TTS / ASR 不在这里**：它们按时长计费，没有 token 口径。
 * - **生图 / 生视频多数接口不回 token，但照样记一行**（`requests` 计数、token 为 0；
 *   接口回了 usage 就照实填）—— 「我这个月生了几百张图」本身就是用户要看的用量。
 * - **向量化（embedding / rerank）也不在这里**：`embeddings.ts` 刻意保持零主进程
 *   依赖（`omi` CLI 在应用没启动时直接调它），把用量带出来要改 6 处调用签名，
 *   而这些调用通常是本地的、免费的。留给以后有需要时再补。
 */

/** 调用是从哪个入口发起的。界面上的「渠道」一栏按它分类。 */
export type UsageChannel =
  /** 应用内对话（含语音通话的回合、右键「翻译这条消息」）。 */
  | "chat"
  /** 内置 Agent 主循环、子智能体、上下文压缩摘要。 */
  | "agent"
  /** 本地网关：外部 agent（Claude Code / Codex / Pi…）经它转发到模型。 */
  | "gateway"
  /** 生图 / 修图。 */
  | "image"
  /** 生视频。 */
  | "video"
  /** 文档 OCR 的 VLM 视觉理解。 */
  | "ocr"
  /** 翻译页的整段翻译。 */
  | "translate";

export const USAGE_CHANNELS: readonly UsageChannel[] = [
  "chat",
  "agent",
  "gateway",
  "image",
  "video",
  "ocr",
  "translate",
];

/** 上游类别：本地推理服务器，还是云端服务商。 */
export type UsageUpstream = "local" | "cloud";

/** 一次调用的用量快照（写库前的形状）。 */
export type UsageRecordInput = {
  channel: UsageChannel;
  upstream: UsageUpstream;
  /**
   * 厂商展示名：本地是引擎名（llama.cpp / vLLM / SGLang / MLX），
   * 云端是服务商名（配置被删时退回地址主机名）。空串按「未知」归类。
   */
  provider: string;
  /** 模型展示名（`getChatModelLabel()` 那一套，不带 MLX 的绝对路径）。 */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** 命中缓存的输入 tokens（是 input 的子集，不重复累加）。 */
  cachedTokens?: number;
  /** 思考 tokens（推理模型才有，已含在 output 里）。 */
  reasoningTokens?: number;
  /** 本次记录代表的请求数，默认 1。 */
  requests?: number;
  /** 上游没回 usage、token 是本地估算时置 true。 */
  estimated?: boolean;
};

/** 热力图 / 趋势图的一天。 */
export type UsageDayBucket = {
  /** 本地时区下的 YYYY-MM-DD。 */
  day: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  requests: number;
};

/** 一个分组（模型 / 厂商 / 渠道）在所选区间内的合计。 */
export type UsageBreakdownRow = {
  key: string;
  label: string;
  /** 补充说明：模型行的「来自哪些厂商」、渠道行的入口描述。 */
  detail?: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cachedTokens: number;
  requests: number;
  /** 占筛选区间的 token 比例（0–1）；区间内没有任何 token 时为 0。 */
  share: number;
  /** 最后一次使用的时刻（毫秒）；没有记录时为 0。 */
  lastUsedAt: number;
};

export type UsageTrendSeries = {
  key: string;
  label: string;
  /** 与 `trend.days` 一一对应。 */
  values: number[];
  tokens: number;
};

export type UsageSummary = {
  /** 累计（全部历史）输入 / 输出 tokens。 */
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  requests: number;
  /** 今天（本地时区）的 tokens 与请求数。 */
  todayTokens: number;
  todayRequests: number;
  /** 单日最高的那一天。 */
  peakDay: UsageDayBucket | null;
  /** 有记录的天数。 */
  activeDays: number;
  /** 从今天（今天还没有记录时从昨天）往前数的连续活跃天数。 */
  currentStreak: number;
  /** 历史上最长的连续活跃天数。 */
  longestStreak: number;
  /** 最早的一天（YYYY-MM-DD）。 */
  firstDay: string | null;
  /** 用过的模型 / 厂商种数。 */
  modelCount: number;
  providerCount: number;
  /** token 数为估算值（上游没回 usage）的记录占比，0–1。 */
  estimatedShare: number;
};

export type UsageStats = {
  generatedAt: number;
  /** 明细区间（趋势 / 分组）的天数。 */
  rangeDays: number;
  /** 累计口径的概要，不随区间变化。 */
  summary: UsageSummary;
  /** 区间内的合计。 */
  range: { days: string[]; tokens: number; requests: number };
  /** 热力图数据（近一年，含今天）。 */
  activity: UsageDayBucket[];
  trend: { days: string[]; series: UsageTrendSeries[]; other: UsageTrendSeries | null };
  models: UsageBreakdownRow[];
  providers: UsageBreakdownRow[];
  channels: UsageBreakdownRow[];
};

/** 明细区间的可选值（天）。 */
export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRangeDays = (typeof USAGE_RANGES)[number];

/** 热力图窗口：近一年（GitHub 那种 53 列 × 7 行的网格）。两端都要用，放这里。 */
export const ACTIVITY_DAYS = 371;
