import { existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { asc, eq } from "drizzle-orm";

import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { db } from "./db";
import { agentEvents, conversations, messages } from "./db/schema";
import { getSetting } from "./db/settings";
import { getChatBaseUrl, getHistory, ensureServerReady } from "./chat";
import { getChatModelName } from "./chat-model";
import { recordUsage } from "./stats";
import { buildAgentTools, buildReadOnlyTools } from "./agent-tools";
import { buildMediaGenTools, buildMediaReadTools } from "./media-tools";
import { cancelMediaSetup } from "./media-setup";
import { buildMcpAgentTools } from "./mcp";
import { buildMemoryAgentTools, memoryEnabled, memoryPromptSection, memoryRecallSection } from "./memory";
import * as Chat from "./chat";

/** Agent 的三种工作模式（对齐 PI-Desktop 的 Agent / Plan / Goal）。 */
export type AgentMode = "agent" | "plan" | "goal";

export const AGENT_MODES: AgentMode[] = ["agent", "plan", "goal"];

/** Agent 运行轨迹中的一条事件（落库后立即返回给 UI）。 */
export type AgentEventRow = {
  id: number;
  conversationId: number;
  messageId: number | null;
  kind: "status" | "tool_start" | "tool_end" | "error";
  toolName: string | null;
  /** JSON 字符串，UI 渲染时再解析。 */
  args: string | null;
  output: string | null;
  isError: number;
  createdAt: number;
};

export type AgentToolInfo = {
  name: string;
  label: string;
  description: string;
};

export type AgentRunState = {
  conversationId: number;
  running: boolean;
  mode: AgentMode;
  workspace: string;
};

type ChunkListener = (payload: {
  conversationId: number;
  messageId: number;
  delta: string;
  kind?: "reasoning" | "content";
}) => void;

type DoneListener = (payload: {
  conversationId: number;
  messageId: number;
  content: string;
  reasoning?: string;
  error?: string;
}) => void;

type StatsListener = (payload: {
  conversationId: number;
  messageId: number;
  tokens: number;
  tokensPerSec: number;
  elapsedMs: number;
}) => void;

type EventListener = (payload: AgentEventRow) => void;

const chunkListeners = new Set<ChunkListener>();
const doneListeners = new Set<DoneListener>();
const statsListeners = new Set<StatsListener>();
const eventListeners = new Set<EventListener>();

export function onAgentChunk(cb: ChunkListener): () => void {
  chunkListeners.add(cb);
  return () => chunkListeners.delete(cb);
}
export function onAgentDone(cb: DoneListener): () => void {
  doneListeners.add(cb);
  return () => doneListeners.delete(cb);
}
export function onAgentStats(cb: StatsListener): () => void {
  statsListeners.add(cb);
  return () => statsListeners.delete(cb);
}
export function onAgentEvent(cb: EventListener): () => void {
  eventListeners.add(cb);
  return () => eventListeners.delete(cb);
}

function emitChunk(payload: Parameters<ChunkListener>[0]) {
  for (const cb of chunkListeners) cb(payload);
}
function emitDone(payload: Parameters<DoneListener>[0]) {
  for (const cb of doneListeners) cb(payload);
}
function emitStats(payload: Parameters<StatsListener>[0]) {
  for (const cb of statsListeners) cb(payload);
}
function emitEvent(payload: AgentEventRow) {
  for (const cb of eventListeners) cb(payload);
}

/** 记录一条轨迹事件：落库后立刻推送给 UI。 */
function recordEvent(row: {
  conversationId: number;
  messageId: number | null;
  kind: AgentEventRow["kind"];
  toolName?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
}): AgentEventRow {
  const inserted = db
    .insert(agentEvents)
    .values({
      conversationId: row.conversationId,
      messageId: row.messageId,
      kind: row.kind,
      toolName: row.toolName ?? null,
      args: row.args === undefined ? null : JSON.stringify(row.args),
      output: row.output ?? null,
      isError: row.isError ? 1 : 0,
    })
    .returning()
    .get() as AgentEventRow;
  emitEvent(inserted);
  return inserted;
}

export function listAgentEvents(conversationId: number): AgentEventRow[] {
  return db
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.conversationId, conversationId))
    .orderBy(asc(agentEvents.id))
    .all() as AgentEventRow[];
}

