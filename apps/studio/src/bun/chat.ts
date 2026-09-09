import { existsSync, readFileSync, rmSync } from "fs";
import path from "path";
import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { conversations, messages } from "./db/schema";
import { getSetting } from "./db/settings";
import { getChatModelName } from "./chat-model";
import { chatImageDir, getImagesBaseDir } from "./image-server";
import { recordUsage } from "./stats";
import { getStatus, getLastError, startServer } from "./server-manager";

export type ChatMessage = {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  images?: string[];
  createdAt: number;
};

export type Conversation = {
  id: number;
  title: string;
  app: string;
  modelId: string | null;
  createdAt: number;
  updatedAt: number;
};

type ChunkListener = (payload: {
  conversationId: number;
  messageId: number;
  delta: string;
}) => void;

type DoneListener = (payload: {
  conversationId: number;
  messageId: number;
  content: string;
  error?: string;
}) => void;

const chunkListeners = new Set<ChunkListener>();
const doneListeners = new Set<DoneListener>();

export function onChatChunk(cb: ChunkListener): () => void {
  chunkListeners.add(cb);
  return () => chunkListeners.delete(cb);
}

export function onChatDone(cb: DoneListener): () => void {
  doneListeners.add(cb);
  return () => doneListeners.delete(cb);
}

function emitChunk(payload: { conversationId: number; messageId: number; delta: string }) {
  for (const cb of chunkListeners) cb(payload);
}

function emitDone(payload: {
  conversationId: number;
  messageId: number;
  content: string;
  error?: string;
}) {
  for (const cb of doneListeners) cb(payload);
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

function parseImages(row: { images: string | null }): string[] {
  if (!row.images) return [];
  try {
    const parsed = JSON.parse(row.images);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Resolve an image ref to an absolute path, refusing anything outside the images base dir. */
function resolveChatImagePath(ref: string): string | null {
  const base = getImagesBaseDir();
  const resolved = path.resolve(base, ref);
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function readImageFile(ref: string): { mediaType: string; base64: string } | null {
  const filePath = resolveChatImagePath(ref);
  if (!filePath || !existsSync(filePath)) return null;
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? "image/jpeg";
  return { mediaType, base64: readFileSync(filePath).toString("base64") };
}

/**
 * Convert stored messages into an OpenAI-compatible chat payload. Images are
 * inlined as base64 `image_url` data URLs (accepted by vLLM / SGLang /
 * llama.cpp vision endpoints). Consecutive same-role user messages are merged.
 */
function buildOpenAiMessages(history: ChatMessage[]): { role: string; content: unknown }[] {
  const out: { role: string; content: unknown }[] = [];

  for (const m of history) {
    if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content });
      continue;
    }

    const parts: { type: string; text?: string; image_url?: { url: string } }[] = [];
    if (m.content.trim()) parts.push({ type: "text", text: m.content });
    for (const ref of m.images ?? []) {
      const img = readImageFile(ref);
      if (img) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        });
      }
    }
    if (parts.length === 0) continue;

    const last = out[out.length - 1];
    if (last && last.role === "user") {
      // merge consecutive user messages into one multi-part message
      if (Array.isArray(last.content)) {
        last.content = [...last.content, ...parts];
      } else {
        last.content = [{ type: "text", text: String(last.content) }, ...parts];
      }
      continue;
    }

    // plain string content when there is nothing but a single text part
    const singleText = parts.length === 1 && parts[0]?.type === "text";
    out.push({ role: "user", content: singleText ? parts[0]?.text ?? "" : parts });
  }

  return out;
}

export function listConversations(app?: string): Conversation[] {
  const q = db.select().from(conversations);
  const filtered = app ? q.where(eq(conversations.app, app)) : q;
  return filtered.orderBy(desc(conversations.updatedAt)).all() as Conversation[];
}

export function getConversation(id: number): {
  conversation: Conversation | null;
  messages: ChatMessage[];
} {
  const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!conv) return { conversation: null, messages: [] };
  const msgs = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt)
    .all()
    .map((m) => ({ ...m, images: parseImages(m) }));
  return { conversation: conv as Conversation, messages: msgs as ChatMessage[] };
}

export function createConversation(title?: string, app: string = "chat"): Conversation {
  const result = db
    .insert(conversations)
    .values({ title: title?.trim() || "New conversation", app, modelId: getChatModelName() || getSetting("CHAT_MODEL") || null })
    .returning()
    .get();
  return result as Conversation;
}

export function deleteConversation(id: number): void {
  db.delete(messages).where(eq(messages.conversationId, id)).run();
  db.delete(conversations).where(eq(conversations.id, id)).run();
  const dir = chatImageDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function getHistory(conversationId: number): ChatMessage[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt)
    .all()
    .map((m) => ({ ...m, images: parseImages(m) })) as ChatMessage[];
}

