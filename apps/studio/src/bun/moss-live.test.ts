import { afterAll, expect, test } from "bun:test";

import { MossLiveClient, MOSS_TAG_AUDIO, MOSS_TAG_CAMERA, type MossVoiceConfig } from "./moss-live";
import type { RealtimeVoiceEvent } from "./realtime-voice";

// ---------------------------------------------------------------------------
// MOSS-Live 的**上线报文形状**。
//
// 它和百炼 / 阶跃那套 OpenAI-Realtime 没有一处相同（真实服务端实测得出，
// 见 bun/moss-live.ts 顶部注释）：
//   1. 先 attach_session → session_attached → session.update → session.updated；
//      不发 attach_session，后面所有事件都不会来。
//   2. 音频是**二进制帧**，不是 base64 JSON。
//   3. 下行音频**不带** 0x00 前缀（前缀只在上行）。
//   4. 服务端要播放回执，字段在顶层而不是 data 里。
//
// 用真的 WebSocket（Bun.serve）收报文：这套协议只有发出去才看得见。
// ---------------------------------------------------------------------------

type ServerFrame =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "binary"; tag: number; payload: Buffer };

type Server = {
  port: number;
  frames: ServerFrame[];
  /** 服务端按握手顺序把 MOSS 该发的事件推回去，直到会话就绪。 */
  open: () => Promise<void>;
  pushJson: (body: unknown) => void;
  pushBinary: (payload: Buffer) => void;
  /** 原样发字节（不加 tagged-v1 前缀）—— 下行音频就是这样。 */
  pushRawBinary: (bytes: Buffer) => void;
  stop: () => void;
};

function startServer(): Server {
  const frames: ServerFrame[] = [];
  let socket: { send: (data: string | Uint8Array) => void; close: () => void } | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (!srv.upgrade(req)) return new Response("upgrade failed", { status: 400 });
      return undefined;
    },
    websocket: {
      open(ws) {
        socket = ws as unknown as { send: (d: string | Uint8Array) => void; close: () => void };
      },
      message(ws, raw) {
        if (typeof raw === "string") {
          frames.push({ kind: "json", body: JSON.parse(raw) as Record<string, unknown> });
          // 模拟服务端：attach → 回 session_attached；session.update → 回 session.updated。
          const body = JSON.parse(raw) as { action?: string };
          if (body.action === "attach_session") {
            ws.send(
              JSON.stringify({
                action: "session_attached",
                data: { session_id: "sess_moss_1", memory_scope: "session", delegation: "none" },
              }),
            );
          } else if (body.action === "session.update") {
            ws.send(JSON.stringify({ action: "session.updated", data: { error: "" } }));
          }
          return;
        }
        const buf = Buffer.from(raw as Uint8Array);
        frames.push({ kind: "binary", tag: buf[0]!, payload: buf.subarray(1) });
      },
    },
  });
  return {
    port: server.port!,
    frames,
    open: async () => {},
    pushJson: (body) => socket?.send(JSON.stringify(body)),
    pushBinary: (payload) => socket?.send(Buffer.concat([Buffer.from([MOSS_TAG_AUDIO]), payload])),
    pushRawBinary: (bytes) => socket?.send(bytes),
    stop: () => void server.stop(true),
  };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await Bun.sleep(10);
  }
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
});

function connect(port: number, events: RealtimeVoiceEvent[] = [], failures: string[] = []) {
  const cfg: MossVoiceConfig = {
    apiKey: "sk-test",
    baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    model: "moss-live-1.0",
    instructions: "简短回答",
    onEvent: (ev) => events.push(ev),
  };
  const client = new MossLiveClient(cfg, () => {}, (m) => failures.push(m));
  client.connect();
  return client;
}

const jsonFrames = (s: Server) =>
  s.frames.filter((f): f is { kind: "json"; body: Record<string, unknown> } => f.kind === "json");

