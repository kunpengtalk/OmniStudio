import { sqliteTable, text, int, unique, primaryKey } from "drizzle-orm/sqlite-core";
import type { KbDocKind, KbDocStatus } from "../../shared/knowledge";

export type PromptKind = "image" | "llm" | "video";

export const documents = sqliteTable("documents", {
  id: int().primaryKey({ autoIncrement: true }),
  path: text("path").notNull(),
  type: text("type").notNull(),
  size: int("size").notNull(),
  status: text("status")
    .$type<"pending" | "processing" | "completed" | "failed">()
    .$defaultFn(() => "pending")
    .notNull(),
  totalPages: int("total_pages"),
  processedPages: int("processed_pages"),
  imagesDir: text("images_dir"),
  error: text("error"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  processingStartedAt: int("processing_started_at"),
  completedAt: int("completed_at"),
  failedAt: int("failed_at"),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

export const pages = sqliteTable("pages", {
  id: int().primaryKey({ autoIncrement: true }),
  documentId: int("document_id").notNull(),
  pageNumber: int("page_number").notNull(),
  markdown: text("markdown"),
  raw: text("raw"),
  status: text("status")
    .$type<"pending" | "completed" | "failed">()
    .$defaultFn(() => "pending")
    .notNull(),
  error: text("error"),
  startedAt: int("started_at"),
  completedAt: int("completed_at"),
  failedAt: int("failed_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: int().primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  app: text("app").notNull().default("chat"),
  modelId: text("model_id"),
  pinned: int("pinned").notNull().default(0),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

export const messages = sqliteTable("messages", {
  id: int().primaryKey({ autoIncrement: true }),
  conversationId: int("conversation_id").notNull(),
  role: text("role").$type<"user" | "assistant">().notNull(),
  content: text("content").notNull(),
  /** 推理模型的思考过程（reasoning_content），与正文分开存储和展示。 */
  reasoning: text("reasoning"),
  images: text("images"),
  tokens: int("tokens"),
  /** user 消息：发送时挂载的知识库 id JSON 数组（重新生成时复用检索）。 */
  kbIds: text("kb_ids"),
  /** assistant 消息：知识库引用溯源（KbCitation[] 的 JSON）。 */
  citations: text("citations"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
});

/**
 * Agent 运行轨迹（工具调用、状态变更）。会话正文仍落在 messages 里，
 * 这里只记录"Agent 做了什么"，用于 UI 展示工具调用过程与审计。
 */
export const agentEvents = sqliteTable("agent_events", {
  id: int().primaryKey({ autoIncrement: true }),
  conversationId: int("conversation_id").notNull(),
  /** 事件归属的助手消息（一次运行对应一条 assistant 消息）。 */
  messageId: int("message_id"),
  kind: text("kind")
    .$type<"status" | "tool_start" | "tool_end" | "error">()
    .notNull(),
  toolName: text("tool_name"),
  /** JSON 序列化的工具入参。 */
  args: text("args"),
  /** 工具输出 / 状态描述。 */
  output: text("output"),
  isError: int("is_error").notNull().default(0),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
});

export const imageRecords = sqliteTable("image_records", {
  id: int("id").primaryKey({ autoIncrement: true }),
  status: text("status")
    .$type<"done" | "failed">()
    .$defaultFn(() => "done")
    .notNull(),
  backend: text("backend").$type<"api" | "comfyui" | "mlx">(),
  model: text("model"),
  prompt: text("prompt"),
  negativePrompt: text("negative_prompt"),
  width: int("width"),
  height: int("height"),
  seed: int("seed"),
  steps: int("steps"),
  imagePath: text("image_path"),
  error: text("error"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
});

/**
 * AI 视频生成记录。云端后端（minimax / seedance）是「提交任务 + 轮询」的
 * 异步模式：submit 时先落一条 processing 记录（taskId 存上游任务 id），
 * 轮询到成片后回填 videoPath；ComfyUI 的 taskId 存 prompt_id。
 */
export const videoRecords = sqliteTable("video_records", {
  id: int("id").primaryKey({ autoIncrement: true }),
  status: text("status")
    .$type<"processing" | "done" | "failed">()
    .$defaultFn(() => "processing")
    .notNull(),
  backend: text("backend").$type<"comfyui" | "minimax" | "seedance">(),
  model: text("model"),
  prompt: text("prompt"),
  negativePrompt: text("negative_prompt"),
  /** 上游任务 id（MiniMax task_id / Ark 任务 id / ComfyUI prompt_id）。 */
  taskId: text("task_id"),
  ratio: text("ratio"),
  /** minimax: 480P/768P/2K；seedance: 480p/720p/1080p；comfyui 存像素宽高。 */
  resolution: text("resolution"),
  /** 视频时长（秒）；comfyui 换算成帧数提交。 */
  duration: int("duration"),
  width: int("width"),
  height: int("height"),
  seed: int("seed"),
  steps: int("steps"),
  /** 图生视频的首帧图 ref（images 目录内，stageEditImage 暂存）。 */
  firstFramePath: text("first_frame_path"),
  /** 成片 ref（images 目录内，如 videos/xxx.mp4），由本地媒体服务播放。 */
  videoPath: text("video_path"),
  error: text("error"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
});

export const translationRecords = sqliteTable("translation_records", {
  id: int().primaryKey({ autoIncrement: true }),
  sourceLang: text("source_lang").notNull(),
  targetLang: text("target_lang").notNull(),
  text: text("text").notNull(),
  result: text("result"),
  model: text("model"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
});

export const voiceRecords = sqliteTable("voice_records", {
  id: int().primaryKey({ autoIncrement: true }),
  kind: text("kind").$type<"tts" | "asr" | "clone">().notNull(),
  status: text("status")
    .$type<"done" | "failed">()
    .$defaultFn(() => "done")
    .notNull(),
  model: text("model"),
  voice: text("voice"),
  text: text("text"),
  audioPath: text("audio_path"),
  refAudioPath: text("ref_audio_path"),
  durationMs: int("duration_ms"),
  error: text("error"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
});

// ---------------------------------------------------------------------------
// 提示词库（本地 SQLite；种子数据由 bun/prompt-library 首次启动时灌入）
// ---------------------------------------------------------------------------

export const promptCategories = sqliteTable("prompt_categories", {
  id: int().primaryKey({ autoIncrement: true }),
  kind: text("kind").$type<PromptKind>().notNull(),
  /** 分类名（image/video 用统一中文名，llm 用手写分类名）。 */
  name: text("name").notNull(),
  intro: text("intro"),
  sort: int("sort").notNull().default(0),
});

export const prompts = sqliteTable("prompts", {
  id: int().primaryKey({ autoIncrement: true }),
  /** 来源数据里的原始 id，用于幂等灌入。 */
  key: text("key").notNull().unique(),
  kind: text("kind").$type<PromptKind>().notNull(),
  category: text("category").notNull(),
  subcategory: text("subcategory"),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  /** 一句话介绍（llm 提示词 / 视频案例）。 */
  summary: text("summary"),
  /** CSS aspect-ratio，例如 "1 / 1"。 */
  ratio: text("ratio"),
  /** 示例图路径（本地无素材时前端渲染占位）。 */
  image: text("image"),
  /** 视频直链（仅部分视频提示词有）。 */
  video: text("video"),
  /** 视频提示词的生成方式（文生视频 / 首尾帧 / 图生视频 …）。 */
  mode: text("mode"),
  /** 视频提示词的参考时长（秒）。 */
  duration: int("duration"),
  /** 原始出处/原片跳转链接。 */
  playUrl: text("play_url"),
  playLabel: text("play_label"),
  /** 题库来源 id（img2hub / awesome / 仓库 id）。 */
  source: text("source"),
  sourceUrl: text("source_url"),
  sourceLabel: text("source_label"),
  featured: int("featured").notNull().default(0),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
});

// ---------------------------------------------------------------------------
// 我的提示词（用户自建 / 从广场加入，按 source_key 记录来源）
// ---------------------------------------------------------------------------

export const userPrompts = sqliteTable("user_prompts", {
  id: int().primaryKey({ autoIncrement: true }),
  kind: text("kind").$type<PromptKind>().notNull(),
  /** 分类名（自定义，空值归「未分类」）。 */
  category: text("category").notNull().default(""),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  /** 一句话介绍。 */
  summary: text("summary"),
  /** CSS aspect-ratio，例如 "1 / 1"。 */
  ratio: text("ratio"),
  /** 示例图：广场导入存原始路径 /prompt-library/...，手动新建可留空或填 URL。 */
  image: text("image"),
  /** 从广场导入时对应的 prompts.key；唯一，用于防重复导入 + 「已加入」判断。 */
  sourceKey: text("source_key").unique(),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

export type UserPromptRow = typeof userPrompts.$inferSelect;

// ---------------------------------------------------------------------------
// Skills 管理（参照 skills-manager 移植）：中央技能库索引 / 同步目标 / 场景 / 项目
// ---------------------------------------------------------------------------

/** 中央库技能索引：id 即中央库内的目录名（slug）。 */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  sourceType: text("source_type")
    .$type<"manual" | "local" | "git" | "skillssh" | "scan" | "project">()
    .notNull()
    .default("manual"),
  /** "owner/repo/skill_id"（skillssh）、git URL 或空。 */
  sourceRef: text("source_ref"),
  sourceSubpath: text("source_subpath"),
  /** 安装/更新时的 git HEAD，用于更新检查。 */
  sourceRevision: text("source_revision"),
  /** JSON 字符串数组。 */
  tags: text("tags").notNull().default("[]"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

/** 已落盘的同步部署（技能 × 工具）。 */
export const skillTargets = sqliteTable(
  "skill_targets",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    skillId: text("skill_id").notNull(),
    tool: text("tool").notNull(),
    mode: text("mode").$type<"symlink" | "copy">().notNull(),
    /** 同步时的源目录内容哈希，copy 模式判断是否过期。 */
    sourceHash: text("source_hash"),
    createdAt: int("created_at").$defaultFn(() => Date.now()),
    updatedAt: int("updated_at")
      .$defaultFn(() => Date.now())
      .$onUpdateFn(() => Date.now()),
  },
  (t) => [unique().on(t.skillId, t.tool)],
);

/** 场景（预设）。 */
export const skillPresets = sqliteTable("skill_presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon"),
  sortOrder: int("sort_order").notNull().default(0),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

/** 预设成员（技能）。 */
export const presetSkills = sqliteTable(
  "preset_skills",
  {
    presetId: text("preset_id").notNull(),
    skillId: text("skill_id").notNull(),
    sortOrder: int("sort_order").notNull().default(0),
    addedAt: int("added_at").$defaultFn(() => Date.now()),
  },
  (t) => [primaryKey({ columns: [t.presetId, t.skillId] })],
);

/** 预设内「技能 × 工具」开关（活动预设时切换立即落盘部署）。 */
export const presetSkillTools = sqliteTable(
  "preset_skill_tools",
  {
    presetId: text("preset_id").notNull(),
    skillId: text("skill_id").notNull(),
    tool: text("tool").notNull(),
    enabled: int("enabled").notNull().default(1),
    updatedAt: int("updated_at")
      .$defaultFn(() => Date.now())
      .$onUpdateFn(() => Date.now()),
  },
  (t) => [primaryKey({ columns: [t.presetId, t.skillId, t.tool] })],
);

/** 项目工作区。 */
export const skillProjects = sqliteTable("skill_projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

/** skills.sh 市场缓存（榜单 5 分钟 TTL）。 */
export const skillsshCache = sqliteTable("skillssh_cache", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: int("fetched_at").$defaultFn(() => Date.now()),
});

/** Skills 操作审计日志。 */
export const skillAuditLog = sqliteTable("skill_audit_log", {
  id: int("id").primaryKey({ autoIncrement: true }),
  action: text("action").notNull(),
  detail: text("detail"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
});

export type SkillRow = typeof skills.$inferSelect;
export type SkillTargetRow = typeof skillTargets.$inferSelect;
export type SkillPresetRow = typeof skillPresets.$inferSelect;
export type SkillProjectRow = typeof skillProjects.$inferSelect;

// ---------------------------------------------------------------------------
// 模型云服务商：用户添加的 OpenAI 兼容服务商（预设原厂 / 聚合商 / 自定义）。
// id 即预设 slug（deepseek/zhipu/…）或 custom-<ts>；激活的服务商同步写
// VLLM_API_BASE/KEY 等 settings 槽位，网关与 CLI 无需感知本表。
// ---------------------------------------------------------------------------

export const cloudProviders = sqliteTable("cloud_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  vendor: text("vendor").notNull().default(""),
  baseUrl: text("base_url").notNull().default(""),
  apiKey: text("api_key").notNull().default(""),
  /** JSON 序列化的 CloudModelEntry[]。 */
  models: text("models").notNull().default("[]"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

export type CloudProviderRow = typeof cloudProviders.$inferSelect;

// ---------------------------------------------------------------------------
// MCP 服务器（Model Context Protocol）：为 Agent 提供外部工具。
// stdio = 本地子进程（npx/uvx/命令）；http = Streamable HTTP；sse = 旧版 SSE。
// args/headers/env 均为 JSON 序列化存储。
// ---------------------------------------------------------------------------

export const mcpServers = sqliteTable("mcp_servers", {
  id: int("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").$type<"stdio" | "http" | "sse">().notNull().default("stdio"),
  /** stdio：可执行命令（支持 npx / bunx / uvx / 绝对路径）。 */
  command: text("command").notNull().default(""),
  /** stdio：JSON 字符串数组（命令行参数）。 */
  args: text("args").notNull().default("[]"),
  /** http / sse：服务器 URL。 */
  url: text("url").notNull().default(""),
  /** http / sse：JSON 对象（额外请求头，如 Authorization）。 */
  headers: text("headers").notNull().default("{}"),
  /** stdio：JSON 对象（子进程环境变量）。 */
  env: text("env").notNull().default("{}"),
  enabled: int("enabled").notNull().default(1),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

export type McpServerRow = typeof mcpServers.$inferSelect;

// ---------------------------------------------------------------------------
// 知识库（本地 RAG）：文档导入 → 切片 → 可选向量化 → 关键词/向量混合检索。
// 嵌入配置按库快照（model 为空 = 纯 BM25 关键词检索，base 留空跟随当前模型服务商）。
// 向量以 Float32Array 的 base64 存在 chunk 行上，个人知识库规模下 JS 余弦足够。
// ---------------------------------------------------------------------------

export const knowledgeBases = sqliteTable("knowledge_bases", {
  id: int().primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  /** 嵌入模型 id；空 = 不向量化，仅关键词检索。 */
  embeddingModel: text("embedding_model").notNull().default(""),
  /** OpenAI 兼容 base（不带 /v1）；空 = 跟随 VLLM_API_BASE / 本地推理服务。 */
  embeddingBase: text("embedding_base").notNull().default(""),
  embeddingApiKey: text("embedding_api_key").notNull().default(""),
  /** 首次嵌入成功后记录维度，之后校验模型是否换了。 */
  embeddingDim: int("embedding_dim"),
  /** 重排模型 id；空 = 不重排（RRF 融合序即最终序）。 */
  rerankModel: text("rerank_model").notNull().default(""),
  /** 重排服务 base（不带 /v1）；空 = 跟随嵌入配置/当前服务商。 */
  rerankBase: text("rerank_base").notNull().default(""),
  rerankApiKey: text("rerank_api_key").notNull().default(""),
  chunkSize: int("chunk_size").notNull().default(800),
  chunkOverlap: int("chunk_overlap").notNull().default(120),
  /** 单库召回条数（聊天里多库合并后再截断）。 */
  topK: int("top_k").notNull().default(6),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

export const knowledgeDocs = sqliteTable("knowledge_docs", {
  id: int().primaryKey({ autoIncrement: true }),
  kbId: int("kb_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").$type<KbDocKind>().notNull(),
  /** file：原文件绝对路径（按引用不复制）。 */
  sourcePath: text("source_path"),
  /** web：来源 URL。 */
  url: text("url"),
  /** note：正文原文（其他类型为空）。 */
  content: text("content"),
  sizeBytes: int("size_bytes"),
  /** 提取出的正文字符数。 */
  charCount: int("char_count"),
  chunkCount: int("chunk_count").notNull().default(0),
  /** 已向量化的分块数（无嵌入配置时等于 chunkCount）。 */
  embeddedCount: int("embedded_count").notNull().default(0),
  status: text("status")
    .$type<KbDocStatus>()
    .$defaultFn(() => "pending")
    .notNull(),
  error: text("error"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

export const knowledgeChunks = sqliteTable("knowledge_chunks", {
  id: int().primaryKey({ autoIncrement: true }),
  kbId: int("kb_id").notNull(),
  docId: int("doc_id").notNull(),
  /** 文档内序号（1 起）。 */
  seq: int("seq").notNull(),
  content: text("content").notNull(),
  charCount: int("char_count").notNull(),
  /** Float32Array 的 base64；NULL = 未向量化。 */
  embedding: text("embedding"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
});

export type KnowledgeBaseRow = typeof knowledgeBases.$inferSelect;
export type KnowledgeDocRow = typeof knowledgeDocs.$inferSelect;
export type KnowledgeChunkRow = typeof knowledgeChunks.$inferSelect;


// ---------------------------------------------------------------------------
// 记忆（Memory）：所有 Agent 共享的长期记忆库。
// Agent 对话中经 memory_search / memory_save 工具读写，置顶记忆注入系统提示。
// ---------------------------------------------------------------------------

export const memories = sqliteTable("memories", {
  id: int("id").primaryKey({ autoIncrement: true }),
  content: text("content").notNull(),
  category: text("category")
    .$type<"fact" | "preference" | "experience" | "skill" | "other">()
    .notNull()
    .default("fact"),
  /** JSON 字符串数组。 */
  tags: text("tags").notNull().default("[]"),
  /** manual = 设置页录入；agent = Agent 工具写入。 */
  source: text("source").$type<"manual" | "agent">().notNull().default("manual"),
  /** 置顶记忆注入 Agent 系统提示（常驻核心记忆）。 */
  pinned: int("pinned").notNull().default(0),
  usageCount: int("usage_count").notNull().default(0),
  lastAccessedAt: int("last_accessed_at"),
  createdAt: int("created_at").$defaultFn(() => Date.now()),
  updatedAt: int("updated_at")
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

export type MemoryRow = typeof memories.$inferSelect;