/** 会话删除时清理其轨迹。 */
export function deleteConversationEvents(conversationId: number): void {
  db.delete(agentEvents).where(eq(agentEvents.conversationId, conversationId)).run();
}

/** 当前生效的工作区：未配置时回落到用户主目录。 */
/** OmniStudio 的隐藏根目录（位于当前用户主目录下）。 */
export const OMNI_STUDIO_DIR = ".omnistudio";
/** 默认工作区：~/.omnistudio/workspace */
export const DEFAULT_WORKSPACE_NAME = "workspace";

/**
 * 确保默认工作区存在：~/.omnistudio/workspace。
 * 用当前用户权限创建（mkdir 继承进程 umask），失败时回落到用户主目录。
 */
function ensureDefaultWorkspace(): string {
  const home = os.homedir();
  const root = path.join(home, OMNI_STUDIO_DIR);
  const workspace = path.join(root, DEFAULT_WORKSPACE_NAME);
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
    return workspace;
  } catch {
    return home;
  }
}

/**
 * 当前生效的工作区：
 * 1. 设置里指定的目录（AGENT_WORKSPACE）—— 用户在界面上自己选的，目录不存在时自动创建；
 * 2. 否则用默认工作区 ~/.omnistudio/workspace。
 */
export function getAgentWorkspace(): string {
  const configured = getSetting("AGENT_WORKSPACE").trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (!existsSync(resolved)) {
      try {
        mkdirSync(resolved, { recursive: true });
      } catch {
        // 创建失败时仍然返回该路径，让工具层给出明确的写入错误。
      }
    }
    return resolved;
  }
  return ensureDefaultWorkspace();
}

export function getAgentMode(): AgentMode {
  const mode = getSetting("AGENT_MODE") as AgentMode;
  return AGENT_MODES.includes(mode) ? mode : "agent";
}

/** 构造指向当前推理服务（本地 llama.cpp / vLLM / SGLang 或远端 OpenAI 兼容 API）的 pi-ai Model。 */
function buildModel(): Model<"openai-completions"> {
  const base = getChatBaseUrl().replace(/\/+$/, "");
  const baseUrl = /\/v1$/i.test(base) ? base : `${base}/v1`;
  const id = getChatModelName();
  const contextWindow = Number(getSetting("SERVER_CTX_SIZE")) || 8192;
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "omni-studio",
    baseUrl,
    // 是否支持 reasoning 由服务端决定；保持 false 以免强行注入 reasoning 参数。
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.max(1024, Math.floor(contextWindow / 2)),
  };
}

function createStreamFn() {
  const model = buildModel();
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "omni-studio",
      name: "OmniStudio",
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: "OmniStudio inference server",
          resolve: async () => {
            const key = getSetting("VLLM_API_KEY");
            return { auth: { apiKey: key && key !== "EMPTY" ? key : "EMPTY" }, source: "env" as const };
          },
        },
      },
      models: [model],
      api: openAICompletionsApi() as never,
    }),
  );
  return {
    model,
    streamFn: (m: Model<string>, context: Context, options?: SimpleStreamOptions) =>
      models.streamSimple(m as Model<"openai-completions">, context, options),
  };
}

function currentTimeLine(): string {
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
  return `当前日期时间是 ${date} ${time}（时区 ${tz}）。涉及"今天/最新/最近"的内容必须以此为据。`;
}

