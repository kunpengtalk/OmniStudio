import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MODEL_CATEGORIES, safeRepoId } from "../shared/modelscope";

/**
 * 嵌入实例的活动状态隔离（③-A4）：
 *
 * 嵌入实例走 18190 端口段、启动参数带 --embeddings（经 RuntimeOverrides.purpose），
 * 且**永不**触碰聊天活动状态 —— 启动 / 停止 / 多实例的任何组合下，
 * SERVED_ACTIVE_ID / CHAT_MODEL / LOCAL_MODEL_PATH / 聊天活动端口都只跟 chat 实例走。
 * mock 骨架沿用 model-servers.test.ts（桩掉设置 / 运行时 / 模型库）。
 */

const SETTINGS: Record<string, string> = {};
// 展开真实模块再覆盖（见 test-mocks.ts / mock-hygiene.test.ts）：字面量替身会在
// db/settings 新增导出（ensureSettingsEncrypted 等）后于 import 阶段直接报缺导出。
const realSettings = await import("./db/settings");
mock.module("./db/settings", () => ({
  ...realSettings,
  getSetting: (key: string) => SETTINGS[key] ?? "",
  getNumericSetting: (key: string) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values: Record<string, string>) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getServerPort: (engine: string) =>
    engine === "llama.cpp" ? (SETTINGS.SERVER_PORT || "8080") : (SETTINGS.VLLM_PORT || "8081"),
  getActiveServerPort: () => SETTINGS.SERVER_PORT || "8080",
  setActiveServerPortOverride: (port: string | null) => {
    PORT_OVERRIDE = port;
  },
}));

let PORT_OVERRIDE: string | null = null;

/** 假的 runtime：记录被启动 / 停止，能手动推状态与日志（沿用 model-servers.test.ts）。 */
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
const realRuntimes = await import("./runtimes");
mock.module("./runtimes", () => ({
  ...realRuntimes,
  createRuntime: (
    _engine: string,
    overrides?: Record<string, string | undefined>,
  ) => {
    const runtime = new FakeRuntime(overrides);
    created.push(runtime);
    return runtime;
  },
}));

const realMlx = await import("./runtimes/mlx");
mock.module("./runtimes/mlx", () => ({
  ...realMlx,
  mlxRequestModelId: (target: string) => `/abs/${target}`,
  isMlxActive: () => SETTINGS.INFERENCE_ENGINE === "mlx",
  resolveMlxModel: () => ({ model: "", requestModelId: "" }),
}));

/** 模型库可配置桩：category 决定 purpose（startServedModel 从这读）。 */
let INSTALLED: Array<{
  runtimeTarget: string;
  path: string;
  category: string;
  repo?: string;
  size?: number;
  /** C.10 类别改键用：来源位置（managed = 应用下载目录，才允许改类别）。 */
  origin?: string;
  isDir?: boolean;
}> = [];

const realModelStore = await import("./model-store");
mock.module("./model-store", () => ({
  ...realModelStore,
  listInstalledModels: () =>
    INSTALLED.map((entry) => ({
      ...entry,
      // 与真实 model-store 一致：仓库 meta 的类别优先于条目的基础类别（③-C2 回读链路）
      category: (entry.repo ? readMetaOf(join(tmpDir, entry.repo))?.category : null) ?? entry.category,
    })),
  servedNameForModelPath: (path: string) =>
    (path.split("/").pop() ?? path).replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
  slugModelFileName: (name: string) => name.replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
  // C.10 类别改键：镜像真实 setModelMeta 的契约（VALID_CATEGORIES 校验 + 按仓库目录
  // 落盘 `.vllm-meta.json`），落盘失败静默吞掉 —— 由 updateModelCategory 的回读兜底报错。
  setModelMeta: (repo: string, patch: { category?: string; source?: string }) => {
    const repoDir = join(tmpDir, safeRepoId(repo));
    try {
      let meta: { category?: string; source?: string } = readMetaOf(repoDir) ?? {};
      const valid = MODEL_CATEGORIES.filter((c) => c.value !== "all").map((c) => c.value);
      if (patch.category && (valid as string[]).includes(patch.category)) meta.category = patch.category;
      if (patch.source && ["modelscope", "huggingface"].includes(patch.source)) meta.source = patch.source;
      writeFileSync(join(repoDir, ".vllm-meta.json"), JSON.stringify(meta, null, 2));
    } catch {
      // ignore —— 与真实实现一致
    }
  },
}));

