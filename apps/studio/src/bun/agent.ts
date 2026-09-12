import { existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";

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
import { getChatModelLabel, getChatRequestModelId } from "./chat-model";
import { recordUsage } from "./stats";
import { buildAgentTools, buildReadOnlyTools, type ToolContext } from "./agent-tools";
import { buildMediaGenTools, buildMediaReadTools } from "./media-tools";
import { cancelMediaSetup } from "./media-setup";
import { buildMcpAgentTools } from "./mcp";
import { buildMemoryAgentTools, memoryEnabled, memoryPromptSection, memoryRecallSection } from "./memory";
import { clearTodos, listTodos, onTodosChanged, writeTodos } from "./agent-todos";
import { deleteArtifact, listArtifacts, onArtifactRecorded, recordArtifact } from "./agent-artifacts";
import {
  askQuestions,
  authorizeToolCall,
  cancelPendingForConversation,
  listPendingPermissions,
  listPendingQuestions,
  onPermissionRequest,
  onPermissionSettled,
  onQuestionAsked,
  onQuestionSettled,
} from "./agent-interactions";
import { compactMessages } from "./agent-compaction";
import { notify } from "./notifications";
import * as Chat from "./chat";

/** Agent 的三种工作模式（对齐 PI-Desktop 的 Agent / Plan / Goal）。 */
export type AgentMode = "agent" | "plan" | "goal";

export const AGENT_MODES: AgentMode[] = ["agent", "plan", "goal"];

/** Agent 运行轨迹中的一条事件（落库后立即返回给 UI）。 */
export type AgentEventRow = {
  id: number;
  conversationId: number;
  messageId: number | null;
  kind: "status" | "tool_start" | "tool_end" | "error" | "subagent_start" | "subagent_end";
  toolName: string | null;
  /** JSON 字符串，UI 渲染时再解析。 */
  args: string | null;
  output: string | null;
  isError: number;
  /** 子智能体事件的归属 id（主 Agent 的事件为 null）。 */
  subagentId: string | null;
  createdAt: number;
};

export type AgentToolInfo = {
  name: string;
  label: string;
  description: string;
  /** 工具分类：read（只读）/ write（有副作用）/ interact（与用户交互）。 */
  group: "read" | "write" | "interact";
  /** 该工具是否需要授权（UI 里用盾牌标记）。 */
  gated: boolean;
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

// 待办 / 产出物 / 交互（授权、提问）四类推送：直接转给 RPC 层，UI 各自订阅。
export const onAgentTodos = onTodosChanged;
export const onAgentArtifact = onArtifactRecorded;
export const onAgentPermissionRequest = onPermissionRequest;
export const onAgentPermissionSettled = onPermissionSettled;
export const onAgentQuestion = onQuestionAsked;
export const onAgentQuestionSettled = onQuestionSettled;

// 授权结果也写进运行轨迹：回看会话时能看清"哪一步被拒绝过、为什么绕路"。
/**
 * 授权与提问都要**落成会话里的两条事件**（请求 + 结果）：
 * 界面据此把确认卡片画在消息流里（而不是弹窗盖住输入框），
 * 回看历史时也还能看到"当时问了什么、用户怎么答的"。
 * 请求 id 存在 args 里，请求与结果按 id 配对。
 */
onPermissionRequest((payload) => {
  if (payload.conversationId > 0) {
    recordEvent({
      conversationId: payload.conversationId,
      messageId: currentMessageId(payload.conversationId),
      kind: "status",
      toolName: "permission_request",
      args: {
        id: payload.id,
        permission: payload.permission,
        pattern: payload.pattern,
        title: payload.title,
        detail: payload.detail,
        tool: payload.toolName,
        expiresAt: payload.expiresAt,
      },
      output: `${payload.permission} · ${payload.pattern}`,
    });
  }
  notify({
    kind: "permission",
    title: `Agent 需要授权：${payload.title}`,
    body: `${payload.permission} · ${payload.pattern}`.slice(0, 200),
    conversationId: payload.conversationId,
  });
});

onPermissionSettled((payload) => {
  if (payload.conversationId <= 0) return;
  const labels: Record<string, string> = {
    once: "已允许（仅本次）",
    session: "已允许（本会话总是）",
    workspace: "已允许（写入工作区规则）",
    deny: "已拒绝",
  };
  recordEvent({
    conversationId: payload.conversationId,
    messageId: currentMessageId(payload.conversationId),
    kind: "status",
    toolName: "permission",
    args: { id: payload.id, reply: payload.reply },
    output: `${labels[payload.reply] ?? payload.reply}：${payload.permission} · ${payload.pattern}`,
  });
});

onQuestionAsked((payload) => {
  if (payload.conversationId <= 0) return;
  recordEvent({
    conversationId: payload.conversationId,
    messageId: currentMessageId(payload.conversationId),
    kind: "status",
    toolName: "question_request",
    args: { id: payload.id, questions: payload.questions },
    output: payload.questions[0]?.question ?? "Agent 有问题要问",
  });
});

onQuestionSettled((payload) => {
  if (payload.conversationId <= 0) return;
  const answers = payload.answers ?? [];
  const flat = answers.map((answer) => answer.join("、")).filter(Boolean);
  recordEvent({
    conversationId: payload.conversationId,
    messageId: currentMessageId(payload.conversationId),
    kind: "status",
    toolName: "question",
    args: { id: payload.id, answers },
    output: flat.length > 0 ? `已回答：${flat.join(" / ")}` : "未作答（跳过或超时）",
  });
});

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
  subagentId?: string | null;
}): AgentEventRow {
  const inserted = db
    .insert(agentEvents)
    .values({
      conversationId: row.conversationId,
      messageId: row.messageId,
      kind: row.kind,
      toolName: row.toolName ?? null,
      subagentId: row.subagentId ?? null,
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

/** 会话删除时清理它的全部附属数据：轨迹、待办、产出物、未决交互。 */
export function deleteConversationEvents(conversationId: number): void {
  db.delete(agentEvents).where(eq(agentEvents.conversationId, conversationId)).run();
  try {
    clearTodos(conversationId);
  } catch {
    // 表缺失时忽略（旧库尚未迁移完成）
  }
  try {
    for (const artifact of listArtifacts(conversationId)) {
      deleteArtifact(artifact.id);
    }
  } catch {
    // 同上
  }
  cancelPendingForConversation(conversationId);
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

/** 确保给定目录存在（工作区可能被用户删掉了）。 */
function ensureDir(target: string): string {
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) {
    try {
      mkdirSync(resolved, { recursive: true });
    } catch {
      // 创建失败时仍然返回该路径，让工具层给出明确的写入错误。
    }
  }
  return resolved;
}

/**
 * 会话的工作区：会话自己指定过就用它（同一份会话列表可以横跨多个项目），
 * 否则回落到全局设置 / 默认工作区。
 */
export function workspaceForConversation(conversationId: number): string {
  try {
    const row = db
      .select({ workspace: conversations.workspace })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (row?.workspace?.trim()) return ensureDir(row.workspace);
  } catch {
    // 表缺少列（旧库）时回落
  }
  return getAgentWorkspace();
}

/** 设置会话的工作区（null = 恢复跟随全局设置）。会话重建后新工作区立即生效。 */
export function setConversationWorkspace(conversationId: number, workspace: string | null): void {
  db.update(conversations)
    .set({ workspace: workspace?.trim() ? path.resolve(workspace) : null })
    .where(eq(conversations.id, conversationId))
    .run();
  resetAgentSession(conversationId);
}

/** 构造指向当前推理服务（本地 llama.cpp / vLLM / SGLang / MLX 或远端 OpenAI 兼容 API）的 pi-ai Model。 */
function buildModel(): Model<"openai-completions"> {
  const base = getChatBaseUrl().replace(/\/+$/, "");
  const baseUrl = /\/v1$/i.test(base) ? base : `${base}/v1`;
  // id 是发请求用的（MLX 下是它认的绝对路径），name 只用于展示。
  const id = getChatRequestModelId();
  const contextWindow = Number(getSetting("SERVER_CTX_SIZE")) || 8192;
  return {
    id,
    name: getChatModelLabel() || id,
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
    "5. 多步任务（3 步以上）先用 todo_write 列出清单，每完成一步就更新状态；只保留一个 in_progress。",
    "6. 需求不确定、或需要用户在多个方案里选一个时，用 ask_user 问清楚再动手，不要自己替他做选择。",
    "7. 需要大范围搜索 / 读很多文件才能定位的内容，用 task 派给子智能体（subagent_type=explore），只把它",
    "   的结论拿回主线，避免自己的上下文被工具输出淹没。",
    "8. 有副作用的操作（跑命令、改工作区外的文件）可能触发用户授权弹窗：被拒绝时不要硬绕，换思路或直接问用户。",
  ];
  // Plan 模式不给生成类工具，"先找现成素材"的引导也只对能动手的模式有意义。
  if (mode !== "plan") {
    guidelines.push(
      "9. 应用里存着用户和 Agent 生成过的图片 / 语音 / 视频：写文档要配图配声时，先用 media_search 找现成的复用" +
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

/** 工具分类：只读 / 有副作用 / 与用户交互（列表页分组展示用）。 */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "knowledge_search",
  "media_search",
  "media_list",
  "memory_search",
  "memory_recall",
]);
const INTERACTIVE_TOOLS = new Set(["todo_write", "ask_user", "task"]);

function toolGroup(name: string): AgentToolInfo["group"] {
  if (INTERACTIVE_TOOLS.has(name)) return "interact";
  return READ_ONLY_TOOLS.has(name) ? "read" : "write";
}

/** 需要授权的工具（弹窗会出现的那些），UI 上打盾牌标记。 */
const GATED_TOOLS = new Set(["bash", "write_file", "edit_file", "task"]);

/**
 * 工具集 = 内置工具 + 素材工具 + 记忆工具 + 已启用 MCP 服务器的工具
 * （连接失败的服务器自动跳过）。Plan 模式只保留内置只读工具与素材检索：
 * 生成 / 导出与记忆 / MCP 工具都可能有副作用，不参与"先出方案"阶段。
 */
async function toolsForMode(
  mode: AgentMode,
  workspace: string,
  conversationId?: number,
  messageId?: number | null,
  /** 无人值守（自动化 / 通话）：ask_user 直接返回"没人回答"，避免干等超时。 */
  headless = false,
): Promise<AgentTool<any>[]> {
  const allowShell = getSetting("AGENT_ALLOW_SHELL") !== "0";
  const ctx: ToolContext = {
    workspace,
    allowShell: allowShell && mode !== "plan",
    conversationId,
    messageId: messageId ?? null,
    onTodoWrite: conversationId
      ? (todos) => {
          writeTodos(conversationId, todos as never);
        }
      : undefined,
    askUser: conversationId && !headless
      ? (questions) =>
          askQuestions({
            conversationId,
            messageId: messageId ?? null,
            questions: questions.map((q) => ({
              question: q.question,
              header: q.header ?? "问题",
              options: q.options ?? [],
              multiple: q.multiple,
            })),
          })
      : undefined,
    spawnSubagent: conversationId
      ? (opts) =>
          runSubagent({
            conversationId,
            parentMessageId: messageId ?? null,
            workspace,
            mode,
            ...opts,
          })
      : undefined,
    recordArtifact: conversationId
      ? (filePath, tool) => {
          recordArtifact({ conversationId, messageId: messageId ?? null, filePath, workspace, tool });
        }
      : undefined,
  };
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
    group: toolGroup(t.name),
    gated: GATED_TOOLS.has(t.name),
  }));
}

type Session = {
  agent: Agent;
  mode: AgentMode;
  workspace: string;
  /** 最近的工具调用指纹，用于识别「原地打转」（同一次调用连续重复）。 */
  recentCalls: string[];
  /** 无人值守运行（自动化）：ask_user 不挂起。 */
  headless: boolean;
  /** 本会话累计省略过多少条历史消息（上下文压缩），用于在轨迹里提示。 */
  compactedDropped: number;
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
  // 挂起的授权 / 提问也一并收尾，否则工具会一直等到超时。
  cancelPendingForConversation(conversationId);
}

/** UI 打开会话时要恢复的挂起交互（切换会话 / 重连后不能丢弹窗）。 */
export function listAgentInteractions(conversationId: number) {
  return {
    permissions: listPendingPermissions(conversationId),
    questions: listPendingQuestions(conversationId),
    todos: listTodos(conversationId),
    artifacts: listArtifacts(conversationId),
  };
}

/** 侧栏里的一个会话（OpenWork 的 session 列表项）。 */
export type AgentSessionView = {
  id: number;
  title: string;
  /** 生效的工作区（会话自己指定过就是它，否则是全局 / 默认工作区）。 */
  workspace: string;
  /** 会话自己指定的工作区（null = 跟随全局设置）。 */
  sessionWorkspace: string | null;
  archived: boolean;
  pinned: boolean;
  running: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** 最近一条消息的摘要（侧栏第二行）。 */
  preview: string;
  todo: { completed: number; total: number };
  /** 有挂起的授权 / 提问：侧栏显示「需要你」。
   *  9 = 该会话正等着用户（前端据此高亮）。 */
  needsAttention: boolean;
};

/**
 * 会话列表：默认只列未归档的，可按标题 / 消息内容搜索。
 * 挂起交互与待办进度一起算出来，侧栏一次请求就能画出状态点。
 */
export function listAgentSessions(opts?: { includeArchived?: boolean; query?: string }): AgentSessionView[] {
  const includeArchived = opts?.includeArchived === true;
  const query = opts?.query?.trim().toLowerCase() ?? "";
  const rows = db
    .select()
    .from(conversations)
    .where(eq(conversations.app, "agent"))
    .orderBy(asc(conversations.id))
    .all();
  if (rows.length === 0) return [];

  // 侧栏每 4 秒轮询一次，所以这里只做三条批量查询（会话 / 消息条数与末条预览 / 待办进度），
  // 绝不按会话逐个 getHistory —— 会话一多就会变成"每次轮询读几万行"。
  const ids = rows.map((row) => row.id);
  const counts = new Map<number, number>(
    db
      .select({ conversationId: messages.conversationId, count: sql<number>`count(*)`.as("count") })
      .from(messages)
      .where(inArray(messages.conversationId, ids))
      .groupBy(messages.conversationId)
      .all()
      .map((row) => [row.conversationId, Number(row.count)]),
  );
  const previews = new Map<number, string>(
    db.all<{ conversation_id: number; content: string }>(
      sql`select m.conversation_id, m.content from messages m
          join (select conversation_id, max(id) as id from messages
                where conversation_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
                group by conversation_id) last
            on last.id = m.id
          where m.content <> ''`,
    ).map((row) => [row.conversation_id, row.content]),
  );
  const todoCounts = new Map<number, { completed: number; total: number }>();
  for (const row of db.all<{ conversation_id: number; status: string; count: number }>(
    sql`select conversation_id, status, count(*) as count from agent_todos
        where conversation_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        group by conversation_id, status`,
  )) {
    const entry = todoCounts.get(row.conversation_id) ?? { completed: 0, total: 0 };
    // cancelled 不计入总数（与 todoProgress 一致）
    if (row.status !== "cancelled") entry.total += Number(row.count);
    if (row.status === "completed") entry.completed += Number(row.count);
    todoCounts.set(row.conversation_id, entry);
  }

  const sessions: AgentSessionView[] = [];
  for (const row of rows) {
    if (!includeArchived && row.archivedAt) continue;
    const preview = previews.get(row.id) ?? "";
    if (query) {
      const hit =
        row.title.toLowerCase().includes(query) || preview.toLowerCase().includes(query);
      if (!hit) continue;
    }
    sessions.push({
      id: row.id,
      title: row.title,
      workspace: row.workspace?.trim() ? row.workspace : getAgentWorkspace(),
      sessionWorkspace: row.workspace ?? null,
      archived: row.archivedAt != null,
      pinned: row.pinned === 1,
      running: running.has(row.id),
      createdAt: row.createdAt ?? Date.now(),
      updatedAt: row.updatedAt ?? Date.now(),
      messageCount: counts.get(row.id) ?? 0,
      preview: preview.replace(/\s+/g, " ").slice(0, 160),
      todo: todoCounts.get(row.id) ?? { completed: 0, total: 0 },
      needsAttention:
        listPendingPermissions(row.id).length > 0 || listPendingQuestions(row.id).length > 0,
    });
  }
  // 置顶优先，其次按最近更新（与对话侧栏一致）。
  return sessions.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

export type AgentSessionSearchHit = {
  id: number;
  title: string;
  workspace: string;
  updatedAt: number;
  /** 正文命中片段（最多 3 条）。 */
  matches: { role: string; snippet: string; createdAt: number }[];
};

/** 命中处前后的片段（给搜索结果看上下文，而不是只给整条正文）。 */
function snippetAround(content: string, keyword: string, radius = 60): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const index = flat.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(flat.length, index + keyword.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * 会话搜索（Agent 侧栏「搜索」入口）：
 * 标题命中 + **正文命中**（原来只匹配最后一条消息，长会话里的内容搜不到），
 * 结果带命中的片段，点开直接跳到那条会话。
 */
export function searchAgentSessions(query: string, limit = 20): AgentSessionSearchHit[] {
  const keyword = query.trim();
  if (keyword.length === 0) return [];
  const pattern = `%${keyword}%`;

  const titleHits = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.app, "agent"), like(conversations.title, pattern)))
    .all();

  const contentHitIds = db
    .selectDistinct({ conversationId: messages.conversationId })
    .from(messages)
    .where(like(messages.content, pattern))
    .all()
    .map((row) => row.conversationId);

  const ids = [...new Set([...titleHits.map((row) => row.id), ...contentHitIds])];
  if (ids.length === 0) return [];

  const rows = db
    .select()
    .from(conversations)
    .where(inArray(conversations.id, ids))
    .orderBy(asc(conversations.id))
    .all();

  const hits: AgentSessionSearchHit[] = [];
  for (const row of rows) {
    const matched = db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, row.id), like(messages.content, pattern)))
      .limit(3)
      .all();
    hits.push({
      id: row.id,
      title: row.title,
      workspace: row.workspace?.trim() ? row.workspace : getAgentWorkspace(),
      updatedAt: row.updatedAt ?? Date.now(),
      matches: matched.map((message) => ({
        role: message.role,
        snippet: snippetAround(message.content, keyword),
        createdAt: message.createdAt ?? Date.now(),
      })),
    });
  }
  // 最近更新的排前面
  return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** 新建一个 Agent 会话（可指定标题与工作区）。 */
