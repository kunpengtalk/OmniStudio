import { eq } from "drizzle-orm";
import type { InferenceEngine } from "../../shared/modelscope";
import { ENGINE_IDS, ENGINE_SPECS, EMBEDDING_PORT_BASE } from "../../shared/engines";
import { db } from "./index";
import { settings as settingsTable } from "./schema";
import { DEFAULT_ASR_MODEL_FILE } from "../../shared/modelscope";
import { DEFAULT_INFERENCE_PORT } from "../../shared/server-info";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secrets";

export type SettingsKey =
  | "SETUP_COMPLETE"
  | "VLLM_API_BASE"
  | "VLLM_API_KEY"
  | "VLLM_MODEL_NAME"
  | "VLLM_MODEL_PROFILE"
  | "SERVER_MODE"
  | "SERVER_HOST"
  | "SERVER_PORT"
  | "VLLM_PORT"
  | "SGLANG_PORT"
  | "SERVER_EXTRA_ARGS"
  | "VLLM_EXTRA_ARGS"
  | "SGLANG_EXTRA_ARGS"
  | "AUTO_START_SERVER"
  | "MODEL_DIRS"
  | "UPDATE_CHANNEL"
  | "AUTO_UPDATE"
  | "FAVORITE_MODELS"
  | "LAUNCHER_CLAUDE_MODE"
  | "LAUNCHER_CLAUDE_OPUS"
  | "LAUNCHER_CLAUDE_SONNET"
  | "LAUNCHER_CLAUDE_HAIKU"
  | "LAUNCHER_CODEX_MODEL"
  | "LAUNCHER_OPENCODE_MODEL"
  | "LAUNCHER_OPENCLAW_MODEL"
  | "LAUNCHER_HERMES_MODEL"
  | "LAUNCHER_PI_MODEL"
  | "LAUNCHER_COPILOT_MODEL"
  | "SERVER_CTX_SIZE"
  | "SERVER_IMAGE_MAX_TOKENS"
  | "SERVER_BATCH_SIZE"
  | "SERVER_UBATCH_SIZE"
  | "SERVER_PARALLEL"
  | "SERVER_TEMP"
  | "SERVER_TOP_P"
  | "SERVER_GPU_LAYERS"
  | "SERVER_CACHE_TYPE_K"
  | "SERVER_CACHE_TYPE_V"
  | "CUSTOM_HF_MODEL"
  | "LOCAL_MODEL_PATH"
  | "LOCAL_MODEL_NAME"
  | "CHAT_MODEL"
  | "UI_LANG"
  | "UI_THEME"
  // 网络代理（设置 → 偏好 → 通用）：system = 跟随系统 / 环境变量，custom = 手填地址，
  // none = 强制直连。生效范围见 bun/proxy.ts —— 云端模型、模型/引擎下载、联网检索都走它，
  // 回环与（默认的）局域网地址直连。
  | "PROXY_MODE"
  | "PROXY_URL"
  /** 「允许访问本地网络地址」：开（默认）= 局域网直连，关 = 连局域网也走代理。 */
  | "PROXY_ALLOW_LOCAL_NETWORK"
  | "MAX_VLLM_RETRIES"
  | "MAX_VLLM_FAILURE_RETRIES"
  | "PAGE_CONCURRENCY"
  | "INFERENCE_ENGINE"
  | "MLX_PORT"
  | "MLX_EXTRA_ARGS"
  | "MLX_MODEL"
  | "MLX_CACHE_SIZE_GB"
  | "MLX_HF_ENDPOINT"
  | "VLLM_MAX_MODEL_LEN"
  | "VLLM_TENSOR_PARALLEL_SIZE"
  | "VLLM_GPU_MEMORY_UTILIZATION"
  | "VLLM_ENFORCE_EAGER"
  | "VLLM_DTYPE"
  | "SGLANG_CONTEXT_LENGTH"
  | "SGLANG_TP_SIZE"
  | "SGLANG_MEM_FRACTION_STATIC"
  | "SGLANG_CHUNKED_PREFILL_SIZE"
  | "TTS_MODEL"
  | "ASR_MODEL"
  | "ASR_LANG"
  | "TTS_VOICE"
  | "VOICE_CLONES"
  | "TTS_HTTP_BASE"
  | "TTS_MODELS_DIR"
  | "TTS_ENABLED_MODELS"
  | "TTS_EDGE_VOICE"
  | "TTS_PROVIDER"
  | "TTS_PROVIDER_BASE"
  | "TTS_PROVIDER_API_KEY"
  | "TTS_PROVIDER_MODEL"
  | "TTS_LOCAL_ENGINE"
  | "TTS_LOCAL_MODEL"
  | "ASR_PORT"
  | "ASR_ENGINE"
  | "ASR_AUDIOCPP_MODEL"
  | "ASR_PROVIDER_BASE"
  | "ASR_PROVIDER_API_KEY"
  | "ASR_PROVIDER_MODEL"
  | "OCR_ENGINE"
  | "OCR_TESSERACT_MODEL"
  | "OCR_PSM"
  | "OCR_VLM_SOURCE"
  | "OCR_PROVIDER_BASE"
  | "OCR_PROVIDER_API_KEY"
  | "OCR_PROVIDER_MODEL"
  | "PPOCR_MODEL_SIZE"
  | "IMG_BACKEND"
  | "IMG_API_BASE"
  | "IMG_API_KEY"
  | "IMG_MODEL"
  | "IMG_COMFY_BASE"
  | "IMG_MLX_IDLE_MINUTES"
  // AI 视频生成（video-gen.ts）
  | "VIDEO_BACKEND"
  | "VIDEO_PROVIDER_ID"
  | "VIDEO_MODEL"
  | "VIDEO_MINIMAX_BASE"
  | "VIDEO_MINIMAX_API_KEY"
  | "VIDEO_MINIMAX_MODEL"
  | "VIDEO_SEEDANCE_BASE"
  | "VIDEO_SEEDANCE_API_KEY"
  | "VIDEO_SEEDANCE_MODEL"
  | "VIDEO_COMFY_BASE"
  | "VIDEO_COMFY_CKPT"
  | "VIDEO_COMFY_CLIP"
  | "VIDEO_COMFY_VAE"
  // AI 音乐生成（music-gen.ts）
  | "MUSIC_BACKEND"
  | "MUSIC_PROVIDER_ID"
  | "MUSIC_MODEL"
  | "MUSIC_LOCAL_API"
  | "MUSIC_LOCAL_BASE"
  | "MUSIC_LOCAL_MODEL"
  | "MODEL_DOWNLOADS"
  | "GATEWAY_ENABLED"
  | "GATEWAY_HOST"
  | "GATEWAY_PORT"
  | "GATEWAY_API_KEY"
  /** 内网穿透：把上面的网关经 Cloudflare 隧道暴露到公网（见 bun/tunnel.ts）。 */
  | "TUNNEL_ENABLED"
  /** quick = 免账号的临时隧道（域名随机、重启即变）；token = 命名隧道（自己的域名）。 */
  | "TUNNEL_MODE"
  /** 命名隧道的 Token（加密存储）与公网域名（Host 白名单 + 拼接访问地址）。 */
  | "TUNNEL_TOKEN"
  | "TUNNEL_PUBLIC_HOST"
  /** 出站协议：auto / http2（UDP 7844 被封时用）/ quic。 */
  | "TUNNEL_PROTOCOL"
  | "WEB_SEARCH_ENABLED"
  | "WEB_SEARCH_PROVIDER"
  | "WEB_SEARCH_API_KEY"
  | "WEB_SEARCH_MAX_RESULTS"
  /** 记忆总开关：Agent 获得记忆工具，置顶记忆注入系统提示。 */
  | "MEMORY_ENABLED"
  | "MEMORY_REVIEW_MODE"
  | "MEMORY_EMBEDDING_MODEL"
  | "MEMORY_EMBEDDING_BASE"
  | "MEMORY_EMBEDDING_API_KEY"
  | "MEMORY_SCOPE_ENABLED"
  /**
   * 小应用「笔记」是否对 Agent 可见：开启时每条笔记沉淀一条索引级记忆，
   * 且 Agent 拿到 note_list / note_search / note_read 三个只读工具（0=只是用户的私人笔记）。
   */
  | "NOTES_AGENT_ACCESS"
  | "TRANSLATION_ENGINE"
  | "AGENT_WORKSPACE"
  | "AGENT_WORKSPACES"
  | "AGENT_MODE"
  /**
   * 推理等级：off（默认，请求里不带任何推理参数）/ minimal / low / medium / high / xhigh / max。
   *
   * 默认关是有意的：能不能吃 reasoning 由模型与服务端共同决定，猜错会被 400。
   * 用户显式选了等级 = 他知道自己的模型支持，才把 `reasoning` 打开随请求带出去。
   */
  | "AGENT_THINKING_LEVEL"
  | "AGENT_MAX_STEPS"
  /** 子智能体（task 工具）的步数上限：多步调研要给它足够回合，但要防止失控。 */
  | "AGENT_SUBAGENT_MAX_STEPS"
  | "AGENT_ALLOW_SHELL"
  /** 工具授权模式：smart（只拦危险动作）/ manual（全部询问）/ auto（全部放行）/ strict（全部拒绝）。 */
  | "AGENT_APPROVAL_MODE"
  /** 用户自定义权限规则（JSON 数组：[{permission, pattern, action}]）。 */
  | "AGENT_PERMISSION_RULES"
  /** 已授权的工作区之外目录（JSON 字符串数组）。 */
  | "AGENT_AUTHORIZED_FOLDERS"
  /** 项目指令（AGENTS.md）开关与体积上限。 */
  | "AGENT_PROJECT_DOC"
  | "AGENT_PROJECT_DOC_MAX_BYTES"
  /**
   * 上下文压缩方式：summary（默认，顶到阈值时先让模型把旧历史摘成摘要）/
   * trim（只用确定性裁剪，不额外调模型）。摘要失败 / 超时都会自动退回裁剪。
   */
  | "AGENT_COMPACT_MODE"
  /**
   * 自动重试次数（默认 2，0 = 关掉全部自愈）：传输层的瞬时错误重试
   * （408/409/429/5xx 与网络中断）、整轮失败后的重发、以及「空回合」提醒
   * 共用这一个旋钮 —— 代价都是"多花一次推理"，不该拆成三个要理解的开关。
   */
  | "AGENT_RETRY_MAX"
  /** 把已安装的 Skills 列进系统提示，让 Agent 按需读取（默认开）。 */
  | "AGENT_SKILLS_PROMPT"
  /** Goal 模式自动续跑的轮数上限（默认 6）：自主跑下去的兜底刹车。 */
  | "AGENT_GOAL_MAX_CONTINUATIONS"
  /** Goal 模式的 token 预算上限（0 / 空 = 不限制；只计 input+output，不计缓存命中）。 */
  | "AGENT_GOAL_TOKEN_BUDGET"
  /** 看图工具（view_image）开关：auto / on / off。 */
  | "AGENT_VISION_TOOL"
  /** 回合快照（影子 git 仓库，支持「撤销本轮」）开关。 */
  | "AGENT_SNAPSHOTS"
  /** 影子仓库自动整理的体积阈值（MB，默认 256）。 */
  | "AGENT_SNAPSHOT_GC_MB"
  /** 影子仓库自动整理的轮数阈值（默认与索引上限一致：200）。 */
  | "AGENT_SNAPSHOT_GC_TURNS"
  /** 命令沙箱模式：off（默认）/ workspace-write（写只能落在工作区与临时目录）。 */
  | "AGENT_SANDBOX_MODE"
  /** 沙箱内是否允许联网（默认允许；关掉后 curl / 装依赖都会被拦）。 */
  | "AGENT_SANDBOX_NETWORK"
  /** 后端偏好：auto（默认，Linux 上 bwrap 优先、Landlock 兜底）/ bwrap / landlock。 */
  | "AGENT_SANDBOX_BACKEND"
  /** 外部通知回调命令（对齐 Codex 的 notify）：事件 JSON 作为最后一个参数追加。 */
  | "AGENT_NOTIFY_COMMAND"
  /** 生命周期 hooks（对齐 Codex 的 SessionStart / UserPromptSubmit），JSON 数组。 */
  | "AGENT_HOOKS"
  | "VOICE_CALL_PROVIDER"
  /** 实时通话（DashScope Realtime）选中的云厂商：API Key 从厂商行取，页面不再手填。 */
  | "VOICE_CALL_REALTIME_PROVIDER_ID"
  | "VOICE_CALL_REALTIME_API_KEY"
  | "VOICE_CALL_REALTIME_BASE_URL"
  | "VOICE_CALL_REALTIME_MODEL"
  | "VOICE_CALL_REALTIME_VOICE"
  // Skills 管理（参照 skills-manager 移植）
  | "SKILLS_CENTRAL_PATH"
  | "SKILLS_SYNC_MODE"
  | "SKILLS_TOOLS_DISABLED"
  | "SKILLS_TOOL_PATH_OVERRIDES"
  | "SKILLS_CUSTOM_TOOLS"
  | "SKILLS_ACTIVE_PRESET"
  | "SKILLS_AUTO_BACKUP"
  | "SKILLS_GIT_REMOTE"
  | "SKILLS_GIT_PAT"
  | "BACKUP_REMOTE_KIND"
  | "BACKUP_REMOTE_ENABLED"
  | "BACKUP_REMOTE_ENDPOINT"
  | "BACKUP_REMOTE_BUCKET"
  | "BACKUP_REMOTE_REGION"
  | "BACKUP_REMOTE_ACCESS_KEY"
  | "BACKUP_REMOTE_SECRET_KEY"
  | "BACKUP_REMOTE_PREFIX"
  | "BACKUP_REMOTE_PATH_STYLE"
  | "BACKUP_REMOTE_AUTO_UPLOAD"
  | "BACKUP_REMOTE_DELETE_LOCAL"
  // 模型云服务（cloud_providers 表的兼容槽位：激活行写回，网关 / CLI 消费）
  | "CLOUD_PROVIDER"
  | "CLOUD_MODELS"
  | "CUSTOM_PROVIDERS"
  // 各功能页选中的云服务商（只存 id：地址 / 密钥从 cloud_providers 表取，
  // 功能页不再让用户重填连接信息）+ 旧配置搬家的一次性标记
  | "IMG_PROVIDER_ID"
  | "TTS_PROVIDER_ID"
  | "ASR_PROVIDER_ID"
  | "OCR_PROVIDER_ID"
  | "CLOUD_APP_PROVIDERS_MIGRATED"
  // 已启动模型注册表：当前活动实例 id（本地模式请求的目标），见 bun/model-servers.ts
  | "SERVED_ACTIVE_ID"
  // 嵌入服务（llama.cpp `--embeddings`）的端口段基址与池化方式；嵌入实例不占聊天端口段，
  // 也不参与聊天活动状态（见 shared/engines.ts 的 EMBEDDING_PORT_BASE）。
  | "EMBEDDING_PORT"
  | "EMBEDDING_POOLING"
  // 全局默认嵌入配置（设置 → 默认模型 → 向量嵌入）。**只在写入时快照**：
  // 新建 KB 预填进 KB 行、KB 设置页「启用向量检索」按入重嵌，共享记忆在解析时兜底。
  // 唯一读取点见 bun/embeddings.ts 的 globalEmbeddingDefaults()。
  | "EMBEDDING_MODEL"
  | "EMBEDDING_BASE"
  | "EMBEDDING_API_KEY";

