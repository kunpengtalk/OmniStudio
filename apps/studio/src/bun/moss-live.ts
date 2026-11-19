/**
 * MOSS-Live 1.0 实时会话客户端（全双工语音 + 摄像头 / 屏幕画面）。
 *
 * 协议来源：https://platform.moss.cn/docs/reference/moss-live（2026-11 实测通过）。
 * 它与百炼 / 阶跃那套 OpenAI-Realtime 方言**没有一处相同**，所以是独立客户端，
 * 而不是 `RealtimeVoiceClient` 里的又一个分支：
 *
 *   1. 握手是**两步**：`attach_session` → `session_attached` → `session.update`
 *      → `session.updated`（`data.error` 为空才算就绪）。OpenAI 那套没有
 *      attach_session，而这里不发它后面所有事件都不会来。
 *   2. 音频走**二进制帧**，不是 base64 JSON。上行 16k、下行 **48k** 裸 PCM S16LE；
 *      开启 `tagged-v1` 后上行音频带 `0x00` 前缀（摄像头 `0x01`、屏幕 `0x02`），
 *      下行音频**不带**前缀（实测首块首字节就是 PCM 数据）。
 *   3. 断句在服务端，但**必须持续送静音帧**：实测停止发送后 `input.speech.stopped`
 *      与回合结束永远不会到。所以通话期间一直按 20ms 节奏推，说话时推音频、
 *      不说话时推静音。
 *   4. 服务端要**播放回执**：每个 `response.audio.context` 的 chunk_id 在该块真正
 *      播完后回 `playback.chunk.completed`（字段在顶层，不在 data 里），整轮回
 *      `playback.completed`，被打断回 `playback.stopped`。不回执服务端会一直以为
 *      上一句没播完。
 *   5. 没有 voice 参数 —— 音色由 `session.persona` 决定。
 *
 * 归一化后仍然吐 `RealtimeVoiceEvent`，`voice-call.ts` 的分派逻辑与另两家共用。
 */

import { proxyWebSocketOptions } from "./proxy";
import type { RealtimeVoiceEvent } from "./realtime-voice";
import {
  DEFAULT_MOSS_REALTIME_MODEL,
  MOSS_REALTIME_BASE_URL,
  realtimeDefaultVoice,
} from "../shared/realtime-voice";

/** tagged-v1 的二进制前缀（开视频后音频也必须带，见模块注释）。 */
export const MOSS_TAG_AUDIO = 0x00;
export const MOSS_TAG_CAMERA = 0x01;
export const MOSS_TAG_SCREEN = 0x02;

/**
 * 握手被拒的 HTTP 状态码。
 *
 * Bun 的 WebSocket 升级失败会把一切塌缩成 close 1006，真实状态码只出现在
 * onerror 的文本里（`Expected 101 status code: 402`）—— 抠出来才能把
 * "key 不对"与"账号没额度"分开。
 */