export function createAgentSession(input?: { title?: string; workspace?: string }): AgentSessionView {
  const workspace = input?.workspace?.trim() ? path.resolve(input.workspace) : null;
  const created = db
    .insert(conversations)
    .values({
      title: input?.title?.trim() || "新任务",
      app: "agent",
      workspace,
      updatedAt: Date.now(),
    })
    .returning()
    .get();
  return {
    id: created.id,
    title: created.title,
    workspace: workspace ?? getAgentWorkspace(),
    sessionWorkspace: workspace,
    archived: false,
    pinned: false,
    running: false,
    createdAt: created.createdAt ?? Date.now(),
    updatedAt: created.updatedAt ?? Date.now(),
    messageCount: 0,
    preview: "",
    todo: { completed: 0, total: 0 },
    needsAttention: false,
  };
}

/**
 * 子智能体：用同一套模型 + 一套受限工具跑一个独立的 Agent 循环，
 * 只把最终答复交回主 Agent（自己的上下文不回流）。事件带 subagentId 便于 UI 折叠展示。
 */
async function runSubagent(opts: {
  conversationId: number;
  parentMessageId: number | null;
  workspace: string;
  mode: AgentMode;
  description: string;
  prompt: string;
  subagentType: string;
}): Promise<string> {
  const subagentId = randomUUID().slice(0, 8);
  const label = `${opts.subagentType === "explore" ? "探索" : "执行"}：${opts.description}`;
  recordEvent({
    conversationId: opts.conversationId,
    messageId: opts.parentMessageId,
    kind: "subagent_start",
    toolName: "task",
    subagentId,
    output: label,
  });

  const { model, streamFn } = createStreamFn();
  // 子智能体不派子智能体（避免无限递归），也不提问（没人盯着它）；
  // explore 只给只读工具，general 给完整工具（仍受权限策略约束）。
  const ctx: ToolContext = {
    workspace: opts.workspace,
    allowShell: opts.subagentType !== "explore" && getSetting("AGENT_ALLOW_SHELL") !== "0",
    conversationId: opts.conversationId,
    messageId: opts.parentMessageId,
    recordArtifact: (filePath, tool) => {
      recordArtifact({
        conversationId: opts.conversationId,
        messageId: opts.parentMessageId,
        filePath,
        workspace: opts.workspace,
        tool,
      });
    },
  };
  const tools =
    opts.subagentType === "explore"
      ? buildReadOnlyTools(ctx)
      : buildAgentTools(ctx).filter((tool) => tool.name !== "task");

  const agent = new Agent({
    streamFn,
    initialState: {
      systemPrompt: [
        `你是 OmniStudio 的子智能体，被主 Agent 派来${opts.subagentType === "explore" ? "调研" : "执行"}一个子任务。`,
        `工作区根目录：${opts.workspace}`,
        "你只有一个回合的上下文：直接用工具把事做完，然后给出结论。",
        "最终答复必须自包含（主 Agent 看不到你的中间过程），先给结论再给关键证据（文件:行号）。",
        opts.subagentType === "explore" ? "你没有写权限，只做只读调研。" : "",
      ]
        .filter(Boolean)
        .join("\n"),
      model,
      tools,
      messages: [],
    },
    beforeToolCall: async (context, signal) => {
      const toolName = context.toolCall.name;
      const args = (context.args ?? {}) as Record<string, unknown>;
      const denial = await authorizeToolCall({
        conversationId: opts.conversationId,
        messageId: opts.parentMessageId,
        toolName,
        args,
        workspace: opts.workspace,
        argsPreview: describeArgs(args),
        signal,
      });
      if (denial) return { block: true, reason: denial };
      return undefined;
    },
  });

  let text = "";
  let subagentSteps = 0;
  const maxSubagentSteps = Math.max(2, Number(getSetting("AGENT_SUBAGENT_MAX_STEPS")) || 12);
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_update": {
        const delta = deltaOf(event.assistantMessageEvent);
        if (delta?.kind === "content") text += delta.text;
        return;
      }
      case "turn_end": {
        subagentSteps += 1;
        return;
      }
      case "tool_execution_start": {
        recordEvent({
          conversationId: opts.conversationId,
          messageId: opts.parentMessageId,
          kind: "tool_start",
          toolName: event.toolName,
          args: event.args,
          output: describeArgs(event.args),
          subagentId,
        });
        return;
      }
      case "tool_execution_end": {
        recordEvent({
          conversationId: opts.conversationId,
          messageId: opts.parentMessageId,
          kind: "tool_end",
          toolName: event.toolName,
          output: resultText(event.result),
          isError: event.isError,
          subagentId,
        });
        return;
      }
      default:
        return;
    }
  });

  try {
    // 按轮数封顶，而不是"只跑一轮"：子智能体通常要先调研再写结论，
    // 一轮就掐断会让它永远交不出结论 —— 主线拿到的是「（无输出）」。
    agent.shouldStopAfterTurn = () => subagentSteps >= maxSubagentSteps;
    await agent.prompt(opts.prompt);
    recordEvent({
      conversationId: opts.conversationId,
      messageId: opts.parentMessageId,
      kind: "subagent_end",
      toolName: "task",
      subagentId,
      output: text.trim()
        ? `完成：${text.trim().slice(0, 400)}`
        : `已停止（达到子任务步数上限 ${maxSubagentSteps}，未给出结论）`,
      isError: !text.trim(),
    });
    return text.trim();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordEvent({
      conversationId: opts.conversationId,
      messageId: opts.parentMessageId,
      kind: "subagent_end",
      toolName: "task",
      subagentId,
      output: `失败：${message}`,
      isError: true,
    });
    throw e;
  } finally {
    unsubscribe();
  }
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
            model: getChatModelLabel(),
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

