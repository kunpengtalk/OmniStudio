/**
 * 增量批量下发（40ms 一批）。
 *
 * 模型每个 token 一次 RPC 会让 webview 每秒重建几十次消息数组、并整段重解析 Markdown。
 * 40ms 一批（≈25fps）保持"逐字"观感，同时把 IPC 与前端重渲染次数降一个数量级 ——
 * AGENTS.md 里那条「Streaming pushes are throttled (chat 40ms)」说的就是这件事。
 *
 * 对话与 Agent 两条链路各写过一份一模一样的缓冲 + 定时器（连常量都各写一遍 40），
 * 只有"额外记账"（累计正文、步骤分段、通话的即时回调）不同。这里只保留共用的那半：
 * 攒够一批就冲，收尾前必须 `flushNow()` 把尾巴冲干净 —— 否则 `emitDone` 会先到、
 * 最后几个字后到，界面上表现为"收尾了又冒出来半句话"。
 */
export const CHUNK_FLUSH_INTERVAL_MS = 40;

export type ChunkFlusher = {
  /** 攒一段正文增量。 */
  pushContent(delta: string): void;
  /** 攒一段思考增量。 */
  pushReasoning(delta: string): void;
  /** 立刻冲掉缓冲（收尾 / 中断前必须调）。 */
  flushNow(): void;
  /**
   * 丢掉还没冲出去的缓冲（不发送）。
   *
   * Agent 的失败重发需要它：那一轮已经流出去的半截正文要作废，缓冲里还没发出去的
   * 更要作废 —— 留着的话它会在重试成功之后才被冲出去，于是"半截旧文本 + 新回答"
   * 一起出现在同一个气泡里。
   */
  discard(): void;
  /** 丢掉定时器（正常收尾后调用，避免残留 timer 让进程多活一拍）。 */
  dispose(): void;
};

export function createChunkFlusher(opts: {
  conversationId: number;
  messageId: number;
  emit: (payload: {
    conversationId: number;
    messageId: number;
    delta: string;
    kind?: "reasoning" | "content";
  }) => void;
  intervalMs?: number;
}): ChunkFlusher {
  const { conversationId, messageId, emit } = opts;
  const interval = opts.intervalMs ?? CHUNK_FLUSH_INTERVAL_MS;
  let pendingContent = "";
  let pendingReasoning = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingContent) {
      emit({ conversationId, messageId, delta: pendingContent, kind: "content" });
      pendingContent = "";
    }
    if (pendingReasoning) {
      emit({ conversationId, messageId, delta: pendingReasoning, kind: "reasoning" });
      pendingReasoning = "";
    }
  };

  const schedule = () => {
    if (!timer) timer = setTimeout(flushNow, interval);
  };

  return {
    pushContent: (delta) => {
      if (!delta) return;
      pendingContent += delta;
      schedule();
    },
    pushReasoning: (delta) => {
      if (!delta) return;
      pendingReasoning += delta;
      schedule();
    },
    flushNow,
    discard: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingContent = "";
      pendingReasoning = "";
    },
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
