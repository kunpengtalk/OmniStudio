import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { CloudModelType, CloudProviderInfo } from "../shared/cloud-providers";
import type { ModelCategory, ModelFileKind, ModelOrigin } from "../shared/modelscope";
import type { ServerStatus } from "./runtimes/types";
import { mockModulePartial } from "./test-mocks";

/**
 * 对话模型列表的三条硬要求（用户直接提的）：
 *   1. 本地条目带**运行状态** —— 对话框只显示已启动的（running / 正在加载）；
 *   2. 云端只列**已启用厂商**的模型，且必须是用户在该厂商「模型列表」里添加过的
 *      **对话**模型（生图 / 视频 / TTS / ASR 一律不进对话选择器）；
 *   3. 在选择器里选模型**不启动任何进程**（启动在控制台）。
 *
 * 注意：这里**不能** mock `./model-servers`（它在被测路径上）：`bun test` 的
 * mock 注册表在同一批次里跨文件可见，mock 掉它会污染 model-servers.test.ts
 * （那里需要真实注册表）。改为桩掉运行时，用真实注册表启动实例来构造
 * "已启动 / 加载中" 的状态。
 */

const SETTINGS: Record<string, string> = {
  SERVER_MODE: "local",
  INFERENCE_ENGINE: "llama.cpp",
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: "18600",
  VLLM_PORT: "18601",
  CHAT_MODEL: "",
  VLLM_MODEL_NAME: "",
  VLLM_API_BASE: "",
  VLLM_API_KEY: "EMPTY",
  CLOUD_PROVIDER: "",
};

// 设置层用「真实导出 + 局部覆盖」：真实模块新增导出时这里自动跟上，不必逐个补。
await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: (key) => SETTINGS[key] ?? "",
  getNumericSetting: (key) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getServerPort: (engine) =>
    engine === "llama.cpp" ? SETTINGS.SERVER_PORT || "8080" : SETTINGS.VLLM_PORT || "8081",
  getActiveServerPort: () => SETTINGS.SERVER_PORT || "8080",
  setActiveServerPortOverride: () => {},
});

/** 假 runtime：启动即 running，可以手动推状态（用来构造"正在加载"）。 */
class FakeRuntime {
  readonly id = "fake";
  readonly label = "Fake Engine";
  status: ServerStatus = "stopped";
  logs = "";
  readonly statusCbs = new Set<(status: ServerStatus) => void>();

  constructor(readonly overrides: Record<string, string | undefined> = {}) {}

  checkBinary = async () => ({ found: true, path: "/fake/bin" });
  buildCommandLine = (model?: string) => `fake ${model ?? this.overrides.model ?? ""}`;
  start = async () => {
    this.setStatus("running");
    return { ok: true };
  };
  stop = async () => this.setStatus("stopped");
  restart = () => this.start();
  forceKill = () => this.setStatus("stopped");
  getStatus = () => this.status;
  getPid = () => 1234;
  getLogs = () => this.logs;
  getLastError = () => "";
  clearLogs = () => {
    this.logs = "";
  };
  onLog = () => () => {};
  onStatusChange = (cb: (status: ServerStatus) => void) => {
    this.statusCbs.add(cb);
    return () => {
      this.statusCbs.delete(cb);
    };
  };
  setStatus(status: ServerStatus) {
    this.status = status;
    for (const cb of this.statusCbs) cb(status);
  }
}

let created: FakeRuntime[] = [];
await mockModulePartial<typeof import("./runtimes")>("./runtimes", {
  createRuntime: (_engine, overrides) => {
    const runtime = new FakeRuntime(overrides);
    created.push(runtime);
    return runtime;
  },
});

await mockModulePartial<typeof import("./runtimes/mlx")>("./runtimes/mlx", {
  isMlxActive: () => SETTINGS.INFERENCE_ENGINE === "mlx",
  resolveMlxModel: () => ({ model: "", requestModelId: "" }),
  mlxRequestModelId: (target) => `/abs/${target}`,
});

type FakeInstalled = {
  repo: string;
  fileName: string;
  path: string;
  runtimeTarget: string;
  size: number;
  isActive: boolean;
  isChatModel: boolean;
  category: ModelCategory;
  favorite: boolean;
  origin: ModelOrigin;
  isDir: boolean;
  kind: ModelFileKind;
};
let INSTALLED: FakeInstalled[] = [];
const setActiveModelCalls: string[] = [];

