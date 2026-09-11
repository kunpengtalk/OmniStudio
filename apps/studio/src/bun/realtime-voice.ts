import { getSetting, updateSettings } from "./db/settings";

/**
 * Qwen Audio Realtime（DashScope「实时语音通话」云端模式）。
 *
 * 走 OpenAI-Realtime 兼容 WebSocket 协议（endpoint/api-ws/v1/realtime），
 * 协议细节对照 qwen-audio-agent（Apache-2.0）的 realtime-gateway.mjs /
 * providers/dashscope.mjs 逐条核实：
 *   - 连接：`<base>?model=<model>`，Header `Authorization: Bearer <API_KEY>`
 *   - 上行：session.update / input_audio_buffer.append（base64 PCM16 16k）/
 *           response.cancel（打断）
 *   - 下行：response.audio_transcript.delta（助手流式文本）/
 *           response.audio.delta（base64 PCM16 24k 音频块）/
 *           conversation.item.input_audio_transcription.{delta,text}（用户转写）/
 *           input_audio_buffer.speech_started/stopped（服务端 VAD）/ response.done
 *   - 音频模型族 turn_detection 用 smart_turn（服务端智能断句 + 自动打断），
 *     Omni 族用 semantic_vad；输入 16k / 输出 24k，格式 pcm。
 */

export type VoiceCallProvider = "local" | "cloud";

/** 可选的云端实时模型（qwen-audio-agent 默认即 plus 档）。 */
export const REALTIME_MODELS = [
  "qwen-audio-3.0-realtime-plus",
  "qwen-audio-3.0-realtime-flash",
  "qwen3.5-omni-flash-realtime",
  "qwen3.5-omni-plus-realtime",
] as const;

export const DEFAULT_REALTIME_BASE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
export const DEFAULT_REALTIME_MODEL = "qwen-audio-3.0-realtime-plus";
export const DEFAULT_REALTIME_VOICE = "longanqian";

export type RealtimeProviderConfig = {
  provider: VoiceCallProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  /** 云端是否已配好（有 API Key 即可走云端）。 */
  configured: boolean;
};

export function getVoiceCallProvider(): VoiceCallProvider {
  return getSetting("VOICE_CALL_PROVIDER") === "cloud" ? "cloud" : "local";
}

export function getRealtimeProviderConfig(): RealtimeProviderConfig {
  const apiKey = (getSetting("VOICE_CALL_REALTIME_API_KEY") || "").trim();
  return {
    provider: getVoiceCallProvider(),
    apiKey,
    baseUrl: (getSetting("VOICE_CALL_REALTIME_BASE_URL") || DEFAULT_REALTIME_BASE_URL).trim(),
    model: (getSetting("VOICE_CALL_REALTIME_MODEL") || DEFAULT_REALTIME_MODEL).trim(),
    voice: (getSetting("VOICE_CALL_REALTIME_VOICE") || DEFAULT_REALTIME_VOICE).trim(),
    configured: !!apiKey,
  };
}

export function saveRealtimeProviderConfig(cfg: {
  provider?: VoiceCallProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
}): void {
  const settings: Record<string, string> = {};
  if (cfg.provider !== undefined) settings.VOICE_CALL_PROVIDER = cfg.provider;
  if (cfg.apiKey !== undefined) settings.VOICE_CALL_REALTIME_API_KEY = cfg.apiKey.trim();
  if (cfg.baseUrl !== undefined) settings.VOICE_CALL_REALTIME_BASE_URL = cfg.baseUrl.trim();
  if (cfg.model !== undefined) settings.VOICE_CALL_REALTIME_MODEL = cfg.model.trim();
  if (cfg.voice !== undefined) settings.VOICE_CALL_REALTIME_VOICE = cfg.voice.trim();
  updateSettings(settings);
}

// ---------------------------------------------------------------------------
// WAV → PCM16
// ---------------------------------------------------------------------------

