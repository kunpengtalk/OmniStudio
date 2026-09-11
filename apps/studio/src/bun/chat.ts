import { existsSync, readFileSync, rmSync } from "fs";
import path from "path";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { conversations, messages } from "./db/schema";
import { getSetting, getActiveServerPort } from "./db/settings";
import { getChatModelName } from "./chat-model";
import { chatImageDir, getImagesBaseDir } from "./image-server";
import { recordUsage } from "./stats";
import { webSearch } from "./web-search";
import { getStatus, getLastError, startServer } from "./server-manager";

export type ChatMessage = {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  /** 推理模型的思考过程，与正文分开存储和展示（旧消息无此字段）。 */
  reasoning?: string | null;
  images?: string[];
  tokens?: number | null;
  createdAt: number;
};

export type ChatStats = {
  conversationId: number;
  messageId: number;
  tokens: number;
  tokensPerSec: number;
  elapsedMs: number;
};

export type Conversation = {
  id: number;
  title: string;
  app: string;
  modelId: string | null;
  pinned: number;
  /** 会话内消息条数（用于判断是否为空会话）。仅 listConversations 填充。 */
  messageCount?: number;
  createdAt: number;
  updatedAt: number;
};

type ChunkListener = (payload: {
  conversationId: number;
  messageId: number;
  delta: string;
  /** 增量所属区块：思考过程 / 正式回答。缺省为正文。 */
  kind?: "reasoning" | "content";
}) => void;

type DoneListener = (payload: {
  conversationId: number;
  messageId: number;
  content: string;
  reasoning?: string;
  error?: string;
}) => void;

const chunkListeners = new Set<ChunkListener>();
const doneListeners = new Set<DoneListener>();
const statsListeners = new Set<(payload: ChatStats) => void>();

export function onChatChunk(cb: ChunkListener): () => void {
  chunkListeners.add(cb);
  return () => chunkListeners.delete(cb);
}

export function onChatDone(cb: DoneListener): () => void {
  doneListeners.add(cb);
  return () => doneListeners.delete(cb);
}

export function onChatStats(cb: (payload: ChatStats) => void): () => void {
  statsListeners.add(cb);
  return () => statsListeners.delete(cb);
}

function emitChunk(payload: Parameters<ChunkListener>[0]) {
  for (const cb of chunkListeners) cb(payload);
}

function emitDone(payload: Parameters<DoneListener>[0]) {
  for (const cb of doneListeners) cb(payload);
}

function emitChatStats(payload: ChatStats) {
  for (const cb of statsListeners) cb(payload);
}

/**
 * 在没有 usage 元数据时估算 token 数：CJK（中日韩）字符约 1 token/字，
 * 其余字符按 4 字符/token 折算。仅用于展示吞吐量，精确值以 API 的 usage 为准。
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
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
  const rows = filtered
    .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
    .all() as Conversation[];
  const counts = db
    .select({ conversationId: messages.conversationId, count: sql<number>`count(*)`.as("count") })
    .from(messages)
    .groupBy(messages.conversationId)
    .all();
  const countMap = new Map(counts.map((c) => [c.conversationId, c.count]));
  return rows.map((r) => ({ ...r, messageCount: countMap.get(r.id) ?? 0 }));
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

export function togglePinConversation(id: number): {
  ok: boolean;
  conversation?: Conversation;
  error?: string;
} {
  const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!conv) return { ok: false, error: "Conversation not found" };
  const pinned = conv.pinned ? 0 : 1;
  const updated = db
    .update(conversations)
    .set({ pinned, updatedAt: Date.now() })
    .where(eq(conversations.id, id))
    .returning()
    .get();
  return { ok: true, conversation: updated as Conversation };
}

export function setConversationPinned(id: number, pinned: boolean): {
  ok: boolean;
  conversation?: Conversation;
  error?: string;
} {
  const updated = db
    .update(conversations)
    .set({ pinned: pinned ? 1 : 0, updatedAt: Date.now() })
    .where(eq(conversations.id, id))
    .returning()
    .get();
  if (!updated) return { ok: false, error: "Conversation not found" };
  return { ok: true, conversation: updated as Conversation };
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
export function getChatBaseUrl(): string {
  const isLocal = getSetting("SERVER_MODE") === "local";
  if (isLocal) {
    const host = getSetting("SERVER_HOST") || "127.0.0.1";
    const port = getActiveServerPort();
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
export async function ensureServerReady(
  timeoutMs = 180_000,
): Promise<{ ok: boolean; error?: string }> {
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

/**
 * 构建携带当前时间的系统消息：模型自身不知道"今天是哪天"，不注入的话
 * 涉及"今天/最新/最近"的问题会按训练数据里的旧日期回答（如报出两年前的股价）。
 * 每次推理请求都注入在最前面，所有模型生效；仅注入 payload，不落库。
 */