/** Resolve the OpenAI-compatible base URL (without the /v1 suffix). */
function getChatBaseUrl(): string {
  const isLocal = getSetting("SERVER_MODE") === "local";
  if (isLocal) {
    const host = getSetting("SERVER_HOST") || "127.0.0.1";
    const port = getSetting("SERVER_PORT") || "8080";
    return `http://${host}:${port}`;
  }
  return (getSetting("VLLM_API_BASE") || "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Ensure the local inference server is ready before sending: auto-start it when
 * stopped, and wait for an already-triggered start (e.g. from the model picker)
 * to reach "running". Startup progress is streamed to the UI via
 * serverStatusChanged, so the frontend can show a progress indicator meanwhile.
 */
async function ensureServerReady(timeoutMs = 180_000): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = getStatus();
    if (status === "running") return { ok: true };
    if (status === "error") {
      return { ok: false, error: getLastError() || "Inference server failed to start" };
    }
    if (status === "stopped") {
      // startServer resolves only once the health check passes.
      const result = await startServer();
      if (!result.ok) return { ok: false, error: result.error || "Failed to start inference server" };
      return { ok: true };
    }
    // starting / downloading — keep waiting for the status to advance.
    await Bun.sleep(500);
  }
  return { ok: false, error: "Timed out waiting for the inference server to start" };
}

export async function sendMessage(
  conversationId: number,
  content: string,
  images: string[] = [],
): Promise<{ ok: boolean; error?: string }> {
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv) return { ok: false, error: "Conversation not found" };
  if (!content.trim() && images.length === 0) return { ok: false, error: "Empty message" };

  const model = getChatModelName();
  if (!model) {
    emitDone({ conversationId, messageId: Date.now(), content: "", error: "No model configured" });
    return { ok: false, error: "No model configured" };
  }
  const base = getChatBaseUrl();
  if (!base) {
    emitDone({
      conversationId,
      messageId: Date.now(),
      content: "",
      error: "No inference server configured",
    });
    return { ok: false, error: "No inference server configured" };
  }

  const existingCount = getHistory(conversationId).length;

  db.insert(messages)
    .values({
      conversationId,
      role: "user",
      content,
      images: images.length ? JSON.stringify(images) : undefined,
    })
    .run();

  if (existingCount === 0) {
    const title = (content.trim() || images.join(" ")).trim().slice(0, 40) || "New conversation";
    db.update(conversations)
      .set({ title })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  const assistant = db
    .insert(messages)
    .values({ conversationId, role: "assistant", content: "" })
    .returning({ id: messages.id })
    .get();
  const assistantId = assistant.id;

  // 本地模式下若推理服务器未就绪，先自动启动并等待就绪（进度通过 serverStatusChanged 推送）。
  if (getSetting("SERVER_MODE") === "local") {
    const ready = await ensureServerReady();
    if (!ready.ok) {
      const errMsg = ready.error || "Inference server not ready";
      db.update(messages)
        .set({ content: `⚠️ ${errMsg}` })
        .where(eq(messages.id, assistantId))
        .run();
      db.update(conversations)
        .set({ updatedAt: Date.now() })
        .where(eq(conversations.id, conversationId))
        .run();
      emitDone({ conversationId, messageId: assistantId, content: "", error: errMsg });
      return { ok: false, error: errMsg };
    }
  }

  const apiKey = getSetting("VLLM_API_KEY");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "EMPTY") headers.Authorization = `Bearer ${apiKey}`;

  const payload = {
    model,
    messages: buildOpenAiMessages(getHistory(conversationId)),
    stream: true,
  };

  let full = "";
  let reasoning = "";
  let sawReasoning = false;

  const append = (delta: string) => {
    if (!delta) return;
    full += delta;
    emitChunk({ conversationId, messageId: assistantId, delta });
  };

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(600_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = body
        ? (() => {
            try {
              return JSON.parse(body)?.error?.message ?? body.slice(0, 300);
            } catch {
              return body.slice(0, 300);
            }
          })()
        : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payloadLine = trimmed.slice(5).trim();
      if (payloadLine === "[DONE]") return;
      try {
        const json = JSON.parse(payloadLine);
        const delta = json.choices?.[0]?.delta ?? {};
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          reasoning += delta.reasoning_content;
          sawReasoning = true;
          append(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          if (sawReasoning && full.length === reasoning.length) {
            // first content token after reasoning — insert a separator
            append("\n\n");
          }
          append(delta.content);
        }
        if (json.usage) usage = json.usage;
      } catch {
        // skip malformed chunk
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        consumeLine(line);
      }
    }
    if (buffer.trim()) consumeLine(buffer);

    if (sawReasoning && full.length === reasoning.length) {
      // only reasoning was emitted — mark it as the answer
      append("\n");
    }

    recordUsage(model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 把失败原因持久化到助手消息，避免刷新会话后错误反馈被清空。
    db.update(messages)
      .set({ content: msg ? `⚠️ ${msg}` : "⚠️ Request failed" })
      .where(eq(messages.id, assistantId))
      .run();
    db.update(conversations)
      .set({ updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId))
      .run();
    emitDone({ conversationId, messageId: assistantId, content: "", error: msg });
    return { ok: false, error: msg };
  }

  if (full) {
    db.update(messages).set({ content: full }).where(eq(messages.id, assistantId)).run();
  }

  db.update(conversations)
    .set({ updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run();

  emitDone({ conversationId, messageId: assistantId, content: full });
  return { ok: true };
}