import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isModelWeightExt, modelDisplayName, safeRepoId } from "../shared/modelscope";

/**
 * 聊天活动状态防串（UltraQA cycle 1）：
 *
 * setActiveModel 是 LOCAL_MODEL_PATH / LOCAL_MODEL_NAME / CHAT_MODEL 三把键的写入方。
 * 嵌入 / 重排模型不是对话模型 —— 写进这三把键会顶掉真正的聊天模型（CLI 的 ● 活动
 * 标记、冷启动 auto-start 都按这三把键找目标），历史版本就因为启动嵌入模型也走
 * setActiveModel 把用户的库写脏了。
 *
 * 三层防线，本文件覆盖后两层：
 *   1. UI 不再对嵌入行调 setActiveModel（UI 层，不在本文件覆盖范围）；
 *   2. 类别守卫：嵌入 / 重排 → 拒绝且三把键一个都不写（模型库 / CLI / 控制通道通吃）；
 *   3. 自愈：老版本写脏的库，启动时清掉（healDriftedChatConfig）。
 *
 * mock 骨架沿用 model-servers.embedding.test.ts：桩掉设置 / 扫描层，model-store 本体真跑。
 * 类别全部按真实链路推导：repo meta（.vllm-meta.json）→ 文件名分类（classifyModelName）。
 */

const SETTINGS: Record<string, string> = {};
mock.module("./db/settings", () => ({
  getSetting: (key: string) => SETTINGS[key] ?? "",
  updateSettings: (values: Record<string, string>) => Object.assign(SETTINGS, values),
}));

/**
 * 扫描层桩：SCAN 决定 listInstalledModels 能看到哪些条目（= 守卫的「查列表」层）。
 * resolveRuntimeTarget 恒等：夹具都是普通单文件 GGUF，没有分片 / 仓库目录形态。
 */
let SCAN: Array<{
  repo: string;
  fileName: string;
  path: string;
  size: number;
  kind: string;
  isDir: boolean;
  runtimeTarget: string;
  origin: string;
}> = [];

mock.module("./model-scan", () => ({
  resolveRuntimeTarget: (p: string) => p,
  scanModelSources: () => SCAN,
  getScanDirs: () => [{ dir: tmpDir, origin: "managed" }],
  getExtraModelDirs: () => [],
  getHfHubCacheDir: () => join(tmpDir, "hf-hub"),
  dirModelKind: () => "other",
  modelNameForPath: (p: string) => p.split("/").pop() ?? p,
}));

// ./modelscope 是下载器所在模块，model-store 只用 4 个导出，前 3 个与 shared 同实现。
mock.module("./modelscope", () => ({
  getModelsBaseDir: () => tmpDir,
  safeRepoId,
  isModelWeightExt,
  modelDisplayName,
}));

const ModelStore = await import("./model-store");

// ---------------------------------------------------------------------------
// 真实落盘的夹具（守卫 / 自愈都先 existsSync 真文件），类别走真实推导链：
// repo meta（.vllm-meta.json）优先，没有 meta 再按文件名分类。
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "model-store-embedding-test-"));

/** 扫描条目桩的最小构造：单文件条目（非目录、managed 来源、runtimeTarget 即文件本身）。 */
function entryFor(p: string) {
  return {
    repo: "test-repo",
    fileName: p.split("/").pop() ?? p,
    path: p,
    size: 8,
    kind: "gguf",
    isDir: false,
    runtimeTarget: p,
    origin: "managed",
  };
}

// 文件名分类 → chat（classifyModelName("qwen3.5-4b.gguf") 命中 qwen 关键词）
const chatFile = join(tmpDir, "qwen3.5-4b.gguf");
// 文件名分类 → embedding / rerank
const embFile = join(tmpDir, "wemm-embedding-9b-bf16.gguf");
const rerankFile = join(tmpDir, "bge-reranker-v2-m3.gguf");
// 文件名认不出来的模型 → other（聊天口径按能用处理，守卫必须放行）
const otherFile = join(tmpDir, "mystery-model.gguf");

writeFileSync(chatFile, "gguf");
writeFileSync(embFile, "gguf");
writeFileSync(rerankFile, "gguf");
writeFileSync(otherFile, "gguf");

// repo meta 夹具：文件名像 chat，但 `.vllm-meta.json` 持久化了 embedding 类别
//（市场下载写入 / 用户在模型库里改过类别都会落在这）。
const metaRepoDir = join(tmpDir, "Org__Meta-Embed");
mkdirSync(metaRepoDir, { recursive: true });
writeFileSync(join(metaRepoDir, ".vllm-meta.json"), JSON.stringify({ category: "embedding" }));
const metaEmbFile = join(metaRepoDir, "qwen3.5-4b.gguf");
writeFileSync(metaEmbFile, "gguf");