const MODE_INSTRUCTION: Record<AgentMode, string> = {
  agent: [
    "你是 Agent 模式：直接把事情做完。",
    "先探查再动手，能改就改，改完用命令验证（测试 / 构建 / lint）。",
    "遇到不确定的地方优先用工具确认，不要凭猜测下结论。",
  ].join("\n"),
  plan: [
    "你是 Plan 模式：只做调研和产出实施方案，绝不修改任何文件、绝不执行写操作。",
    "可用工具仅限只读工具（读取文件、列目录、搜索、联网检索）。",
    "输出一份可直接执行的方案：目标、涉及文件、分步改动、风险与验证方式。",
  ].join("\n"),
  goal: [
    "你是 Goal 模式：先与用户对齐目标与验收标准，然后自主选择路径把目标达成。",
    "开工前先用一句话复述你要达成的目标和验收标准，再执行。",
    "过程中持续用命令验证，直到验收标准全部满足才停止。",
  ].join("\n"),
};

function buildSystemPrompt(mode: AgentMode, workspace: string): string {
  const guidelines = [
    "1. 路径尽量用相对工作区的相对路径；绝对路径只允许落在工作区内用于写操作。",
    "2. 一次只调用当下最需要的工具，拿到结果再决定下一步，不要成批猜测。",
    "3. 修改既有代码前先读取相关片段，保证 old_str 精确匹配。",
    "4. 最终回答用简洁的中文总结：做了什么、改了哪些文件、如何验证。",
  ];
  // Plan 模式不给生成类工具，"先找现成素材"的引导也只对能动手的模式有意义。
  if (mode !== "plan") {
    guidelines.push(
      "5. 应用里存着用户和 Agent 生成过的图片 / 语音 / 视频：写文档要配图配声时，先用 media_search 找现成的复用" +
        "（用 media_export 复制到工作区后按相对路径引用），确实没有再 generate_image / generate_speech / generate_video 生成。",
    );
  }
  const sections = [
    "你是 OmniStudio 内置的 Pi Agent —— 一个在用户本机工作区里执行任务的 AI 智能体。",
    currentTimeLine(),
    `工作区根目录：${workspace}`,
    `运行环境：${os.type()} ${os.release()}（${os.arch()}），shell：${process.env.SHELL ?? "/bin/sh"}。`,
    "",
    "工作准则：",
    ...guidelines,
  ];
  // 常驻记忆（启用且有内容时）：置顶/高热记忆作为核心上下文注入。
  const memorySection = memoryPromptSection();
  if (memorySection) sections.push("", memorySection);
  sections.push("", MODE_INSTRUCTION[mode]);
  return sections.join("\n");
}

/**
 * 工具集 = 内置工具 + 素材工具 + 记忆工具 + 已启用 MCP 服务器的工具
 * （连接失败的服务器自动跳过）。Plan 模式只保留内置只读工具与素材检索：
 * 生成 / 导出与记忆 / MCP 工具都可能有副作用，不参与"先出方案"阶段。
 */
async function toolsForMode(mode: AgentMode, workspace: string, conversationId?: number): Promise<AgentTool<any>[]> {
  const allowShell = getSetting("AGENT_ALLOW_SHELL") !== "0";
  const ctx = { workspace, allowShell: allowShell && mode !== "plan" };
  const base = mode === "plan" ? buildReadOnlyTools(ctx) : buildAgentTools(ctx);
  // 素材检索是只读的（看看用户和 Agent 都生成过什么），三模式都给。
  const mediaRead = buildMediaReadTools();
  if (mode === "plan") return [...base, ...mediaRead];
  // 记忆工具带上下文：写入记项目作用域（按工作区隔离）与审计来源（哪个会话写的）。
  const extras = memoryEnabled()
    ? buildMemoryAgentTools({
        scope: workspace,
        sourceRef: conversationId ? `agent:conv-${conversationId}` : "agent",
      })
    : [];
  const mcpTools = await buildMcpAgentTools();
  return [...base, ...mediaRead, ...buildMediaGenTools(ctx), ...extras, ...mcpTools];
}

export async function listAgentTools(mode: AgentMode = getAgentMode()): Promise<AgentToolInfo[]> {
  const tools = await toolsForMode(mode, getAgentWorkspace());
  return tools.map((t) => ({
    name: t.name,
    label: t.label,
    description: t.description ?? "",
  }));
}

