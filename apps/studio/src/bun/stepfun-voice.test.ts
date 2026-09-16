import { afterAll, expect, mock, test } from "bun:test";

import { DEFAULT_STEPFUN_TTS_VOICE } from "../shared/tts-voices";

// ---------------------------------------------------------------------------
// 阶跃星辰（StepFun）语音线的接入形状。
//
// 三件事在实现里各有一处"看不出来就错"的地方，全部在这里钉住：
//   1. TTS 走 OpenAI 兼容的 `/v1/audio/speech`，但音色名与别家不通用 ——
//      全局那个 alloy 默认值原样发过去只会得到一句 `invalid voice`；
//   2. ASR 走的不是 OpenAI 兼容的 multipart 端点（那里只有 2.5 代模型），
//      而是 `/v1/audio/asr/sse`：base64 音频 + SSE 增量文本，StepAudio 3 ASR 只在这里；
//   3. 服务商 baseUrl 自带 `/v1`，再拼一遍 `/v1/audio/...` 就是稳定 404。
// ---------------------------------------------------------------------------
const Voice = await import("./voice");
const Asr = await import("./asr");
const CloudProviders = await import("./cloud-providers");
const { getSetting, updateSettings } = await import("./db/settings");

const originalFetch = globalThis.fetch;
/** 厂商行与设置都是真实（临时）库，跑完要还回去。 */
const created: string[] = [];
const TOUCHED = ["TTS_PROVIDER_ID", "TTS_PROVIDER_MODEL", "TTS_VOICE", "ASR_PROVIDER_ID", "ASR_PROVIDER_MODEL", "ASR_LANG"] as const;
const originalSettings = Object.fromEntries(TOUCHED.map((k) => [k, getSetting(k)]));

// 用 custom 行 + 阶跃的地址（而不是预设 id）：认厂商必须靠主机名 —— 用户自建一行
// 指向 api.stepfun.com 时，只看 providerId 的实现会把音色与端点全判成百炼。
const providerRes = CloudProviders.createCloudProvider({
  name: "阶跃语音测试",
  baseUrl: "https://api.stepfun.com/v1",
});
const providerId = providerRes.id!;
created.push(providerId);
CloudProviders.updateCloudProvider(providerId, { apiKey: "sk-step" });
updateSettings({
  TTS_PROVIDER_ID: providerId,
  TTS_PROVIDER_MODEL: "stepaudio-3-tts",
  ASR_PROVIDER_ID: providerId,
  ASR_PROVIDER_MODEL: "stepaudio-3-asr-max",
  ASR_LANG: "zh",
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const id of created) CloudProviders.deleteCloudProvider(id);
  updateSettings({ ...originalSettings });
});

/** 一段合法的最小 WAV（16k / 16bit / 单声道），内容无所谓，只要求能被解析。 */
function tinyWav(samples = 64): Buffer {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

/** 把若干 SSE 帧拼成一个流式响应（真接口就是流式返回，不是一次性 body）。 */
function sseResponse(events: unknown[], status = 200): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

test("TTS：地址不拼成 /v1/v1，响应按 mp3 字节存下来", async () => {
  updateSettings({ TTS_VOICE: DEFAULT_STEPFUN_TTS_VOICE });
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: URL | string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200 });
  }) as never;

  const record = await Voice.runTTS({ text: "智能阶跃，十倍每个人的可能。" });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe("https://api.stepfun.com/v1/audio/speech");
  const headers = seen[0]!.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer sk-step");
  const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>;
  expect(body.model).toBe("stepaudio-3-tts");
  expect(body.input).toBe("智能阶跃，十倍每个人的可能。");
  expect(body.voice).toBe(DEFAULT_STEPFUN_TTS_VOICE);
  expect(body.response_format).toBe("mp3");
  expect(record.status).toBe("done");
  expect(record.voice).toBe(DEFAULT_STEPFUN_TTS_VOICE);
  expect(record.audioPath).toMatch(/^audio\/tts-.*\.mp3$/);
});

test("TTS：全局音色还是别家的占位值（alloy）时，按阶跃默认音色发出去", async () => {
  // 出厂默认就是 alloy。用户在设置页选完厂商直接点合成，什么都没改 —— 这时原样发出
  // alloy 只会拿到上游的 invalid voice，而页面上完全看不出哪里不对。
  updateSettings({ TTS_VOICE: "alloy" });
  let body: Record<string, unknown> = {};
  globalThis.fetch = mock(async (_url: URL | string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(new Uint8Array([1]), { status: 200 });
  }) as never;

  await Voice.runTTS({ text: "你好" });
  expect(body.voice).toBe(DEFAULT_STEPFUN_TTS_VOICE);
});