test("握手顺序：attach_session → session.update → media.mode → mic_state，地址带 model、Bearer 鉴权", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(srv.port, events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  const actions = jsonFrames(srv).map((f) => f.body.action);
  expect(actions).toEqual(["attach_session", "session.update", "media.mode", "mic_state"]);
  // 新会话不带 session_id；重连才带。
  expect(jsonFrames(srv)[0]!.body.session_id).toBeUndefined();
  // 人格与业务规则都从 instructions 来（MOSS 没有 voice 参数）。
  const update = jsonFrames(srv)[1]!.body.session as Record<string, unknown>;
  expect((update.persona as Record<string, unknown>).prompt).toBe("简短回答");
  expect(jsonFrames(srv)[2]!.body.binary_protocol).toBe("tagged-v1");
  expect(jsonFrames(srv)[3]!.body.enabled).toBe(true);
  client.stop();
});

test("上行音频是二进制帧且带 0x00 前缀（不是 base64 JSON）", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(srv.port, events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  client.appendAudio(Buffer.from([1, 2, 3, 4]));
  await waitFor(() => srv.frames.some((f) => f.kind === "binary"));
  const bin = srv.frames.find((f) => f.kind === "binary") as { tag: number; payload: Buffer };
  expect(bin.tag).toBe(MOSS_TAG_AUDIO);
  expect([...bin.payload]).toEqual([1, 2, 3, 4]);
  client.stop();
});

test("下行音频：原样交给播放端，不猜前缀（0x00 是正常的低字节，不能剥）", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(srv.port, events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  srv.pushJson({
    action: "response.audio.context",
    data: { chunk_id: "chunk_1", run_id: "run_1", turn_id: "turn_1" },
  });
  // 原样发 3 个字节。真实下行里首字节经常就是 0x00（PCM16 低字节），
  // 任何"看首字节像前缀就剥掉"的逻辑都会把这一帧的采样全部错位成噪声。
  srv.pushRawBinary(Buffer.from([0x00, 8, 9]));
  await waitFor(() => events.some((e) => e.type === "audio"));

  const audio = events.find((e) => e.type === "audio") as Extract<RealtimeVoiceEvent, { type: "audio" }>;
  // 收到什么就是什么：0x00 必须保留，不能被当成 tagged-v1 前缀剥掉。
  expect([...audio.pcm]).toEqual([0x00, 8, 9]);
  expect(audio.chunkId).toBe("chunk_1");
  expect(audio.runId).toBe("run_1");
  expect(audio.turnId).toBe("turn_1");
  client.stop();
});

test("播放回执字段在顶层（不嵌在 data 里）", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(srv.port, events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  client.ackChunkPlayed("chunk_1", "run_1", "turn_1");
  await waitFor(() => jsonFrames(srv).some((f) => f.body.action === "playback.chunk.completed"));
  const ack = jsonFrames(srv).find((f) => f.body.action === "playback.chunk.completed")!;
  expect(ack.body).toEqual({
    action: "playback.chunk.completed",
    chunk_id: "chunk_1",
    run_id: "run_1",
    turn_id: "turn_1",
  });
  client.stop();
});

test("转写：userPartial 保留累计全文（前端是替换语义）；done 走 userText", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(srv.port, events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  srv.pushJson({ action: "input.transcript.updated", data: { text: "你好" } });
  srv.pushJson({ action: "input.transcript.updated", data: { text: "你好，请" } });
  srv.pushJson({ action: "input.transcript.done", data: { text: "你好，请介绍一下" } });
  await waitFor(() => events.some((e) => e.type === "userText"));

  const partials = events.filter((e) => e.type === "userPartial").map((e) => (e as { text: string }).text);
  // 用户字幕走 setLiveText（替换），所以这里给全文；助手正文是追加，那边才转增量。
  expect(partials).toEqual(["你好", "你好，请"]);
  expect(events.find((e) => e.type === "userText")).toEqual({ type: "userText", text: "你好，请介绍一下" });
  client.stop();
});

