/**
 * 对话 / Agent 的上下文窗口解析。
 *
 * 为什么要单独一个模块：`SERVER_CTX_SIZE` 是 **llama.cpp 本地引擎的 KV 旋钮**
 * （设置页在「本地模型 → 启动参数」，改完重启推理服务器才生效），但历史上
 * 云端模式也读它 —— 没设置时就回落 8192。云端模型的真实窗口动辄 128k+，
 * 按 8192 算会让 pi-ai 的 `clampMaxTokensToContext` 把 `max_tokens` 钳到下限 1：
 * 模型只被允许生成 1 个 token 就 `finish_reason=length`，界面上表现为
 * 「模型本轮没有给出正文，也没有再调用工具」的空回合，怎么提醒都一样空
 * （2026-09 MiniMax-M3 云端空回合事故，根因即此）。
 *
 * 规则：
 * - **本地模式**：沿用 `SERVER_CTX_SIZE || 8192`（它就是为本地引擎准备的）；
 * - **云端模式**：模型 id 自带窗口尺寸的按 id 认（`moonshot-v1-8k`、
 *   `ernie-4.5-turbo-128k` 这类），否则回落保守的 128k。云端**不读**
 *   `SERVER_CTX_SIZE` —— 那个旋钮的语义是本地 KV 分配，误伤只会重演上面的事故。
 */
import { getSetting } from "./db/settings";

/** 云端兜底窗口：现代云端对话模型最小也有 128k（个别 64k 的厂商高估它只会换来
 * 一个罕见且响亮的「上下文超限」400，而低估它会把 max_tokens 钳没、每次都空回合）。 */
const CLOUD_CTX_FALLBACK = 131_072;

/** 本地默认窗口（与旧版 `Number(SERVER_CTX_SIZE) || 8192` 保持一致）。 */
const LOCAL_CTX_DEFAULT = 8192;

/**
 * 从模型 id 里解析它自带的窗口尺寸后缀：`-8k` / `-32k` / `-128k` / `-1m`。
 * 只认独立段（`-8k-`、`-8k_` 或结尾），避免把 `glm-4-flash-250414` 里的
 * 数字误当尺寸。解析不出来返回 undefined，交给兜底。
 */
export function contextWindowFromModelId(id: string): number | undefined {
  const match = /-(\d{1,4})(k|m)(?:[-_.]|$)/i.exec(id);
  if (!match) return undefined;
  const size = Number(match[1]);
  const unit = match[2];
  if (!unit || !Number.isFinite(size) || size <= 0) return undefined;
  const scale = unit.toLowerCase() === "m" ? 1_048_576 : 1024;
  const tokens = size * scale;
  // 防御：异常大的解析结果（比如恶意 / 手滑的 id）不给出去。
  return tokens >= 1024 && tokens <= 16_777_216 ? tokens : undefined;
}

/**
 * 当前对话 / Agent 该按多大的上下文窗口算账（压缩预算、占用展示、max_tokens 钳制）。
 * 语义见模块注释：本地看引擎旋钮，云端看模型 id / 兜底，二者不串门。
 */
export function chatContextWindow(): number {
  if (getSetting("SERVER_MODE") === "local") {
    return Number(getSetting("SERVER_CTX_SIZE")) || LOCAL_CTX_DEFAULT;
  }
  const modelId = getSetting("VLLM_MODEL_NAME") ?? "";
  return contextWindowFromModelId(modelId) ?? CLOUD_CTX_FALLBACK;
}