type Session = {
  agent: Agent;
  mode: AgentMode;
  workspace: string;
};

/** 每个会话一个 Pi Agent 实例：保存完整 transcript，支持中途打断与多轮继续。 */
const sessions = new Map<number, Session>();

/** 会话是否正在运行（UI 用来禁用输入框 / 显示停止按钮）。 */
const running = new Set<number>();

export function isAgentRunning(conversationId: number): boolean {
  return running.has(conversationId);
}

/** 丢弃会话的 Agent 实例（切换工作区 / 模式后需要重建）。 */
export function resetAgentSession(conversationId: number): void {
  const session = sessions.get(conversationId);
  if (session) {
    try {
      session.agent.abort();
    } catch {
      // ignore
    }
    sessions.delete(conversationId);
  }
  // 生图弹窗还在等用户确认时，会话被重置就把等待一并收尾。
  cancelMediaSetup();
}

/** 把库里的历史消息（仅 user / assistant 正文）回填成 Pi Agent 的 transcript。 */
function historyAsAgentMessages(conversationId: number): AgentMessage[] {
  return getHistory(conversationId)
    .filter((m) => m.content.trim().length > 0)
    .map((m) =>
      m.role === "user"
        ? ({
            role: "user",
            content: [{ type: "text" as const, text: m.content }],
            timestamp: m.createdAt,
          } as AgentMessage)
        : ({
            role: "assistant",
            content: [{ type: "text" as const, text: m.content }],
            api: "openai-completions",
            provider: "omni-studio",
            model: getChatModelName(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: m.createdAt,
          } as unknown as AgentMessage),
    );
}

async function getOrCreateSession(conversationId: number, mode: AgentMode, workspace: string): Promise<Session> {
  const existing = sessions.get(conversationId);
  if (existing && existing.mode === mode && existing.workspace === workspace) return existing;
  if (existing) resetAgentSession(conversationId);

  const { model, streamFn } = createStreamFn();
  const agent = new Agent({
    streamFn,
    initialState: {
      systemPrompt: buildSystemPrompt(mode, workspace),
      model,
      tools: await toolsForMode(mode, workspace, conversationId),
      messages: historyAsAgentMessages(conversationId),
    },
  });
  const session: Session = { agent, mode, workspace };
  sessions.set(conversationId, session);
  return session;
}

/** 从 Pi 的流式事件里取增量文本 / 思考内容。 */
function deltaOf(event: AssistantMessageEvent): { text: string; kind: "reasoning" | "content" } | null {
  if (event.type === "thinking_delta") return { text: event.delta, kind: "reasoning" };
  if (event.type === "text_delta") return { text: event.delta, kind: "content" };
  return null;
}

function describeArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    const json = JSON.stringify(args);
    return json && json.length > 400 ? `${json.slice(0, 400)}…` : json;
  } catch {
    return String(args);
  }
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const content = (result as { content?: { type?: string; text?: string }[] }).content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(result);
}

/**
 * 跑一次 Agent：把用户消息交给 Pi Agent 的工具循环，直到它给出最终回答
 * （或达到步数上限 / 被用户中断）。流式内容复用 chat 的 chunk/done 通道，
 * 工具调用通过 agentEvent 单独推送，前端据此渲染执行轨迹。
 */
/**
 * 把附件拼进交给 Agent 的任务描述里（附件本身不进 transcript，只做上下文）：
 * 文本文件内联内容，图片给出本地路径（本地模型未必支持视觉输入）。
 */
function withAttachments(
  content: string,
  files: { name: string; content: string }[],
  imagePaths: string[],
  recall?: string | null,
): string {
  const parts: string[] = [];
  const text = content.trim();
  if (text) parts.push(text);

  for (const f of files) {
    parts.push(`--- 附件文件：${f.name} ---\n${f.content}\n--- 附件结束 ---`);
  }
  for (const p of imagePaths) {
    parts.push(`--- 附件图片（本地路径）：${p} ---`);
  }
  // 召回的记忆随用户消息一起进来（会随会话正文保留，便于回溯"当时它知道什么"）。
  if (recall) parts.push(`--- 自动召回的相关记忆（仅供参考） ---\n${recall}\n--- 记忆结束 ---`);
  return parts.join("\n\n") || content;
}

