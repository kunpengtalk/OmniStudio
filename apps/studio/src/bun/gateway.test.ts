import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { tmpdir } from "os";
import { join } from "path";

import * as schema from "./db/schema";
// 只借类型：`import type` 在运行时被擦除，不会把真实模块拉进 mock 之前的加载顺序里。
import type { ASRProviderConfig, AsrStatus } from "./asr";
import type { TTSProviderConfig } from "./voice";
import type { ImageGenConfig } from "./image-gen";
import type { MlxModelInfo } from "./mlx-gen";
import type { InstalledModel } from "./model-store";
import { mockModulePartial } from "./test-mocks";

// 假的"上游"端口：本地推理服务器 + 云端 OpenAI 兼容 API。
const LOCAL_PORT = 18099;
const CLOUD_PORT = 18100;
// 嵌入上游（/v1/embeddings 的反代目标）。
const EMBED_PORT = 18101;

// 桩掉网关依赖的后端与设置，让测试不依赖真实 db / 推理服务 / electrobun。
let SERVER_STATUS: "stopped" | "running" = "running";

// 展开真实模块再覆盖：只写死用到的几个函数，避免"模块新增导出 →
// 单跑本文件时解析不到导出"（例如 restartServer 曾让本文件无法独立运行）。
const realServerManager = await import("./server-manager");
mock.module("./server-manager", () => ({
  ...realServerManager,
  getStatus: () => SERVER_STATUS,
  onStatusChange: () => () => {},
}));

const ASR_STATUS: AsrStatus = {
  serverRunning: false,
  port: 18081,
  engine: "none",
  engineInstalled: false,
  engineVersion: null,
  binaryPath: null,
  activeModel: null,
};
const ASR_PROVIDER: ASRProviderConfig = { providerId: "", base: "", apiKey: "", model: "" };

await mockModulePartial<typeof import("./asr")>("./asr", {
  getAsrStatus: async () => ({ ...ASR_STATUS }),
  getASRProviderConfig: () => ({ ...ASR_PROVIDER }),
});

const TTS_PROVIDER: TTSProviderConfig = { providerId: "", base: "", apiKey: "", model: "" };

await mockModulePartial<typeof import("./voice")>("./voice", {
  getTTSProviderConfig: () => ({ ...TTS_PROVIDER }),
  listProviderModels: async () => [] as string[],
  runTTSEdge: async () => ({
    id: 1,
    kind: "tts",
    status: "done",
    source: "agent",
    model: "Edge TTS（在线免费）",
    voice: "zh-CN-XiaoxiaoNeural",
    text: "edge",
    audioUrl: `http://127.0.0.1:${LOCAL_PORT}/fake-audio`,
    audioPath: "audio/tts-fake.mp3",
    refAudioPath: null,
    durationMs: 100,
    error: null,
    createdAt: 0,
  }),
});

await mockModulePartial<typeof import("./tts-local")>("./tts-local", {
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
});

const SETTINGS: Record<string, string> = {
  GATEWAY_ENABLED: "1",
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PORT: "10123",
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: String(LOCAL_PORT),
  VLLM_API_KEY: "EMPTY",
  VLLM_API_BASE: `http://127.0.0.1:${CLOUD_PORT}/v1`,
  GATEWAY_API_KEY: "",
  IMG_BACKEND: "mlx",
  IMG_MODEL: "z-image-turbo",
};

await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: (key) => SETTINGS[key] ?? "",
  // kb-mcp → knowledge.ts → vllm/vllm.ts 会读重试次数等数值设置。
  getNumericSetting: (key) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getActiveServerPort: () => SETTINGS.SERVER_PORT || String(LOCAL_PORT),
});