export function extractUpgradeStatus(message: string | null | undefined): number | null {
  const m = /status code:\s*(\d{3})/.exec(message ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * 把实时端点拒绝握手时的 JSON 错误体翻成可执行的中文提示。
 *
 * 错误体是 OpenAI 形状的 `{"error":{"message","type","code"}}`
 * （2026-11-19 实测：`insufficient_credits` = 账号额度不足——同一把 key 在
 * `/v1/models` 仍然 200，所以厂商能在设置页启用、通话却拨不出去；只报
 * "云端拒绝连接"会让人反复重填 key 与地址）。认不出来返回 null，调用方回落通用文案。
 */
export function explainMossHandshakeError(
  status: number | null,
  body: unknown,
): string | null {
  const err = (body as { error?: { message?: string; code?: string; type?: string } } | null)?.error;
  const code = (err?.code ?? "").toLowerCase();
  const type = (err?.type ?? "").toLowerCase();
  const message = (err?.message ?? "").trim();
  if (status === 402 || code === "insufficient_credits" || code === "billing_error" || type === "billing_error") {
    return "账号额度不足（insufficient_credits）——请到 platform.moss.cn 充值后再拨";
  }
  if (status === 401 || code === "invalid_api_key" || code === "unauthorized") {
    return "API Key 被拒绝——请到设置 → 云端模型 重新粘贴 MOSS 的密钥";
  }
  if (status === 403 || code === "access_denied" || code === "permission_denied") {
    return "这把密钥没有 MOSS-Live 的访问权限——请到 platform.moss.cn 确认该 key 已开通实时模型";
  }
  if (status === 404) {
    return "找不到实时端点——默认应为 wss://api.mosi.cn/v1/realtime";
  }
  if (status === 429) {
    return "请求过于频繁（429）——稍后再拨";
  }
  if (/model must/i.test(message)) {
    return "缺少 model 参数——MOSS-Live 实时端点要求 model=moss-live-1.0";
  }
  return null;
}

/** 上行一帧的时长（协议给的节奏：20ms = 16k × 2 字节 × 0.02）。 */
export const MOSS_FRAME_MS = 20;
/** 20ms @ 16k mono s16le。 */
export const MOSS_FRAME_BYTES = 640;

/**
 * 持续推流的帧长：协议是 20ms 一帧，但 20ms 定时器在小机器上太密
 * （每秒 50 次 send + 50 次定时器抖动）。这里按 40ms 发，帧内容仍是同一段
 * 时间的声音 —— 服务端按字节流读，不要求严格 20ms 对齐（实测 40ms 可正常断句）。
 */
const UPLINK_FRAME_MS = 40;
const UPLINK_FRAME_BYTES = (16000 * 2 * UPLINK_FRAME_MS) / 1000;

export type MossVoiceConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 助手人格（`session.persona.prompt`，上限 8000 字符）。 */
  instructions: string;
  /** 助手名字（人格名，帮服务端识别用户怎么称呼它）。 */
  personaName?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  onEvent: (ev: RealtimeVoiceEvent) => void;
};

type WsLike = {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
};

const WS_OPEN = 1;

export class MossLiveClient {
  private cfg: MossVoiceConfig;
  private ws: WsLike | null = null;
  private stopped = false;
  private openedOnce = false;
  /** 会话就绪（session.updated 且 error 为空）。 */
  private ready = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  /** 会话 id：重连时带回去，服务端才知道是同一条会（记忆与计费都跟着它）。 */
  private sessionId: string | null = null;
  /** 最近一次连接的真实 URL（握手被拒时给 HTTPS 补探用）。 */
  private lastUrl = "";
  /** onerror 的原文（Bun 把升级失败的 HTTP 状态码只藏在这里）。 */
  private upgradeErrorText = "";
  /** 待推的音频队列（未就绪 / 断线期间攒着，连上后按节奏发）。 */
  private pending: Buffer[] = [];
  /** 持续推流定时器：说话与不说话都在跑（不发静音服务端不断句）。 */
  private uplinkTimer: ReturnType<typeof setInterval> | null = null;
  /** 上次真正发出一段音频的时刻：用来判断上游是不是断了（见 pumpUplink）。 */
  private lastAudioSentAt = 0;
  /**
   * 断流多久之后开始补静音帧。
   *
   * 前端在云端模式下按 ~120ms 持续推（说话推音频、不说话推静音），正常情况下这里
   * 永远等不到空档。只有前端停推（用户静音、页面切走）时才需要客户端自己兜底 ——
   * 若一直补静音，就会和前端推来的真实音频**交错**，服务端听到的是被切碎的声音。
   */
  private static readonly SILENCE_AFTER_MS = 800;
  private respText = "";
  /** 当前助手回合的 run/turn，用于结束与打断。 */
  private runId: string | null = null;
  private turnId: string | null = null;
  /** 已发出但还没播完的 chunk（打断时挑最后一个回报实际播放时长）。 */
  private lastChunkId: string | null = null;
  /** 刚收到的 context：下一条二进制音频属于它（见 response.audio.context 分支）。 */
  private pendingChunk: { chunkId: string; runId?: string; turnId?: string } | null = null;
  /** 麦克风当前状态（静音时 mic_state 已报 false；重连就绪后要重新报 true）。 */
  private micEnabled = true;
  private log: (line: string) => void;
  private onFailure: (message: string, detail?: Record<string, unknown>) => void;

  constructor(
    cfg: MossVoiceConfig,
    log?: (line: string) => void,
    onFailure?: (message: string, detail?: Record<string, unknown>) => void,
  ) {
    this.cfg = cfg;
    this.log = log ?? (() => {});
    this.onFailure = onFailure ?? (() => {});
  }

  /** 建立连接。断线自动重连（1s→2s→5s 封顶，最多 5 次）。 */
  connect(): void {
    if (this.stopped) return;
    if (!this.cfg.apiKey) {
      this.fail("云端模式未配置 API Key，请先在通话界面的「云端配置」中填写");
      return;
    }
    this.closeWs();
    const base = (this.cfg.baseUrl || MOSS_REALTIME_BASE_URL).trim();
    const model = (this.cfg.model || DEFAULT_MOSS_REALTIME_MODEL).trim();
    const url = `${base}${base.includes("?") ? "&" : "?"}model=${encodeURIComponent(model)}`;
    this.lastUrl = url;
    this.upgradeErrorText = "";
    this.log(`moss connect: ${url}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
        ...proxyWebSocketOptions(url),
      } as unknown as string);
    } catch (e) {
      this.fail(`无法连接云端实时语音：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // 下行音频是二进制帧，Bun / DOM 默认给 Blob 之外也可能是 ArrayBuffer，显式要后者。
    try {
      (ws as unknown as WsLike).binaryType = "arraybuffer";
    } catch {
      // ignore
    }
    const handle = ws as unknown as WsLike;
    this.ws = handle;
    handle.onopen = () => {
      this.openedOnce = true;
      this.reconnectAttempts = 0;
      this.ready = false;
      this.respText = "";
      // 第一步：加入会话。重连时带上原 session_id（记忆连续、计费归一条会话）。
      // `memory_scope:'session'` 与官方 demo 的桥接端一致（demo 的 server.mjs 就是这么发的）：
      // 记忆只在这条会话内连续，不会把别处的会话内容串进来。
      this.send({
        action: "attach_session",
        memory_scope: "session",
        ...(this.sessionId ? { session_id: this.sessionId } : {}),
      });
    };
    handle.onmessage = (ev) => this.handleMessage(ev.data);
    handle.onerror = (ev) => {
      // Bun 的升级失败只在这里给出 HTTP 状态码（close 会塌缩成 1006），存下原文给补探用。
      this.upgradeErrorText = (ev as { message?: string } | null)?.message ?? "";
      this.log(`moss ws onerror ${JSON.stringify(this.upgradeErrorText.slice(0, 200))}`);
    };
    handle.onclose = (ev) => {
      if (this.ws === handle) this.ws = null;
      this.ready = false;
      this.stopUplink();
      if (this.stopped) return;
      const code = ev?.code;
      const reason = (ev?.reason ?? "").trim();
      this.log(`moss closed code=${code} reason=${JSON.stringify(reason)} opened=${this.openedOnce}`);
      // 1013 "Session already connected"：服务端认为这条会话还挂在旧连接上（网络抖动
      // 后它还没超时）。带着 session_id 重连只会一直撞这一条，所以**丢掉会话 id**、
      // 以新会话重连 —— 代价是丢了这通的云端记忆，好过永远连不上。
      if (code === 1013) {
        this.sessionId = null;
      }
      // 1008 = 会话参数错误（协议文档：Invalid session option）。重连不带改动的
      // 参数只会再挂一次，直接报错让人看到真实原因。
      if (!this.openedOnce || code === 1008) {
        void this.reportRefusal(code, reason);
        return;
      }
      void this.scheduleReconnect();
    };
  }

  /**
   * 把「拒绝连接」讲到人能懂。
   *
   * WebSocket 升级被拒时 close 塌缩成 1006、HTTP 错误体整个丢掉 —— 但服务端在
   * HTTPS 上对同一个地址会给 JSON 错误体（402=`insufficient_credits` 额度不足、
   * 401=key 不对，2026-11-19 实测）。补一次 GET 把它翻成可执行提示；补探失败
   * 就用原来的通用文案，且只等 4 秒，不为文案把失败拖成长时间无响应。
   */
  private async reportRefusal(code?: number, reason?: string): Promise<void> {
    const generic = `云端拒绝连接（code=${code ?? "?"}${reason ? `：${reason}` : ""}）：请检查 API Key 与 WebSocket 地址`;
    try {
      const probeUrl = this.lastUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
      const res = await fetch(probeUrl, {
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          // 带 upgrade 头去撞真实握手路径：不带时有些网关回的是另一条通用错误（实测带回头 402 的 JSON）。
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
        signal: AbortSignal.timeout(4000),
      });
      this.log(`moss refusal probe: HTTP ${res.status}`);
      if (res.ok) {
        // HTTP 层过了（key 与地址都对）却拨不通：多半是实时开通状态，保留原文。
        this.fail(generic);
        return;
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // 有的网关拒升级时不给 JSON；无 body 只剩状态码可用。
      }
      // 补探拿到的才是真实 HTTP 状态（升级文本里的状态只作日志参考）。
      const upgradeStatus = extractUpgradeStatus(this.upgradeErrorText);
      const hint = explainMossHandshakeError(res.status, body);
      this.log(`moss refusal detail: probe=${res.status} upgrade=${upgradeStatus ?? "?"} ${JSON.stringify(body ?? null).slice(0, 300)}`);
      this.fail(hint ? `${generic}\nHTTP ${res.status}：${hint}` : `${generic}（HTTP ${res.status}）`);
    } catch (e) {
      this.log(`moss refusal probe failed: ${e instanceof Error ? e.message : String(e)}`);
      this.fail(generic);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 5) {
      this.fail("云端实时连接断开且重连失败，请检查网络与 API Key");
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 5000);
    this.log(`moss reconnect #${this.reconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private closeWs(): void {
    this.stopUplink();
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
    this.stopUplink();
    this.log(`moss error: ${message}`);
    this.onFailure(`云端实时语音失败：${message}`, {
      model: this.cfg.model,
      baseUrl: this.cfg.baseUrl,
      openedOnce: this.openedOnce,
    });
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
      // 断开瞬间丢弃即可
    }
  }

  /** 二进制帧：tagged-v1 前缀 + 裸 PCM。 */
  private sendBinary(tag: number, payload: Buffer): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(Buffer.concat([Buffer.from([tag]), payload]));
    } catch {
      // ignore
    }
  }

  /** 就绪后开启持续推流（说话时是音频，不说话时是静音）。 */
  private startUplink(): void {
    if (this.uplinkTimer) return;
    this.uplinkTimer = setInterval(() => this.pumpUplink(), UPLINK_FRAME_MS);
  }

  /**
   * 一拍上行：有待发音频就发一帧；前端断流超过 `SILENCE_AFTER_MS` 就补静音。
   *
   * 补静音是协议要求（不发静音服务端不会判定回合结束），但只能在前端确实没在推
   * 的时候补 —— 两边同时发就会把用户的话切成碎片，转写变成一串残句。
   */
  private pumpUplink(): void {
    const chunk = this.pending.shift();
    if (chunk) {
      // 队列里可能攒了不止一帧（重连期间）：按帧切开发，别把几分钟的音频
      // 一次性塞给服务端 —— 那会被上游当成"突发音频"直接丢帧。
      const frame =
        chunk.length > UPLINK_FRAME_BYTES ? chunk.subarray(0, UPLINK_FRAME_BYTES) : chunk;
      if (chunk.length > UPLINK_FRAME_BYTES) this.pending.unshift(chunk.subarray(UPLINK_FRAME_BYTES));
      this.sendBinary(MOSS_TAG_AUDIO, frame);
      this.lastAudioSentAt = Date.now();
      return;
    }
    if (Date.now() - this.lastAudioSentAt < MossLiveClient.SILENCE_AFTER_MS) return;
    this.sendBinary(MOSS_TAG_AUDIO, Buffer.alloc(UPLINK_FRAME_BYTES));
    this.lastAudioSentAt = Date.now();
  }

  private stopUplink(): void {
    if (this.uplinkTimer) {
      clearInterval(this.uplinkTimer);
      this.uplinkTimer = null;
    }
    this.pending = [];
  }

  /**
   * 追加一段上行音频（16k mono PCM16）。通话期间一直调：说话时是真实音频，
   * 不说话时前端也会送静音帧（见 use-voice-call.ts），两边的节奏对得上。
   */
  appendAudio(pcm: Buffer): void {
    if (pcm.length === 0) return;
    this.pending.push(Buffer.from(pcm));
  }

  /**
   * 显式"这句话说完了"：MOSS 由服务端 VAD 判，客户端没有 commit 信号，
   * 这里保持空实现，好让 voice-call.ts 的三家分派不用再区分。
   */
  commit(): void {}

  /**
   * 打断：MOSS 的服务端本身支持自然打断（用户开口即截断），协议里**没有**
   * `response.cancel` 这类客户端取消事件。这里只回报"停止播放"，让服务端把
   * 上一句的对齐信息收掉；真正停声由前端播放端做。
   */
  interrupt(): void {
    if (this.lastChunkId) {
      this.ackPlaybackStopped(0, this.runId ?? undefined, this.turnId ?? undefined);
      this.lastChunkId = null;
    }
  }

  /**
   * 播放回执。MOSS 要求每个 chunk **真正播完**后回执，否则服务端会等。
   *
   * `chunk_id` 来自 `response.audio.context`；这里由调用方（播放端）在播完后调。
   * 也支持整轮播完的 `playback.completed`。
   */
  ackChunkPlayed(chunkId: string, runId?: string, turnId?: string): void {
    this.send({
      action: "playback.chunk.completed",
      chunk_id: chunkId,
      run_id: runId ?? this.runId ?? "",
      turn_id: turnId ?? this.turnId ?? "",
    });
  }

  ackTurnPlayed(runId?: string, turnId?: string): void {
    this.send({
      action: "playback.completed",
      run_id: runId ?? this.runId ?? "",
      turn_id: turnId ?? this.turnId ?? "",
    });
  }

  /** 被打断时回报实际播放时长（毫秒），让服务端对齐它自己的进度。 */
  ackPlaybackStopped(playedMs: number, runId?: string, turnId?: string): void {
    this.send({
      action: "playback.stopped",
      run_id: runId ?? this.runId ?? "",
      turn_id: turnId ?? this.turnId ?? "",
      played_audio_ms: Math.max(0, Math.round(playedMs)),
    });
  }

  /** 上行视频帧（摄像头或屏幕）。调用方负责编码成 JPEG 并控制帧率。 */
  sendVideoFrame(source: "camera" | "screen", jpeg: Buffer): void {
    if (jpeg.length === 0) return;
    this.sendBinary(source === "camera" ? MOSS_TAG_CAMERA : MOSS_TAG_SCREEN, jpeg);
  }

  /**
   * 麦克风开关（官方 demo 的静音就是这样）：`mic_state{enabled:false}` 只发一次信号，
   * **音频帧照常推静音** —— 上游靠持续字节流维持节奏与断句，停推会让它以为断了。
   * 静音帧由前端生成（把采样换成等长零），这里只管信号。
   */
  setMicState(enabled: boolean): void {
    this.micEnabled = enabled;
    this.send({ action: "mic_state", enabled });
  }

  /** 开关摄像头 / 屏幕帧（关掉画面不会结束会话）。 */
  setVideoState(source: "camera" | "screen", enabled: boolean): void {
    this.send({ action: "video.state", source, enabled });
  }

  /** 两条画面流都有时，指定服务端该看哪一路。 */
  setVideoFocus(source: "camera" | "screen" | "auto"): void {
    this.send({ action: "video.stream_focus", source });
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

  private handleMessage(data: unknown): void {
    // 下行音频：裸 PCM16 48k，直接交给播放端。
    if (typeof data !== "string") {
      const buf = toBuffer(data);
      if (!buf || buf.length === 0) return;
      // 下行**不**带 tagged-v1 前缀（协议只规定上行带，实测首帧起就是裸 PCM）。
      //
      // 这里曾经有过一版"防御"：首字节是 0x00 就当成前缀剥掉。那是错的，而且后果很重
      // —— PCM16 的首字节是采样值的**低字节**，正常语音里它经常正好是 0x00（任何
      // 256 整数倍的采样值、以及接近静音的样本）。剥掉 1 个字节之后，这一帧里所有
      // 采样的高低字节全部错位，那段音频就变成刺耳白噪声。用户听到的是"杂音严重、
      // 根本听不清"，而不是任何可识别的错误。
      // 宁可相信协议（下行无前缀），也不要猜。
      const chunk = this.pendingChunk;
      this.pendingChunk = null;
      this.emit({ type: "audio", pcm: buf, chunkId: chunk?.chunkId, runId: chunk?.runId, turnId: chunk?.turnId });
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const action = typeof msg.action === "string" ? msg.action : "";
    const d = (msg.data ?? {}) as Record<string, unknown>;
    switch (action) {
      case "session_attached": {
        const sid = typeof d.session_id === "string" ? d.session_id : "";
        if (sid) this.sessionId = sid;
        this.log(`moss attached session=${sid} delegation=${String(d.delegation ?? "")}`);
        // 第二步：人格与业务规则。
        this.send({
          action: "session.update",
          session: {
            persona: {
              name: this.cfg.personaName || "Omni",
              prompt: this.cfg.instructions.slice(0, 8000),
            },
            instructions: this.cfg.instructions.slice(0, 8000),
          },
        });
        break;
      }
      case "session.updated": {
        const error = typeof d.error === "string" ? d.error : "";
        if (error) {
          this.fail(`会话配置失败：${error}`);
          return;
        }
        // 第三步：开媒体。tagged-v1 必须显式开（音频前缀靠它）。
        // mic_state 报的是**当前**状态而不是硬编码 true：用户在通话中静音过，
        // 断线重连就绪时若报 true，等于替他取消了静音。
        this.send({ action: "media.mode", binary_protocol: "tagged-v1" });
        this.send({ action: "mic_state", enabled: this.micEnabled });
        this.ready = true;
        this.startUplink();
        this.emit({ type: "ready" });
        break;
      }
      case "input.speech.started":
        this.emit({ type: "speechStart" });
        break;
      case "input.speech.stopped":
        this.emit({ type: "speechEnd" });
        break;
      case "input.transcript.updated": {
        // 用户字幕是**替换**语义（前端 setLiveText 直接覆盖），所以原样给全文；
        // 助手正文是追加（appendChunk），才需要在下面转成增量。
        const text = String(d.text ?? "");
        if (text) this.emit({ type: "userPartial", text });
        break;
      }
      case "input.transcript.done": {
        const text = String(d.text ?? "");
        if (text) this.emit({ type: "userText", text });
        break;
      }
      case "response.audio.started":
        // 回合开始：清空累计正文。**只在这里清** —— 真机实测事件顺序是
        // `response.audio.started` → `output.transcript.updated`（音频先起、正文后跟），
        // 若在 transcript 分支里也复位，第一帧正文会被自己抹掉。
        this.respText = "";
        this.runId = typeof d.run_id === "string" ? d.run_id : null;
        this.turnId = typeof d.turn_id === "string" ? d.turn_id : null;
        this.emit({ type: "turnStart" });
        break;
      case "output.transcript.updated": {
        this.runId = typeof d.run_id === "string" ? d.run_id : this.runId;
        this.turnId = typeof d.turn_id === "string" ? d.turn_id : this.turnId;
        const text = String(d.text ?? "");
        // MOSS 给的是**累计全文**（协议明写 replace, don't append）。归一化成
        // 增量：另两家都是 delta，voice-call 那边的拼装逻辑才不用分叉。
        if (text.length > this.respText.length && text.startsWith(this.respText)) {
          const delta = text.slice(this.respText.length);
          this.respText = text;
          this.emit({ type: "partial", text: delta });
        } else if (text !== this.respText) {
          this.respText = text;
          this.emit({ type: "partial", text });
        }
        break;
      }
      case "output.transcript.done": {
        // 不在这里收尾（音频可能还没播完，回合结束由 response.ended 判），但**要把
        // 还没推出去的正文补发掉**。
        //
        // 为什么需要兜底：实测同一条连接上，MOSS 有时只在 done 里给全文、一条
        // `output.transcript.updated` 都不发（取决于服务端走的哪条生成路径）。
        // 只缓存不推的话，界面上一整轮助手回复会是空的 —— 声音听得见、字一个没有。
        const text = String(d.text ?? "");
        this.runId = typeof d.run_id === "string" ? d.run_id : this.runId;
        this.turnId = typeof d.turn_id === "string" ? d.turn_id : this.turnId;
        if (text && text !== this.respText) {
          const delta =
            text.startsWith(this.respText) && text.length > this.respText.length
              ? text.slice(this.respText.length)
              : text;
          this.respText = text;
          this.emit({ type: "partial", text: delta });
        }
        break;
      }
      case "response.audio.context": {
        // 紧跟其后的二进制帧就是这一块音频。把 id 记下来挂到下一条 audio 事件上：
        // 播放端播完后按 id 回执（协议要求"真正播完后"才回，所以只能由播放端发）。
        const chunkId = typeof d.chunk_id === "string" ? d.chunk_id : "";
        if (chunkId) {
          this.lastChunkId = chunkId;
          this.pendingChunk = {
            chunkId,
            runId: typeof d.run_id === "string" ? d.run_id : this.runId ?? undefined,
            turnId: typeof d.turn_id === "string" ? d.turn_id : this.turnId ?? undefined,
          };
          this.runId = this.pendingChunk.runId ?? this.runId;
          this.turnId = this.pendingChunk.turnId ?? this.turnId;
        }
        break;
      }
      case "response.interrupted": {
        const text = String(d.text ?? "");
        if (text) this.respText = text;
        this.emit({ type: "audioStop" });
        break;
      }
      case "response.audio.done":
        // 本轮音频已全部下发。回合收尾仍在 response.ended（音频到齐 ≠ 已经播完）。
        // 播放端按 chunk 回执，这里不需要额外动作。
        break;
      case "response.audio.stop":
        // 服务端要求停止播放：停声并回报已播时长（播放端负责算）。
        this.emit({ type: "audioStop" });
        break;
      case "response.ended": {
        const status = String(d.status ?? "");
        const text = this.respText;
        this.respText = "";
        this.runId = typeof d.run_id === "string" ? d.run_id : this.runId;
        this.turnId = typeof d.turn_id === "string" ? d.turn_id : this.turnId;
        this.log(`moss turn ended status=${status}`);
        if (status === "failed") {
          this.emit({ type: "error", message: "MOSS 回合失败" });
        } else {
          this.emit({ type: "turnEnd", text });
        }
        this.runId = null;
        this.turnId = null;
        break;
      }
      case "error": {
        const err = (d.error ?? {}) as Record<string, unknown>;
        const message =
          String(err.message ?? "") ||
          (typeof d.message === "string" ? d.message : "") ||
          "云端实时语音错误";
        this.emit({ type: "error", message });
        break;
      }
      default:
        if (action) this.log(`moss event (unhandled): ${action}`);
        break;
    }
  }
}

/** WebSocket 的二进制负载转 Buffer（Bun 给 Buffer，DOM 给 ArrayBuffer / Blob 由上层处理）。 */
function toBuffer(data: unknown): Buffer | null {
  if (typeof data === "string") return Buffer.from(data, "binary");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/**
 * 从云端地址推出 MOSS 的实时端点（导出给配置层用；与 shared 里的推导保持一致）。
 * 单独导出是为了让 `testRealtimeConnection` 不必知道方言细节。
 */
export function mossDefaultVoicePlaceholder(): string {
  return realtimeDefaultVoice("moss");
}
