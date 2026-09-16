import { existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { and, asc, eq, gt, inArray, like, sql } from "drizzle-orm";

import {
  Agent,
  type AfterToolCallResult,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
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
import { getSetting, updateSettings } from "./db/settings";
import { getChatBaseUrl, getHistory, ensureServerReady, titleFromMessage } from "./chat";
import { getChatModelLabel, getChatRequestModelId, getChatProviderLabel, chatModelSupportsImages } from "./chat-model";
import { chatContextWindow } from "./chat-context";
import { recordUsage } from "./stats";
import { recordTokenUsage } from "./usage";
import {
  buildAgentTools,
  buildReadOnlyTools,
  createWritePlan,
  errorResult,
  textResult,
  type ToolContext,
  type ToolOutcome,
} from "./agent-tools";
import { loadProjectInstructions } from "./agent-instructions";
import { buildMediaGenTools, buildMediaReadTools } from "./media-tools";
import { buildNotesAgentTools } from "./notes-tools";
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
import { compactMessages, pruneSupersededReads } from "./agent-compaction";
import { applyRewind, checkpointReminderText, type RewindState } from "./agent-checkpoint";
import {
  addGoalUsage,
  createGoal,
  describeGoal,
  getGoal,
  goalContinuationText,
  goalPromptSection,
  isTerminal,
  maxGoalContinuations,
  onGoalChanged,
  setGoalStatus,
} from "./agent-goals";
import { onPlanChanged, planHandoffSection, savePlan } from "./agent-plans";
import { estimateMessagesTokens } from "../shared/token-estimate";
import {
  buildHistoryMessages,
  dropCurrentPrompt,
  planRegenerate,
  planRevertToMessage,
} from "./agent-history";
import { currentTime } from "./current-time";
import { createChunkFlusher } from "./chunk-flusher";
import { findSummaryCut, summarizeHistory, summaryMessageText } from "./agent-summary";
import { skillsPromptSection } from "./agent-skills";
import { approvalMode, type ApprovalMode } from "./permissions";
import { sandboxMode } from "./agent-sandbox";
import { createTurnSnapshot, revertToSnapshot } from "./agent-snapshots";
import { getWorkspaceChanges, getWorkspaceDiff, isGitRepo } from "./workspace-changes";
import {
  contextUsage,
  forgetPromptTokens,
  rememberPromptTokens,
  type ContextUsage,
} from "./agent-context";
import { estimateTokens } from "./agent-compaction";
import {
  DEFAULT_RETRY_ATTEMPTS,
  MAX_EMPTY_TURN_NUDGES,
  attachTurnRecovery,
  dropTrailingFailures,
  failureReasonOf,
  isRetryableTurnFailure,
  lastAssistantMessage,
  retryBackoffMs,
  retryNoticeText,
} from "./agent-retry";
import {
  MAX_TOOL_OUTPUT_CHARS,
  clearConversationSpills,
  spillToolOutput,
  truncateForModel,
} from "./agent-spill";
import { computeTokenStats, type MessageStats } from "./chat-stats";
import { runHooks } from "./agent-hooks";
import { classifyTurnOutcome } from "./agent-outcome";
import { notify } from "./notifications";
import * as ViewState from "./view-state";
import { logEvent } from "./app-log";
import * as Chat from "./chat";

/** Agent 的三种工作模式（对齐 PI-Desktop 的 Agent / Plan / Goal）。 */
export type AgentMode = "agent" | "plan" | "goal";

export const AGENT_MODES: AgentMode[] = ["agent", "plan", "goal"];

/** Agent 运行轨迹中的一条事件（落库后立即返回给 UI）。 */
export type AgentEventRow = {
  id: number;
  conversationId: number;
  messageId: number | null;
  kind:
    | "status"
    | "tool_start"
    | "tool_end"
    | "error"
    | "subagent_start"
    | "subagent_end"
    /**
     * 模型在**某一步**说的话（正文片段）。
     *
     * 一条助手消息的正文是整轮拼接的（多个步骤的话连成一整块），正文里没有
     * "这句话说在哪次工具调用之前"这个信息；而界面要的是时间轴：说了什么 →
     * 调了什么工具 → 又说了什么。所以每个步骤的正文额外落成一条带顺序的事件，
     * 由 runAgentTurn 在"这一步的工具开始执行之前"冲出来（见 flushStepText）。
     */
    | "text";
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

/**
 * 本轮助手消息的行刚建好（开跑瞬间，一个字还没出）。
 *
 * 这条推送是"点发送之后立刻有反馈"的唯一来源：建会话、起推理服务、等模型加载
 * 都发生在第一个 token 之前，界面要等到那时才建得出消息行的话，干等的那几十秒
 * 屏幕上什么都没有 —— 用户看到的就是"程序挂了"。
 */

/**
 * 回合用量统计的推送负载：与聊天路径共用 `chat-stats.ts` 的 `MessageStats`
 * （输入 / 输出 / 思考 tokens、首 token 耗时、两种吞吐…），
 * 额外带上本轮结束时的上下文占用（输入框上方的占用条用它）。
 */
type StatsListener = (
  payload: MessageStats & {
    conversationId: number;
    messageId: number;
    context?: ContextUsage;
  },
) => void;

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
export const onAgentGoalChanged = onGoalChanged;
export const onAgentPlanChanged = onPlanChanged;

/** 切换 Agent 模式（`/plan`、Goal 面板、批准方案后的执行都用这一条，避免各处各写一遍）。 */
export function setAgentMode(mode: AgentMode): void {
  const next = AGENT_MODES.includes(mode) ? mode : "agent";
  if (getSetting("AGENT_MODE") === next) return;
  updateSettings({ AGENT_MODE: next });
}
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

/**
 * 会话的运行轨迹。`afterId` = 只取比它新的事件（增量）。
 *
 * 为什么要增量：轨迹在界面上主要靠 `agentEvent` 推送逐条追加，而推送不是可靠的
 * 账本 —— 窗口被系统节流、webview 刷新过、消息在信道里丢了，都会让界面停在某一刻，
 * 库里却还在继续写。界面于是在跑动中按 `afterId` 定期追平一次（见 app/agent/conversation.tsx 的
 * tail 轮询）：正常情况下每次返回空数组，几乎不花钱；真丢了推送时就把缺的那几条补上。
 * `afterId = 0` 就是"整份列表"（打开会话时用）。
 */
export function listAgentEvents(conversationId: number, afterId = 0): AgentEventRow[] {
  return db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.conversationId, conversationId), gt(agentEvents.id, afterId)))
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
  // 工具输出的转存文件（`agent-spill.ts`）：会话没了它们也没有归属，一并清掉。
  clearConversationSpills(conversationId);
  stopRequests.delete(conversationId);
  // 上下文用量缓存按会话 id 记（`agent-context.ts`）。不清的话，删掉的会话会把自己的
  // 实测 token 数一直留在内存里，而且 id 被复用时会拿旧值当"这次请求的用量"报出去。
  forgetPromptTokens(conversationId);
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

/**
 * 推理等级（`AGENT_THINKING_LEVEL`）。`off` = 请求里不带任何推理参数。
 *
 * 这里只负责取值与校验：真正决定"服务端吃不吃"的是模型本身。所以 UI 把它当成一个
 * 纯偏好暴露，选错最多是这一轮被服务端拒绝，不会被静默改写成别的参数。
 */
export const AGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

export function getAgentThinkingLevel(): AgentThinkingLevel {
  const level = getSetting("AGENT_THINKING_LEVEL") as AgentThinkingLevel;
  return AGENT_THINKING_LEVELS.includes(level) ? level : "off";
}

export function setAgentThinkingLevel(level: AgentThinkingLevel): void {
  const next = AGENT_THINKING_LEVELS.includes(level) ? level : "off";
  if (getSetting("AGENT_THINKING_LEVEL") === next) return;
  updateSettings({ AGENT_THINKING_LEVEL: next });
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
  const remote = getSetting("SERVER_MODE") !== "local";
  const contextWindow = chatContextWindow();
  const thinking = getAgentThinkingLevel();
  return {
    id,
    name: getChatModelLabel() || id,
    api: "openai-completions",
    provider: "omni-studio",
    baseUrl,
    // 是否支持 reasoning 由服务端决定，所以只在用户显式选了等级时才声明支持 ——
    // 声明 true 会让 pi-ai 把推理参数发出去，不支持的模型会直接 400。
    // 默认 off 时保持 false，行为与没有这个开关时完全一致。
    reasoning: thinking !== "off",
    // 声明支持 image 后，pi-ai 才会把 view_image 的图片块随工具结果发出去；
    // 纯文本模型声明了会被服务端 400，所以跟着模型探测走。
    input: chatModelSupportsImages() ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // 输出上限：本地跟随窗口一半（小窗口下很现实）；云端各家有自己的输出天花板
    // （deepseek-chat 8k、qwen-max 8k……），统一 8k —— 窗口一半动辄 64k 的请求
    // 会被厂商 400 拒掉，宁可封得保守，模型正常自己会 EOS 收尾。
    maxTokens: remote ? 8192 : Math.max(1024, Math.floor(contextWindow / 2)),
  };
}

/**
 * 当前"发给谁"的标识：模式 + 请求模型 id + 地址。
 * 三者任一变了都算换模型（本地实例换了、云端换了厂商 / 模型、切了本地↔云端）。
 */
export function currentModelKey(): string {
  // 推理等级也算进 key：它改的是 `buildModel().reasoning` 与 initial state，
  // 只改设置不重建会话的话，新一轮仍会用旧的模型对象发请求。
  return `${getSetting("SERVER_MODE") === "local" ? "local" : "remote"}:${getChatRequestModelId()}:${getChatBaseUrl()}:${getAgentThinkingLevel()}`;
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
    models,
    /**
     * 传输层重试：`maxRetries` 交给 pi-ai 的 `retryProviderRequest`
     * （408/409/429/5xx 与网络错误按指数退避重试，遵守服务端 `retry-after`、带抖动）。
     *
     * 不配它的话默认是 **0 次**：本地推理服务「模型还在加载」时返回的 503、
     * 云端偶发的 429 都会直接变成一条失败回合 —— 用户看到的是「任务跑一半没了」。
     * 内核对 SDK 用的是 `maxRetries: 0` + 自己的可中断退避，所以这里传的值是唯一入口。
     *
     * `maxRetryDelayMs` 压到 30s：服务端要是让我们等更久（比如限流窗口 60s），
     * 宁可当场失败，交给上层那条**用户看得见**的回合级重试去处理。
     */
    streamFn: (m: Model<string>, context: Context, options?: SimpleStreamOptions) =>
      models.streamSimple(m as Model<"openai-completions">, context, {
        ...options,
        maxRetries: options?.maxRetries ?? retryAttempts(),
        maxRetryDelayMs: options?.maxRetryDelayMs ?? 30_000,
      }),
  };
}

/**
 * 自愈的重试预算（设置 `AGENT_RETRY_MAX`，默认 2，0 = 全关）。
 *
 * 一处开关管三件事：传输层 `maxRetries`、回合层的失败重发、空回合提醒。
 * 它们的代价是同一种（多花一次推理），所以不该拆成三个用户要理解的旋钮。
 */
function retryAttempts(): number {
  const raw = Number(getSetting("AGENT_RETRY_MAX"));
  if (!Number.isFinite(raw)) return DEFAULT_RETRY_ATTEMPTS;
  return Math.min(5, Math.max(0, Math.floor(raw)));
}

/**
 * 工具结果的最后一道处理：**超限就转存 + 截断 + 给出读回路径**。
 *
 * 为什么放在 `afterToolCall` 而不是每个工具里：
 * - 一处生效，所有工具（含 MCP / 媒体 / 会话新增的）行为一致；
 * - 它在内核里**早于** `tool_execution_end` 事件执行，所以事件流与 `agent_events`
 *   里落的也是截断后的文本 —— 一次大输出不会把数据库撑爆。
 *
 * 图片结果（`view_image`）与短结果原样放行，只动纯文本。
 */
function makeToolOutputHook(conversationId: number) {
  return async (context: {
    toolCall: { name: string };
    result: unknown;
  }): Promise<AfterToolCallResult | undefined> => {
    const text = resultText(context.result);
    if (text.length <= MAX_TOOL_OUTPUT_CHARS) return undefined;
    const spill = spillToolOutput({ conversationId, toolName: context.toolCall.name, text });
    logEvent({
      level: "info",
      source: "agent",
      event: "agent.tool_output.spilled",
      message: `工具输出超限（${text.length} 字符），已截断${spill ? `并转存到 ${spill.path}` : "（转存失败）"}`,
      detail: { conversationId, tool: context.toolCall.name, chars: text.length, spill: spill?.path ?? null },
    });
    return {
      content: [{ type: "text" as const, text: truncateForModel(text, { spillPath: spill?.path ?? null }).text }],
    };
  };
}