async function getOrCreateSession(
  conversationId: number,
  mode: AgentMode,
  workspace: string,
  headless = false,
): Promise<Session> {
  const existing = sessions.get(conversationId);
  if (existing && existing.mode === mode && existing.workspace === workspace && existing.headless === headless) {
    return existing;
  }
  if (existing) resetAgentSession(conversationId);

  const { model, streamFn } = createStreamFn();
  const session: Session = {
    agent: null as unknown as Agent,
    mode,
    workspace,
    recentCalls: [],
    headless,
    compactedDropped: 0,
  };
  const agent = new Agent({
    streamFn,
    initialState: {
      systemPrompt: buildSystemPrompt(mode, workspace),
      model,
      tools: await toolsForMode(mode, workspace, conversationId, currentMessageId(conversationId), headless),
      messages: historyAsAgentMessages(conversationId),
    },
    /**
     * 上下文压缩：本地模型窗口通常只有 8k，长任务必然顶到上限。
     * 每次请求前按预算裁剪历史（保留任务陈述 + 最近若干条），
     * 裁剪发生时会往轨迹里写一条说明，用户能看到"它没忘，只是被裁了"。
     */
    transformContext: async (messages) => {
      const contextWindow = Number(getSetting("SERVER_CTX_SIZE")) || 8192;
      // 留 40% 给系统提示 / 工具定义 / 模型输出；下限取 256，
      // 但不能高过窗口本身的 60%（窗口本身很小的时候，下限会让压缩永远不触发）。
      const budget = Math.max(256, Math.floor(contextWindow * 0.6));
      const result = compactMessages(
        messages as { role?: string; content?: unknown }[],
        budget,
        (dropped) => ({
          role: "user",
          content: [
            {
              type: "text",
              text:
                `（上下文自动压缩：为节省窗口，已省略中间 ${dropped} 条历史消息，` +
                "只保留任务陈述与最近的进展。需要细节时请重新读取文件或重新执行命令。）",
            },
          ],
          timestamp: Date.now(),
        }),
      );
      if (result.dropped > 0) {
        session.compactedDropped += result.dropped;
        recordEvent({
          conversationId,
          messageId: currentMessageId(conversationId),
          kind: "status",
          toolName: "compact",
          output:
            `上下文压缩：省略 ${result.dropped} 条历史消息（约 ${result.tokensBefore} → ${result.tokensAfter} tokens，` +
            `上下文预算 ${budget}）。`,
        });
      }
      return result.messages as typeof messages;
    },
    /**
     * 工具执行前的授权闸门：
     * 1. 先做「原地打转」检测（同一调用连续重复 3 次 → 按 doom_loop 询问）；
     * 2. 再按权限策略评估，ask 会挂起并把请求推给 UI。
     */
    beforeToolCall: async (context, signal) => {
      const toolName = context.toolCall.name;
      const args = (context.args ?? {}) as Record<string, unknown>;
      const fingerprint = `${toolName}:${JSON.stringify(args)}`;
      session.recentCalls.push(fingerprint);
      if (session.recentCalls.length > 8) session.recentCalls.shift();
      const repeats = session.recentCalls.filter((item) => item === fingerprint).length;
      const denial =
        repeats >= 3
          ? await authorizeToolCall({
              conversationId,
              messageId: currentMessageId(conversationId),
              toolName,
              args: { ...args, command: describeArgs(args) },
              workspace,
              argsPreview: describeArgs(args),
              signal,
            })
          : null;
      const blocked =
        denial ??
        (await authorizeToolCall({
          conversationId,
          messageId: currentMessageId(conversationId),
          toolName,
          args,
          workspace,
          argsPreview: describeArgs(args),
          signal,
        }));
      if (blocked) return { block: true, reason: blocked };
      return undefined;
    },
  });
  session.agent = agent;
  sessions.set(conversationId, session);
  return session;
}

