import { sqliteTable, text, int } from "drizzle-orm/sqlite-core";

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