/**
 * 用户按过停止的会话。
 *
 * 「上一轮失败 → 退避 → 再发一次」这段发生在一轮**跑完之后**（`agent.prompt()`
 * 已经返回、`agent.signal` 也空了），所以内核的 abort 传不到这里 —— 只有靠这条
 * 显式标记，用户在退避期间按停止才拦得住下一次请求。
 */
const stopRequests = new Set<number>();

/** 等一会儿再重试，期间响应停止请求（100ms 一跳，最多等 ms 毫秒）。 */
async function sleepWithStop(conversationId: number, ms: number): Promise<void> {
  const step = 100;
  for (let waited = 0; waited < ms; waited += step) {
    if (stopRequests.has(conversationId)) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
  }
}

/** 空回合提醒的那条消息与"装上自愈"都在 agent-retry.ts 里（纯逻辑，有单测）。 */

/**
 * 本轮的时间提醒。
 *
 * 它**不能**放进系统提示：系统提示是请求里最靠前的内容，而这个字符串带时分，
 * 分钟一翻就改掉前缀最早的几个字节 —— 开了前缀缓存的后端（llama.cpp
 * `--cache-reuse`、vLLM APC、SGLang radix）会因此把系统提示 + 工具 schema +
 * 整段历史全部重算。改挂在「本轮用户消息」上：一轮之内是常量，跨轮变化也只动尾部。
 */
function currentTimeLine(): string {
  const { date, time, tz } = currentTime();
  return `当前日期时间是 ${date} ${time}（时区 ${tz}）。涉及"今天/最新/最近"的内容必须以此为据。`;
}

const MODE_INSTRUCTION: Record<AgentMode, string> = {
  agent: [
    "你是 Agent 模式：直接把事情做完。",
    "先探查再动手，能改就改，改完用命令验证（测试 / 构建 / lint）。",
    "遇到不确定的地方优先用工具确认，不要凭猜测下结论。",
  ].join("\n"),
  plan: [
    "你是 Plan 模式：只做调研和产出实施方案，绝不修改工作区里的任何文件、绝不执行写操作。",
    "可用工具仅限只读工具（读取文件、列目录、搜索、联网检索）。",
    "**把方案用 write_plan 写下来**（那是你唯一能写的东西，写进应用的数据目录，不碰工作区），"
      + "然后在回复里简短说明要点并停下 —— 用户会决定批准还是让你改。",
    "方案要能被没参与这次对话的人直接执行：目标、要改哪些文件（带路径）、分步改动、风险、怎么验证。",
    "方案里提到的每个路径都必须是**这次会话里真的读过**的；没验证过的要标注出来。",
    "只写不做的原因：先让用户看清代价与影响面，再决定要不要动手。",
  ].join("\n"),
  goal: [
    "你是 Goal 模式：先与用户对齐目标与验收标准，然后自主选择路径把目标达成。",
    "开工前先用一句话复述你要达成的目标和验收标准，再执行。",
    "过程中持续用命令验证，直到验收标准全部满足才停止。",
  ].join("\n"),
};

function buildSystemPrompt(mode: AgentMode, workspace: string, goalSection?: string | null): string {
  const guidelines = [
    "1. 路径尽量用相对工作区的相对路径；绝对路径只允许落在工作区内用于写操作。",
    "2. 一次只调用当下最需要的工具，拿到结果再决定下一步，不要成批猜测。",
    "3. 改代码优先用 apply_patch：一个补丁可以同时改多个文件，而且要么全改要么全不改；" +
      "只有单点小改才用 edit_file，新建整份文件用 write_file。",
    "4. 不要「打开文件碰运气」：先用 grep / glob 定位，再用 read_file 的 offset / limit 读需要的段落，" +
      "而不是整份读进来。工具报错、或文件在你读之后被改过 → 重新读，不要凭印象改。",
    "5. 多步任务（3 步以上）先用 todo_write 列出清单，每完成一步就更新状态；只保留一个 in_progress。",
    "6. 需求不确定、或需要用户在多个方案里选一个时，用 ask_user 问清楚再动手，不要自己替他做选择。",
    "7. 子智能体要**先摸底再决定**：自己先用 grep / glob / read 看清范围，不要开局就派。" +
      "只有**两个以上互不依赖、各自都要读很多文件**的调研才值得派；只有一个方向时自己做完更快。" +
      "派出去之后就别管着它 —— 等它给结论，不要再派一个去做同一件事。",
    "8. 有副作用的操作（跑命令、改工作区外的文件）可能触发用户授权弹窗：被拒绝时不要硬绕，换思路或直接问用户。",
  ];
  // Plan 模式不给生成类工具，"先找现成素材"的引导也只对能动手的模式有意义。
  if (mode !== "plan") {
    guidelines.push(
      "9. 应用里存着用户和 Agent 生成过的图片 / 语音 / 视频：写文档要配图配声时，先用 media_search 找现成的复用" +
        "（用 media_export 复制到工作区后按相对路径引用），确实没有再 generate_image / generate_speech / generate_video 生成。",
    );
  }
  /**
   * 记忆的写入引导。
   *
   * 常驻记忆（置顶/高重要度）会进系统提示，所以把"该记什么"讲清楚比让模型自己悟划算。
   * 有意的边界：**不在回合结束时自动抽取记忆** —— 那需要每 N 轮多跑一次推理，
   * 本地模型上这笔开销该由用户显式选择（对齐摘要式压缩的取舍）。
   */
  if (getSetting("MEMORY_ENABLED") === "1" && mode !== "plan") {
    guidelines.push(
      "10. 任务里产生了**下次还用得上**的结论时（用户的稳定偏好、项目约定、踩过的坑与解法），" +
        "用 memory_save 记一条；只记结论性的一句话，不要记流水账，也不要记这次任务的一次性细节。" +
        "拿不准是否值得记时就不记 —— 记忆库堆满无关内容反而会让后续召回变差。",
    );
  }
  const sections = [
    "你是 OmniStudio 内置的 Pi Agent —— 一个在用户本机工作区里执行任务的 AI 智能体。",
    `工作区根目录：${workspace}`,
    `运行环境：${os.type()} ${os.release()}（${os.arch()}），shell：${process.env.SHELL ?? "/bin/sh"}。`,
    "",
    "工作准则：",
    ...guidelines,
    "",
    "做完之前先验证（按你改了什么选一种，别跳过）：",
    "- 改了代码 → 真的跑一次（测试 / 构建 / 直接运行），把命令和输出写进总结；",
    "- 改了文档 / 配置 → 重新读一遍落盘后的内容，确认写进去的是你以为的东西；",
    "- 生成了媒体 / 复制了文件 → 确认目标路径下真的存在（list_dir 或读一次）；",
    "- 修 bug → 先能复现、修完确认不再复现，两者都要有命令依据。",
    "没法验证时（环境不具备、需要用户机器上的东西）就**明说没验证**，不要用「应该没问题」糊过去。",
    "",
    "交付要求：",
    "- 没做完就别说做完；没验证过的结论要写明是推测。",
    "- 不要编造：文件内容、命令输出、测试结果都要有工具调用作为依据。",
    "- 不要偷偷缩小范围：说好做 A 就做 A，做不到就说清卡在哪，不要交一个「A 的一部分」当成 A。",
    "- 不要治症状：用抑制报错、特判输入这类办法绕开问题时，先说清楚为什么这才是对的。",
    "- 最终回答用简洁的中文写清：做了什么、改了哪些文件、怎么验证的。",
  ];
  // 项目指令（AGENTS.md）：仓库自己的约定比通用准则更贴近现场，放在记忆之前。
  const instructions = loadProjectInstructions(workspace);
  if (instructions.section) sections.push("", instructions.section);
  // 已安装的 Skills：只列「名字: 描述」，正文让模型用 read_skill 按需取（渐进披露）。
  // 放在项目指令之后：技能是"做法"，项目约定是"现场规矩"，后者更该压过前者。
  if (getSetting("AGENT_SKILLS_PROMPT") !== "0") {
    const skillsSection = skillsPromptSection();
    if (skillsSection) sections.push("", skillsSection);
  }
  /**
   * Goal 模式的目标段落。
   *
   * 放在项目指令之后、记忆之前：目标比"仓库约定"更该压过一切 —— 它是这一轮存在的理由。
   * 只有目标存在且未终结时才注入，所以普通会话的系统提示一个字节都不会变（缓存友好）。
   */
  if (goalSection) sections.push("", goalSection);
  // 常驻记忆（启用且有内容时）：置顶/高热记忆作为核心上下文注入。
  const memorySection = memoryPromptSection();
  if (memorySection) sections.push("", memorySection);
  sections.push("", MODE_INSTRUCTION[mode]);
  return sections.join("\n");
}

/** 工具分类：只读 / 有副作用 / 与用户交互（列表页分组展示用）。名字要与工具真实注册名一致。 */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "view_image",
  "web_search",
  "web_fetch",
  "knowledge_search",
  "get_context_remaining",
  "media_search",
  "memory_search",
  "read_skill",
  "think",
]);
const INTERACTIVE_TOOLS = new Set(["todo_write", "ask_user", "task", "request_permissions"]);

function toolGroup(name: string): AgentToolInfo["group"] {
  if (INTERACTIVE_TOOLS.has(name)) return "interact";
  return READ_ONLY_TOOLS.has(name) ? "read" : "write";
}

/** 需要授权的工具（弹窗会出现的那些），UI 上打盾牌标记。 */
const GATED_TOOLS = new Set(["bash", "write_file", "edit_file", "apply_patch", "task"]);

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
  /**
   * 系统提示的 token 估算（get_context_remaining 用；子智能体不传）。
   */
  systemPromptTokens?: number,
  /**
   * 需要会话上下文的工具回调（checkpoint / rewind / goal / write_plan）。
   * 子智能体不传：它只有一个回合，打点收网与目标管理都没有意义。
   */
  toolHooks?: {
    onCheckpoint?: (goal: string) => ToolOutcome;
    onRewind?: (input: { report: string; revertFiles: boolean }) => Promise<ToolOutcome>;
    onGoal?: (input: { op: string; objective?: string; acceptance?: string; outcome?: string }) => ToolOutcome;
    onWritePlan?: (content: string) => ToolOutcome;
  },
): Promise<AgentTool<any>[]> {
  const allowShell = getSetting("AGENT_ALLOW_SHELL") !== "0";
  /**
   * 本轮助手消息 id 必须**调用时现取**，不能用建工具集那一刻的值。
   *
   * 会话实例（连带这份工具集）是跨回合复用的：模型 / 工作区 / 无人值守没变就一直
   * 沿用（见 getOrCreateSession），于是建会话时 `currentMessageId()` 要么是 null
   * ——第一轮里助手消息还没建出来——要么指向**上一轮**的消息。产出物就是这么丢的：
   * 自动化那一轮产出的报告挂在了 message_id = NULL 上，右侧面板里能看到、消息底下
   * 却没有卡片，点回看还以为它什么都没写。提问与授权请求同理（弹窗记录挂错消息）。
   * 子智能体不走这里：它的父消息由 runSubagent 显式钉住。
   */
  const messageIdNow = () =>
    (conversationId != null ? currentMessageId(conversationId) : null) ?? messageId ?? null;
  const ctx: ToolContext = {
    workspace,
    allowShell: allowShell && mode !== "plan",
    vision: chatModelSupportsImages(),
    systemPromptTokens,
    conversationId,
    // 快照值，供工具自身读取；注入的回调一律用 messageIdNow()（见上）。
    messageId: messageIdNow(),
    onCheckpoint: toolHooks?.onCheckpoint,
    onRewind: toolHooks?.onRewind,
    onGoal: toolHooks?.onGoal,
    onWritePlan: toolHooks?.onWritePlan,
    onTodoWrite: conversationId
      ? (todos) => {
          writeTodos(conversationId, todos as never);
        }
      : undefined,
    askUser: conversationId && !headless
      ? (questions) =>
          askQuestions({
            conversationId,
            messageId: messageIdNow(),
            questions: questions.map((q) => ({
              question: q.question,
              header: q.header ?? "问题",
              options: q.options ?? [],
              multiple: q.multiple,
            })),
          })
      : undefined,
    /**
     * 沙箱升级（对齐 Codex 的 sandbox_approval）：命令被沙箱拦下后问用户
     * "跳过沙箱重跑一次"。无人值守不注入 —— 没人可问，就如实报告被拦。
     */
    escalateSandbox:
      conversationId && !headless
        ? (input) =>
            authorizeToolCall({
              conversationId,
              messageId: messageIdNow(),
              toolName: "escalate_sandbox",
              args: { command: input.command, output: input.output },
              workspace,
              argsPreview: input.command,
            })
        : undefined,
    spawnSubagent: conversationId
      ? (opts) =>
          runSubagent({
            conversationId,
            parentMessageId: messageIdNow(),
            workspace,
            mode,
            ...opts,
          })
      : undefined,
    recordArtifact: conversationId
      ? (filePath, tool) => {
          recordArtifact({ conversationId, messageId: messageIdNow(), filePath, workspace, tool });
        }
      : undefined,
  };
  const base = mode === "plan" ? buildReadOnlyTools(ctx) : buildAgentTools(ctx);
  // 素材检索是只读的（看看用户和 Agent 都生成过什么），三模式都给。
  const mediaRead = buildMediaReadTools();
  // 笔记三件套（list / search / read）同样是只读：Plan 模式分析需求时也该读得到
  // 用户之前写下的东西。开关关掉时它返回空数组（工具直接不出现）。
  const notesRead = buildNotesAgentTools();
  // Plan 模式只多一个 write_plan：方案要能留痕（否则切回 Agent 模式后模型手里没有那份方案）。
  // 它写的是数据目录，不碰工作区，所以"Plan 模式不改任何东西"这条仍然成立。
  if (mode === "plan") return [...base, ...mediaRead, ...notesRead, createWritePlan(ctx)];
  // 记忆工具带上下文：写入记项目作用域（按工作区隔离）与审计来源（哪个会话写的）。
  const extras = memoryEnabled()
    ? buildMemoryAgentTools({
        scope: workspace,
        sourceRef: conversationId ? `agent:conv-${conversationId}` : "agent",
      })
    : [];
  const mcpTools = await buildMcpAgentTools();
  return [...base, ...mediaRead, ...notesRead, ...buildMediaGenTools(ctx), ...extras, ...mcpTools];
}