const DEFAULTS: Record<SettingsKey, string> = {
  SETUP_COMPLETE: "",
  VLLM_API_BASE: `http://localhost:${DEFAULT_INFERENCE_PORT}/v1`,
  VLLM_API_KEY: "EMPTY",
  VLLM_MODEL_NAME: "",
  VLLM_MODEL_PROFILE: "chandra",
  SERVER_MODE: "local",
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: DEFAULT_INFERENCE_PORT,
  VLLM_PORT: "8081",
  SGLANG_PORT: "8082",
  SERVER_EXTRA_ARGS: "",
  VLLM_EXTRA_ARGS: "",
  SGLANG_EXTRA_ARGS: "",
  AUTO_START_SERVER: "1",
  MODEL_DIRS: "",
  UPDATE_CHANNEL: "stable",
  // 启动时自动检查并下载新 release（"0" 关闭，仅手动检查）。
  AUTO_UPDATE: "1",
  FAVORITE_MODELS: "[]",
  LAUNCHER_CLAUDE_MODE: "local",
  LAUNCHER_CLAUDE_OPUS: "",
  LAUNCHER_CLAUDE_SONNET: "",
  LAUNCHER_CLAUDE_HAIKU: "",
  LAUNCHER_CODEX_MODEL: "",
  LAUNCHER_OPENCODE_MODEL: "",
  LAUNCHER_OPENCLAW_MODEL: "",
  LAUNCHER_HERMES_MODEL: "",
  LAUNCHER_PI_MODEL: "",
  LAUNCHER_COPILOT_MODEL: "",
  SERVER_CTX_SIZE: "8192",
  SERVER_IMAGE_MAX_TOKENS: "2048",
  SERVER_BATCH_SIZE: "256",
  SERVER_UBATCH_SIZE: "64",
  SERVER_PARALLEL: "1",
  SERVER_TEMP: "0.2",
  SERVER_TOP_P: "0.9",
  SERVER_GPU_LAYERS: "-1",
  SERVER_CACHE_TYPE_K: "q8_0",
  SERVER_CACHE_TYPE_V: "q8_0",
  CUSTOM_HF_MODEL: "",
  LOCAL_MODEL_PATH: "",
  LOCAL_MODEL_NAME: "",
  CHAT_MODEL: "",
  UI_LANG: "zh",
  /** 界面主题：system / light / dark，前端据此切换 <html> 的 .dark 类。 */
  UI_THEME: "system",
  // 默认跟随系统：用户 shell 里的 HTTP(S)_PROXY 与 macOS / Windows 的系统代理本来就在生效，
  // 默认值保持这个行为；没有配代理时解析结果为空 = 直连，与以前完全一致。
  PROXY_MODE: "system",
  PROXY_URL: "",
  PROXY_ALLOW_LOCAL_NETWORK: "1",
  MAX_VLLM_RETRIES: "6",
  MAX_VLLM_FAILURE_RETRIES: "0",
  PAGE_CONCURRENCY: "3",
  INFERENCE_ENGINE: "llama.cpp",
  MLX_PORT: "18010",
  MLX_EXTRA_ARGS: "",
  // MLX 引擎部署的模型（HF repo id 或本地目录）。**必须留空**：这个键是「用户显式部署」
  // 的标记，运行时优先用它 —— 一旦给默认值（曾默认是 DeepSeek V4.1 Flash 预设），
  // 用户在模型库里选的本地 MLX 目录就会被预设盖住：启动时拿着预设 repo 去 HuggingFace
  // 下载，下载不到就报 LocalEntryNotFoundError（「启动 / 加载都有问题」就是这么来的）。
  // 预设仍在 MLX 引擎面板与引导流程里一键部署，那两处会显式写入本键。
  MLX_MODEL: "",
  MLX_CACHE_SIZE_GB: "8",
  // 国内环境优先走 hf-mirror，置空则使用 HuggingFace 官方。
  MLX_HF_ENDPOINT: "https://hf-mirror.com",
  VLLM_MAX_MODEL_LEN: "8192",
  VLLM_TENSOR_PARALLEL_SIZE: "1",
  VLLM_GPU_MEMORY_UTILIZATION: "0.9",
  VLLM_ENFORCE_EAGER: "0",
  VLLM_DTYPE: "auto",
  SGLANG_CONTEXT_LENGTH: "8192",
  SGLANG_TP_SIZE: "1",
  SGLANG_MEM_FRACTION_STATIC: "0.88",
  SGLANG_CHUNKED_PREFILL_SIZE: "",
  TTS_MODEL: "",
  ASR_MODEL: DEFAULT_ASR_MODEL_FILE,
  ASR_LANG: "zh",
  TTS_VOICE: "alloy",
  VOICE_CLONES: "[]",
  TTS_HTTP_BASE: "",
  TTS_MODELS_DIR: "",
  TTS_ENABLED_MODELS: "[]",
  TTS_EDGE_VOICE: "zh-CN-XiaoxiaoNeural",
  TTS_PROVIDER: "",
  // 默认服务地址为线上 OmniLabs 多模态平台（统一接入 TTS / ASR）。
  // 与 mainview/app/voice-provider-presets.ts 的 DEFAULT_VOICE_BASE_URL 保持一致。
  TTS_PROVIDER_BASE: "https://omnilabs.vibeadmin.cn/v1",
  TTS_PROVIDER_API_KEY: "",
  TTS_PROVIDER_MODEL: "",
  TTS_LOCAL_ENGINE: "",
  TTS_LOCAL_MODEL: "",
  ASR_PORT: "18081",
  ASR_ENGINE: "whisper",
  ASR_AUDIOCPP_MODEL: "",
  ASR_PROVIDER_BASE: "https://omnilabs.vibeadmin.cn/v1",
  ASR_PROVIDER_API_KEY: "",
  ASR_PROVIDER_MODEL: "",
  OCR_ENGINE: "",
  OCR_TESSERACT_MODEL: "",
  OCR_PSM: "3",
  OCR_VLM_SOURCE: "local",
  OCR_PROVIDER_BASE: "",
  OCR_PROVIDER_API_KEY: "",
  OCR_PROVIDER_MODEL: "",
  PPOCR_MODEL_SIZE: "medium",
  IMG_BACKEND: "api",
  IMG_API_BASE: "",
  IMG_API_KEY: "",
  IMG_MODEL: "",
  IMG_COMFY_BASE: "",
  // MLX 生图常驻 worker 空闲多少分钟后自动卸载（0 = 一直常驻）：模型会占数 GB 内存。
  IMG_MLX_IDLE_MINUTES: "10",
  // 云端生视频：厂商与模型在「设置 → 模型云服务」里配（VIDEO_PROVIDER_ID / VIDEO_MODEL）。
  VIDEO_BACKEND: "cloud",
  VIDEO_PROVIDER_ID: "",
  VIDEO_MODEL: "",
  VIDEO_MINIMAX_BASE: "https://api.minimaxi.com",
  VIDEO_MINIMAX_API_KEY: "",
  VIDEO_MINIMAX_MODEL: "MiniMax-H3",
  // Seedance 走火山方舟内容生成任务 API（Bearer ARK_API_KEY）。
  VIDEO_SEEDANCE_BASE: "https://ark.cn-beijing.volces.com/api/v3",
  VIDEO_SEEDANCE_API_KEY: "",
  VIDEO_SEEDANCE_MODEL: "doubao-seedance-1-0-lite-t2v-250428",
  VIDEO_COMFY_BASE: "",
  VIDEO_COMFY_CKPT: "",
  VIDEO_COMFY_CLIP: "",
  VIDEO_COMFY_VAE: "",
  // 云端生音乐：与生视频同一套做法 —— 厂商与模型在「设置 → 模型云服务」里配
  // （MUSIC_PROVIDER_ID / MUSIC_MODEL），地址与密钥都来自厂商行。
  MUSIC_BACKEND: "cloud",
  MUSIC_PROVIDER_ID: "",
  MUSIC_MODEL: "",
  // 本地生音乐：**已预留、尚未接入引擎**。三把键先占好位，接入时只需补一个
  // MUSIC_LOCAL_API 取值 + 一个 submit/poll 实现，不必再动设置面与界面。
  MUSIC_LOCAL_API: "",
  MUSIC_LOCAL_BASE: "",
  MUSIC_LOCAL_MODEL: "",
  MODEL_DOWNLOADS: "[]",
  GATEWAY_ENABLED: "1",
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PORT: "10000",
  GATEWAY_API_KEY: "",
  // 隧道默认关：它把网关推到公网，必须是用户显式开启的能力（且要求先配 GATEWAY_API_KEY）。
  TUNNEL_ENABLED: "0",
  TUNNEL_MODE: "quick",
  TUNNEL_TOKEN: "",
  TUNNEL_PUBLIC_HOST: "",
  TUNNEL_PROTOCOL: "auto",
  WEB_SEARCH_ENABLED: "1",
  WEB_SEARCH_PROVIDER: "bing",
  WEB_SEARCH_API_KEY: "",
  WEB_SEARCH_MAX_RESULTS: "5",
  MEMORY_ENABLED: "1",
  /** Agent / CLI / MCP 的写入先落「待确认」，用户在记忆页批准后才生效（0=直接生效）。 */
  MEMORY_REVIEW_MODE: "0",
  /** 记忆向量检索（可选）：留空则纯关键词检索。 */
  MEMORY_EMBEDDING_MODEL: "",
  MEMORY_EMBEDDING_BASE: "",
  MEMORY_EMBEDDING_API_KEY: "",
  /** 是否把 Agent 写入记为项目记忆（按工作区隔离，1=开启）。 */
  MEMORY_SCOPE_ENABLED: "1",
  /** 笔记对 Agent 可见（沉淀记忆 + 可读正文）：默认开，开关在笔记小应用的设置里。 */
  NOTES_AGENT_ACCESS: "1",
  TRANSLATION_ENGINE: "model",
  AGENT_WORKSPACE: "",
  /** 最近使用的工作区列表（JSON 数组），供输入框上方的工作区选择面板展示。 */
  AGENT_WORKSPACES: "[]",
  AGENT_MODE: "agent",
  // 默认 off：不发推理参数，行为与加这个开关之前完全一致。
  AGENT_THINKING_LEVEL: "off",
  AGENT_MAX_STEPS: "40",
  AGENT_SUBAGENT_MAX_STEPS: "12",
  AGENT_ALLOW_SHELL: "1",
  // 默认 smart：写工作区 / 跑普通命令不打扰，危险命令与工作区外访问才弹授权。
  AGENT_APPROVAL_MODE: "smart",
  AGENT_PERMISSION_RULES: "[]",
  AGENT_AUTHORIZED_FOLDERS: "[]",
  // 项目指令（AGENTS.md，对齐 Codex）：从工作区向上找到仓库根，逐级拼接注入系统提示。
  AGENT_PROJECT_DOC: "1",
  /** 项目指令的体积上限（字节）。本地模型上下文小，默认 8KB。 */
  AGENT_PROJECT_DOC_MAX_BYTES: "8192",
  /**
   * 上下文压缩方式：summary = 顶到阈值时先让模型把旧历史摘成摘要（默认），
   * trim = 只用确定性裁剪（不额外调模型，长任务里模型会重新读一遍文件）。
   */
  AGENT_COMPACT_MODE: "summary",
  /**
   * 瞬时失败自愈：传输层重试 + 整轮失败重发 + 空回合提醒，共用这一个次数上限。
   * 默认 2 —— 本地推理服务"正在加载模型"的 503、云端偶发 429 都能被它吃掉。
   */
  AGENT_RETRY_MAX: "2",
  /** 把已安装的 Skills 只列「名字 + 描述」进系统提示，正文由 read_skill 按需取。 */
  AGENT_SKILLS_PROMPT: "1",
  /** Goal 模式自动续跑上限：本地一轮几十秒到几分钟，6 轮够跑完绝大多数任务。 */
  AGENT_GOAL_MAX_CONTINUATIONS: "6",
  /** Goal 模式 token 预算：默认 0（不限制）。理由见 agent-goals.ts 的 defaultGoalTokenBudget。 */
  AGENT_GOAL_TOKEN_BUDGET: "0",
  /** 看图工具（view_image）：auto = 按模型名猜，on / off = 强制开或关。 */
  AGENT_VISION_TOOL: "auto",
  // 回合快照：影子 git 仓库记下每轮开始前的工作区状态，界面可一键「撤销本轮」。
  AGENT_SNAPSHOTS: "1",
  // 影子仓库维护：占用超过 256MB 或快照条数到顶时自动 git gc（设置页可手动清理）。
  AGENT_SNAPSHOT_GC_MB: "256",
  AGENT_SNAPSHOT_GC_TURNS: "200",
  // 命令沙箱默认关闭：本地开发要装依赖 / 起 dev server，先让用户显式开启。
  AGENT_SANDBOX_MODE: "off",
  AGENT_SANDBOX_NETWORK: "1",
  // 后端偏好：auto = Linux 上 bubblewrap 优先（能连凭据目录读取一起挡），Landlock 兜底。
  AGENT_SANDBOX_BACKEND: "auto",
  // 外部通知回调：留空 = 关闭（默认）。示例：notify-send OmniStudio / 自写脚本
  AGENT_NOTIFY_COMMAND: "",
  // 生命周期 hooks：留空 = 关闭（默认）。示例：
  // [{"event":"user_prompt_submit","command":"scripts/context.sh"}]
  AGENT_HOOKS: "[]",
  // 语音通话：local = 本地 ASR+LLM+TTS 三段管线；cloud = Qwen Realtime（DashScope）。
  // 默认空 = 首次进入时由前端引导二选一（getVoiceCallProvider 会把空值当 local）。
  VOICE_CALL_PROVIDER: "",
  VOICE_CALL_REALTIME_PROVIDER_ID: "",
  // 旧版手填的 Key：仍作为兜底（选了厂商后以厂商行的 Key 为准）。
  VOICE_CALL_REALTIME_API_KEY: "",
  VOICE_CALL_REALTIME_BASE_URL: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
  VOICE_CALL_REALTIME_MODEL: "qwen-audio-3.0-realtime-plus",
  VOICE_CALL_REALTIME_VOICE: "longanqian",
  // Skills 管理默认值
  SKILLS_CENTRAL_PATH: "",
  SKILLS_SYNC_MODE: "symlink",
  SKILLS_TOOLS_DISABLED: "[]",
  SKILLS_TOOL_PATH_OVERRIDES: "{}",
  SKILLS_CUSTOM_TOOLS: "[]",
  SKILLS_ACTIVE_PRESET: "",
  SKILLS_AUTO_BACKUP: "1",
  SKILLS_GIT_REMOTE: "",
  SKILLS_GIT_PAT: "",

  // 备份远端存储（S3 兼容 / WebDAV）。密钥类键名带 KEY/SECRET，备份的「剔除密钥」会抹掉它们。
  BACKUP_REMOTE_KIND: "s3",
  BACKUP_REMOTE_ENABLED: "0",
  BACKUP_REMOTE_ENDPOINT: "",
  BACKUP_REMOTE_BUCKET: "",
  BACKUP_REMOTE_REGION: "us-east-1",
  BACKUP_REMOTE_ACCESS_KEY: "",
  BACKUP_REMOTE_SECRET_KEY: "",
  BACKUP_REMOTE_PREFIX: "OmniStudio",
  BACKUP_REMOTE_PATH_STYLE: "1",
  BACKUP_REMOTE_AUTO_UPLOAD: "0",
  BACKUP_REMOTE_DELETE_LOCAL: "0",
  CLOUD_PROVIDER: "",
  CLOUD_MODELS: "[]",
  CUSTOM_PROVIDERS: "[]",
  // 各功能页选中的云服务商 id（地址 / 密钥由 cloud_providers 表提供）
  IMG_PROVIDER_ID: "",
  TTS_PROVIDER_ID: "",
  ASR_PROVIDER_ID: "",
  OCR_PROVIDER_ID: "",
  CLOUD_APP_PROVIDERS_MIGRATED: "",
  SERVED_ACTIVE_ID: "",
  // 嵌入服务：端口段基址（实例从它起 +100 顺延，与聊天段语义一致）+ 池化方式
  // （set 时校验枚举 last|mean|none|cls，非法值直接拒，见 updateSettings）。
  EMBEDDING_PORT: String(EMBEDDING_PORT_BASE),
  EMBEDDING_POOLING: "last",
  // 全局默认嵌入配置：留空 = 不设默认（新建 KB 仍为空配置的纯关键词库，
  // 记忆也保持关键词检索）。地址与密钥可选；地址留空时解析按既有四层链走。
  EMBEDDING_MODEL: "",
  EMBEDDING_BASE: "",
  EMBEDDING_API_KEY: "",
};