/**
 * 从 16k/16bit 单声道 WAV 里剥离文件头，返回裸 PCM16 数据。
 * 头校验失败时按「已是裸 PCM」处理（前端云端模式直接传裸 PCM，不会被误伤）。
 */
export function wavToPcm16(wav: Buffer): Buffer {
  if (wav.length < 44) return wav;
  if (
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return wav;
  }
  let pos = 12;
  let dataSize = 0;
  let dataStart = 0;
  while (pos + 8 <= wav.length) {
    const id = wav.toString("ascii", pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    if (id === "data") {
      dataSize = size;
      dataStart = pos + 8;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  const end = Math.min(dataStart + dataSize, wav.length);
  if (dataStart >= end) return Buffer.alloc(0);
  return wav.subarray(dataStart, end);
}

// ---------------------------------------------------------------------------
// 实时会话客户端
// ---------------------------------------------------------------------------

/**
 * 归一化后的云端事件：voice-call.ts 据此驱动现有 RPC 通道
 * （partial / utterance / state / audio / audioStop），前端无感切换。
 */
export type RealtimeVoiceEvent =
  | { type: "ready" }
  /** 用户实时转写（直播字幕）。 */
  | { type: "userPartial"; text: string }
  /** 用户一句话定稿（服务端 VAD 断句后给出）。 */
  | { type: "userText"; text: string }
  /** 助手流式正文（response.audio_transcript.delta）。 */
  | { type: "partial"; text: string }
  /** 助手音频块（PCM16 24k 单声道）。 */
  | { type: "audio"; pcm: Buffer }
  /** 一回合开始（服务端开始生成）。 */
  | { type: "turnStart" }
  /** 一回合结束（含本回合助手全文）。 */
  | { type: "turnEnd"; text: string }
  /** 服务端 VAD 检测到用户开始说话（speaking 期打断靠它触发）。 */
  | { type: "speechStart" }
  | { type: "speechEnd" }
  | { type: "error"; message: string };

export type RealtimeVoiceConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  instructions: string;
  /**
   * 恢复历史通话时注入的上下文（最近一些轮次的文本消息）。连接就绪后通过
   * conversation.item.create 回放给模型，让云端会话"记得"上次聊了什么。
   */
  history?: { role: "user" | "assistant"; content: string }[];
  onEvent: (ev: RealtimeVoiceEvent) => void;
};

type WsLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
};

const WS_OPEN = 1;

export class RealtimeVoiceClient {
  private cfg: RealtimeVoiceConfig;
  private ws: WsLike | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private ready = false;
  /** 是否曾成功打开过（onopen）。从未打开就收到 onclose 说明是服务端拒绝握手。 */
  private openedOnce = false;
  private respText = "";
  private log: (line: string) => void;

  constructor(cfg: RealtimeVoiceConfig, log?: (line: string) => void) {
    this.cfg = cfg;
    this.log = log ?? (() => {});
  }

  /** 建立连接并下发 session 配置。断线自动重连（1s→2s→5s 封顶，最多 5 次）。 */
  connect(): void {
    if (this.stopped) return;
    if (!this.cfg.apiKey) {
      this.fail("云端模式未配置 API Key，请先在通话界面的「云端配置」中填写");
      return;
    }
    this.closeWs();
    const url = `${this.cfg.baseUrl}${this.cfg.baseUrl.includes("?") ? "&" : "?"}model=${encodeURIComponent(
      this.cfg.model,
    )}`;
    this.log(`realtime connect: ${url}`);
    let ws: WebSocket;
    try {
      // Bun 的 WebSocket 支持自定义 headers，但 DOM 类型签名没有，故断言。
      ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      } as unknown as string);
    } catch (e) {
      this.fail(`无法连接云端实时语音：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const handle: WsLike = ws as unknown as WsLike;
    this.ws = handle;
    handle.onopen = () => {
      this.openedOnce = true;
      this.reconnectAttempts = 0;
      this.respText = "";
      this.ready = false;
      this.sendSessionUpdate();
    };
    handle.onmessage = (ev) => {
      if (typeof ev.data === "string") this.handleMessage(ev.data);
    };
    handle.onerror = () => {
      // Bun 不提供可读的错误消息，拒绝细节由 onclose 的 code/reason 承担。
      this.log("realtime ws onerror (no readable detail)");
    };
    handle.onclose = (ev) => {
      if (this.ws === handle) this.ws = null;
      this.ready = false;
      if (this.stopped) return;
      const code = ev?.code;
      const reason = (ev?.reason ?? "").trim();
      this.log(`realtime closed code=${code} reason=${JSON.stringify(reason)} opened=${this.openedOnce}`);
      // 从未成功打开就被服务端拒绝（1002/1003/1008/1011 或 4xxx 业务拒绝）：
      // 问题是鉴权/协议级别的，重连再多也过不去，直接报错让用户看到真实原因。
      if (
        !this.openedOnce &&
        (code === 1002 || code === 1003 || code === 1008 || code === 1011 ||
          (code != null && code >= 4000 && code < 5000))
      ) {
        this.fail(
          `云端拒绝连接（code=${code}${reason ? `：${reason}` : ""}）：请检查 API Key 与 WebSocket 地址`,
        );
        return;
      }
      void this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 5) {
      this.fail("云端实时连接断开且重连失败，请检查网络与 API Key");
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 5000);
    this.log(`realtime reconnect #${this.reconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private closeWs(): void {
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private fail(message: string): void {
    this.stopped = true;
    this.log(`realtime error: ${message}`);
    this.emit({ type: "error", message });
  }

  private emit(ev: RealtimeVoiceEvent): void {
    try {
      this.cfg.onEvent(ev);
    } catch (e) {
      this.log(`onEvent error: ${String(e)}`);
    }
  }

  private send(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      // 连接刚断开时丢弃即可
    }
  }

  private sendSessionUpdate(): void {
    // 音频模型族默认 smart_turn（服务端智能断句 + 说话即打断），Omni 族 semantic_vad。
    const isOmni = /omni/i.test(this.cfg.model);
    this.send({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: this.cfg.voice,
        instructions: this.cfg.instructions,
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        turn_detection: isOmni ? { type: "semantic_vad" } : { type: "smart_turn" },
      },
    });
  }

  /** 会话就绪后回放历史消息作为上下文（失败不影响主流程，仅记录）。 */
  private injectHistory(): void {
    for (const item of this.cfg.history ?? []) {
      const text = item.content.trim().slice(0, 800);
      if (!text) continue;
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: item.role,
          // 用户历史用 input_text；助手历史用 output_text（OpenAI Realtime 约定）。
          content: [
            {
              type: item.role === "user" ? "input_text" : "output_text",
              text,
            },
          ],
        },
      });
    }
  }

  /** 追加一段用户音频（PCM16 16k 单声道）。 */
  appendAudio(pcm: Buffer): void {
    if (pcm.length === 0) return;
    this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  /**
   * 用户一句话结束的显式信号：告诉服务端输入缓冲可以落定了。
   * 配合服务端 smart_turn 使用，可让断句更跟手（无副作用，重复提交安全）。
   */
  commit(): void {
    this.send({ type: "input_audio_buffer.commit" });
  }

  /** 打断：停掉正在进行的生成（服务端 smart_turn 同时会自动截断旧回复）。 */
  interrupt(): void {
    this.send({ type: "response.cancel" });
  }

  /** 挂断：关闭连接且不再重连。 */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeWs();
  }

  private handleMessage(raw: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof ev.type === "string" ? ev.type : "";
    switch (type) {
      case "session.updated":
        this.ready = true;
        this.emit({ type: "ready" });
        this.injectHistory();
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const text = String(ev.text ?? "");
        if (text) this.emit({ type: "userPartial", text });
        break;
      }
      case "conversation.item.input_audio_transcription.text":
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(ev.text ?? "");
        if (text) this.emit({ type: "userText", text });
        break;
      }
      case "input_audio_buffer.speech_started":
        this.emit({ type: "speechStart" });
        break;
      case "input_audio_buffer.speech_stopped":
        this.emit({ type: "speechEnd" });
        break;
      case "response.created":
        this.respText = "";
        this.emit({ type: "turnStart" });
        break;
      case "response.audio_transcript.delta": {
        const delta = String(ev.delta ?? "");
        if (!delta) break;
        this.respText += delta;
        this.emit({ type: "partial", text: delta });
        break;
      }
      case "response.audio.delta": {
        const b64 = String(ev.delta ?? "");
        if (!b64) break;
        try {
          this.emit({ type: "audio", pcm: Buffer.from(b64, "base64") });
        } catch {
          // 非法 base64 直接丢弃
        }
        break;
      }
      case "response.done": {
        const full = this.respText;
        this.respText = "";
        this.emit({ type: "turnEnd", text: full });
        break;
      }
      case "error": {
        const raw = ev.message;
        const message =
          typeof raw === "string"
            ? raw
            : raw && typeof raw === "object" && "message" in raw
              ? String((raw as { message?: string }).message ?? "")
              : "";
        this.emit({ type: "error", message: message || "云端实时语音错误" });
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// 连接测试（配置引导里的「保存并测试连接」）
// ---------------------------------------------------------------------------

const REALTIME_TEST_TIMEOUT_MS = 10_000;

export type RealtimeTestResult = {
  ok: boolean;
  error?: string;
  /** 从发起连接到收到 onopen / onclose 的耗时（ms）。 */
  latencyMs?: number;
};

/**
 * 用给定（或已保存的）配置开一条真实 WebSocket 连接，验证 API Key / 地址 / 模型
 * 是否可用。能收到 onopen 即代表鉴权通过（DashScope 在升级阶段校验 token，
 * key 无效时直接回非 101 状态码、进 onclose）。测试完立即关闭连接。
 */
export function testRealtimeConnection(
  cfg?: Partial<Pick<RealtimeProviderConfig, "apiKey" | "baseUrl" | "model">>,
): Promise<RealtimeTestResult> {
  return new Promise((resolve) => {
    const current = getRealtimeProviderConfig();
    const apiKey = (cfg?.apiKey ?? current.apiKey).trim();
    const baseUrl = (cfg?.baseUrl ?? current.baseUrl).trim() || DEFAULT_REALTIME_BASE_URL;
    const model = (cfg?.model ?? current.model).trim() || DEFAULT_REALTIME_MODEL;
    if (!apiKey) {
      resolve({ ok: false, error: "请先填写 DashScope API Key" });
      return;
    }
    const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}model=${encodeURIComponent(model)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      } as unknown as string);
    } catch (e) {
      resolve({ ok: false, error: `无法创建 WebSocket 连接：${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    let settled = false;
    const finish = (r: RealtimeTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
      resolve({ ...r, latencyMs: Date.now() - t0 });
    };
    const t0 = Date.now();
    const timer = setTimeout(
      () => finish({ ok: false, error: "连接超时（10s）：请检查网络与 WebSocket 地址" }),
      REALTIME_TEST_TIMEOUT_MS,
    );
    ws.onopen = () => finish({ ok: true });
    ws.onerror = () => {
      // Bun 无可读消息，拒绝细节由 onclose 承担。
    };
    ws.onclose = (ev: { code?: number; reason?: string }) => {
      finish({
        ok: false,
        error: `连接被拒绝（code=${ev?.code ?? "?"}${ev?.reason ? `：${ev.reason}` : ""}）：请检查 API Key 与地址`,
      });
    };
  });
}