beforeEach(() => {
  for (const key of Object.keys(SETTINGS)) delete SETTINGS[key];
  SETTINGS.INFERENCE_ENGINE = "llama.cpp";
  SCAN = [entryFor(chatFile), entryFor(embFile), entryFor(rerankFile), entryFor(otherFile), entryFor(metaEmbFile)];
});

// ---------------------------------------------------------------------------
// setActiveModel 类别守卫：嵌入 / 重排拒绝且三把键一个都不写，聊天 / other 放行。
// ---------------------------------------------------------------------------

describe("setActiveModel 类别守卫", () => {
  /** 三把聊天键都没被写过的断言（守卫拒绝 = 设置层零写入）。 */
  function expectTrioUntouched() {
    expect(SETTINGS.LOCAL_MODEL_PATH).toBeUndefined();
    expect(SETTINGS.LOCAL_MODEL_NAME).toBeUndefined();
    expect(SETTINGS.CHAT_MODEL).toBeUndefined();
  }

  test("嵌入模型（repo meta 持久化类别）拒绝：报错可读且不写三把键", () => {
    const res = ModelStore.setActiveModel(metaEmbFile);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("嵌入");
    expect(res.error).toContain("不能设为当前聊天模型");
    expectTrioUntouched();
  });

  test("嵌入模型（不在安装列表，按文件名分类兜底）拒绝", () => {
    // 列表里没有 embFile：categoryOfModelPath 退回 classifyModelName(文件名)。
    SCAN = [entryFor(chatFile), entryFor(otherFile), entryFor(metaEmbFile)];
    const res = ModelStore.setActiveModel(embFile);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("嵌入");
    expectTrioUntouched();
  });

  test("重排模型拒绝", () => {
    const res = ModelStore.setActiveModel(rerankFile);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("重排");
    expectTrioUntouched();
  });

  test("聊天模型放行：三把键正常写入（LOCAL_MODEL_PATH = 运行时目标）", () => {
    const res = ModelStore.setActiveModel(chatFile);
    expect(res.ok).toBe(true);
    expect(SETTINGS.LOCAL_MODEL_PATH).toBe(chatFile);
    expect(SETTINGS.LOCAL_MODEL_NAME).toBe("qwen3.5-4b");
    expect(SETTINGS.CHAT_MODEL).toBe("qwen3.5-4b");
  });

  test("other（认不出类别）放行：零行为变化", () => {
    const res = ModelStore.setActiveModel(otherFile);
    expect(res.ok).toBe(true);
    expect(SETTINGS.LOCAL_MODEL_PATH).toBe(otherFile);
    expect(SETTINGS.CHAT_MODEL).toBe("mystery-model");
  });
});

// ---------------------------------------------------------------------------
// healDriftedChatConfig 启动自愈：只有「LOCAL_MODEL_PATH 指向嵌入模型」这一种脏
// 状态会清三把键（保守起见不含重排），聊天 / 空路径一律不动。
// ---------------------------------------------------------------------------

describe("healDriftedChatConfig 启动自愈", () => {
  test("聊天配置指向嵌入模型（列表条目）：清空三把键并返回 healed", () => {
    SETTINGS.LOCAL_MODEL_PATH = embFile;
    const res = ModelStore.healDriftedChatConfig();
    expect(res.healed).toBe(true);
    expect(res.path).toBe(embFile);
    expect(SETTINGS.LOCAL_MODEL_PATH).toBe("");
    expect(SETTINGS.LOCAL_MODEL_NAME).toBe("");
    expect(SETTINGS.CHAT_MODEL).toBe("");
  });

  test("聊天配置指向嵌入模型（文件已删 / 不在列表，按文件名兜底）：同样清空", () => {
    SCAN = [entryFor(chatFile)];
    SETTINGS.LOCAL_MODEL_PATH = embFile;
    const res = ModelStore.healDriftedChatConfig();
    expect(res.healed).toBe(true);
    expect(SETTINGS.LOCAL_MODEL_PATH).toBe("");
    expect(SETTINGS.LOCAL_MODEL_NAME).toBe("");
    expect(SETTINGS.CHAT_MODEL).toBe("");
  });

  test("聊天配置指向聊天模型：不动（healed=false，三把键原样）", () => {
    SETTINGS.LOCAL_MODEL_PATH = chatFile;
    SETTINGS.LOCAL_MODEL_NAME = "qwen3.5-4b";
    SETTINGS.CHAT_MODEL = "qwen3.5-4b";
    const res = ModelStore.healDriftedChatConfig();
    expect(res.healed).toBe(false);
    expect(SETTINGS.LOCAL_MODEL_PATH).toBe(chatFile);
    expect(SETTINGS.CHAT_MODEL).toBe("qwen3.5-4b");
  });

  test("路径为空：不动", () => {
    SETTINGS.LOCAL_MODEL_PATH = "";
    const res = ModelStore.healDriftedChatConfig();
    expect(res.healed).toBe(false);
    expect(SETTINGS.CHAT_MODEL).toBeUndefined();
  });
});