// 桩掉网关生图适配层（gateway-images）：让 /v1/images/generations 不依赖真实 mflux，
// 也避免直接 mock ./image-gen —— 后者会泄漏给 image-gen.test.ts（它需要真实模块）。
let IMG_GEN_PARAMS: Record<string, unknown> | null = null;
let IMG_GEN_RESULT: { records: any[]; error?: string } = { records: [] };
const IMG_GEN_CONFIG: ImageGenConfig = {
  backend: "mlx",
  providerId: "",
  apiBase: "",
  apiKey: "",
  model: "z-image-turbo",
  comfyBase: "",
};
const MLX_MODELS: MlxModelInfo[] = [
  {
    id: "z-image-turbo",
    label: "Z-Image Turbo (6B)",
    cmd: "",
    modelArg: null,
    defaultSteps: 9,
    approxSizeGb: 6,
    description: "",
  },
  {
    id: "flux-schnell",
    label: "FLUX.1 Schnell (12B)",
    cmd: "",
    modelArg: "schnell",
    defaultSteps: 4,
    approxSizeGb: 12,
    description: "",
  },
];

// 经由函数读取：让 TS 以声明类型（而非收窄后的 null）参与类型检查。
const readImgParams = (): Record<string, unknown> | null => IMG_GEN_PARAMS;

// 桩掉图片落盘目录：b64_json 读取用测试临时目录。
const TMP_IMG_DIR = (() => {
  const { mkdtempSync } = require("fs");
  const { tmpdir } = require("os");
  const { join } = require("path");
  return mkdtempSync(join(tmpdir(), "gw-img-"));
})();

await mockModulePartial<typeof import("./gateway-images")>("./gateway-images", {
  getImageGenConfig: () => ({ ...IMG_GEN_CONFIG }),
  generateImage: async (params) => {
    IMG_GEN_PARAMS = params as Record<string, unknown>;
    return IMG_GEN_RESULT;
  },
  // 从同一份清单里查：以前这里是手写 `{ id }`，缺了 label / cmd / steps —— 一个
  // 「查得到就等于认得出」的假实现，模型信息一多就对不上真实返回。
  lookupMlxModel: (id) => MLX_MODELS.find((m) => m.id === id) ?? null,
  IMAGE_MODELS: MLX_MODELS,
  imagesBaseDir: () => TMP_IMG_DIR,
});