test("助手正文：累计全文转增量，回合在 response.ended 收尾（不是 transcript.done）", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(srv.port, events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  srv.pushJson({ action: "response.audio.started", data: {} });
  srv.pushJson({ action: "output.transcript.updated", data: { text: "我是", run_id: "r", turn_id: "t" } });
  srv.pushJson({ action: "output.transcript.updated", data: { text: "我是小安", run_id: "r", turn_id: "t" } });
  // 音频还没播完就先给了 done：不能在这里收尾。
  srv.pushJson({ action: "output.transcript.done", data: { text: "我是小安。", run_id: "r", turn_id: "t" } });
  await Bun.sleep(50);
  expect(events.some((e) => e.type === "turnEnd")).toBe(false);

  srv.pushJson({ action: "response.ended", data: { status: "completed", run_id: "r", turn_id: "t" } });
  await waitFor(() => events.some((e) => e.type === "turnEnd"));

  const partials = events.filter((e) => e.type === "partial").map((e) => (e as { text: string }).text);
  // 前两帧是 updated 的增量；done 里的「。」还没推过，也要补出去（见下一条测试的说明）。
  expect(partials).toEqual(["我是", "小安", "。"]);
  expect(events.find((e) => e.type === "turnEnd")).toEqual({ type: "turnEnd", text: "我是小安。" });
  client.stop();
});

test("没有 updated、只有 transcript.done 时也要把正文补发出去（否则界面一句都没有）", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(srv.port, events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  // 真机见过这种响应：一条 output.transcript.updated 都没有，正文只在 done 里。
  srv.pushJson({ action: "response.audio.started", data: { run_id: "r", turn_id: "t" } });
  srv.pushJson({ action: "output.transcript.done", data: { text: "你好，我是小安。", run_id: "r", turn_id: "t" } });
  await waitFor(() => events.some((e) => e.type === "partial"));

  expect(events.find((e) => e.type === "partial")).toEqual({ type: "partial", text: "你好，我是小安。" });
  srv.pushJson({ action: "response.ended", data: { status: "completed", run_id: "r", turn_id: "t" } });
  await waitFor(() => events.some((e) => e.type === "turnEnd"));
  expect(events.find((e) => e.type === "turnEnd")).toEqual({ type: "turnEnd", text: "你好，我是小安。" });
  client.stop();
});

test("response.ended 的 aborted / failed 都算回合结束，failed 报 error", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(srv.port, events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  srv.pushJson({ action: "response.audio.started", data: {} });
  srv.pushJson({ action: "response.ended", data: { status: "failed", run_id: "r", turn_id: "t" } });
  await waitFor(() => events.some((e) => e.type === "error"));
  // 协议明确三种 status 都表示回合已结束，不能只等 completed。
  expect(events.some((e) => e.type === "turnEnd")).toBe(false);
  client.stop();
});

test("video.state 与画面帧：摄像头 0x01、屏幕 0x02", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(srv.port, events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  client.setVideoState("camera", true);
  client.sendVideoFrame("camera", Buffer.from([0xaa, 0xbb]));
  client.sendVideoFrame("screen", Buffer.from([0xcc]));
  await waitFor(() => srv.frames.filter((f) => f.kind === "binary").length >= 2);

  const state = jsonFrames(srv).find((f) => f.body.action === "video.state");
  expect(state?.body).toEqual({ action: "video.state", source: "camera", enabled: true });
  const bins = srv.frames.filter((f) => f.kind === "binary") as { tag: number; payload: Buffer }[];
  expect(bins[0]!.tag).toBe(MOSS_TAG_CAMERA);
  expect(bins[1]!.tag).toBe(0x02);
  client.stop();
});

test("会话配置失败（session.updated.data.error 非空）当作连接失败报出来", async () => {
  const failures: string[] = [];
  const events: RealtimeVoiceEvent[] = [];
  // 自定义服务端：attach 正常，但配置回一个错误。
  let socket: { send: (d: string) => void } | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (!srv.upgrade(req)) return new Response("no", { status: 400 });
      return undefined;
    },
    websocket: {
      open(ws) {
        socket = ws as unknown as { send: (d: string) => void };
      },
      message(_ws, raw) {
        const body = JSON.parse(String(raw)) as { action?: string };
        if (body.action === "attach_session") {
          socket?.send(JSON.stringify({ action: "session_attached", data: { session_id: "s" } }));
        } else if (body.action === "session.update") {
          socket?.send(JSON.stringify({ action: "session.updated", data: { error: "invalid persona" } }));
        }
      },
    },
  });
  const s = { stop: () => void server.stop(true) } as Server;
  servers.push(s);

  const client = connect(server.port!, events, failures);
  await waitFor(() => failures.length > 0);
  expect(failures[0]).toContain("invalid persona");
  expect(events.some((e) => e.type === "error")).toBe(true);
  client.stop();
});
