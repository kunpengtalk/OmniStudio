/**
 * 宿主侧的最简录音器：**开 → 停 → 一段 16k 单声道 WAV base64**。
 *
 * 为什么录音必须由宿主做，而不是小应用自己在 iframe 里录：
 *   小应用跑在不带 `allow-same-origin` 的 sandbox iframe 里，文档是不透明源，
 *   `navigator.mediaDevices` 在那里根本不存在（实测：会议纪要页的「开始录音」
 *   只能弹一句"拿不到麦克风"）。而宿主窗口是安全上下文、麦克风权限也归它所有
 *   （语音页 / 实时通话都在用），所以录音这件事交给宿主，小应用只说"开始 / 停止"。
 *   这也和仓库的沙箱规矩一致：能力由宿主逐个放行，iframe 里的脚本碰不到设备权限 ——
 *   顺手也不该给沙箱页开 `allow="microphone"`。
 *
 * 两个实现取舍：
 *   - **请求 16k 的 AudioContext**：浏览器会把麦克风重采样到我们要的采样率，
 *     省掉逐块重采样（逐块做会遇到"块边界相位重来"的细碎抖动）。引擎给不了 16k 时
 *     退回实际采样率，收尾时整段重采样一次（单相位，正确）。
 *   - **按块就转成 PCM16**：会议纪要一录可能是一两小时，原始 float32 攒在内存里
 *     是 700MB/小时这个量级，PCM16 只要 115MB/小时。
 *
 * 单例：同时只允许一路录音 —— 小应用连点两下、或用户切走再回来，都不会开着两支流。
 */
import { encodeWavBase64, wavBase64FromPcm16 } from "./wav";

const TARGET_RATE = 16000;

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  node: ScriptProcessorNode;
  /** 每块 4096 个采样、已降位成 PCM16 的片段（块边界不影响拼接）。 */
  blocks: Int16Array[];
  samples: number;
  startedAt: number;
}

let session: Session | null = null;

function toPcm16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const v = Math.max(-1, Math.min(1, data[i] ?? 0));
    out[i] = Math.round(v * 0x7fff);
  }
  return out;
}

function teardown(): Session | null {
  const s = session;
  session = null;
  if (!s) return null;
  try {
    s.node.onaudioprocess = null;
    s.node.disconnect();
  } catch {
    // 已经断开就无所谓
  }
  try {
    void s.ctx.close();
  } catch {
    // 同上
  }
  s.stream.getTracks().forEach((track) => track.stop());
  return s;
}

export type RecordStartResult = { ok: true } | { ok: false; error: string };

/** 开始录音（已经在录时视为成功，不新开一路）。 */
export async function startHostRecording(): Promise<RecordStartResult> {
  if (session) return { ok: true };
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: "这个环境没有麦克风接口" };
  }
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 让浏览器把麦克风重采样到 16k（whisper 要的格式）；不支持时它会给实际采样率。
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      ctx = new AudioContext();
    }
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const blocks: Int16Array[] = [];
    let samples = 0;
    node.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      blocks.push(toPcm16(data));
      samples += data.length;
    };
    // ScriptProcessor 要有下游节点才会被驱动：接一个静音增益到 destination（不能直连，
    // 否则麦克风会被回放出来）。
    const silent = ctx.createGain();
    silent.gain.value = 0;
    src.connect(node);
    node.connect(silent);
    silent.connect(ctx.destination);
    session = { stream, ctx, node, blocks, samples, startedAt: Date.now() };
    return { ok: true };
  } catch (e) {
    stream?.getTracks().forEach((track) => track.stop());
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `拿不到麦克风：${message}` };
  }
}

export type RecordStopResult =
  | { ok: true; wavBase64: string; seconds: number }
  | { ok: false; error: string };

/** 停止录音并给出整段 WAV（没在录时返回失败，调用方据此还原界面）。 */
export function stopHostRecording(): RecordStopResult {
  const s = session;
  if (!s) return { ok: false, error: "没有正在进行的录音" };
  const seconds = Math.max(0, Math.round((Date.now() - s.startedAt) / 1000));
  const rate = s.ctx.sampleRate;
  teardown();

  // 空录音（点开就停）也当失败：给模型一段静音只会换来一句"没有内容"。
  if (s.samples === 0) return { ok: false, error: "没有录到声音" };

  const pcm = new Int16Array(s.samples);
  let at = 0;
  for (const block of s.blocks) {
    pcm.set(block, at);
    at += block.length;
  }

  if (Math.abs(rate - TARGET_RATE) < 1) {
    return { ok: true, wavBase64: wavBase64FromPcm16(pcm, TARGET_RATE), seconds };
  }
  // 引擎没给 16k：整段重采样一次（单相位，块边界不会有抖动）
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) f32[i] = (pcm[i] ?? 0) / 0x7fff;
  return { ok: true, wavBase64: encodeWavBase64(f32, rate, TARGET_RATE), seconds };
}

/** 丢弃当前录音（小应用重载 / 关闭容器时调用，避免麦克风一直开着）。 */
export function cancelHostRecording(): void {
  teardown();
}

export function isHostRecording(): boolean {
  return session !== null;
}