await mockModulePartial<typeof import("./model-store")>("./model-store", {
  setActiveModel: (path) => {
    setActiveModelCalls.push(path);
    return { ok: true };
  },
  slugModelFileName: (name) => name.replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
  servedNameForModelPath: (path) =>
    (path.split("/").pop() ?? path).replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
  listInstalledModels: () => INSTALLED,
});

type FakeProvider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 厂商「模型列表」：id + 可选的用途标注（不标就按 id 自动识别）。 */
  models: { id: string; type?: CloudModelType }[];
  /** 已「启动」的厂商才有模型进对话列表。 */
  enabled?: boolean;
};
/**
 * 补上 `CloudProviderInfo` 里对话列表用不到的字段。
 * 放在这里而不是让每处 fixture 都写一遍：fixture 只该写它真正关心的东西，
 * 而"返回类型必须是完整的"这件事由这一个函数承担。
 */
const asProviderInfo = (p: FakeProvider): CloudProviderInfo => ({
  vendor: "",
  videoApi: "",
  musicApi: "",
  createdAt: 0,
  updatedAt: 0,
  enabled: false,
  ...p,
});
let PROVIDERS: FakeProvider[] = [];
let ACTIVE_PROVIDER: string | null = null;
const activatedProviders: string[] = [];

await mockModulePartial<typeof import("./cloud-providers")>("./cloud-providers", {
  listCloudProviders: () => ({ providers: PROVIDERS.map(asProviderInfo), activeId: ACTIVE_PROVIDER }),
  activeProviderId: () => ACTIVE_PROVIDER,
  activateCloudProvider: (id) => {
    activatedProviders.push(id);
    ACTIVE_PROVIDER = id;
    return { ok: true };
  },
});

const Served = await import("./model-servers");
const {
  listChatModels,
  selectChatModel,
  getChatModelName,
  getChatModelLabel,
  getChatRequestModelId,
  chatModelSupportsImages,
} = await import("./chat-model");

const tmpDir = mkdtempSync(join(tmpdir(), "chat-model-test-"));
const modelA = join(tmpDir, "a.gguf");
const modelB = join(tmpDir, "b.gguf");
const otherModelPath = join(tmpDir, "other.gguf");
for (const file of [modelA, modelB, otherModelPath]) writeFileSync(file, "gguf");
// 目录目标（MLX 场景：repo / 目录也算实例）。
const repoDir = join(tmpDir, "repo");
mkdirSync(repoDir, { recursive: true });

const originalFetch = globalThis.fetch;
let fetchedUrls: string[] = [];

beforeEach(async () => {
  await Served.stopAllServed();
  created = [];
  INSTALLED = [];
  setActiveModelCalls.length = 0;
  activatedProviders.length = 0;
  PROVIDERS = [];
  ACTIVE_PROVIDER = null;
  fetchedUrls = [];
  for (const key of Object.keys(SETTINGS)) SETTINGS[key] = "";
  SETTINGS.SERVER_MODE = "local";
  SETTINGS.INFERENCE_ENGINE = "llama.cpp";
  SETTINGS.SERVER_HOST = "127.0.0.1";
  SETTINGS.SERVER_PORT = "18600";
  SETTINGS.VLLM_PORT = "18601";
  SETTINGS.VLLM_API_KEY = "EMPTY";
  globalThis.fetch = mock(async (url: unknown) => {
    fetchedUrls.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: "live-model" }] }), { status: 200 });
  }) as never;
});

afterAll(async () => {
  await Served.stopAllServed();
  globalThis.fetch = originalFetch;
});

/** 启动一个真实注册表实例（运行时是假的），返回它。 */
async function serve(path: string, opts: { engine?: "llama.cpp" | "mlx" } = {}) {
  const res = await Served.startServedModel({ model: path, engine: opts.engine });
  expect(res.ok).toBe(true);
  return res.model!;
}