/**
 * 设置读取缓存：`getSetting` 是热路径（一次服务器启动会读十几次，每次对话也要读），
 * 263 处调用点每处一次 SELECT 会被放大。
 *
 * - 本进程写入（updateSettings）立即失效对应键，读到的一定是最新值；
 * - 跨进程写入（omi CLI、记忆桥接会直连同一个 SQLite）不经过本进程，
 *   用 2 秒 TTL 兜底 —— 代价是最多 2 秒的陈旧窗口，换来热路径零查询。
 */
const SETTINGS_CACHE_TTL_MS = 2000;
const settingsCache = new Map<string, { value: string; at: number }>();

/**
 * 需要「存储加密」的设置槽位。
 *
 * 这些键落盘时存密文（AES-256-GCM，见 secrets.ts），读取时透明解密，消费方
 * （网关 / chat / 翻译 / 嵌入等几十处 getSetting 调用点）零改动。这解决的是
 * 「密钥明文躺 SQLite」的问题：拷走数据库读到的是密文，而密钥只在内存里解密。
 *
 * 目前有三类：模型云激活行回写的 VLLM_API_KEY、本地 API 网关自身的
 * GATEWAY_API_KEY（网关是用户允许保留 Key 的两处之一，同样不该明文躺盘），
 * 以及内网穿透用的隧道 Token（它等价于"在这条隧道上运行 cloudflared"的凭据）。
 * `EMPTY` 哨兵值不加密也不解密（它就是"无 key"的约定占位，解密会把它当成
 * 普通明文透传）。
 */
