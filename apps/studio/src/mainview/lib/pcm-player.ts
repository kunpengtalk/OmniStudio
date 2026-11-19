/**
 * 云端实时 PCM 的**连续播放器**：一个常驻 ScriptProcessorNode + 一条字节队列。
 *
 * 这里换过两版实现，前两版都是错的，记录一下免得再走回去：
 *
 * 1. "攒一批 → 播完（onended）→ 再取下一批"的接力：每批之间等回调 + `await`，
 *    连续说话听成持续卡顿。
 * 2. "每个块新建 AudioBufferSourceNode、用 `start(when)` 排队"：看着像标准做法，
 *    实际仍是**每块一个独立 source**。几十个 source 并发存在时浏览器要对每个
 *    buffer 各自重采样再混音，块边界（尤其 9600/4800 字节交替的帧）处相位不连续，
 *    听感就是持续的"沙沙"杂音。
 *
 * 现在：**一个常驻节点 + 一条不间断的样本队列**。`onaudioprocess` 由音频时钟
 * 驱动，每次要多少就连续从队列里取多少，取不满就补静音 —— 波形天然连续，
 * 不存在"块"这个概念，所以既没有空隙也没有边界跳变。
 *
 * 队列按**字节**存（不是样本），因为 PCM16 的字节流才是连续的：某块长度是奇数时
 * 那个字节要接到下一块开头，逐块按样本切会丢掉它、让后面全部错位。
 *
 * 队列本身（`createPcmQueue`）与音频节点分离，是为了能在 bun test 里逐样本
 * 验证（happy-dom 没有 ScriptProcessorNode，播放器壳只能在真机跑，队列不必）。
 */

/** 字节队列（push 任意分片 / take 按拍取 int16 样本），与音频设备无关。 */
export function createPcmQueue() {
  /** 待播字节（PCM16 little-endian）。 */
  let queue = new Uint8Array(0);
  /** 队列里的读偏移（避免每次 shift 都搬整块内存）。 */
  let readPos = 0;
  /** 写入但在等另一半字节的残留。 */
  let carry: Uint8Array | null = null;

  return {
    /** 排入一块裸 PCM16 字节（会与残留的半样本拼接，保持字节流连续）。 */
    push(bytes: Uint8Array): void {
      let all = bytes;
      if (carry) {
        all = new Uint8Array(carry.length + bytes.length);
        all.set(carry, 0);
        all.set(bytes, carry.length);
        carry = null;
      }
      // 奇数长度：末尾那个字节留到下一块，不能丢（丢了后面全部错位）。
      if (all.length % 2 !== 0) {
        carry = all.slice(all.length - 1);
        all = all.subarray(0, all.length - 1);
      }
      if (all.length === 0) return;
      // 追加到队列尾部。
      const merged = new Uint8Array(queue.length - readPos + all.length);
      merged.set(queue.subarray(readPos), 0);
      merged.set(all, queue.length - readPos);
      queue = merged;
      readPos = 0;
    },

    /**
     * 取最多 `n` 个 int16 样本（不足则取现有全部，返回值可能短于 n）。
     * 返回的样本与推入的字节流逐位一致 —— 这是播放连续性的根。
     */
    take(n: number): Int16Array {
      const out = new Int16Array(n);
      let produced = 0;
      while (produced < n) {
        const availBytes = queue.length - readPos;
        if (availBytes < 2) break;
        const availSamples = availBytes >> 1;
        const cnt = Math.min(n - produced, availSamples);
        // 直接按 int16 读，源与目标都连续。
        const dv = new DataView(queue.buffer, queue.byteOffset + readPos, cnt * 2);
        for (let i = 0; i < cnt; i++) out[produced + i] = dv.getInt16(i * 2, true);
        produced += cnt;
        readPos += cnt * 2;
      }
      // 队列读空了就把已读部分丢掉，避免无限增长。
      if (readPos > 0 && readPos >= queue.length) {
        queue = new Uint8Array(0);
        readPos = 0;
      } else if (readPos > 1 << 18) {
        queue = queue.subarray(readPos);
        readPos = 0;
      }
      return out.subarray(0, produced);
    },

    /** 待播字节数（水位判断用）。 */
    get pendingBytes(): number {
      return queue.length - readPos;
    },

    /** 清空（打断 / 挂断）。 */
    reset(): void {
      carry = null;
      queue = new Uint8Array(0);
      readPos = 0;
    },
  };
}

export type PcmQueue = ReturnType<typeof createPcmQueue>;

/** 常驻 PCM 播放器（见模块注释）。 */
export type PcmPlayer = {
  push(bytes: Uint8Array): void;
  /** 队列里还有多少秒音频（判断缓冲水位，播放回执按它估算完成时刻）。 */
  bufferedSec: number;
  stop(): void;
  dispose(): void;
  node: ScriptProcessorNode;
};

/**
 * 建一个常驻播放器：2048 帧的缓冲区（≈43ms@48k）——
 * 太小（256/512）在 WKWebView 里容易欠采出爆音，太大（8192）会让打断延迟明显。
 */
export function createPcmPlayer(ctx: AudioContext, sampleRate: number): PcmPlayer {
  const q = createPcmQueue();

  const node = ctx.createScriptProcessor(2048, 0, 1);
  node.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    const got = q.take(out.length);
    for (let i = 0; i < got.length; i++) out[i] = got[i]! / 0x8000;
    // 欠载：剩余保持 0（静音）。宁可有极短静音，也不要有爆音。
    for (let i = got.length; i < out.length; i++) out[i] = 0;
  };
  node.connect(ctx.destination);

  return {
    push: (bytes) => q.push(bytes),
    get bufferedSec() {
      return q.pendingBytes / 2 / sampleRate;
    },
    stop: () => q.reset(),
    dispose() {
      q.reset();
      try {
        node.onaudioprocess = null;
        node.disconnect();
      } catch {
        // ignore
      }
    },
    node,
  };
}