describe("listChatModels 的本地条目", () => {
  test("已启动实例：value = 实例 id、带端点与状态，isActive 跟随活动实例", async () => {
    const a = await serve(modelA);
    const b = await serve(modelB);
    // 后启动的成为活动模型（对话请求跟它走）
    expect(Served.getActiveServedId()).toBe(b.id);

    const { models } = await listChatModels();
    const local = models.filter((m) => m.type === "local");
    expect(local.map((m) => m.value)).toEqual([a.id, b.id]);
    expect(local.map((m) => m.state)).toEqual(["running", "running"]);
    expect(local.map((m) => m.isActive)).toEqual([false, true]);
    expect(local[0]!.endpoint).toContain(`:${a.port}`);
    expect(local[0]!.engine).toBe("llama.cpp");
  });

  test("加载中的实例 state = starting（对话框里显示转圈而不是不可选）", async () => {
    const a = await serve(modelA);
    created[0]!.setStatus("starting");
    const { models } = await listChatModels();
    expect(models.find((m) => m.value === a.id)?.state).toBe("starting");
  });

  test("未启动的已安装模型：state = stopped（对话框据此过滤掉）", async () => {
    INSTALLED = [
      {
        repo: "org/c",
        fileName: "c.gguf",
        path: join(tmpDir, "c.gguf"),
        runtimeTarget: join(tmpDir, "c.gguf"),
        size: 10,
        isActive: true,
        isChatModel: true,
        category: "chat",
        favorite: false,
        origin: "managed",
        isDir: false,
        kind: "gguf",
      },
    ];
    const { models } = await listChatModels();
    const local = models.filter((m) => m.type === "local");
    expect(local).toHaveLength(1);
    expect(local[0]!.state).toBe("stopped");
    // 没启动实例时 isActive 跟随设置里的当前模型（默认模型面板要能看到它）
    expect(local[0]!.isActive).toBe(true);
  });

  test("同目标的实例启动后，条目变成实例（value = 实例 id，state = running）", async () => {
    INSTALLED = [
      {
        repo: "org/a",
        fileName: "a.gguf",
        path: modelA,
        runtimeTarget: modelA,
        size: 10,
        isActive: true,
        isChatModel: true,
        category: "chat",
        favorite: false,
        origin: "managed",
        isDir: false,
        kind: "gguf",
      },
    ];
    const a = await serve(modelA);
    const { models } = await listChatModels();
    const local = models.filter((m) => m.type === "local");
    expect(local).toHaveLength(1);
    expect(local[0]!.value).toBe(a.id);
    expect(local[0]!.state).toBe("running");
    expect(local[0]!.detail).toBe("org/a");
  });

  test("MLX 实例：value 是实例 id，label 是模型名（不是它认的绝对路径）", async () => {
    const m = await serve(repoDir, { engine: "mlx" });
    const { models } = await listChatModels();
    const local = models.filter((o) => o.type === "local");
    expect(local).toHaveLength(1);
    expect(local[0]!.value).toBe(m.id);
    // 请求 id 仍是 MLX 认的绝对路径（servedName），界面上显示的却是模型名 ——
    // 下拉、会话记录里都不该出现 `/Users/…` 这样的路径。
    expect(m.servedName).toBe(`/abs/${repoDir}`);
    expect(local[0]!.label).toBe("repo");
    expect(local[0]!.engine).toBe("mlx");
  });
});

