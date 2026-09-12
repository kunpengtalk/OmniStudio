/**
 * Agent 交互（OpenWork 的 "session interactions"）：
 * 工具授权「询问」与 ask_user「提问」都需要把控制权交给用户，
 * 这里负责挂起 / 唤醒 —— 工具执行 await 一个 Promise，UI 应答后 resolve。
 *
 * 设计要点：
 * - 请求只存在内存里（进程重启即失效），但用户的「总是允许」会写成规则落库；
 * - 每个请求带超时（默认 10 分钟），超时按拒绝处理，避免工具永远挂着；
 * - 会话被中断 / 重置时，该会话所有待处理请求立刻按「已取消」收尾。
 */
import { randomUUID } from "crypto";

import {
  addAuthorizedFolder,
  evaluate,
  effectiveRules,
  grantPermission,
  permissionRequestForTool,
  type PermissionAction,
  type PermissionRequest,
} from "./permissions";

/** 授权弹窗上的四个选择。 */
export type PermissionReply = "once" | "session" | "workspace" | "deny";

export type PendingPermission = PermissionRequest & {
  id: string;
  conversationId: number;
  messageId: number | null;
  /** 触发它的工具名，弹窗里显示「来自 bash」。 */
  toolName: string;
  /** 工具入参摘要（弹窗折叠区里的原始信息）。 */
  argsPreview: string;
  createdAt: number;
  expiresAt: number;
};

export type QuestionOption = { label: string; description?: string };
export type QuestionPrompt = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
};

export type PendingQuestion = {
  id: string;
  conversationId: number;
  messageId: number | null;
  questions: QuestionPrompt[];
  createdAt: number;
};

