import { beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * llama.cpp 运行时的命令行构造：purpose=embedding 两态快照（③-A1a）。
 *
 * 桩掉设置表 / 模型扫描 / 模型库，只测 buildArgs / buildCommandLine 自己：
 *   1. chat 实例命令行与旧版逐字节一致（聊天路径零变化）；
 *   2. embedding 实例追加 `--embeddings --pooling`、裁剪聊天采样参数、端口回落嵌入段。
 */

// 桩一律「读写同源」并尽量展开真实模块：bun 的 mock.module 是进程级共享、
// 且 ESM 绑定在首次导入时固化——getSetting 覆盖而 updateSettings 留真实（写临时
// DB）会让之后评估的 central-repo.test.ts 出现「写入丢失」假失败（读写分家）。
// 形态对齐 model-servers.test.ts 那份在全量跑里验证过的桩：同一本地 store 读写。
// 展开真实模块再覆盖（mock-hygiene.test.ts 规矩）：db/settings 新增导出后字面量替身会炸。
const SETTINGS: Record<string, string> = {};
let PORT_OVERRIDE: string | null = null;
const realSettings = await import("../db/settings");
mock.module("../db/settings", () => ({
  ...realSettings,
  getSetting: (key: string) => SETTINGS[key] ?? "",
  getNumericSetting: (key: string) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (values: Record<string, string>) => Object.assign(SETTINGS, values),
  getAllSettings: () => ({ ...SETTINGS }),
  getServerPort: (engine: string) =>
    engine === "llama.cpp" ? (SETTINGS.SERVER_PORT || "18080") : (SETTINGS.VLLM_PORT || "8081"),
  setActiveServerPortOverride: (port: string | null) => {
    PORT_OVERRIDE = port;
  },
  getActiveServerPort: () => PORT_OVERRIDE ?? SETTINGS.SERVER_PORT ?? "18080",
}));

const realModelScan = await import("../model-scan");
mock.module("../model-scan", () => ({
  ...realModelScan,
  modelNameForPath: (p: string) => p.split("/").pop() ?? p,
}));

const realModelStore = await import("../model-store");
mock.module("../model-store", () => ({
  ...realModelStore,
  slugModelFileName: (name: string) => name.replace(/\.(gguf|safetensors)$/i, "").toLowerCase(),
}));

const realStats = await import("../stats");
mock.module("../stats", () => ({
  ...realStats,
  markServerStarted: () => {},
}));

const { LlamaRuntime } = await import("./llama");

const tmpDir = mkdtempSync(join(tmpdir(), "llama-runtime-test-"));
const chatModel = join(tmpDir, "e2e-chat.gguf");
const embedModel = join(tmpDir, "wemm-emb.gguf");
writeFileSync(chatModel, "gguf");
writeFileSync(embedModel, "gguf");

/**
 * mmproj 注入场景目录：每个目录自包含（模型 + 不同投影文件组合），
 * 验证嵌入实例的自动配对与选择规则（多文件优先 f16）。
 */
function scenarioDir(name: string, files: string[]): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "gguf");
  return dir;
}

const mmprojBothDir = scenarioDir("mmproj-both", ["model.gguf", "mmproj-f16.gguf", "mmproj-bf16.gguf"]);
const mmprojBf16OnlyDir = scenarioDir("mmproj-bf16-only", ["model.gguf", "mmproj-bf16.gguf"]);
const mmprojNoneDir = scenarioDir("mmproj-none", ["model.gguf"]);

/** 与实现同一规则的二进制解析（快照断言需要完整命令行）。 */
const bin =
  ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"].find((p) => existsSync(p)) ??
  "llama-server";

function setChatSettings() {
  SETTINGS.SERVER_PORT = "18400";
  SETTINGS.SERVER_CTX_SIZE = "8192";
  SETTINGS.SERVER_IMAGE_MAX_TOKENS = "2048";
  SETTINGS.SERVER_BATCH_SIZE = "256";
  SETTINGS.SERVER_UBATCH_SIZE = "64";
  SETTINGS.SERVER_PARALLEL = "1";
  SETTINGS.SERVER_TEMP = "0.1";
  SETTINGS.SERVER_TOP_P = "0.8";
  SETTINGS.SERVER_CACHE_TYPE_K = "q8_0";
  SETTINGS.SERVER_CACHE_TYPE_V = "q8_0";
}

beforeEach(() => {
  for (const key of Object.keys(SETTINGS)) delete SETTINGS[key];
});

describe("buildCommandLine / chat", () => {
  test("chat 命令行快照：与旧版逐字节一致（聊天路径零变化，③-A2）", () => {
    setChatSettings();
    const rt = new LlamaRuntime();
    const cmd = rt.buildCommandLine(chatModel);
    expect(cmd).toBe(
      `${bin} -m ${chatModel} --alias e2e-chat --host 127.0.0.1 --port 18400 --ctx-size 8192` +
        " --image-max-tokens 2048 --parallel 1 --batch-size 256 --ubatch-size 64" +
        " --cache-type-k q8_0 --cache-type-v q8_0 --repeat-penalty 1.12 --repeat-last-n 256" +
        " --temp 0.1 --top-p 0.8 --no-mmproj-offload",
    );
  });
});