const ENCRYPTED_KEYS = new Set<SettingsKey>(["VLLM_API_KEY", "GATEWAY_API_KEY", "TUNNEL_TOKEN"]);

function maybeEncrypt(key: SettingsKey, value: string): string {
  if (!ENCRYPTED_KEYS.has(key)) return value;
  if (!value || value === "EMPTY") return value; // 哨兵 / 空：不制造密文
  return encryptSecret(value);
}

function maybeDecrypt(key: SettingsKey, value: string): string {
  if (!ENCRYPTED_KEYS.has(key)) return value;
  if (!value || value === "EMPTY") return value;
  return decryptSecret(value);
}

/** 清空设置缓存（跨进程写入后需要立即生效时手动调用）。 */
export function invalidateSettingsCache() {
  settingsCache.clear();
}

export function getSetting(key: SettingsKey): string {
  const now = Date.now();
  const cached = settingsCache.get(key);
  if (cached && now - cached.at < SETTINGS_CACHE_TTL_MS) return cached.value;
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
  const value = maybeDecrypt(key, row?.value ?? DEFAULTS[key]);
  settingsCache.set(key, { value, at: now });
  return value;
}

export function getNumericSetting(key: SettingsKey): number {
  return Number(getSetting(key));
}

export function getAllSettings(): Record<string, string> {
  const rows = db.select().from(settingsTable).all();
  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) {
    // 敏感槽位解密后再交给调用方（RPC 会下发给渲染进程，落盘是密文，内存是明文 ——
    // 与加密前行为一致，避免前端各处读 key 的逻辑崩掉）。
    const plain = maybeDecrypt(row.key as SettingsKey, row.value);
    result[row.key] = plain;
    settingsCache.set(row.key, { value: plain, at: Date.now() });
  }
  return result;
}