/**
 * 手动压缩（对齐 Codex 的 `/compact`）：现在就把这段上下文收紧一次。
 *
 * 与自动压缩（`transformContext`）的区别只有一个：**预算更紧** —— 自动压缩是
 * "顶到 60% 窗口才裁"，而手动压缩是用户主动说"多留点余量"，所以按预算的一半裁。
 * 不这么设计的话，手动压缩在没顶到预算时什么都不会发生（用户会以为按钮坏了）。
 *
 * 只作用于**当前会话的上下文**：库里的消息一条不删（回看历史还是完整的），
 * 因此重开会话 / 换模型时会从库里重新装载完整历史 —— 这一点在文档里写明了。
 */
export function compactConversationNow(conversationId: number): {
  ok: boolean;
  dropped: number;
  tokensBefore: number;
  tokensAfter: number;
  budgetTokens: number;
  reason?: string;
} {
  const session = sessions.get(conversationId);
  if (!session) {
    return {
      ok: false,
      dropped: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      budgetTokens: 0,
      reason: "这个会话还没跑过（没有可压缩的上下文）",
    };
  }
  const contextWindow = chatContextWindow();
  const autoBudget = Math.max(256, Math.floor(contextWindow * 0.6));
  const budget = Math.max(256, Math.floor(autoBudget / 2));
  const messages = session.agent.state.messages as { role?: string; content?: unknown }[];
  const result = compactMessages(messages, budget, (dropped) => ({
    role: "user",
    content: [
      {
        type: "text",
        text:
          `（用户手动压缩：为留出余量，已省略中间 ${dropped} 条历史消息，` +
          "只保留任务陈述与最近的进展。需要细节时请重新读取文件或重新执行命令。）",
      },
    ],
    timestamp: Date.now(),
  }));

  if (result.dropped === 0) {
    return {
      ok: true,
      dropped: 0,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensBefore,
      budgetTokens: budget,
      reason: `当前上下文约 ${result.tokensBefore} tokens，没超过手动压缩的预算 ${budget}，无需裁剪`,
    };
  }

  session.agent.state.messages = result.messages as never;
  session.compactedDropped += result.dropped;
  // 手动压缩是**真的**把 transcript 换掉了（不是只影响本次请求），旧的摘要记账
  // 对应的是被替换之前的消息下标，留着会错位 —— 直接作废，下一轮按新历史重新判断。
  session.summary = null;
  recordEvent({
    conversationId,
    messageId: currentMessageId(conversationId),
    kind: "status",
    toolName: "compact",
    output:
      `手动压缩：省略 ${result.dropped} 条历史消息（约 ${result.tokensBefore} → ${result.tokensAfter} tokens，` +
      `手动预算 ${budget}）。库里记录不删，回看会话仍是完整的。`,
  });
  return {
    ok: true,
    dropped: result.dropped,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    budgetTokens: budget,
  };
}

/**
 * 会话配置速览（对齐 Codex 的 `/status`）：模型 / 窗口 / 预算 / 审批与沙箱档位。
 * 全部取自现有模块（`agent-context` 的占用与预算、`permissions` 的审批档位），
 * 不另存一份状态 —— 避免"界面显示的和真正生效的不是同一个值"。
 */
export function describeAgentSession(conversationId: number): {
  model: string;
  mode: AgentMode;
  workspace: string;
  serverMode: "local" | "remote";
  contextWindow: number;
  contextBudget: number;
  usedTokens: number;
  remainingTokens: number;
  percent: number;
  usageSource: "usage" | "estimate";
  approvalMode: ApprovalMode;
  thinkingLevel: AgentThinkingLevel;
  sandboxMode: string;
  droppedSoFar: number;
  needsAttention: boolean;
} {
  const session = sessions.get(conversationId);
  const usage = contextUsage(conversationId, { systemPromptTokens: session?.systemPromptTokens });
  return {
    model: getChatModelLabel() || getChatRequestModelId() || "(未配置)",
    mode: session?.mode ?? getAgentMode(),
    workspace: session?.workspace ?? workspaceForConversation(conversationId),
    serverMode: getSetting("SERVER_MODE") === "local" ? "local" : "remote",
    contextWindow: usage.windowTokens,
    contextBudget: usage.budgetTokens,
    usedTokens: usage.usedTokens,
    remainingTokens: usage.remainingTokens,
    percent: usage.percent,
    usageSource: usage.source,
    approvalMode: approvalMode(),
    thinkingLevel: getAgentThinkingLevel(),
    sandboxMode: sandboxMode(),
    droppedSoFar: session?.compactedDropped ?? 0,
    needsAttention: false,
  };
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
  /** 系统提示的 token 估算：没有实测用量时算上下文占用要用它。 */
  systemPromptTokens: number;
  /**
   * session_start hook 注入的段落。**必须留在会话上**：每轮开始都会重建系统提示
   * （记忆 / AGENTS.md 可能变了），不带着它就等于第一轮之后被悄悄丢掉。
   */
  startupContext: string;
  /** 建这个会话时用的模型（`currentModelKey()`）：换了模型要重建会话。 */
  modelKey: string;
  /**
   * 摘要式压缩的记账（`AGENT_COMPACT_MODE=summary` 时用）。
   *
   * 必须记在会话上：摘要是一次真实的模型调用，每轮重算会变成"压缩比不压缩还慢"。
   * `coveredCount` 表示前 N 条消息已经被这段摘要取代（换会话 / 重新生成时整块丢掉）。
   */
  summary: { text: string; coveredCount: number; tokensBefore: number } | null;
  /** 正在进行的摘要调用：同一会话同时只允许一次，避免并发重复计费。 */
  summarizing: Promise<void> | null;
  /**
   * 本轮的回合快照 id（`createTurnSnapshot` 的产物）。
   * `checkpoint` 会记下它，`rewind` 时如果要连文件一起还原就用这个 id。
   */
  turnSnapshotId: string | null;
  /**
   * 探索打点（`checkpoint` 工具）。
   *
   * 这类任务很常见：为了定位一个问题要读十几个文件，读完之后真正有用的只有三五句结论，
   * 那些中间过程却会一直占着窗口。打点 → 探索 → `rewind` 交结论，等于把中间过程
   * **整段换掉**（不走摘要，所以没有"摘要写歪了"的漂移风险）。
   */
  checkpoint: { goal: string; atMessageCount: number; atSnapshotId: string | null; startedAt: number } | null;
  /**
   * 待生效的收网（`rewind` 工具写进来，由 `transformContext` 在**下一次模型调用前**应用）。
   *
   * 为什么不直接改 `agent.state.messages`：`rewind` 是在工具里执行的，
   * 此刻循环正拿着它自己的 `context.messages` 引用，换掉 `state.messages` 指不到它 ——
   * 那只在回合之间（比如 `/compact`）有效。走 `transformContext` 就必然生效，
   * 而且和摘要、去重共用同一条路径。
   *
   * `cutTo` 是"应用那一刻的消息条数"：之后新增的消息要原样接在结论后面，
   * 否则收网会把收网之后的新内容也一起吞掉。
   */
  rewind: RewindState | null;
};

/** 每个会话一个 Pi Agent 实例：保存完整 transcript，支持中途打断与多轮继续。 */
const sessions = new Map<number, Session>();

/** 会话是否正在运行（UI 用来禁用输入框 / 显示停止按钮）。 */
const running = new Set<number>();

export function isAgentRunning(conversationId: number): boolean {
  return running.has(conversationId);
}

/**
 * 运行态变化（开跑 / 收尾）的监听者。
 *
 * 这个状态必须主动推：界面上的"还在干活"不能只靠本窗口发消息时置的本地标记 ——
 * 刷新窗口、切走再切回、后台（自动化 / CLI）起的运行，那些路径下本地标记都是空的，
 * 界面就会显示成"已经干完了"，而实际上还在跑。
 */
type RunStateListener = (payload: { conversationId: number; running: boolean }) => void;
const runStateListeners = new Set<RunStateListener>();

export function onAgentRunState(cb: RunStateListener): () => void {
  runStateListeners.add(cb);
  return () => runStateListeners.delete(cb);
}