function currentTimeSystemMessage(): { role: string; content: string } {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    timeZone: tz,
  });
  const time = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  });
  return {
    role: "system",
    content:
      `系统信息：当前日期时间是 ${date} ${time}（时区 ${tz}）。` +
      `回答涉及"今天、现在、本周、最新、最近"等时间相关内容时，必须以该当前时间为准，` +
      `不要根据训练数据推断日期，也不要猜测当前时间。`,
  };
}

/**
 * 流式执行一次模型推理并把结果写到已插入的 assistant 消息行。
 * 供发消息 / 重新生成 / 翻译 共用；结束后按 API usage（缺失时估算）发出 chatStats。
 */
async function streamAssistantReply(opts: {
  conversationId: number;
  assistantId: number;
  payloadMessages: { role: string; content: unknown }[];
  /** 外部中断信号（实时语音通话的抢话打断），中断时保留已生成的部分并正常收尾。 */
  signal?: AbortSignal;
  /** 正文增量回调（不含思考过程），供逐句 TTS 等场景使用。 */
  onDelta?: (delta: string) => void;
  /** 附加在时间系统提示词之前的场景系统提示词（如语音通话助手）。 */
  extraSystem?: string;
  /** 关闭模型思考模式（llama.cpp Qwen3 等支持），用于要求直接回答的场景。 */
  disableThinking?: boolean;
}): Promise<{ ok: boolean; error?: string; content: string }> {
  const { conversationId, assistantId, payloadMessages } = opts;

  const model = getChatModelName();
  const base = getChatBaseUrl();
  if (!model || !base) {
    const errMsg = !model ? "No model configured" : "No inference server configured";
    db.update(messages)
      .set({ content: `⚠️ ${errMsg}` })
      .where(eq(messages.id, assistantId))
      .run();
    db.update(conversations)
      .set({ updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId))
      .run();
    emitDone({ conversationId, messageId: assistantId, content: "", error: errMsg });
    return { ok: false, error: errMsg, content: "" };
  }

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
      return { ok: false, error: errMsg, content: "" };
    }
  }

  const apiKey = getSetting("VLLM_API_KEY");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "EMPTY") headers.Authorization = `Bearer ${apiKey}`;

  const payload = {
    model,
    messages: [
      ...(opts.extraSystem ? [{ role: "system", content: opts.extraSystem }] : []),
      currentTimeSystemMessage(),
      ...payloadMessages,
    ],
    stream: true,
    // llama.cpp / Qwen3 等支持：通话等场景要求直接回答，不打思考草稿。
    ...(opts.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };

  let full = "";
  let reasoning = "";

  const appendContent = (delta: string) => {
    if (!delta) return;
    full += delta;
    emitChunk({ conversationId, messageId: assistantId, delta, kind: "content" });
    opts.onDelta?.(delta);
  };
  const appendReasoning = (delta: string) => {
    if (!delta) return;
    reasoning += delta;
    emitChunk({ conversationId, messageId: assistantId, delta, kind: "reasoning" });
  };

  const startedAt = performance.now();
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const requestSignal = opts.signal
    ? AbortSignal.any([AbortSignal.timeout(600_000), opts.signal])
    : AbortSignal.timeout(600_000);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: requestSignal,
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

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payloadLine = trimmed.slice(5).trim();
      if (payloadLine === "[DONE]") return;
      try {
        const json = JSON.parse(payloadLine);
        const delta = json.choices?.[0]?.delta ?? {};
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          appendReasoning(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          // 部分推理模型的 content 开头带残留的思考标签，剥掉避免混进正文。
          let content = delta.content;
          if (full.length === 0) content = content.replace(/^\s*<\/?think[\s>]*>/, "").trimStart();
          appendContent(content);
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

    recordUsage(model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 被外部中断（语音通话抢话打断）：保留已生成的部分内容，不当作错误处理。
    if (opts.signal?.aborted) {
      db.update(messages)
        .set({ content: full, reasoning: reasoning || null })
        .where(eq(messages.id, assistantId))
        .run();
      db.update(conversations)
        .set({ updatedAt: Date.now() })
        .where(eq(conversations.id, conversationId))
        .run();
      emitDone({ conversationId, messageId: assistantId, content: full, reasoning: reasoning || undefined });
      return { ok: true, content: full };
    }
    // 把失败原因持久化到助手消息，避免刷新会话后错误反馈被清空。
    db.update(messages)
      .set({ content: msg ? `⚠️ ${msg}` : "⚠️ Request failed", reasoning: reasoning || null })
      .where(eq(messages.id, assistantId))
      .run();
    db.update(conversations)
      .set({ updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId))
      .run();
    emitDone({ conversationId, messageId: assistantId, content: "", reasoning: reasoning || undefined, error: msg });
    return { ok: false, error: msg, content: "" };
  }

  const tokens = usage?.completion_tokens ?? estimateTokens(full);
  const elapsedMs = Math.max(1, performance.now() - startedAt);
  const tokensPerSec = Math.round((tokens / (elapsedMs / 1000)) * 10) / 10;

  db.update(messages)
    .set({ content: full, reasoning: reasoning || null, tokens })
    .where(eq(messages.id, assistantId))
    .run();
  db.update(conversations)
    .set({ updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run();

  emitChatStats({ conversationId, messageId: assistantId, tokens, tokensPerSec, elapsedMs });
  emitDone({ conversationId, messageId: assistantId, content: full, reasoning: reasoning || undefined });
  return { ok: true, content: full };
}

export async function sendMessage(
  conversationId: number,
  content: string,
  images: string[] = [],
  opts: { webSearch?: boolean; files?: { name: string; content: string }[] } = {},
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

  const result = await streamAssistantReply({
    conversationId,
    assistantId: assistant.id,
    payloadMessages: await buildPayloadMessages(conversationId, content, opts),
  });
  return { ok: result.ok, error: result.error };
}

/**
 * 供实时语音通话使用：与 sendMessage 相同的流式回复，但支持外部中断
 * （AbortSignal，用于抢话打断）与逐字回调（用于逐句 TTS）。
 * 用户消息由调用方先行落库（这样能拿到真实消息 id 即时展示），因此这里不再插入。
 */
export async function streamChatTurn(opts: {
  conversationId: number;
  content: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  extraSystem?: string;
  disableThinking?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const { conversationId, content } = opts;
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

  // 首条消息时用开头做会话标题（与 sendMessage 保持一致）。
  if (getHistory(conversationId).length === 1) {
    db.update(conversations)
      .set({ title: content.trim().slice(0, 40) || "New conversation" })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  const assistant = db
    .insert(messages)
    .values({ conversationId, role: "assistant", content: "" })
    .returning({ id: messages.id })
    .get();

  const result = await streamAssistantReply({
    conversationId,
    assistantId: assistant.id,
    payloadMessages: await buildPayloadMessages(conversationId, content, {}),
    signal: opts.signal,
    onDelta: opts.onDelta,
    extraSystem: opts.extraSystem,
    disableThinking: opts.disableThinking,
  });
  return { ok: result.ok, error: result.error };
}

/** 去掉常见请求语气词，作为改写失败时的兜底搜索词。 */
function cleanSearchQuery(raw: string): string {
  let q = raw.trim();
  // 语气词与动词可组合出现（"请帮我联网查一下…"），循环剥离直到稳定。
  const filler =
    /^(?:请|麻烦|帮我|帮忙|给我|你|您)?\s*(?:联网|上网|网上)?\s*(?:搜索|查询|查一下|搜一下|查下|查|搜|找|问)?\s*(?:一下|下)?\s*/;
  let prev = "";
  while (q !== prev) {
    prev = q;
    q = q.replace(filler, "").trim();
  }
  q = q.replace(/^(?:please\s+)?(?:help\s+me\s+)?(?:look\s+up|search\s+for|find|check)\s+/i, "").trim();
  return q || raw;
}

/**
 * 把用户的自然语言消息改写成适合搜索引擎的简短关键词。
 * 整句直接搜索时，搜索引擎容易匹配句首词返回不相关结果
 * （如"帮我联网查下小米的股票价格"会返回"帮"的字典条目），
 * 所以先让当前模型提取关键词（短的非流式调用）；失败时回退到去掉语气词的原句。
 */
async function rewriteSearchQuery(latestQuery: string): Promise<string> {
  const raw = latestQuery.trim();
  const fallback = cleanSearchQuery(raw);
  const model = getChatModelName();
  const base = getChatBaseUrl();
  if (!raw || !model || !base) return fallback;

  const apiKey = getSetting("VLLM_API_KEY");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "EMPTY") headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 80,
        messages: [
          {
            role: "system",
            content:
              "你是搜索查询改写器。把用户的消息改写成适合网页搜索引擎的简短关键词" +
              "（保留实体、数字、时间，去掉请求语气词）。只输出关键词本身，不要解释。",
          },
          { role: "user", content: raw },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return fallback;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const rewritten = (json.choices?.[0]?.message?.content ?? "")
      .trim()
      .replace(/^["'""''\s]+|["'""''\s]+$/g, "");
    if (!rewritten || rewritten.length > 100 || rewritten === raw) return fallback;
    return rewritten;
  } catch {
    return fallback;
  }
}

/**
 * 组装发给模型的完整 payload：
 * - 历史消息转 OpenAI 格式；
 * - 附件文件内容以 text part 追加到最后一条 user 消息（仅注入上下文，不落库）；
 * - 开启联网检索时，先改写查询词再搜索用户最新提问，把结果作为 system 消息注入（不落库）。
 */
async function buildPayloadMessages(
  conversationId: number,
  latestQuery: string,
  opts: { webSearch?: boolean; files?: { name: string; content: string }[] },
): Promise<{ role: string; content: unknown }[]> {
  const payloadMessages = buildOpenAiMessages(getHistory(conversationId));

  const files = (opts.files ?? []).filter((f) => f.name && f.content?.trim());
  if (files.length > 0) {
    const lastUser = [...payloadMessages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      const parts: { type: string; text?: string; image_url?: { url: string } }[] =
        typeof lastUser.content === "string"
          ? [{ type: "text", text: lastUser.content }]
          : (lastUser.content as typeof parts);
      for (const f of files) {
        parts.push({
          type: "text",
          text: `--- 附件文件：${f.name} ---\n${f.content}\n--- 附件结束 ---`,
        });
      }
      lastUser.content = parts;
    }
  }

  if (opts.webSearch && latestQuery.trim()) {
    const searchQuery = await rewriteSearchQuery(latestQuery);
    const search = await webSearch(searchQuery);
    if (search.ok && search.results.length > 0) {
      const context = search.results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
        .join("\n\n");
      payloadMessages.unshift({
        role: "system",
        content:
          `联网检索已开启。下面是针对用户最新提问的搜索结果（${search.provider}，搜索词：${searchQuery}），` +
          `请结合这些信息回答，并在回答中适当标注来源链接：\n\n${context}`,
      });
    } else if (search.error) {
      payloadMessages.unshift({
        role: "system",
        content: `联网检索失败（${search.error}），请基于你已有的知识回答，并提示用户检索可能不可用。`,
      });
    }
  }

  return payloadMessages;
}

/** 删除单条消息（连同其附件图片文件）。 */
export function deleteMessage(conversationId: number, messageId: number): { ok: boolean } {
  const row = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!row || row.conversationId !== conversationId) return { ok: false };
  for (const ref of parseImages(row)) {
    const filePath = resolveChatImagePath(ref);
    if (filePath && existsSync(filePath)) rmSync(filePath, { force: true });
  }
  db.delete(messages).where(eq(messages.id, messageId)).run();
  db.update(conversations)
    .set({ updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run();
  return { ok: true };
}

/**
 * 重新生成一条助手消息：回退到该条之前（删除它及之后的所有消息），
 * 用同样的上文重新请求一次并把新结果流式写回。
 */
export async function regenerateMessage(
  conversationId: number,
  messageId: number,
): Promise<{ ok: boolean; error?: string }> {
  const target = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!target || target.role !== "assistant") return { ok: false, error: "Message not found" };

  const history = getHistory(conversationId);
  const context = history.filter((m) => m.id < messageId);
  if (context.length === 0) return { ok: false, error: "Nothing to regenerate" };

  // 回退：删除目标消息及之后的所有消息（含附件图片）。
  for (const m of history) {
    if (m.id >= messageId) deleteMessage(conversationId, m.id);
  }

  const assistant = db
    .insert(messages)
    .values({ conversationId, role: "assistant", content: "" })
    .returning({ id: messages.id })
    .get();

  const result = await streamAssistantReply({
    conversationId,
    assistantId: assistant.id,
    payloadMessages: buildOpenAiMessages(context),
  });
  return { ok: result.ok, error: result.error };
}

const TARGET_LANG_LABEL: Record<string, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  fr: "français",
  de: "Deutsch",
};

/** 翻译一条消息：把原文（含可能的图片）发给模型，译文作为新消息流式追加。 */
export async function translateMessage(
  conversationId: number,
  messageId: number,
  targetLang = "zh-CN",
): Promise<{ ok: boolean; error?: string }> {
  const source = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!source || source.conversationId !== conversationId) {
    return { ok: false, error: "Message not found" };
  }

  const langLabel = TARGET_LANG_LABEL[targetLang] ?? targetLang;
  const instruction = `请把下面的内容翻译成${langLabel}。只输出译文本身，不要附带任何解释、说明或原文。`;

  const parts: { type: string; text?: string; image_url?: { url: string } }[] = [
    { type: "text", text: source.content || "（空消息）" },
  ];
  for (const ref of parseImages(source)) {
    const img = readImageFile(ref);
    if (img) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
      });
    }
  }
  const payloadMessages: { role: string; content: unknown }[] = [
    { role: "system", content: instruction },
    { role: "user", content: parts.length === 1 ? parts[0]?.text ?? "" : parts },
  ];

  const assistant = db
    .insert(messages)
    .values({ conversationId, role: "assistant", content: "" })
    .returning({ id: messages.id })
    .get();

  const result = await streamAssistantReply({
    conversationId,
    assistantId: assistant.id,
    payloadMessages,
  });
  return { ok: result.ok, error: result.error };
}