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
  images: text("images"),
  tokens: int("tokens"),
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