export async function runAgentTurn(opts: {
  conversationId: number;
  content: string;
  mode?: AgentMode;
  workspace?: string;
  /** 正文增量（不含思考过程）回调，通话等场景用来逐句 TTS。 */
  onDelta?: (delta: string, kind: "content", messageId: number) => void;
  /** 回合结束（含被中断/出错）时回调，参数为助手消息 id。 */
  onTurnEnd?: (messageId: number) => void;
  /** 用户消息是否由本函数写入。通话场景先落库拿到真实 id 后会置为 false。 */
  insertUserMessage?: boolean;
  /** 附带的文本文件内容，作为上下文拼进任务描述。 */
  files?: { name: string; content: string }[];
  /** 附带的图片本地路径（refs 或绝对路径），以路径形式告知 Agent。 */
  imagePaths?: string[];
}): Promise<{ ok: boolean; error?: string }> {
  const { conversationId, content } = opts;
  const files = (opts.files ?? []).filter((f) => f.name && f.content?.trim());
  const imagePaths = (opts.imagePaths ?? []).filter((p) => p && p.trim());

  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv) return { ok: false, error: "Conversation not found" };
  if (!content.trim()) return { ok: false, error: "Empty message" };

  const modelName = getChatModelName();
  if (!modelName) {
    emitDone({ conversationId, messageId: Date.now(), content: "", error: "No model configured" });
    return { ok: false, error: "No model configured" };
  }
  if (!getChatBaseUrl()) {
    emitDone({
      conversationId,
      messageId: Date.now(),
      content: "",
      error: "No inference server configured",
    });
    return { ok: false, error: "No inference server configured" };
  }

  // 本地模式下自动拉起推理服务器（与对话一致）。
  if (getSetting("SERVER_MODE") === "local") {
    const ready = await ensureServerReady();
    if (!ready.ok) {
      const error = ready.error || "Inference server not ready";
      emitDone({ conversationId, messageId: Date.now(), content: "", error });
      return { ok: false, error };
    }
  }

  const mode = opts.mode ?? getAgentMode();
  const workspace = opts.workspace?.trim() ? path.resolve(opts.workspace) : getAgentWorkspace();
  const maxSteps = Math.max(1, Number(getSetting("AGENT_MAX_STEPS")) || 40);

  if (opts.insertUserMessage !== false) {
    db.insert(messages)
      .values({
        conversationId,
        role: "user",
        content,
        images: imagePaths.length ? JSON.stringify(imagePaths) : undefined,
      })
      .run();
  }

  const existingCount = getHistory(conversationId).length;
  if (existingCount === 1) {
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
  const assistantId = assistant.id;

  const session = await getOrCreateSession(conversationId, mode, workspace);
  const { agent } = session;

  let fullText = "";
  let reasoning = "";
  let step = 0;
  let aborted = false;
  let promptTokens = 0;
  let completionTokens = 0;

  const startedAt = performance.now();
  running.add(conversationId);

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_update": {
        const delta = deltaOf(event.assistantMessageEvent);
        if (!delta || !delta.text) return;
        if (delta.kind === "reasoning") reasoning += delta.text;
        else {
          fullText += delta.text;
          emitChunk({ conversationId, messageId: assistantId, delta: delta.text, kind: delta.kind });
          opts.onDelta?.(delta.text, "content", assistantId);
        }
        return;
      }
      case "turn_end": {
        step += 1;
        const msg = event.message as { usage?: { input?: number; output?: number } };
        promptTokens += msg?.usage?.input ?? 0;
        completionTokens += msg?.usage?.output ?? 0;
        return;
      }
      case "tool_execution_start": {
        recordEvent({
          conversationId,
          messageId: assistantId,
          kind: "tool_start",
          toolName: event.toolName,
          args: event.args,
          output: describeArgs(event.args),
        });
        return;
      }
      case "tool_execution_end": {
        recordEvent({
          conversationId,
          messageId: assistantId,
          kind: "tool_end",
          toolName: event.toolName,
          output: resultText(event.result),
          isError: event.isError,
        });
        return;
      }
      case "agent_end": {
        void event.messages;
        return;
      }
      default:
        return;
    }
  });

  try {
    agent.shouldStopAfterTurn = () => step >= maxSteps;

    // 每轮开始刷新系统提示：核心记忆（置顶 / 高重要度）可能在上几轮里变了，
    // 一轮之内保持稳定，不影响本地推理的前缀缓存。
    agent.state.systemPrompt = buildSystemPrompt(mode, workspace);
    // 按当前问题召回相关记忆，拼进本轮用户消息（不改系统提示，故缓存友好）。
    const recall = await memoryRecallSection(content, { scope: workspace }).catch(() => null);

    await agent.prompt(withAttachments(content, files, imagePaths, recall));

    if (step >= maxSteps) {
      recordEvent({
        conversationId,
        messageId: assistantId,
        kind: "status",
        output: `达到步数上限（${maxSteps} 步），已停止。可以继续追问让它接着做。`,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    aborted = /abort/i.test(msg);
    if (!aborted) {
      recordEvent({ conversationId, messageId: assistantId, kind: "error", output: msg });
      fullText = fullText ? `${fullText}\n\n⚠️ ${msg}` : `⚠️ ${msg}`;
    } else {
      fullText = fullText ? `${fullText}\n\n_（已停止）_` : "_（已停止）_";
    }
  } finally {
    unsubscribe();
    running.delete(conversationId);
  }

  db.update(messages)
    .set({ content: fullText, reasoning: reasoning || null, tokens: completionTokens || null })
    .where(eq(messages.id, assistantId))
    .run();
  db.update(conversations)
    .set({ updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run();

  recordUsage(modelName, promptTokens, completionTokens);

  const elapsedMs = Math.max(1, performance.now() - startedAt);
  const totalTokens = promptTokens + completionTokens;
  emitStats({
    conversationId,
    messageId: assistantId,
    tokens: totalTokens,
    tokensPerSec: Math.round((totalTokens / (elapsedMs / 1000)) * 10) / 10,
    elapsedMs,
  });
  emitDone({ conversationId, messageId: assistantId, content: fullText, reasoning: reasoning || undefined });
  opts.onTurnEnd?.(assistantId);

  return { ok: true };
}

/** 中断当前运行（UI 的"停止"按钮）。 */
export function stopAgentRun(conversationId: number): { ok: boolean } {
  // 正在等用户确认的生图弹窗先收尾，否则工具会一直挂到超时。
  cancelMediaSetup();
  const session = sessions.get(conversationId);
  if (!session) return { ok: false };
  try {
    session.agent.abort();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function getAgentRunState(conversationId: number): AgentRunState {
  return {
    conversationId,
    running: running.has(conversationId),
    mode: getAgentMode(),
    workspace: getAgentWorkspace(),
  };
}

/**
 * 重新运行最后一条回答：删掉它及其之后的消息与轨迹，再用同样的上文跑一次。
 */
export async function regenerateAgentMessage(
  conversationId: number,
  messageId: number,
): Promise<{ ok: boolean; error?: string }> {
  const target = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!target || target.role !== "assistant") return { ok: false, error: "Message not found" };

  const history = getHistory(conversationId);
  const context = history.filter((m) => m.id < messageId);
  const lastUser = [...context].reverse().find((m) => m.role === "user");
  if (!lastUser) return { ok: false, error: "Nothing to regenerate" };

  for (const m of history) {
    if (m.id >= messageId) {
      db.delete(agentEvents).where(eq(agentEvents.messageId, m.id)).run();
      Chat.deleteMessage(conversationId, m.id);
    }
  }
  // 丢弃旧实例，避免残留的工具调用轨迹影响新一轮。
  resetAgentSession(conversationId);

  return runAgentTurn({ conversationId, content: lastUser.content });
}
