import { afterAll, expect, test } from "bun:test";

import { RealtimeVoiceClient, type RealtimeVoiceEvent } from "./realtime-voice";

// ---------------------------------------------------------------------------
// 云端实时语音的**上线报文形状**。
//
// 两家事件名相同、取值不同，发错不会报错、只会表现为"连上了但没声音 / 对方听不清"：
//   - 阶跃：input/output_audio_format 必须是 `pcm16`，turn_detection 只认 server_vad，
//     并且**不能发手工 commit**（它会去提交一个已交过、此刻为空的缓冲 → 上游报错）；
//   - 百炼：格式写 `pcm`，音频族用 smart_turn（保持原样，不能一起改掉）。
//
// 用真的 WebSocket（Bun.serve）收报文：这套协议只有发出去才看得见，客户端内部的
// 分支单测覆盖不到"到底发了什么"。
// ---------------------------------------------------------------------------
type Frame = { url: string; authorization: string | null; messages: Record<string, unknown>[] };

function startServer(): {
  port: number;
  frames: Frame[];
  /** 服务端主动下发一个事件（模拟 response.audio.delta 这类推送）。 */
  push: (i: number, event: unknown) => void;
  stop: () => void;
} {
  const frames: Frame[] = [];
  const sockets: { send: (s: string) => void }[] = [];
  /** 升级请求里的地址 / 头 → 连接建立后归到这条连接上（Bun 的 ws.data 不参与类型）。 */
  const pending: Omit<Frame, "messages">[] = [];
  const bySocket = new WeakMap<object, Frame>();
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const info = { url: req.url, authorization: req.headers.get("authorization") };
      // 先入队再升级：`upgrade()` 会在返回前就把 `open` 回调跑起来（同步握手），
      // 反过来写的话 open 里拿到的是空队列。
      pending.push(info);
      const ok = srv.upgrade(req);
      if (!ok) pending.pop();
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        const frame: Frame = { ...pending.shift()!, messages: [] };
        frames.push(frame);
        bySocket.set(ws, frame);
        sockets.push(ws as unknown as { send: (s: string) => void });
        // 真服务端连上就先给一个 session.created（两家都是这个行为）。
        ws.send(JSON.stringify({ type: "session.created", session: { id: "sess_1" } }));
      },
      message(ws, raw) {
        bySocket.get(ws)!.messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
        // 收到 session.update 就回 session.updated（客户端据此判定"就绪"）。
        const parsed = JSON.parse(String(raw)) as { type?: string };
        if (parsed.type === "session.update") {
          ws.send(JSON.stringify({ type: "session.updated", session: { id: "sess_1" } }));
        }
      },
    },
  });
  return {
    port: server.port!,
    frames,
    push: (i, event) => sockets[i]?.send(JSON.stringify(event)),
    stop: () => void server.stop(true),
  };
}

/** 等某个条件成立（连接 / 报文到达是异步的）。 */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await Bun.sleep(10);
  }
}

const servers: { stop: () => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
});

function connect(url: string, model: string, events: RealtimeVoiceEvent[] = []) {
  const client = new RealtimeVoiceClient({
    apiKey: "sk-test",
    baseUrl: url,
    model,
    voice: "test-voice",
    instructions: "简短回答",
    onEvent: (ev) => events.push(ev),
  });
  client.connect();
  return client;
}

test("阶跃：地址带 model 查询参数、Bearer 鉴权，session.update 用 pcm16 + server_vad", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(`ws://127.0.0.1:${srv.port}/v1/realtime`, "stepaudio-3-realtime-preview", events);

  await waitFor(() => srv.frames[0]?.messages.length === 1);
  const frame = srv.frames[0]!;
  expect(frame.url).toContain("model=stepaudio-3-realtime-preview");
  expect(frame.authorization).toBe("Bearer sk-test");

  const update = frame.messages[0]! as { type: string; session: Record<string, unknown> };
  expect(update.type).toBe("session.update");
  expect(update.session.input_audio_format).toBe("pcm16");
  expect(update.session.output_audio_format).toBe("pcm16");
  expect(update.session.turn_detection).toEqual({ type: "server_vad" });
  expect(update.session.voice).toBe("test-voice");

  // 收到 session.updated → ready（voice-call 靠它把通话状态推到"聆听"）。
  await waitFor(() => events.some((e) => e.type === "ready"));
  client.stop();
});

test("阶跃：不发手工 commit（空缓冲提交会被上游拒掉）", async () => {
  const srv = startServer();
  servers.push(srv);
  const client = connect(`ws://127.0.0.1:${srv.port}/v1/realtime`, "stepaudio-3-realtime-preview");
  await waitFor(() => srv.frames[0]?.messages.length === 1);

  client.appendAudio(Buffer.from([1, 2, 3, 4]));
  client.commit();
  client.interrupt();
  await waitFor(() => (srv.frames[0]?.messages.length ?? 0) >= 3);
  await Bun.sleep(50);

  const types = srv.frames[0]!.messages.map((m) => m.type);
  expect(types).toEqual(["session.update", "input_audio_buffer.append", "response.cancel"]);
  expect(types).not.toContain("input_audio_buffer.commit");
  // 音频按 base64 原样带上（PCM16 裸流）。
  expect(srv.frames[0]!.messages[1]!.audio).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
  client.stop();
});

test("百炼：沿用 pcm + smart_turn，并保留手工 commit", async () => {
  const srv = startServer();
  servers.push(srv);
  const client = connect(
    `ws://127.0.0.1:${srv.port}/api-ws/v1/realtime`,
    "qwen-audio-3.0-realtime-plus",
  );
  await waitFor(() => srv.frames[0]?.messages.length === 1);
  const update = srv.frames[0]!.messages[0]! as { session: Record<string, unknown> };
  expect(update.session.input_audio_format).toBe("pcm");
  expect(update.session.turn_detection).toEqual({ type: "smart_turn" });

  client.commit();
  await waitFor(() => (srv.frames[0]?.messages.length ?? 0) >= 2);
  const sent = srv.frames[0]!.messages;
  expect(sent[sent.length - 1]!.type).toBe("input_audio_buffer.commit");
  client.stop();
});

test("阶跃：用户转写取 transcript 字段，助手正文与音频走同名的 delta 字段", async () => {
  const srv = startServer();
  servers.push(srv);
  const events: RealtimeVoiceEvent[] = [];
  const client = connect(`ws://127.0.0.1:${srv.port}/v1/realtime`, "stepaudio-3-realtime-preview", events);
  await waitFor(() => events.some((e) => e.type === "ready"));

  srv.push(0, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "msg_1",
    transcript: "今天天气怎么样",
  });
  srv.push(0, { type: "response.created", response: { id: "resp_1" } });
  srv.push(0, { type: "response.audio_transcript.delta", delta: "挺好的" });
  srv.push(0, { type: "response.audio.delta", delta: Buffer.from([9, 9]).toString("base64") });
  srv.push(0, { type: "response.done", response: { id: "resp_1", status: "completed" } });
  await waitFor(() => events.some((e) => e.type === "turnEnd"));

  const userText = events.find((e) => e.type === "userText");
  expect(userText).toEqual({ type: "userText", text: "今天天气怎么样" });
  expect(events.filter((e) => e.type === "partial").map((e) => (e as { text: string }).text)).toEqual(["挺好的"]);
  const audio = events.find((e) => e.type === "audio") as { pcm: Buffer } | undefined;
  expect(audio && [...audio.pcm]).toEqual([9, 9]);
  expect(events.find((e) => e.type === "turnEnd")).toEqual({ type: "turnEnd", text: "挺好的" });
  client.stop();
});
