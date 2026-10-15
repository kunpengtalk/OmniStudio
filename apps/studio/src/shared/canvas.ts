/**
 * 无限画布（应用栏 `canvas`）的共享类型与常量。
 *
 * 放在 shared 是因为两边的形状必须一致：webview 是画布状态的唯一作者
 * （节点 / 连线 / 视口整份 JSON 保存），主进程只做校验与落库；文本生成
 * 的流式推送（`canvasTextChunk`）也按这里的 nodeId / kind 对上号。
 *
 * 语义模型：节点是生成器（提示词 + 模型选择），连线把上游节点变成下游
 * 生成的上下文 —— 文本连线并入提示词，图片连线成为生图参考图 / 图生视频
 * 首帧。
 */

export type CanvasNodeKind = "text" | "image" | "video" | "music" | "audio";

export type CanvasNodeStatus = "idle" | "loading" | "success" | "error";

/** 节点上选的模型：本地（已启动实例 / MLX 权重 / ComfyUI）或云端（厂商行 + 模型 id）。 */
export type CanvasModelChoice = {
  source: "local" | "cloud";
  /**
   * 该候选走哪条生成后端。图片：api（云端）/ mlx / comfyui；视频：cloud / comfyui；
   * 音乐：cloud。节点执行按它分派，与各功能页 backend 的取值保持一致。
   */
  backend?: "api" | "mlx" | "comfyui" | "cloud";
  /** cloud：云厂商行 id；local 文本生成：已启动实例 id。 */
  providerId?: string;
  /** 模型 id（云端）或权重路径 / checkpoint 名（本地）。 */
  model: string;
};

export type CanvasNodeData = {
  id: string;
  kind: CanvasNodeKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 提示词 / TTS 文本 / 音乐风格描述。 */
  prompt: string;
  model?: CanvasModelChoice;
  /** 音频节点的音色（跟随厂商时可为空）。 */
  voice?: string;
  /** 音乐节点：纯器乐（与歌词互斥，上游文本此时不并入）。 */
  instrumental?: boolean;
  status: CanvasNodeStatus;
  error?: string;
  /** 文本节点的结果（流式写入）。 */
  resultText?: string;
  /** 生成产物在 images 根目录下的相对 ref（gen/xxx.png、videos/xxx.mp4、music|audio/xxx.mp3）。 */
  resultRef?: string;
  /** 轮询中的记录 id（视频 / 音乐这类异步任务）。 */
  recordId?: number;
  updatedAt?: number;

  // ---- 生图参数（与生图页同一套档位；见 mainview/app/canvas/node-params.tsx） ----
  /** 出图分辨率（区别于节点框的 width/height —— 那是画布上的外框尺寸）。 */
  imgWidth?: number;
  imgHeight?: number;
  count?: number;
  steps?: number;
  seed?: number;
  negativePrompt?: string;
  /** MLX 量化位数：0 关 / 8 / 6 / 4。 */
  quantize?: number;
  /** 本节点自己的参考图（AI 修图，images 内 ref）；连线来的上游图片优先于它。 */
  refImageRef?: string;

  // ---- 生视频参数 ----
  /** 时长（秒）与画面比例。 */
  duration?: number;
  ratio?: string;
  resolution?: string;
  watermark?: boolean;
  cfg?: number;
  /** 首帧（图生视频，images 内 ref）；连线来的上游图片优先于它。 */
  firstFrameRef?: string;

  // ---- 生音乐参数 ----
  musicTask?: "text_to_music" | "music_cover" | "vocal_to_music";
  lyrics?: string;
  /** 参考歌曲 / 干声（images 内 ref，翻唱与干声配乐必填）。 */
  refAudioRef?: string;
  responseFormat?: string;
  sampleRate?: number;

  // ---- 语音（TTS）参数 ----
  /** 合成来源：Edge 免费在线 / OpenAI 兼容（云端厂商或本地兼容服务）/ 本地 audio.cpp。 */
  ttsSource?: "edge" | "compat" | "local";
  /** 音色克隆参考音频（images 内 ref，支持参考音频的厂商用它换音色）。 */
  referenceAudioRef?: string;
  /** 本地引擎的情感 / 指令 / 语言。 */
  emotion?: string;
  instruct?: string;
  language?: string;
  /** 本地引擎的模型 id（listTtsLocalModels 的 id）。 */
  localModelId?: string;
};

export type CanvasConnectionData = {
  id: string;
  /** 上游（素材 / 上下文）→ 下游（生成节点）。 */
  fromId: string;
  toId: string;
};

export type CanvasViewport = { x: number; y: number; k: number };

/** 画布文档的完整状态（保存 / 读取的 JSON 载荷）。 */
export type CanvasDocPayload = {
  nodes: CanvasNodeData[];
  connections: CanvasConnectionData[];
  viewport: CanvasViewport;
};

export type CanvasDocSummary = {
  id: number;
  title: string;
  nodeCount: number;
  updatedAt: number;
};

/** 文本生成的流式推送（bun → webview）。 */
export type CanvasTextChunkEvent = {
  nodeId: string;
  docId: number;
  delta: string;
  done: boolean;
  error?: string;
};

/** 文本节点要并入提示词的上游上下文（主进程拼 prompt 用）。 */
export type CanvasTextContextItem = { nodeId: string; title: string; text: string };

/** 默认视口：原点居中、100%。 */
export const CANVAS_DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, k: 1 };

/** 视口缩放范围上下限。 */
export const CANVAS_SCALE_MIN = 0.1;
export const CANVAS_SCALE_MAX = 2;

/** 节点默认尺寸与拉伸下限（媒体节点要放得下预览图）。 */
export const CANVAS_NODE_DEFAULTS: Record<
  CanvasNodeKind,
  { width: number; height: number; min: { width: number; height: number } }
> = {
  text: { width: 340, height: 300, min: { width: 240, height: 160 } },
  image: { width: 380, height: 480, min: { width: 260, height: 260 } },
  video: { width: 420, height: 460, min: { width: 300, height: 260 } },
  music: { width: 380, height: 460, min: { width: 280, height: 240 } },
  audio: { width: 360, height: 380, min: { width: 260, height: 180 } },
};

/** 单份画布的规模上限：保存时截断，异常载荷不至于把主进程拖垮。 */
export const CANVAS_LIMITS = {
  nodes: 400,
  connections: 1600,
  promptChars: 20_000,
  resultTextChars: 200_000,
  refChars: 400,
  titleChars: 120,
  /** 歌词 / 负向提示词这类多行文本的上限。 */
  textChars: 4_000,
  /** 本地引擎的语言 / 情感 / 指令这类短标签。 */
  tagChars: 120,
};

/**
 * 相对 ref 的合法性：只允许 `分类名/文件名` 一层目录、无 `..`、无反斜杠。
 * 这是渲染 URL（chatImageUrl）与转交生成器（referenceImageRef / firstFrameRef）前
 * 的第一道闸，真正的路径解析仍以服务端 resolve 为准。
 */
export function isCanvasMediaRef(ref: unknown): ref is string {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > CANVAS_LIMITS.refChars) return false;
  if (ref.includes("\\") || ref.includes("..") || ref.startsWith("/")) return false;
  return /^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/.test(ref);
}