describe("listChatModels 的云端条目", () => {
  test("云端只列厂商清单里的模型（不去拉 /v1/models），isActive 跟随当前厂商与模型名", async () => {
    SETTINGS.SERVER_MODE = "remote";
    SETTINGS.VLLM_MODEL_NAME = "qwen-max";
    SETTINGS.CHAT_MODEL = "qwen-max";
    SETTINGS.VLLM_API_BASE = "https://d.example/v1";
    SETTINGS.VLLM_API_KEY = "sk-1";
    PROVIDERS = [
      {
        id: "dashscope",
        name: "DashScope",
        baseUrl: "https://d.example/v1",
        apiKey: "sk-1",
        models: [{ id: "qwen-max" }],
        enabled: true,
      },
    ];
    ACTIVE_PROVIDER = "dashscope";

    const { models } = await listChatModels();
    const api = models.filter((m) => m.type === "api");
    // 清单里没添加过的模型（服务商 /v1/models 里的 live-model）不进对话列表：
    // 服务商那份全量清单混着生图 / 视频 / 语音，只能从「模型云服务」配好的里面挑。
    expect(api.map((m) => m.value)).toEqual(["qwen-max"]);
    expect(api[0]!.isActive).toBe(true);
    expect(api[0]!.providerName).toBe("DashScope");
    expect(fetchedUrls).toEqual([]);
  });

  test("没启动的厂商整份不进列表；正在用的厂商即使没启动也保留", async () => {
    PROVIDERS = [
      {
        id: "no-key",
        name: "NoKey",
        baseUrl: "https://n.example/v1",
        apiKey: "",
        models: [{ id: "ghost-model" }],
        enabled: false,
      },
      {
        id: "empty-key",
        name: "EmptyKey",
        baseUrl: "https://e.example/v1",
        apiKey: "EMPTY",
        models: [{ id: "ghost2" }],
        enabled: false,
      },
      {
        // 本地兼容端点（LM Studio 这类）正在用但没走「启动」流程：保留，
        // 否则历史配置的用户一升级就会发现对话里没模型可选。
        id: "local-compat",
        name: "LocalCompat",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "",
        models: [{ id: "local-model" }],
        enabled: false,
      },
      {
        id: "ok",
        name: "OK",
        baseUrl: "https://ok.example/v1",
        apiKey: "sk-x",
        models: [{ id: "real-model" }],
        enabled: true,
      },
    ];
    ACTIVE_PROVIDER = "local-compat";

    const { models } = await listChatModels();
    const ids = models.filter((m) => m.type === "api").map((m) => m.value);
    expect(ids).toContain("real-model");
    expect(ids).toContain("local-model");
    expect(ids).not.toContain("ghost-model");
    expect(ids).not.toContain("ghost2");
  });

  test("云端清单里非对话用途的模型被过滤掉（自动识别 + 显式标注）", async () => {
    PROVIDERS = [
      {
        id: "p",
        name: "P",
        baseUrl: "https://p.example/v1",
        apiKey: "sk-x",
        models: [
          { id: "text-embedding-3-large" },
          { id: "bge-reranker-v2-m3" },
          { id: "whisper-large-v3" },
          { id: "gpt-4o-mini-tts" },
          { id: "gpt-image-1" },
          { id: "MiniMax-H3" },
          { id: "doubao-seedance-1-0-lite-t2v-250428" },
          // 显式标了用途的以标注为准：名字像对话的生视频模型也不能进对话列表。
          { id: "omni-chat-video-edition", type: "video" },
          // 实时语音（`*-realtime-*`）自动识别落在 other，而 other 是**保留**的：
          // 它在对话页被选中后只会在发消息时被上游拒掉。实时语音在通话页选。
          { id: "stepaudio-3-realtime-preview", type: "other" },
          { id: "stepaudio-2.5-realtime" },
          { id: "qwen-audio-3.0-realtime-plus" },
          // 反过来，明确标成对话的照常保留（自建 / 微调的模型名往往认不出来）。
          { id: "my-private-llm", type: "chat" },
          { id: "my-model-7b" },
          { id: "qwen3-8b" },
        ],
        enabled: true,
      },
    ];
    const { models } = await listChatModels();
    expect(models.map((m) => m.value)).toEqual(["my-private-llm", "my-model-7b", "qwen3-8b"]);
    expect(models[0]!.category).toBe("chat");
  });
});

describe("selectChatModel", () => {
  test("选已启动实例：只切活动实例，不碰模型库、不启动进程", async () => {
    const a = await serve(modelA);
    const b = await serve(modelB);
    expect(Served.getActiveServedId()).toBe(b.id);

    const res = await selectChatModel("local", a.id);
    expect(res.ok).toBe(true);
    expect(Served.getActiveServedId()).toBe(a.id);
    expect(SETTINGS.CHAT_MODEL).toBe("a");
    // 关键不变量：选择器不启动 / 不重启任何东西（启动是控制台的事）。
    expect(setActiveModelCalls).toEqual([]);
    expect(created.length).toBe(2);
    expect(res.needsStart).toBeUndefined();
  });

  test("传未启动的模型路径：只记录设置并标记需要去控制台启动", async () => {
    const res = await selectChatModel("local", otherModelPath);
    expect(res.ok).toBe(true);
    expect(res.needsStart).toBe(true);
    expect(setActiveModelCalls).toEqual([otherModelPath]);
    expect(SETTINGS.SERVER_MODE).toBe("local");
    // 不能把 SERVED_ACTIVE_ID 指向一个不存在的实例。
    expect(SETTINGS.SERVED_ACTIVE_ID).toBe("");
  });

  test("选云端模型：切到对应厂商并记录模型名", async () => {
    ACTIVE_PROVIDER = "other";
    const res = await selectChatModel("api", "qwen-max", "dashscope");
    expect(res.ok).toBe(true);
    expect(activatedProviders).toEqual(["dashscope"]);
    expect(SETTINGS.SERVER_MODE).toBe("remote");
    expect(SETTINGS.VLLM_MODEL_NAME).toBe("qwen-max");
    expect(SETTINGS.CHAT_MODEL).toBe("qwen-max");
  });
});