/**
 * 当前正在跑的助手消息 id（授权 / 提问 / 产出物都要挂到这条消息上）。
 * 由 runAgentTurn 写入，工具执行时读取。
 */
const activeMessageIds = new Map<number, number | null>();

function currentMessageId(conversationId: number): number | null {
  return activeMessageIds.get(conversationId) ?? null;
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
  /** 无人值守（自动化）：ask_user 立即返回"没人回答"，不挂起等超时。 */
  headless?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const { conversationId, content } = opts;
  const files = (opts.files ?? []).filter((f) => f.name && f.content?.trim());
  const imagePaths = (opts.imagePaths ?? []).filter((p) => p && p.trim());

  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv) return { ok: false, error: "Conversation not found" };
  if (!content.trim()) return { ok: false, error: "Empty message" };

  const modelName = getChatModelLabel();
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
  const workspace = opts.workspace?.trim()
    ? path.resolve(opts.workspace)
    : workspaceForConversation(conversationId);
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

  const session = await getOrCreateSession(conversationId, mode, workspace, opts.headless === true);
  const { agent } = session;
  // 授权弹窗 / 提问 / 产出物都要挂到本轮助手消息上（工具执行时按会话查）。
  activeMessageIds.set(conversationId, assistantId);
  // 新的用户回合开始：上一轮的「原地打转」计数清零。
  session.recentCalls = [];

  let fullText = "";
  let reasoning = "";
  let step = 0;
  let aborted = false;
  let promptTokens = 0;
  let completionTokens = 0;

  const startedAt = performance.now();
  running.add(conversationId);

  /**
   * 增量按帧批量下发（与对话一致）：模型每个 token 一次 RPC 会让 webview
   * 每秒重建几十次消息数组、并整段重解析 Markdown。40ms 一批（≈25fps）
   * 保持"逐字"观感，同时把 IPC 与前端重渲染次数降一个数量级。
   * 思考增量同样下发：界面上就是「思考中…」那一行的实时内容，不再只有一圈转圈。
   */
  const FLUSH_INTERVAL_MS = 40;
  let pendingContent = "";
  let pendingReasoning = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushChunks = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingContent) {
      emitChunk({ conversationId, messageId: assistantId, delta: pendingContent, kind: "content" });
      pendingContent = "";
    }
    if (pendingReasoning) {
      emitChunk({ conversationId, messageId: assistantId, delta: pendingReasoning, kind: "reasoning" });
      pendingReasoning = "";
    }
  };
  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(flushChunks, FLUSH_INTERVAL_MS);
  };

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_update": {
        const delta = deltaOf(event.assistantMessageEvent);
        if (!delta || !delta.text) return;
        if (delta.kind === "reasoning") {
          reasoning += delta.text;
          pendingReasoning += delta.text;
          scheduleFlush();
        } else {
          fullText += delta.text;
          pendingContent += delta.text;
          // 即时消费方（通话边生成边合成）仍按 token 回调，不走批量缓冲。
          opts.onDelta?.(delta.text, "content", assistantId);
          scheduleFlush();
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
    // 收尾前先把缓冲里的增量冲出去，避免 chatDone 先到、尾巴几个字后到。
    flushChunks();
    running.delete(conversationId);
    activeMessageIds.delete(conversationId);
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

  // 通知中心：无人值守的回合（自动化）跑完要留一条记录，方便回看结果。
  if (opts.headless === true) {
    const title = db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()?.title;
    notify({
      kind: "automation",
      title: `自动化跑完：${title ?? "任务"}`,
      body: (fullText || reasoning || "").replace(/\s+/g, " ").slice(0, 200),
      conversationId,
    });
  }

  // 运行中排队进来的消息：本次结束后自动接着跑（不递归等待，交给调用栈上层）。
  if (!aborted && pendingMessages.has(conversationId)) {
    void drainQueuedMessages(conversationId, workspace).catch(() => {
      // 排队消息失败不改变本轮结果，用户能在会话里看到错误轨迹
    });
  }

  return { ok: true };
}

