/**
 * 把音频回调给的不定长数据块切成**定长帧**。
 *
 * VAD 要求帧长恒定（见 `shared/asr-vad.ts`）：每帧对应确定的采样数，切句的时间点才算得准。
 * 而采集侧一次给多少是浏览器定的（ScriptProcessor 的缓冲区大小，还可能因设备采样率
 * 重采样后长度变化）。这个切分器负责攒够一帧才交出去，且**不丢样本、不重复样本** ——
 * 丢一半个帧的后果是后面所有句子的时间戳都偏，而界面上很难看出来。
 */
export function createFrameSplitter(hopSize: number) {
  if (!Number.isFinite(hopSize) || hopSize <= 0) throw new Error("hopSize 必须是正数");
  let pending: Float32Array[] = [];
  let pendingLen = 0;

  return {
    /** 喂一块，返回这次能凑出的完整帧（可能 0 个，也可能多个）。 */
    push(block: Float32Array): Float32Array[] {
      const frames: Float32Array[] = [];
      if (block.length === 0) return frames;
      pending.push(block);
      pendingLen += block.length;
      while (pendingLen >= hopSize) {
        const frame = new Float32Array(hopSize);
        let filled = 0;
        while (filled < hopSize) {
          const head = pending[0]!;
          const need = hopSize - filled;
          if (head.length <= need) {
            frame.set(head, filled);
            filled += head.length;
            pending.shift();
            pendingLen -= head.length;
          } else {
            // 剩下的留在队首，下次继续用（subarray 是视图，不复制数据）。
            frame.set(head.subarray(0, need), filled);
            pending[0] = head.subarray(need);
            pendingLen -= need;
            filled = hopSize;
          }
        }
        frames.push(frame);
      }
      return frames;
    },
    /** 还没凑成整帧的样本数。 */
    get buffered(): number {
      return pendingLen;
    },
    reset() {
      pending = [];
      pendingLen = 0;
    },
  };
}
