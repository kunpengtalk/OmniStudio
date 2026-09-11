import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// 假的"上游"端口：本地推理服务器 + 云端 OpenAI 兼容 API。
const LOCAL_PORT = 18099;
const CLOUD_PORT = 18100;

// 桩掉网关依赖的后端与设置，让测试不依赖真实 db / 推理服务 / electrobun。
let SERVER_STATUS: "stopped" | "running" = "running";

mock.module("./server-manager", () => ({
  getStatus: () => SERVER_STATUS,
  onStatusChange: () => () => {},
}));

const ASR_STATUS = {
  serverRunning: false,
  port: 18081,
  engine: "none",
  engineInstalled: false,
  engineVersion: null,
  binaryPath: null,
  activeModel: null,
};
const ASR_PROVIDER = { base: "", apiKey: "", model: "" };

mock.module("./asr", () => ({
  getAsrStatus: async () => ({ ...ASR_STATUS }),
  getASRProviderConfig: () => ({ ...ASR_PROVIDER }),
}));

const TTS_PROVIDER = { base: "", apiKey: "", model: "" };

mock.module("./voice", () => ({
  getTTSProviderConfig: () => ({ ...TTS_PROVIDER }),
  listProviderModels: async () => [] as string[],
  runTTSEdge: async () => ({
    id: 1,
    kind: "tts",
    status: "ok",
    model: "Edge TTS（在线免费）",
    voice: "zh-CN-XiaoxiaoNeural",
    text: "edge",
    audioUrl: `http://127.0.0.1:${LOCAL_PORT}/fake-audio`,
    refAudioPath: null,
    durationMs: 100,
    error: null,
    createdAt: 0,
  }),
}));

mock.module("./tts-local", () => ({
  getTtsLocalStatus: async () => ({
    active: false,
    activeModelId: null,
    activeModelPath: null,
    engineInstalled: false,
    binaryPath: null,
    backend: "cpu",
    version: "",
  }),
  runTTSLocal: async () => {
    throw new Error("no local tts");
  },
  listTtsLocalModels: () => [],
}));

const SETTINGS: Record<string, string> = {
  GATEWAY_ENABLED: "1",
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PORT: "10123",
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: String(LOCAL_PORT),
  VLLM_API_KEY: "EMPTY",
  VLLM_API_BASE: `http://127.0.0.1:${CLOUD_PORT}/v1`,
  GATEWAY_API_KEY: "",
};

mock.module("./db/settings", () => ({
  getSetting: (key: string) => SETTINGS[key] ?? "",
  updateSettings: (values: Record<string, string>) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getActiveServerPort: () => SETTINGS.SERVER_PORT || String(LOCAL_PORT),
}));