/**
 * 运行中的跟进消息（对齐 OpenWork 的 queued messages / steer）：
 * - steer：立即插进当前这一轮，模型在下一个工具回合就能看到（打断它的既有计划）；
 * - queue：排在本次运行结束后作为新一轮的输入，逐条下发。
 * 两者都会先落库成 user 消息，保证历史与实时上下文一致。
 */
const pendingMessages = new Map<number, string[]>();

export function listQueuedMessages(conversationId: number): string[] {
  return [...(pendingMessages.get(conversationId) ?? [])];
}

export function clearQueuedMessages(conversationId: number): void {
  pendingMessages.delete(conversationId);
}

export function removeQueuedMessage(conversationId: number, index: number): string[] {
  const queue = pendingMessages.get(conversationId) ?? [];
  queue.splice(index, 1);
  if (queue.length === 0) pendingMessages.delete(conversationId);
  else pendingMessages.set(conversationId, queue);
  return [...queue];
}

/**
 * 用户在运行中继续发消息：
 * - 没在跑就当成普通回合直接跑（等价于 sendAgentMessage）；
 * - 在跑且 mode = "steer" → 立即插入当前运行的上下文；
 * - 在跑且 mode = "queue" → 排队，等本次运行结束再自动开一轮。
 */
export async function followUpAgentMessage(opts: {
  conversationId: number;
  content: string;
  mode?: "steer" | "queue";
  workspace?: string;
}): Promise<{ ok: boolean; queued: boolean; error?: string }> {
  const content = opts.content.trim();
  if (!content) return { ok: false, queued: false, error: "Empty message" };

  if (!isAgentRunning(opts.conversationId)) {
    const result = await runAgentTurn({
      conversationId: opts.conversationId,
      content,
      workspace: opts.workspace,
    });
    return { ok: result.ok, queued: false, error: result.error };
  }

  const session = sessions.get(opts.conversationId);
  const mode = opts.mode ?? "queue";
  // 落库：实时上下文与历史都必须能看到这条消息。
  db.insert(messages)
    .values({ conversationId: opts.conversationId, role: "user", content })
    .run();
  db.update(conversations)
    .set({ updatedAt: Date.now() })
    .where(eq(conversations.id, opts.conversationId))
    .run();

  if (mode === "steer" && session) {
    session.agent.steer({
      role: "user",
      content: [{ type: "text" as const, text: content }],
      timestamp: Date.now(),
    } as AgentMessage);
    recordEvent({
      conversationId: opts.conversationId,
      messageId: currentMessageId(opts.conversationId),
      kind: "status",
      output: `已插话（本轮立即生效）：${content.slice(0, 120)}`,
    });
    return { ok: true, queued: false };
  }

  const queue = pendingMessages.get(opts.conversationId) ?? [];
  queue.push(content);
  pendingMessages.set(opts.conversationId, queue);
  recordEvent({
    conversationId: opts.conversationId,
    messageId: currentMessageId(opts.conversationId),
    kind: "status",
    output: `已排队（本次运行结束后执行，第 ${queue.length} 条）：${content.slice(0, 120)}`,
  });
  return { ok: true, queued: true };
}

/** 本次运行结束后把排队的消息逐条跑掉（一条一轮，避免上下文互相干扰）。 */
async function drainQueuedMessages(conversationId: number, workspace: string): Promise<void> {
  for (;;) {
    const queue = pendingMessages.get(conversationId);
    if (!queue || queue.length === 0) return;
    const [next, ...rest] = queue;
    if (rest.length === 0) pendingMessages.delete(conversationId);
    else pendingMessages.set(conversationId, rest);
    const result = await runAgentTurn({ conversationId, content: next!, workspace });
    if (!result.ok) return;
  }
}

/** 中断当前运行（UI 的"停止"按钮）。 */
export function stopAgentRun(conversationId: number): { ok: boolean } {
  // 正在等用户确认的生图弹窗先收尾，否则工具会一直挂到超时。
  cancelMediaSetup();
  // 挂起的授权 / 提问也要收尾：否则 abort 后工具还停在 await 上。
  cancelPendingForConversation(conversationId);
  // 停止 = 连排队中的后续消息一起取消，否则用户以为停了它又自己跑起来。
  clearQueuedMessages(conversationId);
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
