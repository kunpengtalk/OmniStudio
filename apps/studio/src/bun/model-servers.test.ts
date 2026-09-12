import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * 已启动模型注册表：多个模型同时驻留、各自端口、卸载即摘除条目。
 *
 * 桩掉调度层（设置 / 运行时 / 模型库），只测注册表自己的逻辑：
 *   1. 同一模型重复启动是幂等的，不同模型各占一个端口（第一个用设置端口）；
 *   2. 卸载 = 条目消失 + 进程被杀 + 端口/活动模型不残留；
 *   3. 请求侧只跟「活动实例」走（端口覆盖 + servedName），不再看设置里的活动模型。
 */

const SETTINGS: Record<string, string> = {};
mock.module("./db/settings", () => ({
  getSetting: (key: string) => SETTINGS[key] ?? "",
  getNumericSetting: (key: string) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values: Record<string, string>) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getServerPort: (engine: string) =>
    engine === "llama.cpp" ? (SETTINGS.SERVER_PORT || "8080") : (SETTINGS.VLLM_PORT || "8081"),
  setActiveServerPortOverride: (port: string | null) => {
    PORT_OVERRIDE = port;
  },
}));

let PORT_OVERRIDE: string | null = null;

/** 假的 runtime：记录被启动 / 停止，能手动推状态与日志。 */
class FakeRuntime {
  status = "stopped";
  logs = "";
  pid = 4242;
  readonly logCbs = new Set<(text: string) => void>();
  readonly statusCbs = new Set<(status: string) => void>();

  constructor(readonly overrides: Record<string, string | undefined> = {}) {}

  checkBinary = async () => ({ found: true, path: "/fake/bin" });
  buildCommandLine = (model?: string) => `fake ${model ?? this.overrides.model ?? ""}`;
  start = async () => {
    this.status = "starting";
    this.emitStatus();
    this.status = "running";
    this.emitStatus();
    return { ok: true };
  };
  stop = async () => {
    this.status = "stopped";
    this.emitStatus();
  };
  restart = () => this.start();
  forceKill = () => {
    this.status = "stopped";
  };
  getStatus = () => this.status;
  getPid = () => (this.status === "stopped" ? undefined : this.pid);
  getLogs = () => this.logs;
  getLastError = () => "";
  clearLogs = () => {
    this.logs = "";
  };
  onLog = (cb: (text: string) => void) => {
    this.logCbs.add(cb);
    return () => this.logCbs.delete(cb);
  };
  onStatusChange = (cb: (status: string) => void) => {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  };
  emitStatus() {
    for (const cb of this.statusCbs) cb(this.status);
  }
  emitLog(text: string) {
    this.logs += text;
    for (const cb of this.logCbs) cb(text);
  }
}

let created: FakeRuntime[] = [];
mock.module("./runtimes", () => ({
  createRuntime: (
    _engine: string,
    overrides?: Record<string, string | undefined>,
  ) => {
    const runtime = new FakeRuntime(overrides);
    created.push(runtime);
    return runtime;
  },
}));

mock.module("./runtimes/mlx", () => ({
  mlxRequestModelId: (target: string) => `/abs/${target}`,
  isMlxActive: () => SETTINGS.INFERENCE_ENGINE === "mlx",
  resolveMlxModel: () => ({ model: "", requestModelId: "" }),
}));

mock.module("./model-store", () => ({
  listInstalledModels: () => [],
  servedNameForModelPath: (path: string) =>
    (path.split("/").pop() ?? path).replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
  slugModelFileName: (name: string) => name.replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
}));

const Registry = await import("./model-servers");

const tmpDir = mkdtempSync(join(tmpdir(), "model-servers-test-"));
const modelA = join(tmpDir, "a.gguf");
const modelB = join(tmpDir, "b.gguf");
writeFileSync(modelA, "gguf");
writeFileSync(modelB, "gguf");
const safetensorsDir = join(tmpDir, "repo");
mkdirSyncSafe(safetensorsDir, `{"model_type":"qwen3"}`);
writeFileSync(join(safetensorsDir, "model.safetensors"), "weights");

