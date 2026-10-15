/**
 * 无限画布的文本生成（`canvasRunText` / `canvasStopText`）。
 *
 * 为什么不走 chat 通道：对话流（`sendChatMessage` → `chatChunk`）绑定会话 /
 * 消息 id，而画布节点是"一次性补全"——提示词 + 上游连线文本进、整段文本出，
 * 没有会话可挂。这里直接用 Vercel AI SDK 的 `streamText`（与写词、翻译同一条
 * 依赖路径），增量通过 `canvasTextChunk` 推送回画布页。
 *
 * 模型解析沿用画布节点上保存的 `CanvasModelChoice`：
 * - cloud：`providerId` 指向云厂商行（地址 / 密钥只从行里取，调用方不可传）；
 * - local：`providerId` 指向已启动实例（`Served.getServedModel`），端点与
 *   servedName 都来自实例本身 —— 选了哪个实例就用哪个，不静默退回当前对话模型。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, type LanguageModel } from "ai";

import { logEvent } from "./app-log";
import { getChatModel, getChatModelLabel } from "./chat-model";
import { resolveCloudProvider } from "./cloud-providers";
import * as Served from "./model-servers";
import { recordUsage } from "./stats";
import {
  CANVAS_LIMITS,
  type CanvasModelChoice,
  type CanvasTextChunkEvent,
  type CanvasTextContextItem,
} from "../shared/canvas";

type ChunkListener = (event: CanvasTextChunkEvent) => void;

const chunkListeners = new Set<ChunkListener>();

/** rpc/index.ts 的 initCanvasBroadcast 订阅这个回调，把增量转发给 webview。 */
export function onCanvasTextChunk(cb: ChunkListener): () => void {
  chunkListeners.add(cb);
  return () => chunkListeners.delete(cb);
}

function emitChunk(event: CanvasTextChunkEvent) {
  for (const cb of chunkListeners) {
    try {
      cb(event);
    } catch {}
  }
}

/** 正在流式的节点：nodeId → controller（StopText / 重复生成时中断）。 */
const running = new Map<string, AbortController>();

export function stopCanvasText(nodeId: string): void {
  running.get(nodeId)?.abort();
}

/** 返回模型与它的展示名（用量记录里要能看出这次生成跑在哪个模型上）。 */
function resolveLanguageModel(choice: CanvasModelChoice | undefined): { model: LanguageModel; label: string } {
  // 没选模型时退回当前对话模型，与「默认模型」语义一致。
  if (!choice) return { model: getChatModel(), label: getChatModelLabel() || "canvas" };
  if (choice.source === "local") {
    const instance = choice.providerId ? Served.getServedModel(choice.providerId) : undefined;
    if (!instance || instance.status !== "running") {
      throw new Error("本地模型没有在运行（去 运行模型 页启动后再试）");
    }
    const provider = createOpenAICompatible({
      name: "omni-studio-canvas",
      baseURL: instance.endpoint,
      apiKey: "EMPTY",
    });
    return { model: provider.languageModel(instance.servedName), label: instance.label };
  }
  const providerRow = resolveCloudProvider(choice.providerId);
  if (!providerRow?.baseUrl) {
    throw new Error("云厂商不存在或没有配置地址（设置 → 云端模型）");
  }
  const provider = createOpenAICompatible({
    name: "omni-studio-canvas",
    baseURL: providerRow.baseUrl,
    apiKey: providerRow.apiKey || undefined,
  });
  return { model: provider.languageModel(choice.model), label: choice.model };
}

function buildPrompt(prompt: string, context: CanvasTextContextItem[] | undefined): string {
  const parts: string[] = [];
  for (const item of (context ?? []).slice(0, 20)) {
    const text = (item.text ?? "").trim().slice(0, CANVAS_LIMITS.promptChars);
    if (!text) continue;
    parts.push(`【参考 · ${item.title || "上游节点"}】\n${text}`);
  }
  parts.push(prompt.trim());
  return parts.join("\n\n");
}

/** 启动一次文本生成：立即返回，增量与终态走 `canvasTextChunk` 推送。 */
export function runCanvasText(input: {
  docId: number;
  nodeId: string;
  prompt: string;
  context?: CanvasTextContextItem[];
  model?: CanvasModelChoice;
}): { ok: boolean; error?: string } {
  const nodeId = input.nodeId;
  if (!nodeId) return { ok: false, error: "缺少节点 id" };
  const promptText = buildPrompt(input.prompt, input.context).slice(0, CANVAS_LIMITS.promptChars * 2);
  if (!promptText) return { ok: false, error: "提示词为空（连线上游文本也可以）" };

  // 同一节点重复生成：中断上一次再开新的（节点结果只保留最新一份）。
  running.get(nodeId)?.abort();

  let resolved: { model: LanguageModel; label: string };
  try {
    resolved = resolveLanguageModel(input.model);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emitChunk({ docId: input.docId, nodeId, delta: "", done: true, error: message });
    return { ok: false, error: message };
  }

  const controller = new AbortController();
  running.set(nodeId, controller);

  // 40ms 节流与对话流同款：每个增量都直接重渲染整张画布，攒一批再推。
  let pending = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pending) return;
    const delta = pending;
    pending = "";
    emitChunk({ docId: input.docId, nodeId, delta, done: false });
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 40);
  };

  void (async () => {
    try {
      const result = streamText({ model: resolved.model, prompt: promptText, abortSignal: controller.signal });
      for await (const delta of result.textStream) {
        if (controller.signal.aborted) break;
        pending += delta;
        if (pending.length >= 48) flush();
        else scheduleFlush();
      }
      flush();
      if (!controller.signal.aborted) {
        emitChunk({ docId: input.docId, nodeId, delta: "", done: true });
        try {
          const usage = await result.usage;
          recordUsage(resolved.label, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0);
        } catch {}
      } else {
        emitChunk({ docId: input.docId, nodeId, delta: "", done: true });
      }
    } catch (e) {
      flush();
      const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
      if (!aborted) {
        const message = e instanceof Error ? e.message : String(e);
        logEvent({
          level: "error",
          source: "canvas",
          event: "canvas.text.failed",
          message,
          detail: { nodeId, docId: input.docId },
        });
        emitChunk({ docId: input.docId, nodeId, delta: "", done: true, error: message });
      } else {
        emitChunk({ docId: input.docId, nodeId, delta: "", done: true });
      }
    } finally {
      if (running.get(nodeId) === controller) running.delete(nodeId);
    }
  })();

  return { ok: true };
}
