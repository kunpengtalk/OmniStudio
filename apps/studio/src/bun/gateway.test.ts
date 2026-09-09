import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// 桩掉网关依赖的后端与设置，让测试不依赖真实 db / 推理服务 / electrobun。
mock.module("./server-manager", () => ({
  getStatus: () => "running",
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
}));

mock.module("./asr", () => ({
  getAsrStatus: async () => ({
    serverRunning: false,
    port: 18081,
    engine: "none",
    engineInstalled: false,
    engineVersion: null,
    binaryPath: null,
    activeModel: null,
  }),
  getASRProviderConfig: () => ({ base: "", apiKey: "", model: "" }),
}));

mock.module("./voice", () => ({
  getTTSProviderConfig: () => ({ base: "", apiKey: "", model: "" }),
}));

// 每轮测试可改的端口（供端口冲突回退用例使用）。
let GW_PORT = "10123";

mock.module("./db/settings", () => ({
  getSetting: (key: string) => {
    switch (key) {
      case "GATEWAY_ENABLED":
        return "1";
      case "GATEWAY_HOST":
        return "127.0.0.1";
      case "GATEWAY_PORT":
        return GW_PORT;
      case "SERVER_HOST":
        return "127.0.0.1";
      case "SERVER_PORT":
        return "18099";
      case "VLLM_API_KEY":
        return "EMPTY";
      default:
        return "";
    }
  },
}));

// 在所有 mock 注册后动态加载被测模块（静态 import 会被提升到 mock 之前执行）。
const { startGateway, stopGateway, getGatewayStatus } = await import("./gateway");

const GATEWAY_BASE = "http://127.0.0.1:10123";
const UPSTREAM_PORT = 18099;

// 一个真实的假上游推理服务：/v1/models 返回一个模型；chat 端点流式返回；speech 端点 404。
let upstream: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  const encoder = new TextEncoder();
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "upstream-chat", object: "model", owned_by: "test" }],
        });
      }
      if (url.pathname === "/v1/chat/completions") {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname === "/v1/audio/speech") {
        return Response.json({ error: { message: "not supported" } }, { status: 404 });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    },
  });

  const res = await startGateway();
  expect(res.ok).toBe(true);
});

afterAll(async () => {
  await stopGateway();
  upstream?.stop();
});

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
    const body = (await res.json()) as { name: string };
    expect(body.name).toContain("Gateway");
  });

  test("GET /health reports ok + upstream status", async () => {
    const res = await fetch(`${GATEWAY_BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; gateway: boolean; upstream: string };
    expect(body.status).toBe("ok");
    expect(body.gateway).toBe(true);
    expect(body.upstream).toBe("running");
  });

  test("GET /openapi.json is a valid OpenAPI 3.0 spec listing all endpoints", async () => {
    const res = await fetch(`${GATEWAY_BASE}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(spec.openapi).toBe("3.0.2");
    const paths = Object.keys(spec.paths);
    for (const p of [
      "/v1/models",
      "/v1/chat/completions",
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
  test("GET /v1/models aggregates upstream + gateway capability models", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("upstream-chat");
    // 本地 TTS / ASR 未启用，不应声明对应能力；文生图始终预留。
    expect(ids).toContain("omni-image");
    expect(ids).not.toContain("omni-tts");
    expect(ids).not.toContain("omni-asr");
  });

  test("POST /v1/chat/completions proxies SSE stream", async () => {
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
  });

  test("POST /v1/audio/speech returns 501 when no TTS backend", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "你好" }),
    });
    expect(res.status).toBe(501);
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
      GW_PORT = "10124";
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
      GW_PORT = "10123";
      await startGateway();
    }
  });
});