describe("buildCommandLine / embedding", () => {
  test("embedding 实例：追加 --embeddings --pooling，裁剪聊天采样参数，端口用 overrides", () => {
    setChatSettings();
    const rt = new LlamaRuntime({
      model: embedModel,
      port: "18500",
      servedName: "wemm",
      purpose: "embedding",
    });
    const cmd = rt.buildCommandLine();
    expect(cmd).toBe(
      `${bin} -m ${embedModel} --alias wemm --host 127.0.0.1 --port 18500 --ctx-size 8192` +
        " --parallel 1 --batch-size 8192 --ubatch-size 8192 --cache-type-k q8_0 --cache-type-v q8_0" +
        " --embeddings --pooling last --no-mmproj-offload",
    );
  });

  test("嵌入模式物理 batch 取 ctx-size：超过它的输入会让 llama.cpp 崩进程（KB 导入即崩的根因）", () => {
    setChatSettings();
    const mk = () => new LlamaRuntime({ model: embedModel, purpose: "embedding" }).buildCommandLine();
    // ctx 8192 → batch/ubatch 8192（不能沿用聊天调优的 256/64：--embeddings 下
    // llama.cpp 强制 n_batch = n_ubatch，512 的物理 batch 塞不下真实文档）
    const cmd = mk();
    expect(cmd).toContain("--batch-size 8192 --ubatch-size 8192");
    // ctx 调大时 batch 跟着走，不留静默上限
    SETTINGS.SERVER_CTX_SIZE = "32768";
    expect(mk()).toContain("--batch-size 32768 --ubatch-size 32768");
    // 聊天路径不受影响（仍是聊天调优的 256/64）
    expect(new LlamaRuntime({ model: chatModel, servedName: "chat" }).buildCommandLine()).toContain(
      "--batch-size 256 --ubatch-size 64",
    );
  });

  test("无 overrides.port 时端口回落 EMBEDDING_PORT（18190 段，③-A1a）", () => {
    SETTINGS.EMBEDDING_PORT = "18190";
    const rt = new LlamaRuntime({ model: embedModel, purpose: "embedding" });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain("--port 18190");
    // alias 未显式给时按文件名 slug 生成。
    expect(cmd).toContain("--alias wemm-emb");
  });

  test("pooling 跟随设置键（EMBEDDING_POOLING）", () => {
    SETTINGS.EMBEDDING_POOLING = "mean";
    const rt = new LlamaRuntime({
      model: embedModel,
      port: "18500",
      purpose: "embedding",
    });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain("--pooling mean");
    expect(cmd).not.toContain("--temp");
  });

  test("裁剪清单：--temp/--top-p/--repeat-penalty/--repeat-last-n/--image-max-tokens 都不发", () => {
    setChatSettings();
    const rt = new LlamaRuntime({ model: embedModel, port: "18500", purpose: "embedding" });
    const cmd = rt.buildCommandLine();
    for (const flag of ["--temp", "--top-p", "--repeat-penalty", "--repeat-last-n", "--image-max-tokens"]) {
      expect(cmd).not.toContain(flag);
    }
    // 保留清单：上下文 / batch / 缓存类型仍在。
    for (const flag of ["--ctx-size", "--batch-size", "--ubatch-size", "--cache-type-k", "--cache-type-v"]) {
      expect(cmd).toContain(flag);
    }
  });

  test("purpose 不传即 chat：overrides 只差端口时命令仍是聊天形态", () => {
    setChatSettings();
    const rt = new LlamaRuntime({ model: chatModel, port: "18405" });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain("--port 18405");
    expect(cmd).toContain("--temp 0.1");
    expect(cmd).not.toContain("--embeddings");
  });
});

describe("buildArgs / mmproj 注入", () => {
  /** 嵌入实例命令行：模型与投影文件同目录的场景。 */
  function embedCmd(modelPath: string): string {
    setChatSettings();
    return new LlamaRuntime({
      model: modelPath,
      port: "18500",
      purpose: "embedding",
    }).buildCommandLine();
  }

  test("同目录有 f16 + bf16 → 注入一个 --mmproj 且选 f16", () => {
    const cmd = embedCmd(join(mmprojBothDir, "model.gguf"));
    expect(cmd).toContain(`--mmproj ${join(mmprojBothDir, "mmproj-f16.gguf")}`);
    expect(cmd.split("--mmproj").length).toBe(2);
  });

  test("只有 bf16 → 选它（f16 缺席时字典序首个兜底）", () => {
    const cmd = embedCmd(join(mmprojBf16OnlyDir, "model.gguf"));
    expect(cmd).toContain(`--mmproj ${join(mmprojBf16OnlyDir, "mmproj-bf16.gguf")}`);
  });

  test("同目录无 mmproj → 不注入（行为与旧版一致）", () => {
    const cmd = embedCmd(join(mmprojNoneDir, "model.gguf"));
    expect(cmd).not.toContain("--mmproj");
  });

  test("聊天实例永不注入：同目录有投影文件也不传 --mmproj", () => {
    setChatSettings();
    const rt = new LlamaRuntime({ model: join(mmprojBothDir, "model.gguf"), port: "18406" });
    const cmd = rt.buildCommandLine();
    expect(cmd).not.toContain("--mmproj");
  });

  test("hf ref 嵌入模型（-hf 自管缓存）不注入 mmproj（Non-Goal）", () => {
    setChatSettings();
    const rt = new LlamaRuntime({
      model: "unsloth/gme-Qwen2-VL-2B-GGUF",
      port: "18500",
      purpose: "embedding",
    });
    const cmd = rt.buildCommandLine();
    expect(cmd).toContain("-hf unsloth/gme-Qwen2-VL-2B-GGUF");
    expect(cmd).not.toContain("--mmproj");
  });
});
