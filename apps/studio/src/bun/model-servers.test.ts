import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { ServerStatus } from "./runtimes/types";
import { mockModulePartial } from "./test-mocks";

/**
 * 已启动模型注册表：多个模型同时驻留、各自端口、卸载即摘除条目。
 *
 * 桩掉调度层（设置 / 运行时 / 模型库），只测注册表自己的逻辑：
 *   1. 同一模型重复启动是幂等的，不同模型各占一个端口（第一个用设置端口）；
 *   2. 卸载 = 条目消失 + 进程被杀 + 端口/活动模型不残留；
 *   3. 请求侧只跟「活动实例」走（端口覆盖 + servedName），不再看设置里的活动模型。
 */

const SETTINGS: Record<string, string> = {};
await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: (key) => SETTINGS[key] ?? "",
  getNumericSetting: (key) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getServerPort: (engine) =>
    engine === "llama.cpp" ? SETTINGS.SERVER_PORT || "8080" : SETTINGS.VLLM_PORT || "8081",
  setActiveServerPortOverride: (port) => {
    PORT_OVERRIDE = port;
  },
});

let PORT_OVERRIDE: string | null = null;

/** 假的 runtime：记录被启动 / 停止，能手动推状态与日志。 */
class FakeRuntime {
  readonly id = "fake";
  readonly label = "Fake Engine";
  status: ServerStatus = "stopped";
  logs = "";
  pid = 4242;
  readonly logCbs = new Set<(text: string) => void>();
  readonly statusCbs = new Set<(status: ServerStatus) => void>();

  constructor(readonly overrides: Record<string, string | undefined> = {}) {}