type Waiter<T> = {
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const permissionWaiters = new Map<string, Waiter<PermissionReply>>();
const questionWaiters = new Map<string, Waiter<string[][]>>();
const pendingPermissions = new Map<string, PendingPermission>();
const pendingQuestions = new Map<string, PendingQuestion>();

type PermissionRequestListener = (payload: PendingPermission) => void;
type PermissionSettledListener = (payload: {
  conversationId: number;
  id: string;
  reply: PermissionReply;
  permission: string;
  pattern: string;
}) => void;
type QuestionListener = (payload: PendingQuestion) => void;
type QuestionSettledListener = (payload: {
  conversationId: number;
  id: string;
  answers: string[][];
}) => void;

const permissionListeners = new Set<PermissionRequestListener>();
const settledListeners = new Set<PermissionSettledListener>();
const questionListeners = new Set<QuestionListener>();
const questionSettledListeners = new Set<QuestionSettledListener>();

export function onPermissionRequest(cb: PermissionRequestListener): () => void {
  permissionListeners.add(cb);
  return () => permissionListeners.delete(cb);
}
export function onPermissionSettled(cb: PermissionSettledListener): () => void {
  settledListeners.add(cb);
  return () => settledListeners.delete(cb);
}
export function onQuestionAsked(cb: QuestionListener): () => void {
  questionListeners.add(cb);
  return () => questionListeners.delete(cb);
}
export function onQuestionSettled(cb: QuestionSettledListener): () => void {
  questionSettledListeners.add(cb);
  return () => questionSettledListeners.delete(cb);
}

function emitPermission(payload: PendingPermission) {
  for (const cb of permissionListeners) cb(payload);
}
function emitSettled(payload: Parameters<PermissionSettledListener>[0]) {
  for (const cb of settledListeners) cb(payload);
}
function emitQuestion(payload: PendingQuestion) {
  for (const cb of questionListeners) cb(payload);
}
function emitQuestionSettled(payload: Parameters<QuestionSettledListener>[0]) {
  for (const cb of questionSettledListeners) cb(payload);
}

export function listPendingPermissions(conversationId?: number): PendingPermission[] {
  const all = [...pendingPermissions.values()].sort((a, b) => a.createdAt - b.createdAt);
  return conversationId === undefined ? all : all.filter((p) => p.conversationId === conversationId);
}

export function listPendingQuestions(conversationId?: number): PendingQuestion[] {
  const all = [...pendingQuestions.values()].sort((a, b) => a.createdAt - b.createdAt);
  return conversationId === undefined ? all : all.filter((p) => p.conversationId === conversationId);
}

/**
 * 工具执行前的授权闸门：
 * - 返回 null = 放行（工具照常执行）；
 * - 返回字符串 = 拒绝原因（agent 层把它变成被拦截的工具结果）。
 * ask 的情况会在这里挂起，直到用户应答或超时。
 */
export async function authorizeToolCall(input: {
  conversationId: number;
  messageId: number | null;
  toolName: string;
  args: Record<string, unknown>;
  workspace: string;
  argsPreview: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | null> {
  const request = permissionRequestForTool({
    toolName: input.toolName,
    args: input.args,
    workspace: input.workspace,
  });
  if (!request) return null;

  const rules = effectiveRules(input.conversationId, input.workspace);
  const decision = evaluate(request, rules);
  const action: PermissionAction = decision.action;

  if (action === "allow") return null;
  if (action === "deny") {
    return `已按当前权限策略拒绝：${request.title}（${request.permission} / ${request.pattern}）。如需放行，请在 Agent 权限设置里调整。`;
  }

  const id = randomUUID();
  const now = Date.now();
  const pending: PendingPermission = {
    ...request,
    id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    toolName: input.toolName,
    argsPreview: input.argsPreview,
    createdAt: now,
    expiresAt: now + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  pendingPermissions.set(id, pending);
  emitPermission(pending);

  const denyPayload = () => ({
    conversationId: input.conversationId,
    id,
    reply: "deny" as const,
    permission: request.permission,
    pattern: request.pattern,
  });

  const reply = await new Promise<PermissionReply>((resolve) => {
    const onAbort = () => {
      emitSettled(denyPayload());
      finish("deny");
    };
    const finish = (value: PermissionReply) => {
      const waiter = permissionWaiters.get(id);
      if (waiter) clearTimeout(waiter.timer);
      // 一个长回合可能问很多次：监听器不回收会在同一个 signal 上越挂越多。
      input.signal?.removeEventListener("abort", onAbort);
      permissionWaiters.delete(id);
      pendingPermissions.delete(id);
      resolve(value);
    };
    permissionWaiters.set(id, {
      resolve: finish,
      timer: setTimeout(() => {
        emitSettled(denyPayload());
        finish("deny");
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    // 已经中断过时 addEventListener 不会再触发，这里补一次。
    if (input.signal?.aborted) onAbort();
  });

  if (reply === "deny") {
    return `用户拒绝了本次操作：${request.title}（${request.permission} / ${request.pattern}）。请换一种不需要该授权的方式继续，或询问用户。`;
  }

  // 「本会话总是」/「始终允许」：把模式写成 allow 规则，下次直接放行。
  if (reply === "session" || reply === "workspace") {
    const scope = reply === "session" ? "session" : "workspace";
    const scopeRef = reply === "session" ? String(input.conversationId) : input.workspace;
    const patterns = request.always.length ? request.always : [request.pattern];
    for (const pattern of patterns) {
      grantPermission({ scope, scopeRef, permission: request.permission, pattern, action: "allow" });
    }
    // 访问工作区之外还要过路径层：把目录加进白名单，工具才真的读得到 / 写得进。
    if (request.permission === "external_directory") {
      for (const pattern of patterns) {
        const dir = pattern.replace(/\/\*$/, "");
        addAuthorizedFolder(dir);
      }
    }
  }
  return null;
}

/** UI 应答一个授权请求。 */
export function respondPermission(id: string, reply: PermissionReply): { ok: boolean } {
  const waiter = permissionWaiters.get(id);
  const pending = pendingPermissions.get(id);
  if (!waiter) return { ok: false };
  emitSettled({
    conversationId: pending?.conversationId ?? -1,
    id,
    reply,
    permission: pending?.permission ?? "",
    pattern: pending?.pattern ?? "",
  });
  waiter.resolve(reply);
  return { ok: true };
}

/** 会话中断时把该会话所有待处理授权收尾（按拒绝处理，工具会拿到明确原因）。 */
export function cancelPendingForConversation(conversationId: number): void {
  for (const pending of listPendingPermissions(conversationId)) respondPermission(pending.id, "deny");
  for (const question of listPendingQuestions(conversationId)) {
    respondQuestion(question.id, []);
  }
}

/**
 * ask_user 工具的实现：把问题推给 UI，等用户填完再回传答案。
 * 返回的 answers 与 questions 一一对应（多选为数组拼接「、」）。
 */
export async function askQuestions(input: {
  conversationId: number;
  messageId: number | null;
  questions: QuestionPrompt[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string[][]> {
  const id = randomUUID();
  const pending: PendingQuestion = {
    id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    questions: input.questions,
    createdAt: Date.now(),
  };
  pendingQuestions.set(id, pending);
  emitQuestion(pending);

  return new Promise<string[][]>((resolve) => {
    const onAbort = () => {
      emitQuestionSettled({ conversationId: input.conversationId, id, answers: [] });
      finish([]);
    };
    const finish = (answers: string[][]) => {
      const waiter = questionWaiters.get(id);
      if (waiter) clearTimeout(waiter.timer);
      // 长回合可能问很多次，监听器不回收会在同一个 signal 上越挂越多。
      input.signal?.removeEventListener("abort", onAbort);
      questionWaiters.delete(id);
      pendingQuestions.delete(id);
      resolve(answers);
    };
    questionWaiters.set(id, {
      resolve: finish,
      timer: setTimeout(() => finish([]), input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    // 已经中断过的情况下 addEventListener 不会再触发，补一次。
    if (input.signal?.aborted) onAbort();
  });
}

export function respondQuestion(id: string, answers: string[][]): { ok: boolean } {
  const waiter = questionWaiters.get(id);
  const pending = pendingQuestions.get(id);
  if (!waiter) return { ok: false };
  emitQuestionSettled({
    conversationId: pending?.conversationId ?? -1,
    id,
    answers,
  });
  waiter.resolve(answers);
  return { ok: true };
}
