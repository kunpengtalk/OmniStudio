/**
 * 高频推送的节流。
 *
 * AGENTS.md 定下的口径：**每个事件都会重渲染 webview**，所以流式推送必须压到
 * 「chat 40ms / 下载进度 400ms / 日志 80ms」。这份实现是给「回调式推送」用的
 * （进度回调、stdout 逐行），正文流式的 40ms 批量另有 `chunk-flusher.ts` —— 那条
 * 链路要按 delta 累加文本，和这里的"合并/丢弃中间态"不是一回事。
 *
 * 两种语义，别混用：
 *   - `throttleLatest`：中间的百分比没有价值，**最后一个值必须送达**（进度条要走到 100%）。
 *     首个事件立刻发出（界面马上有反应），之后按时间窗合并，收尾调 `flush()`。
 *   - `throttleBatch`：日志行**一条都不能丢**，攒成一批整批发（少几次 IPC，顺序不变）。
 */

/** 下载 / 安装进度类推送的时间窗（AGENTS.md 的 400ms）。 */
export const PROGRESS_THROTTLE_MS = 400;
/** 日志类推送的时间窗（AGENTS.md 的 80ms）。 */
export const LOG_THROTTLE_MS = 80;

export type ThrottledLatest<A extends unknown[]> = {
  push: (...args: A) => void;
  /** 立刻把待发的最后一个值发出去（收尾 / 终态事件之前必须调）。 */
  flush: () => void;
};

/**
 * 只保留最后一个值，按时间窗下发（leading + trailing）。
 *
 * leading 是刻意的：第一个事件立刻发，用户点「下载」马上就能看到进度条动起来；
 * 之后的中间值合并掉；trailing 保证「最后一个值」在窗口结束后一定送到。
 */
export function throttleLatest<A extends unknown[]>(
  emit: (...args: A) => void,
  intervalMs: number = PROGRESS_THROTTLE_MS,
): ThrottledLatest<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const runAfterWindow = () => {
    timer = null;
    if (!pending) return;
    const args = pending;
    pending = null;
    emit(...args);
    timer = setTimeout(runAfterWindow, intervalMs);
  };

  return {
    push: (...args: A) => {
      if (timer) {
        pending = args;
        return;
      }
      emit(...args);
      timer = setTimeout(runAfterWindow, intervalMs);
    },
    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!pending) return;
      const args = pending;
      pending = null;
      emit(...args);
    },
  };
}

export type ThrottledBatch = {
  push: (line: string) => void;
  flush: () => void;
};

/**
 * 把日志行攒成批，按时间窗整批发（一行不丢、顺序不变）。
 * 收尾（进程退出 / 终态事件）前调 `flush()`，否则最后几行要等下一个窗口。
 */
export function throttleBatch(
  emit: (lines: string[]) => void,
  intervalMs: number = LOG_THROTTLE_MS,
): ThrottledBatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const lines = buffer;
    buffer = [];
    emit(lines);
  };

  return {
    push: (line: string) => {
      if (!line) return;
      buffer.push(line);
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush,
  };
}