// 桩掉「已装本地模型」：默认空 → 所有模型名都走"非本地已装"的旧路由逻辑；
// 需要验证本地模型路由的测试自行填充 INSTALLED_MODELS。
let INSTALLED_MODELS: { fileName: string }[] = [];
mock.module("./model-store", () => ({
  listInstalledModels: () => INSTALLED_MODELS,
  slugModelFileName: (fileName: string) =>
    fileName
      .replace(/\.(gguf|safetensors|bin|pt|pth|ckpt|onnx|ggml)$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-"),
}));

// 在所有 mock 注册后动态加载被测模块（静态 import 会被提升到 mock 之前执行）。
const { startGateway, stopGateway, getGatewayStatus, generateGatewayApiKey, resetModelRouteCaches } = await import("./gateway");

const GATEWAY_BASE = `http://127.0.0.1:10123`;

// 两个假的"上游"：本地推理服务器 + 云端 OpenAI 兼容 API。
type Captured = { model?: string; messages?: unknown[]; stream?: unknown; tools?: unknown[]; tool_choice?: unknown } | null;
let lastLocalChat: Captured = null;
let lastCloudChat: Captured = null;
// 经由函数读取：让 TS 以声明类型（而非收窄后的 null）参与类型检查。
const readLocal = (): Captured => lastLocalChat;
const readCloud = (): Captured => lastCloudChat;

// 脚本化响应：下一次 /v1/chat/completions 直接返回预设 Response（用于模拟工具调用等上游输出）。
let localOverride: Response | null = null;
let cloudOverride: Response | null = null;

/** 从 OpenAI chunk 数组构造一个 SSE Response。 */
function sseResponse(chunks: Record<string, any>[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        c.enqueue(encoder.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function makeUpstream(
  modelId: string,
  streamDelta: string,
  capture: (c: Captured) => void,
  takeOverride: () => Response | null,
) {
  const encoder = new TextEncoder();
  return async (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: modelId, object: "model", owned_by: "test" }],
      });
    }
    if (url.pathname === "/v1/chat/completions") {
      const raw = await req.text();
      const body = (raw ? JSON.parse(raw) : {}) as {
        model?: string;
        messages?: unknown[];
        stream?: boolean;
        tools?: unknown[];
        tool_choice?: unknown;
      };
      capture(body);
      const scripted = takeOverride();
      if (scripted) return scripted;
      if (body.stream) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: streamDelta } }] })}\n\n`),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "!" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: `${streamDelta}!` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    if (url.pathname === "/v1/audio/speech") {
      return Response.json({ error: { message: "not supported" } }, { status: 404 });
    }
    if (url.pathname === "/fake-audio") {
      return new Response(new Uint8Array(64), { headers: { "Content-Type": "audio/wav" } });
    }
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  };
}

let upstream: ReturnType<typeof Bun.serve> | null = null;
let cloud: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  const takeLocal = () => {
    const r = localOverride;
    localOverride = null;
    return r;
  };
  const takeCloud = () => {
    const r = cloudOverride;
    cloudOverride = null;
    return r;
  };
  upstream = Bun.serve({
    port: LOCAL_PORT,
    fetch: makeUpstream("upstream-chat", "hello-local", (c) => (lastLocalChat = c), takeLocal),
  });
  cloud = Bun.serve({
    port: CLOUD_PORT,
    fetch: makeUpstream("cloud-gpt", "hello-cloud", (c) => (lastCloudChat = c), takeCloud),
  });

  const res = await startGateway();
  expect(res.ok).toBe(true);
});

afterAll(async () => {
  await stopGateway();
  upstream?.stop();
  cloud?.stop();
});

/** 解析 SSE 文本为 {event, data} 数组。 */
function parseSSE(text: string): { event: string; data: Record<string, any> }[] {
  const out: { event: string; data: Record<string, any> }[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let event = "message";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

const authed = (key: string) => ({ headers: { Authorization: `Bearer ${key}` } });

describe("gateway lifecycle", () => {
  test("startGateway brings status to running on the configured port", () => {
    const info = getGatewayStatus();
    expect(info.status).toBe("running");
    expect(info.port).toBe(10123);
    expect(info.url).toBe(GATEWAY_BASE);
  });
});

describe("gateway meta endpoints", () => {
  test("GET / returns gateway info", async () => {
    const res = await fetch(`${GATEWAY_BASE}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; endpoints: string[] };
    expect(body.name).toContain("Gateway");
    expect(body.endpoints).toContain("POST /v1/messages");
    expect(body.endpoints).toContain("POST /v1/responses");
  });

  test("GET /health reports ok + upstream status + cloud base", async () => {
    const res = await fetch(`${GATEWAY_BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; gateway: boolean; upstream: string; cloud: string };
    expect(body.status).toBe("ok");
    expect(body.gateway).toBe(true);
    expect(body.upstream).toBe("running");
    // 网关归一化掉结尾 /v1（调用时自行拼接 /v1/chat/completions）。
    expect(body.cloud).toBe(`http://127.0.0.1:${CLOUD_PORT}`);
  });

  test("GET /openapi.json is a valid OpenAPI 3.0 spec listing all endpoints", async () => {
    const res = await fetch(`${GATEWAY_BASE}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.0.2");
    const paths = Object.keys(spec.paths);
    for (const p of [
      "/v1/models",
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/messages",
      "/v1/audio/speech",
      "/v1/audio/transcriptions",
      "/v1/images/generations",
      "/health",
    ]) {
      expect(paths).toContain(p);
    }
  });

  test("GET /docs serves Swagger UI HTML", async () => {
    const res = await fetch(`${GATEWAY_BASE}/docs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("swagger-ui");
  });

  test("unknown path returns OpenAI-style 404", async () => {
    const res = await fetch(`${GATEWAY_BASE}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("未知路径");
  });
});

describe("OpenAI-compatible endpoints", () => {
  test("GET /v1/models aggregates local + cloud + capability models", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("upstream-chat"); // 本地推理服务器
    expect(ids).toContain("cloud-gpt"); // 云端 API
    expect(ids).toContain("omni-tts"); // Edge 兜底，始终可用
    expect(ids).toContain("omni-image"); // 预留
    expect(ids).not.toContain("omni-asr"); // 无 ASR 后端
  });

  test("POST /v1/chat/completions routes known local model to local upstream", async () => {
    lastLocalChat = null;
    lastCloudChat = null;
    const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "upstream-chat", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
    expect(readLocal()?.model).toBe("upstream-chat");
    expect(readCloud()).toBeNull();
  });

  test("POST /v1/chat/completions routes unknown local model to cloud upstream", async () => {
    lastLocalChat = null;
    lastCloudChat = null;
    const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cloud-gpt", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message?.content).toBe("hello-cloud!");
    expect(readCloud()?.model).toBe("cloud-gpt");
    expect(readLocal()).toBeNull();
  });

  test("POST /v1/chat/completions routes an installed local model to local upstream even if the server model list lacks it", async () => {
    lastLocalChat = null;
    lastCloudChat = null;
    INSTALLED_MODELS = [{ fileName: "qwen3-4b-q4_k_m.gguf" }];
    resetModelRouteCaches();
    try {
      const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "qwen3-4b-q4_k_m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0]?.message?.content).toBe("hello-local!");
      expect(readLocal()?.model).toBe("qwen3-4b-q4_k_m");
      expect(readCloud()).toBeNull();
    } finally {
      INSTALLED_MODELS = [];
      resetModelRouteCaches();
    }
  });

  test("POST /v1/chat/completions refuses an installed local model with a clear error when the local server is down", async () => {
    lastLocalChat = null;
    lastCloudChat = null;
    SERVER_STATUS = "stopped";
    INSTALLED_MODELS = [{ fileName: "qwen3-4b-q4_k_m.gguf" }];
    resetModelRouteCaches();
    try {
      const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "qwen3-4b-q4_k_m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain("qwen3-4b-q4_k_m");
      expect(readCloud()).toBeNull(); // 绝不把本地模型名转发给云端
    } finally {
      SERVER_STATUS = "running";
      INSTALLED_MODELS = [];
      resetModelRouteCaches();
    }
  });

  test("POST /v1/chat/completions rejects omni-* capability models", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "omni-tts", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /v1/audio/speech falls back to Edge TTS when nothing else is available", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "你好" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/mpeg");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(64);
  });

  test("POST /v1/audio/transcriptions returns 501 when no ASR backend", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(100)], { type: "audio/wav" }), "a.wav");
    const res = await fetch(`${GATEWAY_BASE}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(501);
  });

  test("POST /v1/images/generations is reserved (501)", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(res.status).toBe(501);
  });

  test("falls back to the next free port when the configured port is busy", async () => {
    await stopGateway();
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 10124,
      fetch: () => new Response("blocked"),
    });
    try {
      SETTINGS.GATEWAY_PORT = "10124";
      const res = await startGateway();
      expect(res.ok).toBe(true);
      const info = getGatewayStatus();
      expect(info.port).toBe(10125);
      expect(info.configuredPort).toBe(10124);
      expect(info.notice).toContain("10124");
      expect(info.notice).toContain("10125");
      const probe = await fetch("http://127.0.0.1:10125/health");
      expect(probe.status).toBe(200);
    } finally {
      blocker.stop();
      await stopGateway();
      SETTINGS.GATEWAY_PORT = "10123";
      await startGateway();
    }
  });
});