function mkdirSyncSafe(dir: string, configJson: string) {
  const { mkdirSync } = require("fs") as typeof import("fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), configJson);
}

beforeEach(async () => {
  for (const key of Object.keys(SETTINGS)) delete SETTINGS[key];
  SETTINGS.INFERENCE_ENGINE = "llama.cpp";
  SETTINGS.SERVER_PORT = "18400";
  SETTINGS.VLLM_PORT = "18401";
  PORT_OVERRIDE = null;
  created = [];
  await Registry.stopAllServed();
});

afterEach(async () => {
  await Registry.stopAllServed();
});

describe("startServedModel", () => {
  test("启动两个模型：各占一个端口，第一个用设置端口，跨越引擎也互不影响", async () => {
    const first = await Registry.startServedModel({ model: modelA });
    expect(first.ok).toBe(true);
    expect(first.model?.status).toBe("running");
    expect(first.model?.port).toBe(18400);
    expect(first.model?.usesDefaultPort).toBe(true);
    expect(first.model?.servedName).toBe("a");
    expect(Registry.getActiveServedId()).toBe(first.model!.id);
    expect(PORT_OVERRIDE).toBe("18400");

    const second = await Registry.startServedModel({ model: modelB });
    expect(second.ok).toBe(true);
    // 同引擎第二个实例顺延到下一个空闲端口，不抢默认端点。
    expect(second.model?.port).toBe(18401);
    expect(second.model?.usesDefaultPort).toBe(false);
    expect(second.model?.id).not.toBe(first.model?.id);

    const list = Registry.listServedModels();
    expect(list.length).toBe(2);
    expect(list.map((m) => m.port).sort()).toEqual([18400, 18401]);
    // 后启动的成为活动模型（对话请求跟它走）。
    expect(Registry.getActiveServedId()).toBe(second.model!.id);
    expect(PORT_OVERRIDE).toBe("18401");
  });

  test("同一模型重复启动是幂等的：不新起进程、不改端口", async () => {
    const first = await Registry.startServedModel({ model: modelA });
    const again = await Registry.startServedModel({ model: modelA });
    expect(again.ok).toBe(true);
    expect(again.model?.id).toBe(first.model?.id);
    expect(created.length).toBe(1);
    expect(Registry.listServedModels().length).toBe(1);
  });

  test("目录仓库（safetensors）自动挑能加载它的引擎", async () => {
    const res = await Registry.startServedModel({ model: safetensorsDir });
    expect(res.ok).toBe(true);
    expect(res.model?.engine).toBe("vllm");
    expect(res.model?.isDir).toBe(true);
    expect(res.model?.port).toBe(18401);
  });

  test("不存在的模型名直接报错，不起进程", async () => {
    const res = await Registry.startServedModel({ model: "not-a-model" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not-a-model");
    expect(created.length).toBe(0);
    expect(Registry.listServedModels()).toEqual([]);
  });
});

describe("stopServedModel / 卸载", () => {
  test("卸载后条目消失、活动模型清空、端口覆盖复位", async () => {
    const { model } = await Registry.startServedModel({ model: modelA });
    const logs: string[] = [];
    const off = Registry.onServedModelLog((id, text) => logs.push(`${id}:${text}`));
    created[0]!.emitLog("hello\n");
    off();
    expect(logs[0]).toBe(`${model!.id}:hello\n`);
    expect(Registry.getServedModelLogs(model!.id)).toBe("hello\n");

    const stopped = await Registry.stopServedModel(model!.id);
    expect(stopped.ok).toBe(true);
    expect(Registry.listServedModels()).toEqual([]);
    expect(Registry.getActiveServedId()).toBeNull();
    expect(SETTINGS.SERVED_ACTIVE_ID).toBe("");
    expect(PORT_OVERRIDE).toBeNull();
    expect(created[0]!.status).toBe("stopped");
  });

  test("卸载活动模型后，剩下的实例能升为活动模型", async () => {
    const first = await Registry.startServedModel({ model: modelA, makeActive: false });
    const second = await Registry.startServedModel({ model: modelB, makeActive: false });
    expect(Registry.getActiveServedId()).toBeNull();
    // 只有一个实例时自动认领；这里两个都不活动，手动指定第一个。
    expect(Registry.setActiveServedId(first.model!.id).ok).toBe(true);
    expect(PORT_OVERRIDE).toBe("18400");

    await Registry.stopServedModel(first.model!.id);
    expect(Registry.getServedModel(second.model!.id)?.isActive).toBe(false);
    // 活动模型被卸载后不会指向幽灵实例。
    expect(Registry.getActiveServedModel()).toBeUndefined();
    expect(Registry.getRequestTargetServedModel()?.id).toBe(second.model!.id);
  });

  test("stopAllServed 停掉所有实例（退出应用时不留孤儿进程）", async () => {
    await Registry.startServedModel({ model: modelA });
    await Registry.startServedModel({ model: modelB });
    expect(created.length).toBe(2);
    await Registry.stopAllServed();
    expect(Registry.listServedModels()).toEqual([]);
    expect(created.every((r) => r.status === "stopped")).toBe(true);
  });
});

describe("setActiveServedId", () => {
  test("写回设置：LOCAL_MODEL_PATH / LOCAL_MODEL_NAME / CHAT_MODEL / 引擎", async () => {
    const { model } = await Registry.startServedModel({ model: modelA, makeActive: false });
    const res = Registry.setActiveServedId(model!.id);
    expect(res.ok).toBe(true);
    expect(SETTINGS.SERVED_ACTIVE_ID).toBe(model!.id);
    expect(SETTINGS.SERVER_MODE).toBe("local");
    expect(SETTINGS.LOCAL_MODEL_PATH).toBe(modelA);
    expect(SETTINGS.LOCAL_MODEL_NAME).toBe("a");
    expect(SETTINGS.CHAT_MODEL).toBe("a");
    expect(SETTINGS.INFERENCE_ENGINE).toBe("llama.cpp");
  });

  test("指向不存在的实例时报错，不写设置", () => {
    const res = Registry.setActiveServedId("llama.cpp:/nope.gguf");
    expect(res.ok).toBe(false);
    // 不能把活动模型指向一个不存在的实例（否则请求会打到空端口上）。
    expect(SETTINGS.SERVED_ACTIVE_ID ?? "").not.toBe("llama.cpp:/nope.gguf");
  });
});

describe("resolveConfiguredTarget", () => {
  test("按引擎与设置解析要加载的模型", () => {
    SETTINGS.LOCAL_MODEL_PATH = "/models/x.gguf";
    expect(Registry.resolveConfiguredTarget()).toEqual({
      model: "/models/x.gguf",
      engine: "llama.cpp",
    });

    SETTINGS.INFERENCE_ENGINE = "mlx";
    SETTINGS.MLX_MODEL = "org/model-mlx";
    expect(Registry.resolveConfiguredTarget()).toEqual({
      model: "org/model-mlx",
      engine: "mlx",
    });

    SETTINGS.MLX_MODEL = "";
    SETTINGS.LOCAL_MODEL_PATH = "";
    SETTINGS.CHAT_MODEL = "qwen3-8b";
    expect(Registry.resolveConfiguredTarget()).toEqual({
      model: "qwen3-8b",
      engine: "mlx",
    });

    SETTINGS.CHAT_MODEL = "";
    expect(Registry.resolveConfiguredTarget()).toBeNull();
  });
});

describe("展示名（label）", () => {
  test("MLX 本地目录：label 是模型名，servedName 才是它认的绝对路径", async () => {
    // 复现用户报的问题：下拉里显示成 `/Users/…/Apodex-1.1-mini-MLX-4bit` 这样的路径。
    const dir = join(tmpDir, "lmstudio", "abenzerps", "Apodex-1.1-mini-MLX-4bit");
    mkdirSyncSafe(dir, `{"model_type":"qwen3"}`);
    writeFileSync(join(dir, "model.safetensors"), "weights");

    const res = await Registry.startServedModel({ model: dir, engine: "mlx" });
    expect(res.ok).toBe(true);
    expect(res.model?.servedName).toBe(`/abs/${dir}`);
    expect(res.model?.label).toBe("Apodex-1.1-mini-MLX-4bit");
  });

  test("llama.cpp 的服务名本来就是名字，label 与它一致", async () => {
    const res = await Registry.startServedModel({ model: modelA });
    expect(res.model?.label).toBe("a");
    expect(res.model?.label).toBe(res.model?.servedName);
  });
});

describe("servedIdForTarget", () => {
  test("本地文件归一化后按引擎 + 目标生成 id", () => {
    expect(Registry.servedIdForTarget(modelA)).toBe(`llama.cpp:${modelA}`);
    expect(Registry.servedIdForTarget(safetensorsDir)).toBe(`vllm:${safetensorsDir}`);
    expect(Registry.servedIdForTarget("")).toBeNull();
  });
});