describe("请求侧模型 id", () => {
  test("本地模式：有活动实例时用实例的服务名（MLX 是绝对路径）", async () => {
    SETTINGS.SERVER_MODE = "local";
    const m = await serve(repoDir, { engine: "mlx" });
    expect(m.servedName).toBe(`/abs/${repoDir}`);
    expect(getChatModelName()).toBe(`/abs/${repoDir}`);
    expect(getChatRequestModelId()).toBe(`/abs/${repoDir}`);
  });

  test("云端模式：本地实例还在跑也发云端选的那个模型名（否则被云 API 回 Model does not exist）", async () => {
    // 切云端不会停掉本地实例：这就是用户「选了云端模型却报 Model does not exist」的场景。
    await serve(repoDir, { engine: "mlx" });
    SETTINGS.SERVER_MODE = "remote";
    SETTINGS.VLLM_MODEL_NAME = "deepseek-v4-flash";
    SETTINGS.CHAT_MODEL = `/abs/${repoDir}`; // 旧数据：CHAT_MODEL 里还留着本地模型

    expect(getChatRequestModelId()).toBe("deepseek-v4-flash");
    expect(getChatModelName()).toBe("deepseek-v4-flash");
    // 会话标题 / 用量统计跟着显示云端模型，不能还写着本地那个。
    expect(getChatModelLabel()).toBe("deepseek-v4-flash");
  });

  test("没有活动实例时回落到设置（CLI / 外部服务器场景）", () => {
    SETTINGS.SERVER_MODE = "local";
    SETTINGS.CHAT_MODEL = "qwen3-8b";
    expect(getChatModelName()).toBe("qwen3-8b");
  });
});

/**
 * 视觉能力探测（决定 Agent 是否拿到 view_image）。
 *
 * 判错的代价不对称：把图片发给纯文本模型，服务端会直接 400（整轮报废）；
 * 反过来只是"少一个工具"。所以默认按模型名猜 + 允许强制开关。
 */
describe("chatModelSupportsImages", () => {
  test("本地模型按名字判断：视觉模型 / 纯文本模型", () => {
    SETTINGS.SERVER_MODE = "local";
    SETTINGS.CHAT_MODEL = "Qwen2.5-VL-7B-Instruct-4bit";
    expect(chatModelSupportsImages()).toBe(true);

    SETTINGS.CHAT_MODEL = "qwen3-8b";
    expect(chatModelSupportsImages()).toBe(false);
  });

  test("云端模式默认放行（主力模型基本都支持视觉）", () => {
    SETTINGS.SERVER_MODE = "remote";
    SETTINGS.VLLM_MODEL_NAME = "gpt-5";
    expect(chatModelSupportsImages()).toBe(true);
  });

  test("AGENT_VISION_TOOL 可以强制开关（auto 之外的档位不受模型名影响）", () => {
    SETTINGS.SERVER_MODE = "local";
    SETTINGS.CHAT_MODEL = "qwen3-8b";
    SETTINGS.AGENT_VISION_TOOL = "on";
    expect(chatModelSupportsImages()).toBe(true);

    SETTINGS.CHAT_MODEL = "Qwen2.5-VL-7B";
    SETTINGS.AGENT_VISION_TOOL = "off";
    expect(chatModelSupportsImages()).toBe(false);

    SETTINGS.AGENT_VISION_TOOL = "auto";
    expect(chatModelSupportsImages()).toBe(true);
  });
});