describe("Anthropic Messages API (/v1/messages)", () => {
  test("non-stream: converts system + content blocks, returns Anthropic message", async () => {
    lastLocalChat = null;
    const res = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "ignored-when-no-key" },
      body: JSON.stringify({
        model: "upstream-chat",
        max_tokens: 100,
        system: "You are terse.",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    expect(res.status).toBe(200);
    // 上游收到的是 OpenAI 格式：system 在前，文本块已合并。
    expect(readLocal()?.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ]);
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("upstream-chat");
    expect(body.content).toEqual([{ type: "text", text: "hello-local!" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(3);
  });

  test("stream: emits message_start → content_block_* → message_delta → message_stop", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "upstream-chat", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSSE(await res.text());
    const names = events.map((e) => e.data.type);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_stop");
    expect(names[names.length - 2]).toBe("message_delta");
    expect(names[names.length - 1]).toBe("message_stop");

    const deltas = events.filter((e) => e.data.type === "content_block_delta");
    const text = deltas.map((e) => e.data.delta.text).join("");
    expect(text).toBe("hello-local!");
    expect(deltas.every((e) => e.data.delta.type === "text_delta")).toBe(true);

    const delta = events.find((e) => e.data.type === "message_delta")!;
    expect(delta.data.delta.stop_reason).toBe("end_turn");
  });

  test("returns Anthropic-style error when model is missing", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("OpenAI Responses API (/v1/responses)", () => {
  test("non-stream: maps input string to message, returns response object", async () => {
    lastCloudChat = null;
    const res = await fetch(`${GATEWAY_BASE}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cloud-gpt", input: "hi", instructions: "be brief" }),
    });
    expect(res.status).toBe(200);
    // instructions → system 消息；路由到云端。
    expect(readCloud()?.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    const body = (await res.json()) as Record<string, any>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("cloud-gpt");
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].content[0]).toEqual({ type: "output_text", text: "hello-cloud!", annotations: [] });
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(3);
    expect(body.usage.total_tokens).toBe(8);
  });

  test("stream: emits response.created → output_text.delta* → response.completed", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "upstream-chat", input: "hi", stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSSE(await res.text());
    const names = events.map((e) => e.data.type);
    expect(names[0]).toBe("response.created");
    expect(names).toContain("response.output_item.added");
    expect(names).toContain("response.content_part.added");
    expect(names[names.length - 1]).toBe("response.completed");

    const deltas = events.filter((e) => e.data.type === "response.output_text.delta");
    expect(deltas.map((e) => e.data.delta).join("")).toBe("hello-local!");

    const completed = events.find((e) => e.data.type === "response.completed")!;
    const resp = completed.data.response;
    expect(resp.status).toBe("completed");
    expect(resp.output[0].content[0].text).toBe("hello-local!");
  });

  test("returns OpenAI-style error when model is missing", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("Anthropic tool calling (/v1/messages)", () => {
  const weatherTool = {
    name: "get_weather",
    description: "Get current weather",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  };

  test("non-stream: tools/tool_choice 转为 OpenAI 格式，tool_calls 转回 tool_use 块", async () => {
    lastLocalChat = null;
    localOverride = Response.json({
        id: "chatcmpl-tool",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Let me check.",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    const res = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "upstream-chat",
        max_tokens: 100,
        tools: [weatherTool],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: "weather in Paris" }],
      }),
    });
    expect(res.status).toBe(200);
    // 上游收到 OpenAI 风格的 tools / tool_choice。
    expect(readLocal()?.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", description: "Get current weather", parameters: weatherTool.input_schema },
      },
    ]);
    expect(readLocal()?.tool_choice).toBe("auto");

    const body = (await res.json()) as Record<string, any>;
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toHaveLength(2);
    expect(body.content[0]).toEqual({ type: "text", text: "Let me check." });
    expect(body.content[1]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
      input: { city: "Paris" },
    });
  });

  test("assistant tool_use 历史 + user tool_result 转成 assistant tool_calls + role:tool", async () => {
    lastLocalChat = null;
    const res = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "upstream-chat",
        max_tokens: 100,
        messages: [
          { role: "user", content: "weather in Paris" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny, 22°C" }],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(readLocal()?.messages).toEqual([
      { role: "user", content: "weather in Paris" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny, 22°C" },
    ]);
    const body = (await res.json()) as Record<string, any>;
    expect(body.stop_reason).toBe("end_turn");
  });

  test("stream: tool_calls 增量转成 content_block_start(tool_use) + input_json_delta 序列", async () => {
    lastLocalChat = null;
    localOverride = sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "get_weather" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    const res = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "upstream-chat",
        max_tokens: 100,
        tools: [weatherTool],
        stream: true,
        messages: [{ role: "user", content: "weather in Paris" }],
      }),
    });
    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    const names = events.map((e) => e.data.type);
    expect(names[0]).toBe("message_start");
    expect(names[names.length - 1]).toBe("message_stop");

    // 无文本块：第一个内容块就是 tool_use。
    const blockStart = events.find((e) => e.data.type === "content_block_start")!;
    expect(blockStart.data.content_block).toEqual({ type: "tool_use", id: "call_9", name: "get_weather", input: {} });

    const jsonDeltas = events.filter((e) => e.data.type === "content_block_delta");
    expect(jsonDeltas.every((e) => e.data.delta.type === "input_json_delta")).toBe(true);
    expect(jsonDeltas.map((e) => e.data.delta.partial_json).join("")).toBe('{"city":"Paris"}');

    const delta = events.find((e) => e.data.type === "message_delta")!;
    expect(delta.data.delta.stop_reason).toBe("tool_use");
  });
});

describe("OpenAI Responses tool calling (/v1/responses)", () => {
  const weatherFn = {
    type: "function",
    name: "get_weather",
    description: "Get current weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  };

  test("non-stream: tools 转 Chat Completions function 嵌套格式，tool_calls 输出为 function_call 项", async () => {
    lastCloudChat = null;
    cloudOverride = Response.json({
        id: "chatcmpl-tool",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    const res = await fetch(`${GATEWAY_BASE}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cloud-gpt", input: "weather in Paris", tools: [weatherFn] }),
    });
    expect(res.status).toBe(200);
    // Responses 扁平工具 → Chat Completions function 嵌套格式后再发给上游。
    expect(readCloud()?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ]);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("completed");
    expect(body.output).toHaveLength(1);
    expect(body.output[0]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
    });
    expect(String(body.output[0].id)).toMatch(/^fc_/);
  });

  test("function_call + function_call_output 输入项转回 assistant tool_calls + role:tool", async () => {
    lastCloudChat = null;
    const res = await fetch(`${GATEWAY_BASE}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cloud-gpt",
        input: [
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
          { type: "function_call_output", call_id: "call_1", output: "sunny" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "summarize" }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(readCloud()?.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
      { role: "user", content: "summarize" },
    ]);
  });

  test("stream: function_call 项 + arguments 增量事件，completed 输出含完整参数", async () => {
    lastLocalChat = null;
    localOverride = sseResponse([
        { choices: [{ delta: { content: "Checking weather..." } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_7", type: "function", function: { name: "get_weather" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city": ' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    const res = await fetch(`${GATEWAY_BASE}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "upstream-chat", input: "weather in Paris", tools: [weatherFn], stream: true }),
    });
    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    const names = events.map((e) => e.data.type);
    expect(names[0]).toBe("response.created");
    expect(names[names.length - 1]).toBe("response.completed");

    const added = events.filter((e) => e.data.type === "response.output_item.added");
    expect(added).toHaveLength(2);
    expect(added[0]?.data.item?.type).toBe("message");
    expect(added[1]?.data.item).toMatchObject({
      type: "function_call",
      call_id: "call_7",
      name: "get_weather",
      arguments: "",
    });

    const argDeltas = events.filter((e) => e.data.type === "response.function_call_arguments.delta");
    expect(argDeltas.map((e) => e.data.delta).join("")).toBe('{"city": "Paris"}');
    const argDone = events.find((e) => e.data.type === "response.function_call_arguments.done")!;
    expect(argDone.data.arguments).toBe('{"city": "Paris"}');

    const textDelta = events.find((e) => e.data.type === "response.output_text.delta")!;
    expect(textDelta.data.delta).toBe("Checking weather...");

    const completed = events.find((e) => e.data.type === "response.completed")!;
    const output = completed.data.response.output;
    expect(output[0].type).toBe("message");
    expect(output[0].content[0].text).toBe("Checking weather...");
    expect(output[1]).toMatchObject({
      type: "function_call",
      call_id: "call_7",
      name: "get_weather",
      arguments: '{"city": "Paris"}',
    });
  });
});