test("TTS：用户自己填的音色原样带上（复刻音色 / 别家音色都不动）", async () => {
  updateSettings({ TTS_VOICE: "my-cloned-voice" });
  let body: Record<string, unknown> = {};
  globalThis.fetch = mock(async (_url: URL | string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(new Uint8Array([1]), { status: 200 });
  }) as never;

  await Voice.runTTS({ text: "你好" });
  expect(body.voice).toBe("my-cloned-voice");

  // 显式传进来的音色优先级最高（通话逐句合成走的就是这条）。
  await Voice.runTTS({ text: "你好", voice: "linjiajiejie" });
  expect(body.voice).toBe("linjiajiejie");
});

test("TTS：上游报错时把原因带出来（不要只说 request failed）", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ error: { message: "invalid voice" } }), { status: 400 }),
  ) as never;
  await expect(Voice.runTTS({ text: "你好" })).rejects.toThrow("invalid voice");
});

test("ASR：走 /audio/asr/sse（base64 + SSE），并按门店定稿文本", async () => {
  const wav = tinyWav();
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: URL | string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return sseResponse([
      { type: "transcript.text.delta", delta: "你好，" },
      { type: "transcript.text.delta", delta: "世界" },
      { type: "transcript.text.done", text: "你好，世界。", usage: { total_tokens: 12 } },
    ]);
  }) as never;

  const res = await Asr.transcribeAudio({ wavBase64: wav.toString("base64"), source: "remote" });

  expect(seen).toHaveLength(1);
  // 服务商地址自带 /v1：拼成 /v1/v1/... 的话是稳定 404。
  expect(seen[0]!.url).toBe("https://api.stepfun.com/v1/audio/asr/sse");
  const headers = seen[0]!.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer sk-step");
  expect(headers.Accept).toBe("text/event-stream");

  const body = JSON.parse(String(seen[0]!.init.body)) as {
    audio: { data: string; input: { transcription: Record<string, unknown>; format: Record<string, unknown> } };
  };
  expect(Buffer.from(body.audio.data, "base64").equals(wav)).toBe(true);
  expect(body.audio.input.transcription.model).toBe("stepaudio-3-asr-max");
  expect(body.audio.input.transcription.enable_itn).toBe(true);
  expect(body.audio.input.transcription.language).toBe("zh");
  expect(body.audio.input.format).toEqual({ type: "wav" });

  expect(res.text).toBe("你好，世界。");
  expect(res.engine).toBe("remote");
});

test("ASR：没拿到 done 帧时用增量拼接兜底", async () => {
  globalThis.fetch = mock(async () =>
    sseResponse([
      { type: "transcript.text.delta", delta: "只有增量" },
      { type: "transcript.text.delta", delta: "没有定稿" },
    ]),
  ) as never;
  const res = await Asr.transcribeAudio({ wavBase64: tinyWav().toString("base64"), source: "remote" });
  expect(res.text).toBe("只有增量没有定稿");
});

test("ASR：SSE 里的 error 事件要让用户看到原因", async () => {
  globalThis.fetch = mock(async () =>
    sseResponse([{ type: "error", meta: { session_id: "sse_1" }, message: "音频内容不完整" }]),
  ) as never;
  await expect(
    Asr.transcribeAudio({ wavBase64: tinyWav().toString("base64"), source: "remote" }),
  ).rejects.toThrow("音频内容不完整");
});

test("ASR：不支持的容器格式在本地就说清楚（而不是等上游 400）", async () => {
  const name = `stepfun-${Date.now()}.flac`;
  const dir = `${Voice.getAudioBaseDir()}/in`;
  const { mkdirSync } = await import("fs");
  mkdirSync(dir, { recursive: true });
  await Bun.write(`${dir}/${name}`, tinyWav());
  // 打桩的 fetch 一旦被调用就说明格式校验没拦住。
  globalThis.fetch = mock(async () => {
    throw new Error("不该发出请求");
  }) as never;

  await expect(
    Asr.transcribeAudio({ audioRef: `audio/in/${name}`, source: "remote" }),
  ).rejects.toThrow(/不支持 .flac 格式/);
});