// 桩掉「已装本地模型」：默认空 → 所有模型名都走"非本地已装"的旧路由逻辑；
// 需要验证本地模型路由的测试自行填充 INSTALLED_MODELS。
//
// 只填 fileName：被测的路由判断只看这一个字段。返回处显式断言成完整类型，
// 免得为了满足结构类型把十来个别处用不到的字段编出来（那样反而看不出"这里只用到名字"）。
let INSTALLED_MODELS: { fileName: string }[] = [];
await mockModulePartial<typeof import("./model-store")>("./model-store", {
  listInstalledModels: () => INSTALLED_MODELS as InstalledModel[],
  slugModelFileName: (fileName) =>
    fileName
      .replace(/\.(gguf|safetensors|bin|pt|pth|ckpt|onnx|ggml)$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-"),
});

/**
 * 用量账本要一个**自己控制的**库。
 *
 * 不能直接 import 真实的 `./db`：`bun test` 的模块 mock 跨文件泄漏，且 chat.test.ts
 * 等文件在 afterAll 里删掉了自己的临时库 —— 后加载的文件拿到的是那个已被删除的
 * 句柄，首次查询就报 "disk I/O error"（报错现场离原因很远）。
 * 与 chat.test.ts 同一套路：自建库 + mock `./db`；**不删**临时文件，免得把同一个坑
 * 留给后加载的文件。
 */
const usageSqlite = new Database(join(tmpdir(), `omni-gw-usage-${process.pid}.db`), { create: true });
const usageDb = drizzle({ client: usageSqlite, schema });
migrate(usageDb, { migrationsFolder: join(import.meta.dir, "db/migrations") });
await mockModulePartial<typeof import("./db")>("./db", { db: usageDb, sqliteClient: usageSqlite });

// 嵌入后端解析：网关 /v1/embeddings 的唯一后端来源是「运行中的嵌入实例」。
// 展开真实模块再覆盖单函数 —— 模式同 ./server-manager：只写死用到的函数，
// 避免「模块新增导出 → 单跑本文件时解析不到导出」。
let EMBEDDING_BACKEND: string | null = null;
const realModelServers = await import("./model-servers");
mock.module("./model-servers", () => ({
  ...realModelServers,
  resolveEmbeddingBackend: () => EMBEDDING_BACKEND,
}));

// 在所有 mock 注册后动态加载被测模块（静态 import 会被提升到 mock 之前执行）。
const { startGateway, stopGateway, getGatewayStatus, resetModelRouteCaches } = await import("./gateway");
const GatewayKeys = await import("./gateway-keys");
const { db } = await import("./db");
const { usageRecords } = await import("./db/schema");

const GATEWAY_BASE = `http://127.0.0.1:10123`;

// 两个假的"上游"：本地推理服务器 + 云端 OpenAI 兼容 API。
type Captured = { model?: string; messages?: unknown[]; stream?: unknown; tools?: unknown[]; tool_choice?: unknown } | null;
let lastLocalChat: Captured = null;
let lastCloudChat: Captured = null;
// 经由函数读取：让 TS 以声明类型（而非收窄后的 null）参与类型检查。
const readLocal = (): Captured => lastLocalChat;
const readCloud = (): Captured => lastCloudChat;

// 嵌入上游捕获：最后一次 /v1/embeddings 请求体（透传断言用）。
let lastEmbedRequest: Record<string, unknown> | null = null;
// 经由函数读取：让 TS 以声明类型（而非收窄后的 null）参与类型检查。
const readEmbedRequest = (): Record<string, unknown> | null => lastEmbedRequest;
// 固定的 OpenAI 形状嵌入响应（小数组代替真实 4096 维，断言形状透传）。
const EMBED_UPSTREAM_BODY = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, -0.2, 0.3, 0.4] }],
  model: "model/wemm-embed",
  usage: { prompt_tokens: 3, total_tokens: 3 },
};

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
let embed: ReturnType<typeof Bun.serve> | null = null;

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
  // 嵌入上游：返回固定 OpenAI 形状的嵌入响应，并捕获请求体（透传断言用）。
  embed = Bun.serve({
    port: EMBED_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/embeddings" && req.method === "POST") {
        const raw = await req.text();
        lastEmbedRequest = raw ? JSON.parse(raw) : null;
        return Response.json(EMBED_UPSTREAM_BODY);
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
  cloud?.stop();
  embed?.stop();
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
      "/v1/embeddings",
      "/v1/responses",
      "/v1/messages",
      "/v1/audio/speech",
      "/v1/audio/transcriptions",
      "/v1/images/generations",
      "/v1/media",
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

  test("POST /v1/images/generations returns OpenAI-style url items with default config", async () => {
    IMG_GEN_PARAMS = null;
    IMG_GEN_RESULT = {
      records: [
        { id: 1, status: "done", backend: "mlx", model: "z-image-turbo", imageUrl: "http://127.0.0.1:1234/gen/a.png", imagePath: "gen/a.png", createdAt: 1700000000000 },
      ],
    };
    const res = await fetch(`${GATEWAY_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "omni-image", prompt: "a cat", n: 1, size: "512x512" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; data: { url: string }[] };
    expect(body.created).toBeGreaterThan(0);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.url).toContain("/gen/a.png");
    // 路由到当前已配置的后端/模型（IMG_BACKEND=mlx, IMG_MODEL=z-image-turbo）。
    expect((readImgParams()?.config as { backend?: string })?.backend).toBe("mlx");
    expect(readImgParams()?.model).toBe("z-image-turbo");
    expect(readImgParams()?.width).toBe(512);
    expect(readImgParams()?.height).toBe(512);
    expect(readImgParams()?.count).toBe(1);
  });

  test("POST /v1/images/generations routes an explicit MLX model id to mlx backend", async () => {
    IMG_GEN_PARAMS = null;
    IMG_GEN_RESULT = {
      records: [{ id: 2, status: "done", backend: "mlx", model: "flux-schnell", imageUrl: "http://127.0.0.1:1234/gen/b.png", imagePath: "gen/b.png", createdAt: 1700000000000 }],
    };
    const res = await fetch(`${GATEWAY_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "flux-schnell", prompt: "an astronaut", n: 2 }),
    });
    expect(res.status).toBe(200);
    expect((readImgParams()?.config as { backend?: string })?.backend).toBe("mlx");
    expect(readImgParams()?.model).toBe("flux-schnell");
    expect(readImgParams()?.count).toBe(2);
  });

  test("POST /v1/images/generations returns b64_json when requested", async () => {
    // 在测试临时目录里放一个假图片文件，网关按 imagePath 读取。
    const { mkdirSync, writeFileSync } = require("fs");
    const { join } = require("path");
    mkdirSync(join(TMP_IMG_DIR, "gen"), { recursive: true });
    writeFileSync(join(TMP_IMG_DIR, "gen", "b64.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    IMG_GEN_RESULT = {
      records: [{ id: 3, status: "done", backend: "mlx", model: "z-image-turbo", imageUrl: "http://127.0.0.1:1234/gen/b64.png", imagePath: "gen/b64.png", createdAt: 1700000000000 }],
    };
    const res = await fetch(`${GATEWAY_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "omni-image", prompt: "a cat", response_format: "b64_json" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { b64_json?: string; url?: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.b64_json).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  });

  test("POST /v1/images/generations returns 502 with the backend error on failure", async () => {
    IMG_GEN_RESULT = { records: [], error: "模型「FLUX.1 Dev」尚未下载，请先点击「下载模型」" };
    const res = await fetch(`${GATEWAY_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "flux-dev", prompt: "an astronaut" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.message).toContain("尚未下载");
    expect(body.error.type).toBe("image_generation_error");
  });

  test("POST /v1/images/generations rejects missing prompt and invalid size", async () => {
    const noPrompt = await fetch(`${GATEWAY_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "omni-image" }),
    });
    expect(noPrompt.status).toBe(400);
    const badSize = await fetch(`${GATEWAY_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", size: "big" }),
    });
    expect(badSize.status).toBe(400);
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

describe("Embeddings endpoint (/v1/embeddings)", () => {
  test("proxies to the running embedding instance, passing through request body and response shape", async () => {
    lastLocalChat = null;
    lastCloudChat = null;
    lastEmbedRequest = null;
    EMBEDDING_BACKEND = `http://127.0.0.1:${EMBED_PORT}`;
    try {
      const reqBody = { model: "model/wemm-embed", input: ["hello", "world"] };
      const res = await fetch(`${GATEWAY_BASE}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      expect(res.status).toBe(200);
      // 响应体原样透传：OpenAI 形状（object / data[].embedding / usage）。
      const body = (await res.json()) as typeof EMBED_UPSTREAM_BODY;
      expect(body).toEqual(EMBED_UPSTREAM_BODY);
      // 请求体原样转发到嵌入实例，且绝不转发给聊天后端。
      expect(readEmbedRequest()).toEqual(reqBody);
      expect(readLocal()).toBeNull();
      expect(readCloud()).toBeNull();
    } finally {
      EMBEDDING_BACKEND = null;
    }
  });

  test("with GATEWAY_API_KEY set, requests without a key get 401", async () => {
    SETTINGS.GATEWAY_API_KEY = "test-key-123";
    try {
      const noAuth = await fetch(`${GATEWAY_BASE}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      });
      expect(noAuth.status).toBe(401);
      const body = (await noAuth.json()) as { error: { type: string; code: string } };
      expect(body.error.type).toBe("authentication_error");
      expect(body.error.code).toBe("invalid_api_key");

      // 带上正确 Key 后走正常链路（无嵌入实例 → 503 引导，而不是 401）。
      const withKey = await fetch(`${GATEWAY_BASE}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authed("test-key-123").headers },
        body: JSON.stringify({ input: "hi" }),
      });
      expect(withKey.status).toBe(503);
    } finally {
      SETTINGS.GATEWAY_API_KEY = "";
    }
  });

  test("no embedding instance → 503 + actionable guidance", async () => {
    lastEmbedRequest = null;
    EMBEDDING_BACKEND = null;
    const res = await fetch(`${GATEWAY_BASE}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.message).toContain("嵌入服务未运行");
    expect(body.error.message).toContain("模型页");
    expect(body.error.type).toBe("server_error");
    // 无实例时不得有任何转发发生。
    expect(readEmbedRequest()).toBeNull();
    expect(readLocal()).toBeNull();
    expect(readCloud()).toBeNull();
  });

  test("GET /openapi.json contains /v1/embeddings, and the root endpoints list includes it", async () => {
    const specRes = await fetch(`${GATEWAY_BASE}/openapi.json`);
    expect(specRes.status).toBe(200);
    const spec = (await specRes.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toContain("/v1/embeddings");

    const rootRes = await fetch(`${GATEWAY_BASE}/`);
    const root = (await rootRes.json()) as { endpoints: string[] };
    expect(root.endpoints).toContain("POST /v1/embeddings");
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
  /**
   * 每轮开始 / 结束都把 Key 清空：这些用例会让"当前有 Key"成为网关状态，
   * 用例中途失败时若留在库里，后面的用例（不带鉴权的请求）会莫名 401。
   */
  const clearKeys = () => {
    SETTINGS.GATEWAY_API_KEY = "";
    for (const k of GatewayKeys.listGatewayKeys()) GatewayKeys.deleteGatewayKey(k.id);
  };
  beforeEach(clearKeys);
  afterEach(clearKeys);

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

  /**
   * 多 Key：列表里每一把（启用中）都能过闸，停用 / 删除立即失效。
   *
   * 关键是"立即"：网关不缓存 Key 集合，改动落库后下一个请求就该按新状态判 —— 否则
   * 用户以为已经吊销，旧 Key 却还在放行。
   */
  test("新建的 Key 立即生效；停用 / 删除立即失效；没有启用的 Key 时回到开放访问", async () => {
    const created = GatewayKeys.createGatewayKey("测试机");
    expect(created.ok).toBe(true);
    const first = created.ok ? created.key! : null;
    expect(first?.key).toMatch(/^osk-/);
    // 投影：settings 槽位指向这把 Key（/health、/docs、omi launch 读的都是它）
    expect(SETTINGS.GATEWAY_API_KEY).toBe(first!.key);
    expect((await fetch(`${GATEWAY_BASE}/v1/models`, authed(first!.key))).status).toBe(200);

    const second = GatewayKeys.createGatewayKey("第二台");
    const secondKey = second.ok ? second.key! : null;
    // 两把同时有效，且镜像仍指向最早启用的那一把
    expect((await fetch(`${GATEWAY_BASE}/v1/models`, authed(secondKey!.key))).status).toBe(200);
    expect((await fetch(`${GATEWAY_BASE}/v1/models`, authed(first!.key))).status).toBe(200);
    expect(SETTINGS.GATEWAY_API_KEY).toBe(first!.key);

    GatewayKeys.setGatewayKeyEnabled(first!.id, false);
    expect((await fetch(`${GATEWAY_BASE}/v1/models`, authed(first!.key))).status).toBe(401);
    expect((await fetch(`${GATEWAY_BASE}/v1/models`, authed(secondKey!.key))).status).toBe(200);
    // 停用后镜像切到仍然启用的那一把（隧道侧"有 Key 才允许开启"跟着走）
    expect(SETTINGS.GATEWAY_API_KEY).toBe(secondKey!.key);

    GatewayKeys.deleteGatewayKey(secondKey!.id);
    // 没有任何启用的 Key = 历史行为：对本机进程开放访问
    expect(SETTINGS.GATEWAY_API_KEY).toBe("");
    expect((await fetch(`${GATEWAY_BASE}/v1/models`)).status).toBe(200);

    GatewayKeys.deleteGatewayKey(first!.id);
  });

  test("列表会采纳直接写进设置槽位的 Key，不会留下看不见却能用的 Key", async () => {
    SETTINGS.GATEWAY_API_KEY = "cli-written-key";
    const keys = GatewayKeys.listGatewayKeys();
    const adopted = keys.find((k) => k.key === "cli-written-key");
    expect(adopted).toBeDefined();

    // 采纳后能被正常吊销：删掉它 = 没有启用的 Key，槽位清空。
    GatewayKeys.deleteGatewayKey(adopted!.id);
    expect(SETTINGS.GATEWAY_API_KEY).toBe("");
    expect(GatewayKeys.gatewayAuthTokens()).toEqual([]);
  });
});

/**
 * 网关的用量记账。
 *
 * 这一路是外部 agent（Claude Code / Codex…）的唯一入口，请求不产生任何本地消息 ——
 * 账本记不下来，统计页上就永远看不到它们。两条硬约束：
 * 1. **透传不能变样**：替客户端向上一跳要的 usage 块必须挡在客户端之外；
 *    （客户端自己没要 usage 时，它不该在流里看见任何一个额外的块）
 * 2. **拿到多少记多少**：流式与非流式都要落行，别只记一种。
 */
describe("用量记账", () => {
  const usageRows = () => db.select().from(usageRecords).all();

  /** 上游"按 OpenAI 规范"的收尾：一个只带 usage 的空 chunk，然后 [DONE]。 */
  const withUsageChunk = () =>
    sseResponse([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } },
    ]);

  beforeEach(() => {
    db.delete(usageRecords).run();
    lastLocalChat = null;
    lastCloudChat = null;
  });

  test("流式为客户端补 include_usage，但只带 usage 的空 chunk 不转发", async () => {
    localOverride = withUsageChunk();
    const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "upstream-chat", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    const text = await res.text();

    // 1) 请求里替客户端要了用量
    expect((readLocal() as { stream_options?: { include_usage?: boolean } })?.stream_options?.include_usage).toBe(true);
    // 2) 内容照常，额外的空 chunk 不见了
    expect(text).toContain("hi");
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"choices":[]');
    // 3) 账本记下了实测用量
    const rows = usageRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.channel).toBe("gateway");
    expect(rows[0]!.upstream).toBe("local");
    expect(rows[0]!.inputTokens).toBe(120);
    expect(rows[0]!.outputTokens).toBe(40);
    expect(rows[0]!.estimated).toBe(0);
  });

  test("客户端自己开了 include_usage 时，那个块原样透传（不能吞掉它要的东西）", async () => {
    localOverride = withUsageChunk();
    const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "upstream-chat",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const text = await res.text();
    expect(text).toContain('"choices":[]');
    expect(text).toContain('"prompt_tokens":120');
    expect(usageRows().length).toBe(1);
  });

  test("非流式请求一样记账，且响应体不被改写", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "upstream-chat", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await res.json()) as { usage?: { prompt_tokens?: number } };
    expect(body.usage?.prompt_tokens).toBe(5);
    const rows = usageRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.inputTokens).toBe(5);
    expect(rows[0]!.outputTokens).toBe(3);
  });

  test("上游一个 token 数都没给时不落行（记 0 只会让调用次数虚高）", async () => {
    localOverride = sseResponse([{ choices: [{ delta: { content: "hi" } }] }]);
    await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "upstream-chat", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(usageRows().length).toBe(0);
  });

  test("/v1/messages 也记账，模型名按展示口径记", async () => {
    const res = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "upstream-chat", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const rows = usageRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.channel).toBe("gateway");
    expect(rows[0]!.model).toBe("upstream-chat");
  });
});