describe("API key auth", () => {
  test("open access when no key is configured", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/models`);
    expect(res.status).toBe(200);
  });

  test("rejects missing / wrong keys and accepts Bearer + x-api-key", async () => {
    SETTINGS.GATEWAY_API_KEY = "test-key-123";
    try {
      const noAuth = await fetch(`${GATEWAY_BASE}/v1/models`);
      expect(noAuth.status).toBe(401);
      const noAuthBody = (await noAuth.json()) as { error: { type: string; code: string } };
      expect(noAuthBody.error.type).toBe("authentication_error");
      expect(noAuthBody.error.code).toBe("invalid_api_key");

      const wrongKey = await fetch(`${GATEWAY_BASE}/v1/models`, authed("wrong"));
      expect(wrongKey.status).toBe(401);

      const bearer = await fetch(`${GATEWAY_BASE}/v1/models`, authed("test-key-123"));
      expect(bearer.status).toBe(200);

      const xApiKey = await fetch(`${GATEWAY_BASE}/v1/models`, { headers: { "x-api-key": "test-key-123" } });
      expect(xApiKey.status).toBe(200);

      // 元信息端点不受鉴权影响。
      const health = await fetch(`${GATEWAY_BASE}/health`);
      expect(health.status).toBe(200);

      // Anthropic 端点同样受保护，且接受 x-api-key。
      const msgNoAuth = await fetch(`${GATEWAY_BASE}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "upstream-chat", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(msgNoAuth.status).toBe(401);
    } finally {
      SETTINGS.GATEWAY_API_KEY = "";
    }
  });

  test("generateGatewayApiKey persists a key that works immediately", async () => {
    const key = generateGatewayApiKey();
    try {
      expect(key).toMatch(/^osk-/);
      const res = await fetch(`${GATEWAY_BASE}/v1/models`, authed(key));
      expect(res.status).toBe(200);
    } finally {
      SETTINGS.GATEWAY_API_KEY = "";
    }
  });
});