/**
 * llama.cpp `--pooling` 的合法取值。设置非法值直接拒（不写库、不进缓存），
 * 别把坏参数塞给 llama-server —— 读侧回落 DEFAULTS 的 "last"。
 */
export const EMBEDDING_POOLING_VALUES = ["last", "mean", "none", "cls"] as const;

export function updateSettings(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
// EMBEDDING_POOLING 只认枚举值：非法值直接跳过（静默拒掉，读侧回落默认 last）。
    if (
      key === "EMBEDDING_POOLING" &&
      !(EMBEDDING_POOLING_VALUES as readonly string[]).includes(value)
    ) {
      continue;
    }
    const encrypted = maybeEncrypt(key as SettingsKey, value);
    db.insert(settingsTable)
      .values({ key, value: encrypted })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: encrypted } })
      .run();
    // 缓存内存的是解密后的明文（紧接的 getSetting 直接命中，行为一致）
    settingsCache.set(key, { value, at: Date.now() });
  }
}

/**
 * 一次性把历史遗留的**明文**敏感设置加密落盘（幂等）。
 *
 * 升级前 `VLLM_API_KEY` / `GATEWAY_API_KEY` 是明文；读取侧能透传旧明文，但值仍
 * 躺在盘上。本函数扫描 settings 表，把 `ENCRYPTED_KEYS` 里尚为明文的行交给
 * `updateSettings` 统一加密写回；已在密文态的跳过，命中明文才写，日常开销可忽略。
 */