/** 登记 / 解除运行态并推送（只在状态真正翻转时推，重复登记不产生噪音）。 */
function setAgentRunning(conversationId: number, value: boolean): void {
  if (running.has(conversationId) === value) return;
  if (value) running.add(conversationId);
  else running.delete(conversationId);
  for (const cb of runStateListeners) cb({ conversationId, running: value });
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
  // 会话被重置 = 上下文从头开始，上一轮的实测占用也就不再代表这个会话。
  forgetPromptTokens(conversationId);
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
 * 审阅型子智能体的补充指令。
 *
 * 三条是刻意写死的（都是"泛泛而谈的审查意见"的解药）：
 * 1. 只报**这次改动引入**的问题 —— 顺手把仓库里的历史遗留问题列一堆，对用户没有价值；
 * 2. 每条都要说清"什么情况下会出问题"，说不出来就说明只是风格偏好，别报；
 * 3. 优先级按严重程度分档，别把所有东西都标成最严重。
 */
const REVIEW_SUBAGENT_PROMPT = [
  "",
  "你在做**代码/文档审阅**：审的是工作区里**尚未提交的改动**（下面会给你 diff）。",
  "只报「这次改动引入的、有具体触发条件的问题」，例如：边界条件没处理、错误分支被吞掉、",
  "改了一处但别处还在用旧约定、并发/资源没释放、路径或类型不匹配。",
  "",
  "每条发现写成一行：`[P0|P1|P2] 文件:行号 — 问题 — 什么情况下会出问题`。",
  "- P0 = 会出错或丢数据；P1 = 明确的行为缺陷，应该修；P2 = 值得改但不出错。",
  "不要报：纯风格偏好、命名口味、缺少注释、笼统的「建议加测试」、以及**改动之前就存在**的老问题。",
  "没有发现就明确说「没发现需要修的问题」，不要为了显得有用而凑条目。",
  "最后用一句话给结论：这批改动能不能直接用。",
].join("\n");

/**
 * 取当前未提交改动，喂给审阅型子智能体。
 *
 * 上限是有意的：diff 太长会把子智能体自己的窗口占满（它还要读文件核实），
 * 真遇到超大改动，让它按文件逐个读比塞一整份 diff 更靠谱。
 */
async function reviewContextFor(workspace: string): Promise<string> {
  const MAX_DIFF_CHARS = 12_000;
  try {
    if (!(await isGitRepo(workspace))) {
      return "\n\n（工作区不是 git 仓库，取不到 diff：请按下面用户给的说明，用 read_file / grep 自己确认改动范围。）";
    }
    const changes = await getWorkspaceChanges(workspace);
    const files = changes.files ?? [];
    if (files.length === 0) {
      return "\n\n（工作区当前没有未提交的改动 —— 请如实说明「没有可审的改动」，不要凭空找问题。）";
    }
    const listed = files
      .slice(0, 60)
      .map((file) => `- ${file.path}（${file.status} +${file.added ?? 0} -${file.removed ?? 0}）`)
      .join("\n");
    let diff = "";
    for (const file of files.slice(0, 20)) {
      if (diff.length >= MAX_DIFF_CHARS) break;
      try {
        const detail = await getWorkspaceDiff(workspace, file.path);
        diff += `\n### ${file.path}\n\`\`\`diff\n${detail.diff ?? ""}\n\`\`\`\n`;
      } catch {
        // 单个文件取不到 diff（二进制 / 已被删除）不该让整个审阅失败。
      }
    }
    const truncated = diff.length > MAX_DIFF_CHARS;
    return [
      "",
      "## 待审阅的改动",
      "",
      `改动文件（${files.length} 个）：`,
      listed,
      files.length > 60 ? `（其余 ${files.length - 60} 个未列出）` : "",
      "",
      diff ? `### diff 节选\n${diff.slice(0, MAX_DIFF_CHARS)}` : "（diff 内容过长或不可读，请用 read_file 逐份确认。）",
      truncated ? "\n（diff 已截断：需要看完整内容时用 read_file 打开对应文件。）" : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    return `\n\n（取改动失败：${error instanceof Error ? error.message : String(error)}。请用 read_file / grep 自行确认改动范围。）`;
  }
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
  const isReview = opts.subagentType === "review";
  const readOnly = opts.subagentType === "explore" || isReview;
  const label = `${isReview ? "审阅" : opts.subagentType === "explore" ? "探索" : "执行"}：${opts.description}`;
  recordEvent({
    conversationId: opts.conversationId,
    messageId: opts.parentMessageId,
    kind: "subagent_start",
    toolName: "task",
    subagentId,
    output: label,
    // 类型与描述另外给一份结构化的：界面上那一行是「子智能体 探索 · 找配置」，
    // 从 `探索：找配置` 这段 label 里切字符串也读得出来，但读的是写入格式而不是事实。
    args: { subagent_type: opts.subagentType, description: opts.description },
  });

  const { model, models, streamFn } = createStreamFn();
  // 子智能体不派子智能体（避免无限递归），也不提问（没人盯着它）；
  // explore / review 只给只读工具，general 给完整工具（仍受权限策略约束）。
  const ctx: ToolContext = {
    workspace: opts.workspace,
    allowShell: !readOnly && getSetting("AGENT_ALLOW_SHELL") !== "0",
    vision: chatModelSupportsImages(),
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
  const tools = readOnly
    ? buildReadOnlyTools(ctx)
    : buildAgentTools(ctx).filter((tool) => tool.name !== "task");
  /**
   * 审阅型子智能体的开场白：把**当前未提交的改动**直接喂给它。
   *
   * 不让模型描述"改了哪些文件"是有意的 —— 它经常记不全（尤其是 bash 改的、自己早就忘了的）。
   * diff 由主进程现取，才是完整且当下的事实。取不到（不是 git 仓库 / 改动为空）就如实说明。
   */
  const reviewContext = isReview ? await reviewContextFor(opts.workspace) : "";
  /**
   * 已批准的整体方案（对齐 OMP 的 plan handoff）：派出去的那一片只知道自己的子任务，
   * 把计划带上它才不会做出与整体方案冲突的局部决定（比如改了方案里不打算动的文件）。
   */
  const planContext = planHandoffSection(opts.conversationId) ?? "";

  const agent = new Agent({
    streamFn,
    initialState: {
      systemPrompt: [
        `你是 OmniStudio 的子智能体，被主 Agent 派来${opts.subagentType === "explore" ? "调研" : "执行"}一个子任务。`,
        `工作区根目录：${opts.workspace}`,
        "你只有一个回合的上下文：直接用工具把事做完，然后给出结论。",
        "最终答复必须自包含（主 Agent 看不到你的中间过程），先给结论再给关键证据（文件:行号）。",
        readOnly ? "你没有写权限，只做只读工作。" : "",
        ...(isReview ? REVIEW_SUBAGENT_PROMPT : []),
      ]
        .filter(Boolean)
        .join("\n"),
      model,
      tools,
      messages: [],
    },
    /**
     * 子智能体也要压上下文：它读几个大文件就可能顶到 8k 窗口，
     * 而"顶到之后开始胡言乱语"在子智能体里更难被发现（用户只看到 task 的结论）。
     * 记账放在这个局部对象上：子智能体跑完即散，不需要跨回合保留。
     */
    transformContext: makeContextTransform(
      { workspace: opts.workspace, summary: null, compactedDropped: 0 },
      opts.conversationId,
      { model, models, streamFn },
    ),
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
    // 子智能体读的几个大文件同样可能超限：转存 + 截断，主 Agent 拿到的结论里
    // 也能看到"原文在哪"（子会话的过程不入主上下文，但工具结果本身要能读回）。
    afterToolCall: makeToolOutputHook(opts.conversationId),
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
        // 子智能体的每一步同样是真金白银的调用，之前只数步数、usage 直接丢掉。
        recordTokenUsage({
          channel: "agent",
          model: model.name,
          usage: (event.message as { usage?: { input?: number; output?: number } }).usage,
        });
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
    // 空回合同样要提醒：子智能体的失败在主线上只表现为「（无输出）」，最难查。
    attachTurnRecovery(agent, {
      steps: () => subagentSteps,
      maxSteps: maxSubagentSteps,
      budget: retryAttempts(),
      onNudge: (attempt) =>
        recordEvent({
          conversationId: opts.conversationId,
          messageId: opts.parentMessageId,
          kind: "status",
          toolName: "task",
          subagentId,
          output: `子智能体空回合，已提醒它继续（第 ${attempt} 次）。`,
        }),
    });
    await agent.prompt(opts.prompt + reviewContext + planContext);
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

/**
 * 把库里的历史消息连同**工具调用与结果**回填成 Pi Agent 的 transcript。
 *
 * 只回填正文的话，换模型 / 换工作区 / 重开会话后模型不记得自己做过什么，
 * 会把同一批文件再读一遍、同一条命令再跑一遍。工具调用的事实来源是 `agent_events`，
 * 配对与截断规则见 `agent-history.ts`（那边是纯函数，有单测）。
 *
 * `dropTrailingUser`：建会话的这一刻，库里最后那条用户消息**就是本轮即将作为 prompt
 * 发出去的那一条**（`runAgentTurn` 先落库、再建会话）。不摘掉的话，模型会在每个
 * "会话刚建立"的回合里看到同一段任务两遍 —— 首轮、换模型 / 换工作区之后的第一轮、
 * 重新生成都属于这一类；任务描述里还捎着时间提醒、召回的记忆、hook 上下文与附件路径，
 * 整段都会翻倍。一句话：**历史只该包含已经结束的回合，当前这一轮由 prompt 承载**。
 *
 * 这个缺陷是 `agent-resilience-smoke` 在检查"重发是接着发、不是重开一轮"时暴露的
 * （它数了请求里任务陈述出现的次数）—— 单测和单点场景都看不见。
 */
function historyAsAgentMessages(
  conversationId: number,
  opts: { dropTrailingUser?: boolean } = {},
): AgentMessage[] {
  const rows = getHistory(conversationId).filter((m) => m.content.trim().length > 0);
  // 占位的空助手消息（本轮正在跑的那条）已经被上面的过滤去掉了，
  // 所以这里要判断的是"末尾是不是本轮的提问"（见 agent-history.ts 的说明）。
  const history = opts.dropTrailingUser ? dropCurrentPrompt(rows) : rows;
  const events = listAgentEvents(conversationId);
  return buildHistoryMessages(history, events, {
    model: getChatModelLabel(),
    provider: "omni-studio",
    api: "openai-completions",
  }) as unknown as AgentMessage[];
}

/**
 * `checkpoint` 工具的落点：记下"探索从哪开始"。
 *
 * 记的是**消息条数**而不是内容：探索过程中消息只会往后追加，所以这个下标始终指向
 * "打点那一刻的最后一条"，收网时切到这里就等于把探索过程整段摘掉。
 */
function beginCheckpoint(session: Session, conversationId: number, goal: string): ToolOutcome {
  const trimmed = goal.trim();
  if (session.checkpoint) {
    return errorResult(`已经有一个打点还开着（目标：${session.checkpoint.goal}）。先用 rewind 收网，不要重复打点。`);
  }
  if (!trimmed) {
    return errorResult("checkpoint 需要一个 goal：这次要查什么？");
  }
  session.checkpoint = {
    goal: trimmed,
    atMessageCount: session.agent.state.messages.length,
    atSnapshotId: session.turnSnapshotId,
    startedAt: Date.now(),
  };
  recordEvent({
    conversationId,
    messageId: currentMessageId(conversationId),
    kind: "status",
    toolName: "checkpoint",
    output: `探索打点：${trimmed}（打完点之后的中间过程会在 rewind 时被结论替换）。`,
  });
  return textResult(
    `已打点：${trimmed}。现在放开去查；查完**必须**调用 rewind，用一份自包含的结论` +
      "（结论 + 证据，含 文件:行号）把中间过程替换掉。",
  );
}

/** `rewind` 工具的落点：把结论写进会话，交给 `transformContext` 在下一次调用前生效。 */
async function finishRewind(
  session: Session,
  conversationId: number,
  input: { report: string; revertFiles: boolean },
): Promise<ToolOutcome> {
  const checkpoint = session.checkpoint;
  if (!checkpoint) {
    return errorResult("没有开着的打点，rewind 无事可做（只有先 checkpoint 过才需要收网）。");
  }
  const report = input.report.trim();
  if (!report) {
    return errorResult("rewind 的 report 不能为空：它是收网后**唯一**留下来的东西，必须自包含（结论 + 证据 + 文件:行号）。");
  }

  session.rewind = { at: checkpoint.atMessageCount, report, cutTo: null };
  // 摘要记账覆盖的是收网前的下标，和收网后的上下文对不上 —— 作废，让它按新历史重新判断。
  session.summary = null;
  session.checkpoint = null;

  let fileNote = "工作区文件未改动";
  if (input.revertFiles) {
    if (!checkpoint.atSnapshotId) {
      fileNote = "没能还原文件（本轮没有可用快照——快照功能可能关着，或工作区不是 git 仓库）";
    } else {
      try {
        const reverted = revertToSnapshot(checkpoint.atSnapshotId);
        fileNote = reverted.ok
          ? `已还原工作区到打点时的状态（还原 ${reverted.restored.length} 个、删除 ${reverted.removed.length} 个文件）`
          : `还原工作区失败：${reverted.error}`;
      } catch (error) {
        fileNote = `还原工作区失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  recordEvent({
    conversationId,
    messageId: currentMessageId(conversationId),
    kind: "status",
    toolName: "rewind",
    output: `探索收网：${checkpoint.goal} —— 打点后的中间过程已由 ${report.length} 字结论替代；${fileNote}。`,
  });
  return textResult(
    `已收网。打点之后的查询与工具输出将在下一次模型调用前被你的结论替换掉；${fileNote}。` +
      "接下来直接用这份结论继续干活（结论里没写的东西，需要时重新查）。",
  );
}

/**
 * `goal` 工具的落点：目标操作落库 + 写轨迹。
 *
 * 目标是**跨回合**的东西（Goal 模式会自动续跑），所以这一层只管落库与回报，
 * 不在这里做"要不要继续"的判断 —— 那个在回合收尾处统一决定（见 `maybeContinueGoal`）。
 */
function handleGoalOp(
  conversationId: number,
  input: { op: string; objective?: string; acceptance?: string; outcome?: string },
): ToolOutcome {
  const op = input.op?.trim();
  const record = (output: string) => {
    recordEvent({ conversationId, messageId: currentMessageId(conversationId), kind: "status", toolName: "goal", output });
  };
  if (op === "create") {
    const objective = input.objective?.trim();
    if (!objective) return errorResult("create 需要 objective：这次要达成什么？");
    const goal = createGoal(conversationId, { objective, acceptance: input.acceptance ?? null });
    record(`目标已立项：${goal.objective}${goal.acceptance ? `（验收标准：${goal.acceptance}）` : ""}`);
    return textResult(
      [
        `目标已记录：${goal.objective}`,
        goal.acceptance
          ? `验收标准：${goal.acceptance}`
          : "**验收标准还是空的** —— 现在就用 ask_user 与用户对齐「怎么算完成」，再用 goal 的 create 把它补上。",
        "",
        "接下来自主推进；每轮都会自动继续，直到达成（调用 complete 并给出证据）或撞上预算。",
      ].join("\n"),
    );
  }
  if (op === "get") {
    const goal = getGoal(conversationId);
    if (!goal) return textResult("当前没有目标。要立一个就用 goal 的 create（先与用户对齐验收标准）。");
    return textResult(
      [describeGoal(goal), goal.acceptance ? `验收标准：${goal.acceptance}` : "验收标准：（未设定）"].join("\n"),
    );
  }
  if (op === "complete") {
    const outcome = input.outcome?.trim();
    if (!outcome) return errorResult("complete 需要 outcome：把证据写清楚（改了什么文件 / 跑了什么命令 / 看到什么输出）。");
    const goal = setGoalStatus(conversationId, "complete", outcome);
    if (!goal) return errorResult("当前没有目标，没什么可完成的。");
    record(`目标完成：${goal.objective} —— ${outcome.slice(0, 200)}`);
    return textResult("目标已标记完成。收起本节；如果用户还有后续需求，等他发话。");
  }
  if (op === "abandon") {
    const outcome = input.outcome?.trim();
    if (!outcome) return errorResult("abandon 需要 outcome：说明卡在哪里（缺什么权限 / 缺什么信息 / 哪一步做不到）。");
    const goal = setGoalStatus(conversationId, "dropped", outcome);
    if (!goal) return errorResult("当前没有目标，没什么可放弃的。");
    record(`目标放弃：${goal.objective} —— ${outcome.slice(0, 200)}`);
    return textResult("已标记放弃。把卡住的原因如实告诉用户，不要假装完成。");
  }
  return errorResult(`goal 不认识的操作：${op || "(空)"}。可用：create / get / complete / abandon。`);
}

/** `write_plan` 工具的落点：方案落盘（数据目录）+ 登记产出物 + 轨迹。 */
function handleWritePlan(
  conversationId: number,
  workspace: string,
  messageId: number | null,
  content: string,
): ToolOutcome {
  const plan = savePlan(conversationId, { content, messageId, workspace });
  recordEvent({
    conversationId,
    messageId,
    kind: "status",
    toolName: "write_plan",
    output: `方案已写入：${plan.filePath}（${plan.content.length} 字，等用户批准）`,
  });
  return textResult(
    [
      `方案已保存（${plan.content.length} 字），用户可以在右侧「产出物」里看到，也可以点「批准并执行」让你动手。`,
      "",
      "现在**停下来**：在回复里用三五句话说明这份方案的关键取舍，不要再开始做别的。",
      "用户会批准、或者让你改；在得到批准之前不要改工作区里的任何东西。",
    ].join("\n"),
  );
}

/** `createStreamFn()` 的返回值：摘要调用要复用同一套 provider / model。 */
type ModelBundle = ReturnType<typeof createStreamFn>;

/** 摘要在实际上下文里的那条消息（已有摘要时每轮都要放回去）。 */
function summaryMessage(summary: { text: string; coveredCount: number }): {
  role: "user";
  content: { type: "text"; text: string }[];
  timestamp: number;
} {
  return {
    role: "user",
    content: [{ type: "text", text: summaryMessageText(summary.text, summary.coveredCount, "auto") }],
    timestamp: Date.now(),
  };
}

/**
 * 请求前的上下文整理：三步，成本从低到高，后一步兜住前一步的失败。
 *
 * 1. **去重**（零模型调用）：同一份文件更早的读取结果换成占位；
 * 2. **摘要**（一次模型调用，`AGENT_COMPACT_MODE=summary` 默认开）：顶到预算时把旧历史
 *    压成一段结构化摘要。失败 / 超时 / 模型返回空 —— 都只是记一条轨迹然后往下走；
 * 3. **裁剪**（零模型调用，永不失败）：还是超预算就按确定性裁剪砍掉中间。
 *
 * 摘要的记账（正文 + 覆盖到第几条）挂在会话上：不记的话每轮都要重摘一遍，
 * 那比不压缩还慢。换模型 / 换工作区会重建会话，记账跟着作废。
 */
/**
 * 压缩记账挂在哪里（会话 / 子智能体的临时对象都满足这个形状）。
 * 只声明真正用到的字段，避免把整个 Session 拖进这个纯逻辑里。
 */
export type CompactionHost = {
  workspace: string;
  summary: { text: string; coveredCount: number; tokensBefore: number } | null;
  compactedDropped: number;
  /** 探索打点 / 收网的状态（子智能体不参与，传 null）。 */
  checkpoint?: { goal: string; atMessageCount: number; atSnapshotId: string | null; startedAt: number } | null;
  rewind?: RewindState | null;
};

/**
 * 导出仅供单测：这个函数的**全部内容就是几步的顺序**（收网 → 去重 → 摘要 → 裁剪），
 * 而顺序错了在界面上看不出来 —— 收网之后不再压缩、或收网把新内容吞掉，都只会在长会话里
 * 慢慢表现为"越来越卡"或"模型忘了刚做的事"。所以顺序本身要被钉住。
 */
export function makeContextTransform(
  host: CompactionHost,
  conversationId: number,
  bundle: ModelBundle,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages, signal) => {
    // 云端模式下窗口来自模型本身（chat-context.ts），不再拿本地引擎的 8k 默认值
    // 当云端窗口 —— 那会让压缩在 60% × 8k 处过早触发，白丢历史。
    const contextWindow = chatContextWindow();
    // 留 40% 给系统提示 / 工具定义 / 模型输出；下限取 256，
    // 但不能高过窗口本身的 60%（窗口本身很小的时候，下限会让压缩永远不触发）。
    const budget = Math.max(256, Math.floor(contextWindow * 0.6));
    // 摘要要保留的"最近上下文"：窗口的 1/4。本地 8k 窗口下约 2k tokens，
    // 够放下最近一两轮的来龙去脉，又不至于让摘要区域小到没意义。
    const keepRecent = Math.max(128, Math.floor(contextWindow * 0.25));

    const record = (toolName: string, output: string) => {
      recordEvent({ conversationId, messageId: currentMessageId(conversationId), kind: "status", toolName, output });
    };

    // ── 0. 收网（`rewind`，零成本）──────────────────────────────────
    // 打点之后的探索过程整段换成模型自己写的那份结论。不做摘要，所以没有"摘要写歪"
    // 的漂移风险；只在模型真的调了 rewind 时才生效。
    //
    // 收网**不是流水线的终点**：它只是把历史换成「结论 + 收网之后的新内容」，之后照样要
    // 进去重 / 摘要 / 裁剪。以前这里直接 return，于是收网过的会话从下一次请求起永远走不到
    // 后面几步 —— 历史重新涨过窗口时（8k 窗口下几轮就够）没有任何兜底，而 finishRewind
    // 还刚刚把旧摘要作废了，等于"再也压不动"。
    let base: AgentMessage[] = messages;
    if (host.rewind) {
      if (!host.rewind.logged) {
        host.rewind.logged = true;
        record("rewind", `探索收网：打点之后的中间过程已由结论替代（保留 ${host.rewind.at} 条 + 新内容）。`);
      }
      base = applyRewind(base, host.rewind) as typeof messages;
    }

    // ── 1. 去重（零成本）─────────────────────────────────────────────
    // 8k 窗口下 Agent 常常把同一文件读三四遍，这些旧副本是窗口开销的大头，
    // 而它们的信息已经被后面那次完整读取覆盖了。
    const pruned = pruneSupersededReads(base as { role?: string; content?: unknown }[], (path) =>
      `（已省略：${path} 在这次之前被读取的结果，后来又被完整读过，已由最新一次取代。）`,
    );
    let current = pruned.messages;
    if (pruned.pruned > 0) {
      record("prune", `上下文去重：省略 ${pruned.pruned} 条被重复读取取代的工具结果（约省 ${pruned.tokensSaved} tokens）。`);
    }

    // 会话上记着的摘要如果比当前消息还长，说明这批消息被换过了（重新生成 / 换模型），作废。
    if (host.summary && host.summary.coveredCount > current.length) host.summary = null;

    // ── 2. 摘要（一次模型调用）────────────────────────────────────────
    const summaryEnabled = getSetting("AGENT_COMPACT_MODE") !== "trim";
    if (summaryEnabled) {
      const effective = host.summary ? [summaryMessage(host.summary), ...current.slice(host.summary.coveredCount)] : current;
      if (estimateMessagesTokens(effective as never) > budget) {
        const covered = host.summary?.coveredCount ?? 0;
        const cut = findSummaryCut(current, keepRecent, (slice) => estimateMessagesTokens(slice as never), 2);
        if (cut !== null && cut > covered) {
          // 摘要输入里带上"这段历史里提到的事"召回的记忆：压缩后上下文才不会断片
          // （摘要是模型写的，它没看过记忆库；不喂给它，记忆就只存在于压缩之前）。
          const query = lastUserText(current.slice(covered, cut)) ?? "";
          const recalled = query ? await memoryRecallSection(query, { scope: host.workspace }).catch(() => null) : null;
          const outcome = await summarizeHistory({
            messages: current,
            from: covered,
            cut,
            models: bundle.models,
            model: bundle.model,
            previousSummary: host.summary?.text ?? null,
            recalled,
            signal,
            maxTokens: Math.min(2048, Math.max(512, Math.floor(contextWindow * 0.2))),
          });
          if (outcome.ok) {
            host.summary = { text: outcome.summary, coveredCount: outcome.coveredCount, tokensBefore: outcome.tokensBefore };
            record(
              "compact",
              `上下文摘要：前 ${outcome.coveredCount} 条历史（约 ${outcome.tokensBefore} tokens）已压缩成摘要` +
                `${covered > 0 ? "（在已有摘要上续写）" : ""}。`,
            );
          } else {
            // 摘要是"锦上添花"：失败就退回确定性裁剪，这一轮必须照常发出去。
            logEvent({
              level: "warn",
              source: "agent",
              event: "agent.compact.summary_failed",
              message: `摘要式压缩失败，退回确定性裁剪：${outcome.reason}`,
              detail: { conversationId },
            });
            record("compact", `摘要式压缩失败（${outcome.reason}），本轮改用确定性裁剪。`);
          }
        }
      }
    }
    let withMemo: { role?: string; content?: unknown }[] =
      host.summary && summaryEnabled
        ? [summaryMessage(host.summary), ...current.slice(host.summary.coveredCount)]
        : current;

    // ── 3. 兜底裁剪（永不失败）───────────────────────────────────────
    const trimmed = compactMessages(withMemo as never[], budget, (dropped) => ({
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
    }));
    if (trimmed.dropped > 0) {
      host.compactedDropped += trimmed.dropped;
      record(
        "compact",
        `上下文压缩：省略 ${trimmed.dropped} 条历史消息（约 ${trimmed.tokensBefore} → ${trimmed.tokensAfter} tokens，` +
          `上下文预算 ${budget}）。`,
      );
    }
    // 打点还开着就每轮提醒一次：模型很容易探索完就直接去干别的，把中间过程一直挂在窗口里。
    if (host.checkpoint) {
      return [
        ...(trimmed.messages as unknown[]),
        {
          role: "user",
          content: [{ type: "text", text: checkpointReminderText(host.checkpoint.goal) }],
          timestamp: Date.now(),
        },
      ] as typeof messages;
    }
    return trimmed.messages as typeof messages;
  };
}

/**
 * 一段历史里最后一条用户消息的正文（摘要召回用它的关键词）。 */function lastUserText(messages: { role?: string; content?: unknown }[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content.slice(0, 500);
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (block as { type?: string; text?: string })?.text ?? "")
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text.slice(0, 500);
    }
  }
  return null;
}

async function getOrCreateSession(
  conversationId: number,
  mode: AgentMode,
  workspace: string,
  headless = false,
): Promise<Session> {
  /**
   * 会话缓存键（对齐 Codex 的"会话内可以换模型"）：
   * 除了模式 / 工作区 / 无人值守，**当前模型也算在内** —— Agent 实例是握着
   * `model` 与 `streamFn` 建的，不带上它，界面里 `/model` 换完模型后这一轮
   * 还会发给旧模型（用户看到的是"换了没反应"）。
   *
   * 重新建会话不会丢历史：`historyAsAgentMessages()` 会把库里的 user / assistant
   * 正文回填成 transcript，所以换模型 = 换引擎、上下文照旧。
   */
  const modelKey = currentModelKey();
  const existing = sessions.get(conversationId);
  if (
    existing &&
    existing.mode === mode &&
    existing.workspace === workspace &&
    existing.headless === headless &&
    existing.modelKey === modelKey
  ) {
    return existing;
  }
  if (existing) {
    recordEvent({
      conversationId,
      messageId: currentMessageId(conversationId),
      kind: "status",
      toolName: "model",
      output: `模型已切换：${existing.modelKey} → ${modelKey}（下一轮起生效，历史继续沿用）。`,
    });
    resetAgentSession(conversationId);
  }

  const { model, models, streamFn } = createStreamFn();
  /**
   * session_start hook（对齐 Codex 的 SessionStart）：首次建立会话时跑一次，
   * 输出作为「会话启动上下文」进系统提示 —— 比如把当前分支 / 环境版本前置。
   * 失败或超时只记警告，不影响会话建立。
   */
  const startupHook = await runHooks("session_start", {
    conversationId,
    workspace,
    mode,
    model: getChatModelLabel(),
  });
  const startupContext = startupHook.context.length
    ? `\n\n# 会话启动上下文（session_start hook）\n\n${startupHook.context.join("\n\n")}`
    : "";
  const systemPrompt = buildSystemPrompt(mode, workspace, goalPromptSection(conversationId)) + startupContext;
  if (startupHook.runs > 0) {
    recordEvent({
      conversationId,
      messageId: currentMessageId(conversationId),
      kind: "status",
      toolName: "hook",
      output:
        (startupHook.context.length
          ? `session_start hook：注入 ${startupHook.context.join("").length} 字符上下文。`
          : "session_start hook：已执行，未注入上下文。") +
        (startupHook.errors.length ? ` 失败 ${startupHook.errors.length} 条：${startupHook.errors.join("；")}` : ""),
    });
  }
  const session: Session = {
    agent: null as unknown as Agent,
    mode,
    workspace,
    recentCalls: [],
    headless,
    compactedDropped: 0,
    systemPromptTokens: estimateTokens(systemPrompt),
    startupContext,
    modelKey,
    summary: null,
    summarizing: null,
    turnSnapshotId: null,
    checkpoint: null,
    rewind: null,
  };
  const agent = new Agent({
    streamFn,
    // 转发给 provider：缓存感知的后端（vLLM / SGLang / llama.cpp）据此把同一会话
    // 的请求归到同一条 KV 缓存线上。
    sessionId: `omni-conversation-${conversationId}`,
    initialState: {
      systemPrompt,
      model,
      // 推理等级：`off` 时整个字段不传（pi-agent-core 的类型里没有 "off"，
      // 而"不传"正好等于它自己的默认值）。
      ...(getAgentThinkingLevel() === "off"
        ? {}
        : { thinkingLevel: getAgentThinkingLevel() as Exclude<AgentThinkingLevel, "off"> }),
      tools: await toolsForMode(
        mode,
        workspace,
        conversationId,
        currentMessageId(conversationId),
        headless,
        session.systemPromptTokens,
        {
          // Plan 模式不注入打点/收网与目标：rewind 可以连带还原工作区文件、goal 会自动续跑，
          // 两者都与"计划模式只读、跑完就停"冲突（回合快照同样在 plan 模式下跳过）。
          onCheckpoint: mode === "plan" ? undefined : (goal) => beginCheckpoint(session, conversationId, goal),
          onRewind: mode === "plan" ? undefined : (input) => finishRewind(session, conversationId, input),
          onGoal: mode === "plan" ? undefined : (input) => handleGoalOp(conversationId, input),
          // write_plan 三种模式都给：它写的是数据目录，碰不到工作区。
          onWritePlan: (content) => handleWritePlan(conversationId, workspace, currentMessageId(conversationId), content),
        },
      ),
      messages: historyAsAgentMessages(conversationId, { dropTrailingUser: true }),
    },
    /**
     * 上下文整理：去重 → 摘要 → 裁剪，见 `makeContextTransform()` 的说明。
     * 三步的量都会往轨迹里写一条说明，用户能看到"它没忘，只是被压过了"。
     */
    transformContext: makeContextTransform(session, conversationId, { model, models, streamFn }),
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
    /**
     * 工具结果的最后一道处理：超限就转存 + 截断 + 给出读回路径（见 makeToolOutputHook）。
     * 放在这里而不是每个工具里，是为了让 MCP / 媒体 / 未来新增的工具自动享受同一套。
     */
    afterToolCall: makeToolOutputHook(conversationId),
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

/** 最后一条助手消息的结束原因：pi-agent-core 用它表达"这一轮出错了 / 被中断了"。 */
function lastAssistantStopReason(agent: Agent): string | undefined {
  const messages = agent.state.messages as { role?: string; stopReason?: string }[];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant") return message.stopReason;
  }
  return undefined;
}

/** 最后一条助手消息的输出 token 数（`stopReason=length` 判「是不是被钳没」用）。 */
function lastAssistantOutputTokens(agent: Agent): number | undefined {
  const messages = agent.state.messages as { role?: string; usage?: { output?: number } }[];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant") return message.usage?.output;
  }
  return undefined;
}

/**
 * 跑一次 Agent：把用户消息交给 Pi Agent 的工具循环，直到它给出最终回答
 * （或达到步数上限 / 被用户中断）。流式内容复用 chat 的 chunk/done 通道，
 * 工具调用通过 agentEvent 单独推送，前端据此渲染执行轨迹。
 */
/**
 * 把附件拼进交给 Agent 的任务描述里（附件本身不进 transcript，只做上下文）：
 * 文本文件内联内容，图片给出本地路径（本地模型未必支持视觉输入）。
 *
 * `clock` 是本轮的时间提醒（见 `currentTimeLine`）—— 放在这里而不是系统提示里，
 * 是为了让系统提示在一场会话里保持字节稳定，不打断后端的前缀缓存。
 */
function withAttachments(
  content: string,
  files: { name: string; content: string }[],
  imagePaths: string[],
  recall?: string | null,
  clock?: string | null,
): string {
  const parts: string[] = [];
  if (clock) parts.push(clock);
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
  /** true = 这一轮是 Goal 模式的自动续跑（不是用户主动发起的）。 */
  goalContinuation?: boolean;
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
  if (!conv) {
    // 早退也要发终态事件：前端靠 `chatDone` 解除运行态，漏一条就是"发了没反应"。
    logEvent({
      level: "warn",
      source: "agent",
      event: "agent.turn.rejected",
      message: "会话不存在，回合被拒绝",
      detail: { conversationId },
    });
    emitDone({ conversationId, messageId: Date.now(), content: "", error: "Conversation not found" });
    return { ok: false, error: "Conversation not found" };
  }
  if (!content.trim()) {
    logEvent({
      level: "debug",
      source: "agent",
      event: "agent.turn.rejected",
      message: "空任务，回合被拒绝",
      detail: { conversationId },
    });
    emitDone({ conversationId, messageId: Date.now(), content: "", error: "Empty message" });
    return { ok: false, error: "Empty message" };
  }

  const modelName = getChatModelLabel();
  if (!modelName) {
    logEvent({
      level: "warn",
      source: "agent",
      event: "agent.turn.no_model",
      message: "没有可用的模型，回合被拒绝",
      detail: { conversationId },
    });
    emitDone({ conversationId, messageId: Date.now(), content: "", error: "No model configured" });
    return { ok: false, error: "No model configured" };
  }
  if (!getChatBaseUrl()) {
    logEvent({
      level: "warn",
      source: "agent",
      event: "agent.turn.no_server",
      message: "没有可用的推理服务地址，回合被拒绝",
      detail: { conversationId },
    });
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
      logEvent({
        level: "error",
        source: "agent",
        event: "agent.turn.server_not_ready",
        message: `推理服务未就绪：${error}`,
        detail: { conversationId },
      });
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
      .set({ title: titleFromMessage(content) })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  // 建行就报备（`insertAssistantMessage` 里成对做了）：下面建会话 / 起服务 / 等模型
  // 加载都是秒级到几十秒级的活儿，界面上那条「处理中 · N 秒」从这里开始有落点
  // （否则要等第一个 token）。
  const assistantId = Chat.insertAssistantMessage(conversationId);

  const session = await getOrCreateSession(conversationId, mode, workspace, opts.headless === true);
  const { agent } = session;
  // 授权弹窗 / 提问 / 产出物都要挂到本轮助手消息上（工具执行时按会话查）。
  activeMessageIds.set(conversationId, assistantId);
  // 新的用户回合开始：上一轮的「原地打转」计数清零。
  session.recentCalls = [];

  /**
   * 回合快照（对齐 Codex 的回合安全网）：在 Agent 动任何文件之前记一次状态，
   * 界面上就能给这条助手消息挂一个「撤销本轮」—— 回退到这里 = 把这一轮改的、
   * 建的文件全部还原（bash 改的文件与新建文件同样覆盖得到，工具 diff 做不到这点）。
   * 失败不影响回合本身（没有 git / 关了开关 / 工作区异常都只是没有撤销按钮）。
   */
  if (mode !== "plan") {
    try {
      const snapshot = createTurnSnapshot({ conversationId, messageId: assistantId, workspace });
      // 记在会话上：checkpoint 要用它当作"探索之前"的文件状态（rewind 时可选还原）。
      session.turnSnapshotId = snapshot?.id ?? null;
    } catch (error) {
      session.turnSnapshotId = null;
      logEvent({
        level: "warn",
        source: "agent",
        event: "agent.snapshot.failed",
        message: `回合快照创建失败：${error instanceof Error ? error.message : String(error)}`,
        detail: { conversationId, workspace },
      });
    }
  }

  let fullText = "";
  let reasoning = "";
  let step = 0;
  let aborted = false;
  /**
   * 自愈（见 `agent-retry.ts`）：`retryLimit` 是这一个回合可以花的重发 / 提醒次数；
   * `committedText` 是"最近一次正常结束的回合"为止的正文与思考 —— 失败回合重发前
   * 把后面那半截收回去，不能连成功回合说过的话一起撤掉。
   */
  const retryLimit = retryAttempts();
  let committedText = "";
  let committedReasoning = "";
  let stopRequested = false;
  let emptyNudges = 0;
  stopRequests.delete(conversationId);
  /** user_prompt_submit hook 拦下这一轮时的原因（收尾时如实返回给调用方）。 */
  let hookBlockedReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let toolCalls = 0;
  /** 首个增量（正文或思考）到达的时刻 —— 首 token 耗时 = 它减 startedAt。 */
  let firstTokenAt: number | null = null;
  let lastDeltaAt: number | null = null;
  /**
   * 纯生成耗时：只累加相邻增量之间的间隔，且单个间隔封顶
   * `DECODE_GAP_CAP_MS`。回合里等模型决定工具调用 / 等工具跑完的静默期
   * （几秒到几分钟）不该算进解码速度，否则「生成速度」会被工具耗时稀释成
   * 一个没有意义的数字；端到端吞吐另算，那里如实包含全部耗时。
   */
  const DECODE_GAP_CAP_MS = 2000;
  let decodeMs = 0;
  const markDelta = () => {
    const now = performance.now();
    if (firstTokenAt == null) firstTokenAt = now;
    if (lastDeltaAt != null) decodeMs += Math.min(now - lastDeltaAt, DECODE_GAP_CAP_MS);
    lastDeltaAt = now;
  };

  const startedAt = performance.now();
  setAgentRunning(conversationId, true);

  /**
   * 增量按帧批量下发（与对话同一份实现与同一个 40ms 常量，见 chunk-flusher.ts）。
   * 思考增量同样下发：界面上就是「思考中…」那一行的实时内容，不再只有一圈转圈。
   */
  const flusher = createChunkFlusher({
    conversationId,
    messageId: assistantId,
    emit: emitChunk,
  });
  const flushChunks = () => flusher.flushNow();

  /**
   * 当前步骤的正文缓冲 —— 冲出去就是时间轴上的一段「它说的话」。
   *
   * 冲的时机是**这一步的工具开始执行之前**：文本事件因此正好排在自己那批工具
   * 上面，界面上就是"说了一句 → 调了几个工具 → 又说一句"。最后一段（没有后续
   * 工具的收尾回答）在模型循环结束时冲一次，于是正文与事件两条来源能对上：
   * 界面按事件画时间轴，只把"还没落成事件的那截尾巴"当流式正文渲染。
   */
  let pendingStepText = "";
  const flushStepText = () => {
    if (!pendingStepText) return;
    const text = pendingStepText;
    pendingStepText = "";
    // 纯空白（换行 / 缩进）不值得占一条事件：它留在正文尾巴里不显示任何东西。
    if (!text.trim()) return;
    recordEvent({ conversationId, messageId: assistantId, kind: "text", output: text });
  };

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_update": {
        const delta = deltaOf(event.assistantMessageEvent);
        if (!delta || !delta.text) return;
        markDelta();
        if (delta.kind === "reasoning") {
          reasoning += delta.text;
          flusher.pushReasoning(delta.text);
        } else {
          fullText += delta.text;
          pendingStepText += delta.text;
          flusher.pushContent(delta.text);
          // 即时消费方（通话边生成边合成）仍按 token 回调，不走批量缓冲。
          opts.onDelta?.(delta.text, "content", assistantId);
        }
        return;
      }
      case "turn_end": {
        step += 1;
        const msg = event.message as {
          usage?: { input?: number; output?: number; cacheRead?: number; reasoning?: number };
          stopReason?: string;
        };
        promptTokens += msg?.usage?.input ?? 0;
        completionTokens += msg?.usage?.output ?? 0;
        // 每一步单独记一行：回合合计看不出"上下文复用了多少"，按步才能算清
        // 输入缓存的命中率，也才对得上服务端的计费账单。
        recordTokenUsage({ channel: "agent", model: modelName, usage: msg?.usage });
        // 实测输入量 = 本轮真实占用的窗口大小，会话内一直用它（比估算准）。
        if (msg?.usage?.input) rememberPromptTokens(conversationId, msg.usage.input);
        // turn_end 之间必然夹着工具执行 / 下一轮请求，不把这段间隔算进解码耗时。
        lastDeltaAt = null;
        /**
         * 正常结束的回合先"落袋"：失败的那一轮重发之前要把已经流出去的半截正文
         * 收回（见 runTurnWithRecovery），而在这之前成功回合的正文必须留着 ——
         * 它可能是模型在调工具之前说的话。
         */
        if (msg?.stopReason !== "error" && msg?.stopReason !== "aborted") {
          committedText = fullText;
          committedReasoning = reasoning;
        }
        if (msg?.stopReason === "aborted") stopRequested = true;
        return;
      }
      case "tool_execution_start": {
        toolCalls += 1;
        // 先说后做的顺序：这一步说的话先落成事件，再记工具调用（时间轴据此混排）。
        flushStepText();
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
    // 步数上限 + 空回合自愈（空回合 = 既没正文也没工具调用，见 attachTurnRecovery）。
    attachTurnRecovery(agent, {
      steps: () => step,
      maxSteps,
      budget: Math.min(MAX_EMPTY_TURN_NUDGES, retryLimit),
      onNudge: (attempt) => {
        emptyNudges = attempt;
        recordEvent({
          conversationId,
          messageId: assistantId,
          kind: "status",
          toolName: "retry",
          output: `模型这一回合什么都没说（既没有正文也没有工具调用），已提醒它继续（第 ${attempt} 次）。`,
        });
        logEvent({
          level: "warn",
          source: "agent",
          event: "agent.turn.empty_nudge",
          message: "空回合：已注入提醒让它重新决定",
          detail: { conversationId, attempt, model: modelName, mode },
        });
      },
    });

    /**
     * 用户主动发话 = 想继续干活。上一轮按过停止而暂停的目标在这里恢复
     * （自动续跑的轮次自己不恢复：否则它一跑就又"活"了，暂停形同虚设）。
     */
    if (mode === "goal" && !opts.goalContinuation && opts.headless !== true) {
      const paused = getGoal(conversationId);
      if (paused?.status === "paused") {
        setGoalStatus(conversationId, "active");
        recordEvent({
          conversationId,
          messageId: currentMessageId(conversationId),
          kind: "status",
          toolName: "goal",
          output: `目标恢复自动推进：${paused.objective}`,
        });
      }
    }

    // 每轮开始刷新系统提示：核心记忆（置顶 / 高重要度）与项目指令（AGENTS.md）
    // 可能在上几轮里变了。只有内容真的变了才写回 —— 系统提示是请求里最靠前的部分，
    // 无谓地重写会让后端的前缀缓存整段作废（内容里的时间提醒已挪到本轮用户消息）。
    const refreshedPrompt =
      buildSystemPrompt(mode, workspace, goalPromptSection(conversationId)) + session.startupContext;
    if (refreshedPrompt !== agent.state.systemPrompt) {
      agent.state.systemPrompt = refreshedPrompt;
      session.systemPromptTokens = estimateTokens(refreshedPrompt);
    }
    // 按当前问题召回相关记忆，拼进本轮用户消息（不改系统提示，故缓存友好）。
    const recall = await memoryRecallSection(content, { scope: workspace }).catch(() => null);

    /**
     * user_prompt_submit hook（对齐 Codex 的 UserPromptSubmit）：提交前让用户的脚本
     * 补上下文或直接拦下这一轮。注入的内容随本轮任务描述走（与附件 / 记忆同一位置），
     * 不写进系统提示 —— 它只对这一轮有效。
     */
    const promptHook = await runHooks("user_prompt_submit", {
      conversationId,
      workspace,
      mode,
      model: modelName,
      prompt: content,
    });
    if (promptHook.runs > 0) {
      recordEvent({
        conversationId,
        messageId: assistantId,
        kind: "status",
        toolName: "hook",
        output: promptHook.blocked
          ? `user_prompt_submit hook 拦下了这一轮：${promptHook.reason ?? "未给出原因"}`
          : `user_prompt_submit hook：注入 ${promptHook.context.join("").length} 字符上下文。` +
            (promptHook.errors.length ? ` 失败 ${promptHook.errors.length} 条：${promptHook.errors.join("；")}` : ""),
      });
    }
    const hookContext = promptHook.context.length
      ? `\n\n--- 来自 user_prompt_submit hook 的上下文 ---\n${promptHook.context.join("\n\n")}\n--- hook 上下文结束 ---`
      : "";

    if (promptHook.blocked) {
      // 拦下这一轮：不发给模型，但仍要走完落库与 emitDone（否则消息会一直停在"运行中"）。
      const reason = promptHook.reason ?? "user_prompt_submit hook 拦下了这一轮";
      hookBlockedReason = reason;
      fullText = `⛔ ${reason}`;
      logEvent({
        level: "info",
        source: "agent",
        event: "agent.turn.blocked",
        message: reason,
        detail: { conversationId, workspace, hook: true },
      });
    } else {
      /**
       * 发这一轮，并在"整轮失败但可恢复"时自己重发（对齐 OMP 的可重试错误重发）。
       *
       * 传输层的瞬时错误（408/409/429/5xx、连接被断）由内核按退避重试，那一步
       * 发生在请求内部、用户完全无感；这里兜的是另一种情况：**请求已经以
       * stopReason=error 收尾**（流中断、服务端中途关闭、被网关改写），
       * 不重发的话整轮就白白报废了。
       *
       * 重发用 `agent.continue()`：拿同一条上下文再发一次，不新增用户消息、
       * 不重跑已经成功的工具调用 —— 只把那条失败的空壳助手消息摘掉。
       */
      const runTurnWithRecovery = async (): Promise<void> => {
        const prompt =
          withAttachments(content, files, imagePaths, recall, currentTimeLine()) + hookContext;
        /** 用户按过停止（`stopAgentRun` 留的标记）就不再发请求 —— 退避期间按的也算。 */
        const stopped = () => stopRequested || stopRequests.has(conversationId);
        let attempt = 0;
        for (;;) {
          if (attempt === 0) await agent.prompt(prompt);
          else await agent.continue();
          if (attempt >= retryLimit || stopped()) return;
          const failed = lastAssistantMessage(agent.state.messages as never);
          if (!isRetryableTurnFailure(failed)) return;
          attempt += 1;
          /**
           * 失败那一轮流出去的半截正文收回来（成功回合说过的话留着）。
           * 还没发出去的增量缓冲也要丢掉：留着的话它会在重试成功之后才被 flush 出去，
           * 于是"半截旧文本 + 新回答"一起出现在同一个气泡里。
           * （已经流到界面的那几个字撤不回来 —— 收尾时 emitDone 会用最终正文整条覆盖。）
           */
          flusher.discard();
          // 失败那一步的正文同样作废：它已经被 fullText 回退掉了，落成事件就会让
          // 时间轴上多出一段正文里并不存在的话（尾巴切片也会因此对不上）。
          pendingStepText = "";
          fullText = committedText;
          reasoning = committedReasoning;
          const reason = failureReasonOf(failed);
          recordEvent({
            conversationId,
            messageId: assistantId,
            kind: "status",
            toolName: "retry",
            output: retryNoticeText({ attempt, max: retryLimit, reason }),
          });
          logEvent({
            level: "warn",
            source: "agent",
            event: "agent.turn.retry",
            message: `第 ${attempt}/${retryLimit} 次自动重试：${reason}`,
            detail: { conversationId, attempt, model: modelName, mode },
          });
          // 内核要求 continue() 的最后一条是 user / toolResult，把失败的空壳摘掉。
          agent.state.messages = dropTrailingFailures(
            agent.state.messages as never[],
          ) as unknown as typeof agent.state.messages;
          await sleepWithStop(conversationId, retryBackoffMs(attempt));
          // 退避期间用户按了停止：不再发下一次请求（否则"停止"看起来没生效）。
          if (stopped()) return;
        }
      };
      await runTurnWithRecovery();
    }
    // 模型循环结束：最后一段正文（收尾回答）也落成事件，时间轴到此完整。
    flushStepText();

    /**
     * 认领"被吞掉的"收尾状态。
     *
     * pi-agent-core 的契约是失败不抛异常：模型请求出错 / 被中断都会变成一条
     * stopReason=error|aborted 的助手消息，prompt() 照常返回（handleRunFailure）。
     * 也就是说一次失败的请求，从外面看和"答完了、只是什么都没说"完全一样 ——
     * 所以必须在回合结束时主动判一次，否则用户看到的就是「跑了一半、没有产出、
     * 也没有任何提示」，只会以为它卡住了。
     */
    const outcome = classifyTurnOutcome({
      // hook 拦下时这轮根本没发请求，别把上一次的 errorMessage 当成这轮的错误。
      errorMessage: hookBlockedReason ? undefined : session.agent.state.errorMessage,
      lastStopReason: hookBlockedReason ? undefined : lastAssistantStopReason(agent),
      lastOutputTokens: hookBlockedReason ? undefined : lastAssistantOutputTokens(agent),
      hasText: fullText.trim().length > 0,
      reachedStepLimit: step >= maxSteps,
    });
    if (outcome.kind === "aborted") {
      aborted = true;
      fullText = fullText ? `${fullText}\n\n_（已停止）_` : "_（已停止）_";
      recordEvent({
        conversationId,
        messageId: assistantId,
        kind: "status",
        output: "本轮已被停止。",
      });
    } else if (outcome.kind === "error") {
      recordEvent({
        conversationId,
        messageId: assistantId,
        kind: "error",
        output: outcome.detail,
      });
      // 这一轮是"失败被编码成一条空助手消息"的形态（见 agent-outcome.ts），
      // 界面只有 ⚠️ 一行；把完整原因与模型信息落到统一日志，便于定位到具体后端。
      logEvent({
        level: "error",
        source: "agent",
        event: "agent.turn.error",
        message: outcome.detail,
        detail: { conversationId, model: modelName, mode, workspace },
      });
      fullText = fullText ? `${fullText}\n\n⚠️ ${outcome.detail}` : `⚠️ ${outcome.detail}`;
    } else if (outcome.kind === "empty") {
      // 模型这一轮什么都没答（没有正文，也没继续调工具）：补一句说明，
      // 否则界面上就是一个空白气泡 —— 用户看到的是"跑完了但没有结果"。
      // 自愈已经试过了（提醒过 emptyNudges 次），所以这里要写清"试过还是这样"，
      // 否则用户会以为应用没管。
      const note = outcome.lengthClamped
        ? // 长度钳制型空回合（stopReason=length 且输出 ≤ 1 token）：请求侧把
          // max_tokens 压到了下限，重试 / 提醒都无济于事，必须指出配置矛盾本身。
          `模型（${modelName}）本轮被输出上限直接掐断：stopReason=length、只生成了 ${
            outcome.lastOutputTokens ?? "?"
          } 个 token。这是请求侧的问题 —— 上下文窗口按 ${chatContextWindow()} 计，` +
          `小于系统提示 + 工具定义 + 安全垫，max_tokens 被钳到了下限。` +
          "请检查模型的上下文窗口配置（本地引擎看「上下文长度」，云端看模型是否被当成 8k 小窗口模型）。"
        : `模型（${modelName}）本轮没有给出正文，也没有再调用工具就结束了。` +
          (emptyNudges > 0
            ? `已经自动提醒它继续 ${emptyNudges} 次，仍然是空回合 —— 多半是模型 / 推理服务的问题（比如上下文被填满、对话模板不匹配）。`
            : "") +
          "可以直接重试，或在控制台确认推理服务 / 模型是否正常。";
      recordEvent({
        conversationId,
        messageId: assistantId,
        kind: "status",
        output: note,
      });
      logEvent({
        level: "warn",
        source: "agent",
        event: "agent.turn.empty",
        message: note,
        detail: { conversationId, model: modelName, mode, workspace },
      });
      fullText = `⚠️ ${note}`;
    }

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
    // 收尾前先把缓冲里的增量冲出去，避免 chatDone 先到、尾巴几个字后到；
    // 再收掉定时器（冲完它已经清空了，这里只是防残留 timer 让进程多活一拍）。
    flushChunks();
    flusher.dispose();
    setAgentRunning(conversationId, false);
    activeMessageIds.delete(conversationId);
    stopRequests.delete(conversationId);
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
  const stats = computeTokenStats({
    // 输入 / 输出都是跨步累积的 usage 实测值；一次都没拿到（服务端没回 usage）
    // 就退回估算 —— 输出按已生成的正文与思考折算，来源字段如实标注。
    inputTokens: promptTokens || undefined,
    outputTokens: completionTokens || estimateTokens(fullText + reasoning),
    reasoningTokens: estimateTokens(reasoning),
    elapsedMs,
    ttftMs: firstTokenAt == null ? null : firstTokenAt - startedAt,
    generationMs: decodeMs || null,
    source: promptTokens > 0 && completionTokens > 0 ? "usage" : promptTokens > 0 ? "mixed" : "estimate",
    model: modelName,
    provider: getChatProviderLabel() ?? undefined,
    steps: step,
    toolCalls,
  });

  db.update(messages)
    .set({
      content: fullText,
      reasoning: reasoning || null,
      tokens: stats.tokens,
      stats: JSON.stringify(stats),
    })
    .where(eq(messages.id, assistantId))
    .run();

  emitStats({
    conversationId,
    messageId: assistantId,
    ...stats,
    context: contextUsage(conversationId, { systemPromptTokens: session.systemPromptTokens }),
  });
  emitDone({ conversationId, messageId: assistantId, content: fullText, reasoning: reasoning || undefined });
  opts.onTurnEnd?.(assistantId);

  // 通知中心：跑完的回合留一条，方便回看结果。
  //   - 无人值守（自动化 / `omi agent run`）：一律通知，那本来就没人在看；
  //   - 交互式：只在用户没看着这个会话时通知（窗口在后台 / 切到了别的会话/页面）——
  //     盯着界面看的时候再弹一条纯属噪音。判断依据是 webview 回传的 view-state。
  if (ViewState.shouldNotifyTurnEnd({ headless: opts.headless === true, conversationId })) {
    const title = db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()?.title;
    notify({
      kind: opts.headless === true ? "automation" : "run_finished",
      title: opts.headless === true ? `自动化跑完：${title ?? "任务"}` : `跑完了：${title ?? "会话"}`,
      body: (fullText || reasoning || "").replace(/\s+/g, " ").slice(0, 200),
      conversationId,
    });
  }

  /**
   * Goal 模式的账本：把这一轮的消耗记到目标上，并判断是否撞上预算。
   *
   * 只计 input + output，**不算 cacheRead**（见 `agent-goals.ts` 的口径说明）：
   * 缓存命中的那部分并没有真的重新送一遍上下文。
   * 时间也按"真正在跑的这段"算，用户去泡咖啡的时间不算进目标耗时。
   */
  if (mode === "goal" && getGoal(conversationId)) {
    const { exceededBudget } = addGoalUsage(conversationId, {
      tokens: promptTokens + completionTokens,
      seconds: elapsedMs / 1000,
      continuation: opts.goalContinuation === true,
    });
    if (exceededBudget) {
      setGoalStatus(conversationId, "budget-limited", "已用满 token 预算");
      recordEvent({
        conversationId,
        messageId: assistantId,
        kind: "status",
        toolName: "goal",
        output: "目标已用满 token 预算，停止自动推进。想接着跑就再发一条消息（会重新计数）。",
      });
    }
  }

  // 运行中排队进来的消息：本次结束后自动接着跑（不递归等待，交给调用栈上层）。
  if (!aborted && !hookBlockedReason && pendingMessages.has(conversationId)) {
    void drainQueuedMessages(conversationId, workspace).catch(() => {
      // 排队消息失败不改变本轮结果，用户能在会话里看到错误轨迹
    });
  } else if (!aborted && !hookBlockedReason) {
    // 目标还开着就自己接着跑 —— 这条是 Goal 模式与 Agent 模式的**唯一实质差别**。
    void maybeContinueGoal({ conversationId, workspace, mode, headless: opts.headless }).catch(() => {});
  }

  if (hookBlockedReason) return { ok: false, error: hookBlockedReason };
  return { ok: true };
}

/**
 * Goal 模式的自动续跑。
 *
 * 一个回合正常结束后，如果目标还开着（status=active）且当前就是 Goal 模式，
 * 就自己再开一轮 —— 内容是一条明确写着"上一步没做完、接着推进"的消息。
 *
 * 为什么不藏起来：这是**用户能看见的自主行为**。桌面应用里，用户滚回去应该能看懂
 * "它为什么自己又跑了一轮"；藏成看不见的注入，只会让人以为是 bug。所以它照样落库、
 * 照样出现在时间线里，只是开头就写明是系统自动继续。
 *
 * 三道刹车（任一生效就不续跑）：撞 token 预算、续跑轮数上限、用户按了停止（→ paused）。
 */
async function maybeContinueGoal(opts: {
  conversationId: number;
  workspace: string;
  mode: AgentMode;
  headless?: boolean;
}): Promise<void> {
  if (opts.mode !== "goal") return;
  if (isAgentRunning(opts.conversationId)) return;
  // 排队消息优先：用户刚说的话比"自己接着跑"重要，等它先跑完（它收尾时还会再判断一次）。
  if ((pendingMessages.get(opts.conversationId) ?? []).length > 0) return;
  const goal = getGoal(opts.conversationId);
  if (!goal || goal.status !== "active" || isTerminal(goal.status)) return;

  // 刹车之一：续跑轮数上限（不是所有部署都设了 token 预算，这个是永远存在的兜底）。
  if (goal.continuations >= maxGoalContinuations()) {
    setGoalStatus(opts.conversationId, "budget-limited", `已自动续跑 ${maxGoalContinuations()} 次`);
    recordEvent({
      conversationId: opts.conversationId,
      messageId: null,
      kind: "status",
      toolName: "goal",
      output: `目标已自动续跑 ${maxGoalContinuations()} 次，先停在这里。看进度决定要不要继续（再发一条消息即可）。`,
    });
    return;
  }

  recordEvent({
    conversationId: opts.conversationId,
    messageId: null,
    kind: "status",
    toolName: "goal",
    output: `目标未完成，自动继续推进：${goal.objective}（第 ${goal.continuations + 1} 次续跑）`,
  });
  await runAgentTurn({
    conversationId: opts.conversationId,
    content: goalContinuationText(goal),
    workspace: opts.workspace,
    headless: opts.headless,
    goalContinuation: true,
  });
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
  /**
   * 用户按了停止 = 不想让它继续。Goal 模式必须跟着停 —— 否则松手之后它自己又跑起来，
   * 那是最让人意外的一种行为。改成 paused（不是 dropped）：用户下次说话时自动恢复。
   */
  const goal = getGoal(conversationId);
  if (goal && goal.status === "active") {
    setGoalStatus(conversationId, "paused", "用户中断了本轮，目标暂停");
    recordEvent({
      conversationId,
      messageId: currentMessageId(conversationId),
      kind: "status",
      toolName: "goal",
      output: "已按停止：目标暂停自动推进。想继续时再发一条消息即可恢复。",
    });
  }
  // 正在等用户确认的生图弹窗先收尾，否则工具会一直挂到超时。
  cancelMediaSetup();
  // 挂起的授权 / 提问也要收尾：否则 abort 后工具还停在 await 上。
  cancelPendingForConversation(conversationId);
  // 停止 = 连排队中的后续消息一起取消，否则用户以为停了它又自己跑起来。
  clearQueuedMessages(conversationId);
  /**
   * 也给自愈循环留个标记：内核的 abort 只能打断"正在跑的那一轮"，
   * 而失败重发发生在两轮之间（退避等待里）—— 没有这条，用户按了停止
   * 它还会再发一次请求，看起来就是"停止没用"。
   */
  stopRequests.add(conversationId);
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
 *
 * 「删哪些、拿谁的正文当 prompt」由 `planRegenerate` 决定（纯函数，有单测）；
 * 这里只负责落库与重跑。
 */
export async function regenerateAgentMessage(
  conversationId: number,
  messageId: number,
): Promise<{ ok: boolean; error?: string }> {
  const target = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!target || target.role !== "assistant") return { ok: false, error: "Message not found" };

  const history = getHistory(conversationId);
  const plan = planRegenerate(history, messageId);
  if (!plan.ok) return { ok: false, error: plan.error };

  for (const m of history) {
    if (m.id >= plan.deleteFromId) {
      db.delete(agentEvents).where(eq(agentEvents.messageId, m.id)).run();
      Chat.deleteMessage(conversationId, m.id);
    }
  }
  // 丢弃旧实例，避免残留的工具调用轨迹影响新一轮。
  resetAgentSession(conversationId);

  // `insertUserMessage: false`：那条用户消息排在目标回答之前、不在删除区间内，
  // 库里已经有了。不传这句 `runAgentTurn` 会默认再插一条 —— 每次重新生成都会多出
  // 一个一模一样的用户气泡，模型侧还会在历史与 prompt 里各看到它一遍。
  return runAgentTurn({
    conversationId,
    content: plan.prompt,
    insertUserMessage: false,
  });
}

/**
 * 回退到某条消息：删掉它之后（用户消息则连它一起）的全部消息与工具事件，**不重新生成**。
 *
 * 与重新生成的区别是「不再自动跑一轮」—— 用户想自己改一改再说，或者只是想让这条
 * 岔路消失。删除边界按角色分：
 * - 落在**用户**消息上（「回到这条提问」）：连它一起删，并把正文回填给输入框，
 *   否则用户得自己把问题重打一遍；
 * - 落在**助手**消息上（「保留到这里」）：保留这条回答，只删它后面的内容
 *   —— 常见场景是「这个回答是对的，后面几轮跑偏了」。
 *
 * 只动对话不动工作区文件：文件还原是另一个功能（每轮快照的「撤销本轮」），
 * 两者混在一起会让「回退」变成一个用户无法预期的破坏性操作。
 */
export async function revertAgentSession(
  conversationId: number,
  messageId: number,
): Promise<{ ok: boolean; error?: string; removed?: number; prompt?: string }> {
  const target = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!target || target.conversationId !== conversationId) {
    return { ok: false, error: "Message not found" };
  }

  // 删除边界是纯函数（`planRevertToMessage`）：这条规则错一次的代价是"用户想保留的
  // 那条回答被删了"，只有单测能盯住，界面上看不出来。
  const plan = planRevertToMessage(getHistory(conversationId), messageId);
  if (plan.doomed.length === 0) return { ok: false, error: "Nothing to revert" };

  for (const id of plan.doomed) {
    db.delete(agentEvents).where(eq(agentEvents.messageId, id)).run();
    Chat.deleteMessage(conversationId, id);
  }
  resetAgentSession(conversationId);
  logEvent({
    level: "info",
    source: "agent",
    event: "agent.session.reverted",
    message: `会话 ${conversationId} 回退到消息 ${messageId}，删除 ${plan.doomed.length} 条`,
    detail: { conversationId, messageId, removed: plan.doomed.length, keepTarget: plan.keepTarget },
  });
  return {
    ok: true,
    removed: plan.doomed.length,
    // 只有"连提问一起删"的那种才需要把正文还回去（助手消息的正文还在库里）。
    prompt: plan.keepTarget ? "" : (target.content ?? ""),
  };
}