const Registry = await import("./model-servers");
const { resolveEmbeddingBase } = await import("./embeddings");
// C.11 KB 嵌入选择器与 C.10 类别改键
const Knowledge = await import("./knowledge");
const Category = await import("./model-category");
// model-store 桩（listInstalledModels 从仓库 meta 推导 category，C.10 回读链路用）
const ModelStore = await import("./model-store");

const tmpDir = mkdtempSync(join(tmpdir(), "model-servers-embedding-test-"));
const modelA = join(tmpDir, "a.gguf");
const modelE1 = join(tmpDir, "wemm1.gguf");
const modelE2 = join(tmpDir, "wemm2.gguf");
writeFileSync(modelA, "gguf");
writeFileSync(modelE1, "gguf");
writeFileSync(modelE2, "gguf");

/** 读仓库目录的 `.vllm-meta.json`（镜像 model-store 的 meta 读取契约）。 */
function readMetaOf(repoDir: string): { category?: string; source?: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(repoDir, ".vllm-meta.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 给已启动实例的端口挂一个 /v1/models 上游（FakeRuntime 不会真的监听端口）。
 *  C.11 选择器测试用它冒充运行中的嵌入 / 聊天实例的模型清单。 */
const upstreams: Array<{ stop: (closeAll: boolean) => void }> = [];
function serveModels(port: number, ids: string[]) {
  const server = Bun.serve({
    port,
    fetch: () => Response.json({ data: ids.map((id) => ({ id })) }),
  });
  upstreams.push(server);
  return server;
}

function setInstalled() {
  INSTALLED = [
    { runtimeTarget: modelA, path: modelA, category: "chat" },
    { runtimeTarget: modelE1, path: modelE1, category: "embedding" },
    { runtimeTarget: modelE2, path: modelE2, category: "embedding" },
  ];
}

beforeEach(() => {
  for (const key of Object.keys(SETTINGS)) delete SETTINGS[key];
  SETTINGS.INFERENCE_ENGINE = "llama.cpp";
  SETTINGS.SERVER_PORT = "18400";
  SETTINGS.VLLM_PORT = "18401";
  // 夹具用 18990 而非默认 18190:测试做真实端口探测,默认段会被正在运行的应用
  // (比如用户起着的嵌入实例)占住,导致分配器顺延、精确断言变 flaky。
  SETTINGS.EMBEDDING_PORT = "18990";
  PORT_OVERRIDE = null;
  created = [];
  setInstalled();
  return Registry.stopAllServed();
});

afterEach(async () => {
  for (const server of upstreams) server.stop(true);
  upstreams.length = 0;
  await Registry.stopAllServed();
});

describe("嵌入实例的活动状态隔离", () => {
  test("聊天运行中启动嵌入模型：活动状态 / 端口覆盖 / 请求目标全部不变，嵌入端口段生效（③-A4）", async () => {
    const chat = await Registry.startServedModel({ model: modelA });
    expect(chat.ok).toBe(true);
    expect(chat.model?.purpose).toBe("chat");
    expect(chat.model?.port).toBe(18400);
    expect(SETTINGS.SERVED_ACTIVE_ID).toBe(chat.model!.id);
    expect(SETTINGS.CHAT_MODEL).toBe("a");
    expect(SETTINGS.LOCAL_MODEL_PATH).toBe(modelA);
    expect(PORT_OVERRIDE).toBe("18400");

    const emb = await Registry.startServedModel({ model: modelE1 });
    expect(emb.ok).toBe(true);
    expect(emb.model?.purpose).toBe("embedding");
    expect(emb.model?.port).toBe(18990);
    expect(emb.model?.usesDefaultPort).toBe(true);
    expect(SETTINGS.SERVED_ACTIVE_ID).toBe(chat.model!.id);
    expect(SETTINGS.CHAT_MODEL).toBe("a");
    expect(SETTINGS.LOCAL_MODEL_PATH).toBe(modelA);
    expect(PORT_OVERRIDE).toBe("18400");
    expect(Registry.getActiveServedId()).toBe(chat.model!.id);
    expect(Registry.getRequestTargetServedModel()?.id).toBe(chat.model!.id);
    expect(Registry.getActiveEmbeddingPort()).toBe(18990);
    expect(Registry.resolveEmbeddingBackend()).toBe("http://127.0.0.1:18990");
    const embRuntime = created.find((r) => r.overrides.model === modelE1);
    expect(embRuntime?.overrides.purpose).toBe("embedding");
    const chatRuntime = created.find((r) => r.overrides.model === modelA);
    expect(chatRuntime?.overrides.purpose).toBe("chat");
  });

  test("停止聊天模型不把嵌入实例 auto-promote（③-A4）", async () => {
    const chat = await Registry.startServedModel({ model: modelA });
    await Registry.startServedModel({ model: modelE1 });
    await Registry.stopServedModel(chat.model!.id);
    expect(SETTINGS.SERVED_ACTIVE_ID ?? "").toBe("");
    expect(Registry.getActiveServedId()).toBeNull();
    // 只剩嵌入实例在跑：聊天请求目标必须是 undefined（不是 promote 嵌入实例）。
    expect(Registry.getRequestTargetServedModel()).toBeUndefined();
    expect(Registry.getActiveEmbeddingPort()).toBe(18990);
    expect(Registry.resolveEmbeddingBackend()).toBe("http://127.0.0.1:18990");
  });

  test("多嵌入实例最近启动胜：新实例接管嵌入后端，停掉后回落旧实例", async () => {
    const e1 = await Registry.startServedModel({ model: modelE1 });
    expect(e1.model?.port).toBe(18990);
    expect(Registry.getActiveEmbeddingPort()).toBe(18990);
    expect(Registry.resolveEmbeddingBackend()).toBe("http://127.0.0.1:18990");

    const e2 = await Registry.startServedModel({ model: modelE2 });
    expect(e2.model?.port).toBe(18991);
    expect(Registry.getActiveEmbeddingPort()).toBe(18991);
    expect(Registry.resolveEmbeddingBackend()).toBe("http://127.0.0.1:18991");
    // 没有聊天实例：聊天端口覆盖保持空。
    expect(PORT_OVERRIDE).toBeNull();

    await Registry.stopServedModel(e2.model!.id);
    expect(Registry.getActiveEmbeddingPort()).toBe(18990);
    expect(Registry.resolveEmbeddingBackend()).toBe("http://127.0.0.1:18990");
  });

  test("setActiveServedId 拒绝嵌入实例，不写任何聊天设置", async () => {
    const emb = await Registry.startServedModel({ model: modelE1 });
    const res = Registry.setActiveServedId(emb.model!.id);
    expect(res.ok).toBe(false);
    expect(SETTINGS.SERVED_ACTIVE_ID ?? "").toBe("");
    expect(SETTINGS.CHAT_MODEL).toBeUndefined();
  });

  test("只跑聊天实例时嵌入后端为 null（purpose 过滤生效）", async () => {
    await Registry.startServedModel({ model: modelA });
    expect(Registry.resolveEmbeddingBackend()).toBeNull();
    expect(Registry.getActiveEmbeddingPort()).toBeNull();
  });

  test("嵌入实例幂等重启（显式 makeActive）也不接管聊天活动状态", async () => {
    const emb = await Registry.startServedModel({ model: modelE1 });
    const again = await Registry.startServedModel({ model: modelE1, makeActive: true });
    expect(again.ok).toBe(true);
    expect(again.model?.id).toBe(emb.model!.id);
    expect(SETTINGS.SERVED_ACTIVE_ID ?? "").toBe("");
    expect(Registry.getActiveServedId()).toBeNull();
  });
});

describe("resolveEmbeddingBase 四层链（③-A3）", () => {
  test("显式 base 胜出：即使有运行实例 + remote 也用它（剥 /v1 与尾斜杠）", async () => {
    SETTINGS.SERVER_MODE = "remote";
    SETTINGS.VLLM_API_BASE = "https://cloud.example/v1";
    await Registry.startServedModel({ model: modelE1 });
    expect(resolveEmbeddingBase({ embeddingBase: "https://api.example.com/v1/" })).toBe(
      "https://api.example.com",
    );
  });

  test("无显式 base + 有运行实例 → 实例端口（实例 > remote）", async () => {
    SETTINGS.SERVER_MODE = "remote";
    SETTINGS.VLLM_API_BASE = "https://cloud.example/v1";
    await Registry.startServedModel({ model: modelE1 });
    expect(resolveEmbeddingBase({ embeddingBase: "" })).toBe("http://127.0.0.1:18990");
  });

  test("无实例 + SERVER_MODE=remote → VLLM_API_BASE（剥 /v1）", async () => {
    SETTINGS.SERVER_MODE = "remote";
    SETTINGS.VLLM_API_BASE = "https://cloud.example/v1";
    expect(resolveEmbeddingBase({ embeddingBase: "" })).toBe("https://cloud.example");
  });

  test("无实例非 remote → 聊天活动端口兜底（与今日行为一致）", async () => {
    expect(resolveEmbeddingBase({ embeddingBase: "" })).toBe("http://127.0.0.1:18400");
  });
});

// ---------------------------------------------------------------------------
// C.11 KB 嵌入选择器（③-C3）：本地组只认运行中的嵌入实例
// ---------------------------------------------------------------------------

describe("suggestEmbeddingModels 两态（③-C3）", () => {
  test("无嵌入实例（本地模式）：本地组为空 + hint 引导，service.base 如实留空", async () => {
    const res = await Knowledge.suggestEmbeddingModels();
    expect(res.local).toEqual([]);
    expect(res.service.kind).toBe("local");
    expect(res.service.base).toBe("");
    expect(res.hint).toBe("kb.settings.noEmbeddingServer");
    expect(res.relaxed).toBe(false);
  });

  test("聊天实例在跑但没有嵌入实例：chat 模型不再混进嵌入候选（③-C3 陷阱）", async () => {
    const chat = await Registry.startServedModel({ model: modelA });
    expect(chat.ok).toBe(true);
    serveModels(chat.model!.port, ["qwen3.5-chat"]);

    const res = await Knowledge.suggestEmbeddingModels();
    expect(res.local).toEqual([]);
    expect(res.hint).toBe("kb.settings.noEmbeddingServer");

    // 重排候选沿用原链路（聊天端口上的模型照列，认不出就 relaxed 全量）
    const rerank = await Knowledge.suggestRerankModels();
    expect(rerank.local).toEqual(["qwen3.5-chat"]);
    expect(rerank.relaxed).toBe(true);
  });

  test("有嵌入实例：本地组列出该实例 /v1/models，service.base 指向实例，无 hint", async () => {
    const emb = await Registry.startServedModel({ model: modelE1 });
    expect(emb.ok).toBe(true);
    serveModels(emb.model!.port, ["wemm-embedding"]);

    const res = await Knowledge.suggestEmbeddingModels();
    expect(res.local).toEqual(["wemm-embedding"]);
    expect(res.service.kind).toBe("local");
    expect(res.service.base).toBe(`http://127.0.0.1:${emb.model!.port}`);
    expect(res.hint).toBeUndefined();

    // 嵌入实例跑着的时候，重排候选同样从该实例拉（地址解析规则与真实请求一致）
    const rerank = await Knowledge.suggestRerankModels();
    expect(rerank.local).toEqual(["wemm-embedding"]);
    expect(rerank.service.base).toBe(`http://127.0.0.1:${emb.model!.port}`);
  });

  test("实例返回混合清单：嵌入选择器只留嵌入模型，不再 relaxed 全量", async () => {
    const emb = await Registry.startServedModel({ model: modelE1 });
    expect(emb.ok).toBe(true);
    serveModels(emb.model!.port, ["wemm-embedding", "qwen3.5-chat"]);

    const res = await Knowledge.suggestEmbeddingModels();
    expect(res.local).toEqual(["wemm-embedding"]);
    expect(res.relaxed).toBe(false);
    expect(res.hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C.10 类别改键（③-C2）：updateModelCategory 编排（查找 → managed 守卫 →
// setModelMeta 落盘 → 安装列表回读）。meta 文件落盘是真实的（走 setModelMeta 桩）。
// ---------------------------------------------------------------------------

describe("updateModelCategory 类别改键往返（③-C2）", () => {
  /** 在桩的下载目录里造一个 managed 单文件条目（market 下载的 GGUF 形态）。 */
  function makeManagedGguf(repoId: string, fileName: string, baseCategory: string): string {
    const repoDir = join(tmpDir, repoId);
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, fileName), "gguf");
    INSTALLED.push({ runtimeTarget: join(repoDir, fileName), path: join(repoDir, fileName), category: baseCategory, repo: repoId, origin: "managed" });
    return join(repoDir, fileName);
  }

  test("managed 模型改类别：meta 落盘 + 回读生效（重启后按新类别启动）", () => {
    const repoId = "Org__Wemm-Embedding";
    const repoDir = join(tmpDir, repoId);
    mkdirSync(repoDir, { recursive: true });
    // 预置 meta：存量模型被误分类为 chat 的形态
    writeFileSync(join(repoDir, ".vllm-meta.json"), JSON.stringify({ category: "chat" }));
    const modelPath = join(repoDir, "wemm-q4.gguf");
    writeFileSync(modelPath, "gguf");
    INSTALLED.push({ runtimeTarget: modelPath, path: modelPath, category: "chat", repo: repoId, origin: "managed" });

    const res = Category.updateModelCategory(modelPath, "embedding");
    expect(res.ok).toBe(true);
    expect(res.model?.category).toBe("embedding");
    // meta 文件真的被改写
    expect(readMetaOf(repoDir)?.category).toBe("embedding");
  });

  test("整仓库条目（目录）改类别同样生效", () => {
    const repoId = "Bge__Bge-M3";
    const repoDir = join(tmpDir, repoId);
    mkdirSync(repoDir, { recursive: true });
    const path = repoDir;
    INSTALLED.push({ runtimeTarget: path, path, category: "embedding", repo: repoId, origin: "managed", isDir: true });

    const res = Category.updateModelCategory(path, "rerank");
    expect(res.ok).toBe(true);
    expect(res.model?.category).toBe("rerank");
    expect(readMetaOf(repoDir)?.category).toBe("rerank");
  });

  test("同一仓库的多个条目共享 meta：改一个全部生效", () => {
    const repoId = "Org__Wemm-Embedding";
    const first = makeManagedGguf(repoId, "wemm-q4.gguf", "chat");
    const second = makeManagedGguf(repoId, "wemm-f16.gguf", "chat");

    const res = Category.updateModelCategory(first, "embedding");
    expect(res.ok).toBe(true);
    // 回读走安装列表桩（category 从仓库 meta 推导），同仓库的另一个条目同步拿到新类别
    const relisted = ModelStore.listInstalledModels().find((m: { path: string }) => m.path === second);
    expect(relisted?.category).toBe("embedding");
  });

  test("外部目录（external）模型拒绝改类别", () => {
    const repoId = "Sub__Org__Local-Model";
    const otherPath = join(tmpdir(), `not-under-base-${process.pid}`, "local.gguf");
    INSTALLED.push({ runtimeTarget: otherPath, path: otherPath, category: "chat", repo: repoId, origin: "external" });

    const res = Category.updateModelCategory(otherPath, "embedding");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("仅市场下载");
  });

  test("列表里不存在的路径返回明确错误", () => {
    const res = Category.updateModelCategory(join(tmpdir(), "omni-not-exist.gguf"), "chat");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("未找到该模型");
  });

  test("非法类别不会写脏 meta（setModelMeta 校验 + 回读兜底）", () => {
    const repoId = "Org__Wemm-Embedding";
    const modelPath = makeManagedGguf(repoId, "wemm-q4.gguf", "chat");
    // "all" 不是合法类别（类型层已挡，这里用 cast 模拟脏输入）
    const res = Category.updateModelCategory(modelPath, "all" as never);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("类别修改未生效");
  });
});

describe("引擎能力守卫（验证评审 MED 修复）", () => {
  test("embedding 类别 + 不支持嵌入的引擎 → 拒绝启动且报错可读，不创建实例", async () => {
    // 引擎由模型格式解析（GGUF 恒回 llama.cpp），safetensors → vLLM 才能触发守卫
    const modelSt = join(tmpDir, "wemm-st.safetensors");
    writeFileSync(modelSt, "safetensors");
    INSTALLED = [
      { runtimeTarget: modelSt, path: modelSt, category: "embedding" },
    ];
    const res = await Registry.startServedModel({ model: modelSt });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("vllm");
    expect(res.error).toContain("嵌入");
    // 守卫必须在 allocatePort / createRuntime 之前生效：不留半成品实例
    expect(created.length).toBe(0);
  });

  test("embedding 类别 + llama.cpp → 正常放行（守卫不误伤）", async () => {
    const res = await Registry.startServedModel({ model: modelE1 });
    expect(res.ok).toBe(true);
    expect(res.model?.purpose).toBe("embedding");
  });
});