export function ensureSettingsEncrypted(): void {
  const rows = db.select().from(settingsTable).all();
  const patch: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key as SettingsKey;
    if (!ENCRYPTED_KEYS.has(key)) continue;
    const raw = row.value;
    if (!raw || raw === "EMPTY" || isEncryptedSecret(raw)) continue;
    patch[key] = raw; // 明文 → 交给 updateSettings 统一加密
  }
  if (Object.keys(patch).length > 0) updateSettings(patch);
}

export function isConfigured(): boolean {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, "SETUP_COMPLETE")).get();
  return row?.value === "1";
}

/** The port key each LLM inference engine reads (derived from shared/engines.ts). */
export const ENGINE_PORT_KEYS: Record<InferenceEngine, SettingsKey> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].portKey]),
) as Record<InferenceEngine, SettingsKey>;

/** The extra-launch-args key for each LLM engine (whitespace-separated flags appended last). */
export const ENGINE_EXTRA_ARGS_KEYS: Record<InferenceEngine, SettingsKey> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].extraArgsKey]),
) as Record<InferenceEngine, SettingsKey>;

/** The configured listen port of the given engine. */
export function getServerPort(engine: InferenceEngine): string {
  return getSetting(ENGINE_PORT_KEYS[engine]) || "8080";
}

/** The currently active LLM engine (as configured in INFERENCE_ENGINE). */
export function getActiveInferenceEngine(): InferenceEngine {
  return (getSetting("INFERENCE_ENGINE") as InferenceEngine) || "llama.cpp";
}

/** The listen port of the currently active LLM inference engine. */
/**
 * 运行期端口覆盖：同时驻留多个模型时，活动实例的端口未必等于引擎的设置端口
 * （只有第一个启动的实例占设置端口）。由 model-servers 维护，不落库。
 */
let activePortOverride: string | null = null;

export function setActiveServerPortOverride(port: string | null) {
  activePortOverride = port;
}

export function getActiveServerPort(): string {
  return activePortOverride || getServerPort(getActiveInferenceEngine());
}