  checkBinary = async () => ({ found: true, path: "/fake/bin" });
  buildCommandLine = (model?: string) => `fake ${model ?? this.overrides.model ?? ""}`;
  start = async () => {
    this.status = "starting";
    this.emitStatus();
    const failure = FAILING.get(this.overrides.model ?? "");
    if (failure) {
      this.lastError = failure;
      this.status = "error";
      this.emitStatus();
      return { ok: false, error: failure };
    }
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
  getLastError = () => this.lastError;
  lastError = "";
  clearLogs = () => {
    this.logs = "";
  };
  onLog = (cb: (text: string) => void) => {
    this.logCbs.add(cb);
    return () => this.logCbs.delete(cb);
  };
  onStatusChange = (cb: (status: ServerStatus) => void) => {
    this.statusCbs.add(cb);
    return () => {
      this.statusCbs.delete(cb);
    };
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
await mockModulePartial<typeof import("./runtimes")>("./runtimes", {
  createRuntime: (_engine, overrides) => {
    const runtime = new FakeRuntime(overrides);
    created.push(runtime);
    return runtime;
  },
});

await mockModulePartial<typeof import("./runtimes/mlx")>("./runtimes/mlx", {
  mlxRequestModelId: (target) => `/abs/${target}`,
  isMlxActive: () => SETTINGS.INFERENCE_ENGINE === "mlx",
  resolveMlxModel: () => ({ model: "", requestModelId: "" }),
});

await mockModulePartial<typeof import("./model-store")>("./model-store", {
  listInstalledModels: () => [],
  servedNameForModelPath: (path) =>
    (path.split("/").pop() ?? path).replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
  slugModelFileName: (name) => name.replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
});

/** 这些目标一启动就失败，值是错误原文。 */
const FAILING = new Map<string, string>();

/** 下载队列桩：`pendingDownloadFor` 只看 fileName 与 status。 */
const DOWNLOADS: { fileName: string; status: string; received: number; total: number | null; percent: number | null }[] = [];
await mockModulePartial<typeof import("./download-manager")>("./download-manager", {
  downloadManager: { list: () => DOWNLOADS } as never,
});

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
  FAILING.clear();
  DOWNLOADS.length = 0;
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

describe("空闲卸载（PERF-01）", () => {
  /** 把虚拟的「现在」推到某个偏移之后：markServedActivity 盖的是真实时间，所以差值就是空闲时长。 */
  const at = (minutes: number) => Date.now() + minutes * 60_000 + 1_000;

  test("默认关闭（0 = 不卸载）", async () => {
    await Registry.startServedModel({ model: modelA });
    expect(await Registry.unloadIdleServers(at(600))).toEqual([]);
    expect(Registry.listServedModels().length).toBe(1);
  });

  test("超过窗口没人用就卸载，并把端口让出来", async () => {
    SETTINGS.SERVER_IDLE_UNLOAD_MINUTES = "10";
    const { model } = await Registry.startServedModel({ model: modelA });

    // 还没到窗口：不动
    expect(await Registry.unloadIdleServers(at(9))).toEqual([]);
    expect(Registry.listServedModels().length).toBe(1);

    expect(await Registry.unloadIdleServers(at(11))).toEqual([model!.id]);
    expect(Registry.listServedModels()).toEqual([]);
    expect(PORT_OVERRIDE).toBeNull();
  });

  test("活动点会把空闲时钟推到现在", async () => {
    SETTINGS.SERVER_IDLE_UNLOAD_MINUTES = "10";
    await Registry.startServedModel({ model: modelA });

    Registry.markServedActivity("a");
    expect(await Registry.unloadIdleServers(at(5))).toEqual([]);
    expect(await Registry.unloadIdleServers(at(11))).toEqual([
      Registry.servedIdForTarget(modelA)!,
    ]);
  });

  test("引擎还在输出就不卸载（外部客户端的长请求只有这个信号）", async () => {
    SETTINGS.SERVER_IDLE_UNLOAD_MINUTES = "10";
    await Registry.startServedModel({ model: modelA });

    // 第一次检查只记基线：此时还没有「变化」可言，实例照常按窗口卸载
    expect(await Registry.unloadIdleServers(at(1))).toEqual([]);

    // 之后输出变了 → 这一轮判定为「还在干活」，空闲时钟被推到现在
    created[0]!.emitLog("slot launched\n");
    expect(await Registry.unloadIdleServers(at(11))).toEqual([]);
    // 11 → 20 分钟之间又安静了 9 分钟，仍在窗口内
    expect(await Registry.unloadIdleServers(at(20))).toEqual([]);
    expect(Registry.listServedModels().length).toBe(1);
    // 再安静超过一个窗口才卸载
    expect(await Registry.unloadIdleServers(at(22))).toEqual([
      Registry.servedIdForTarget(modelA)!,
    ]);
  });

  test("已经停掉的实例不在候选里（不会重复卸载 / 报错）", async () => {
    SETTINGS.SERVER_IDLE_UNLOAD_MINUTES = "10";
    const { model } = await Registry.startServedModel({ model: modelA });
    await Registry.stopServedModel(model!.id);
    expect(await Registry.unloadIdleServers(at(30))).toEqual([]);
  });
});

describe("启动失败的类型（LIE-05）", () => {
  test("原文认得出来就按原文分类", async () => {
    FAILING.set(modelA, "Error: unknown model architecture: 'spark2_5'");
    const res = await Registry.startServedModel({ model: modelA });
    expect(res.ok).toBe(false);
    expect(res.model?.errorKind).toBe("model-format");
  });

  test("认不出来的原文归 unknown，不硬猜", async () => {
    FAILING.set(modelA, "Process exited with code 1");
    const res = await Registry.startServedModel({ model: modelA });
    expect(res.model?.errorKind).toBe("unknown");
  });

  test("权重还在下载中：不看原文，直接说清楚（llama.cpp 的原文分不出这一种）", async () => {
    FAILING.set(modelA, "0.00.058.639 E srv  llama_server: exiting due to model loading error");
    DOWNLOADS.push({
      fileName: "a.gguf",
      status: "downloading",
      received: 3,
      total: 100,
      percent: 3,
    });

    const res = await Registry.startServedModel({ model: modelA });
    expect(res.model?.errorKind).toBe("download-incomplete");
    // 原文照旧留着（排查要看），但前面加一句人能直接照做的
    expect(res.model?.error).toContain("还在下载中");
    expect(res.model?.error).toContain("3%");
    expect(res.model?.error).toContain("model loading error");
  });

  test("队列里已经没有任务、但磁盘上的文件没下完：照旧按「没下完」说，不去猜架构", async () => {
    FAILING.set(modelA, "0.00.058.639 E srv  llama_server: exiting due to model loading error");
    // 中断留下的现场：最终文件被预分配到完整长度（分片路径一上来就这么干），
    // 侧车记录只下了一部分 —— 而下载任务已经被取消 / 清掉了（重启后任务列表只剩活着的那些），
    // 只看队列就会把它当成「架构不认识」，把用户引去查架构、换量化（issue #16）。
    const sidecar = `${modelA}.download.json`;
    writeFileSync(modelA, Buffer.alloc(4096));
    writeFileSync(
      sidecar,
      JSON.stringify({
        url: "https://example.invalid/f",
        total: 4096,
        etag: null,
        flushed: 0,
        parts: [{ index: 0, start: 0, end: 4096, have: 1024 }],
      }),
    );
    try {
      const res = await Registry.startServedModel({ model: modelA });
      expect(res.model?.errorKind).toBe("download-incomplete");
      expect(res.model?.error).toContain("没有下完");
      // 原文照旧留着（排查要看）
      expect(res.model?.error).toContain("model loading error");
    } finally {
      rmSync(sidecar, { force: true });
      writeFileSync(modelA, "gguf");
    }
  });

  test("磁盘上文件是完整的（没有旁路数据）：不误判成没下完", async () => {
    FAILING.set(modelA, "0.00.058.639 E srv  llama_server: exiting due to model loading error");
    const res = await Registry.startServedModel({ model: modelA });
    // llama.cpp 对「没下完」和「架构不认识」说的是同一句，认不出来就老实归 unknown
    expect(res.model?.errorKind).toBe("unknown");
  });

  test("下载已经完成 / 失败的任务不算「还在下」", async () => {
    FAILING.set(modelA, "Process exited with code 1");
    DOWNLOADS.push({ fileName: "a.gguf", status: "completed", received: 100, total: 100, percent: 100 });
    expect((await Registry.startServedModel({ model: modelA })).model?.errorKind).toBe("unknown");
    await Registry.stopAllServed();

    FAILING.set(modelA, "Process exited with code 1");
    DOWNLOADS.length = 0;
    DOWNLOADS.push({ fileName: "b.gguf", status: "downloading", received: 1, total: 100, percent: 1 });
    // 下的是别的文件（同名才算），不能张冠李戴
    expect((await Registry.startServedModel({ model: modelA })).model?.errorKind).toBe("unknown");
  });
});
