import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isModelWeightExt, modelDisplayName, safeRepoId } from "../shared/modelscope";

/**
 * 「没下完的文件不能被当成已安装模型」（issue #16）。
 *
 * 分片下载一上来就把最终文件**预分配到完整长度**（`preallocate`，定位写不留空洞的前提），
 * 所以下到一半的文件在资源管理器 / 模型库里看**尺寸完全正确**、却是花屏内容 ——
 * 报告者那句「模型大小没有问题」就是这么来的。它一旦出现在「已下载」里，
 * 用户能做的只有点「运行」，然后拿到 llama.cpp 一句笼统的 `exiting due to model loading error`，
 * 而市场页又因为文件名在列表里而显示「已下载」，连「重新下载」这条路都被堵住。
 *
 * 判据只有旁路数据知道（sidecar 的 flushed + 分片 have），所以过滤必须走下载器那份状态，
 * 不能看尺寸。
 *
 * 真测试体：model-store 会被 chat-model / gateway / download-manager 等测试桩掉，
 * 批次里直接 import 拿到的是别人的假模块，因此套子进程（同 model-store.embedding.tests.ts）。
 */

mock.module("./db/settings", () => ({
  getSetting: () => "",
  updateSettings: () => {},
}));

const tmpDir = mkdtempSync(join(tmpdir(), "model-store-partial-"));

/** 扫描条目桩（真实扫描层被桩掉，本文件只验证「列表怎么处理这些条目」）。 */
function entryFor(p: string) {
  const size = 1024;
  return {
    repo: "test-repo",
    fileName: p.split("/").pop() ?? p,
    path: p,
    size,
    kind: "gguf",
    isDir: false,
    runtimeTarget: p,
    origin: "managed",
  };
}

// —— 半成品：预分配到完整大小 + sidecar 说只下了 1/4 ——
const PARTIAL_TOTAL = 4 * 1024 * 1024;
const partialPath = join(tmpDir, "half-downloaded.gguf");
writeFileSync(partialPath, Buffer.alloc(PARTIAL_TOTAL));
writeFileSync(
  `${partialPath}.download.json`,
  JSON.stringify({
    url: "https://example.invalid/f",
    total: PARTIAL_TOTAL,
    etag: null,
    flushed: 0,
    parts: [{ index: 0, start: 0, end: PARTIAL_TOTAL, have: Math.floor(PARTIAL_TOTAL / 4) }],
  }),
);

// —— 下完的文件：没有旁路数据 ——
const completePath = join(tmpDir, "ready.gguf");
writeFileSync(completePath, Buffer.alloc(1024, 1));

// —— 下完那一刻崩溃：sidecar 还没来得及删，但字节其实齐了 ——
const stalePath = join(tmpDir, "stale-sidecar.gguf");
const STALE_TOTAL = 2048;
writeFileSync(stalePath, Buffer.alloc(STALE_TOTAL, 2));
writeFileSync(
  `${stalePath}.download.json`,
  JSON.stringify({
    url: "https://example.invalid/f",
    total: STALE_TOTAL,
    etag: null,
    flushed: STALE_TOTAL,
    parts: [{ index: 0, start: 0, end: STALE_TOTAL, have: STALE_TOTAL }],
  }),
);

mock.module("./model-scan", () => ({
  resolveRuntimeTarget: (p: string) => p,
  scanModelSources: () => [entryFor(partialPath), entryFor(completePath), entryFor(stalePath)],
  getScanDirs: () => [{ dir: tmpDir, origin: "managed" }],
  getExtraModelDirs: () => [],
  getHfHubCacheDir: () => join(tmpDir, "hf-hub"),
  dirModelKind: () => "other",
  modelNameForPath: (p: string) => p.split("/").pop() ?? p,
}));

mock.module("./modelscope", () => ({
  getModelsBaseDir: () => tmpDir,
  safeRepoId,
  isModelWeightExt,
  modelDisplayName,
}));

const ModelStore = await import("./model-store");

describe("listInstalledModels / 半成品过滤", () => {
  const names = () => ModelStore.listInstalledModels().map((m) => m.fileName);

  test("还在下载中的文件（尺寸早已是完整大小）不出现在「已下载」里", () => {
    expect(names()).not.toContain("half-downloaded.gguf");
  });

  test("下完的文件照常出现（别把过滤做成一刀切）", () => {
    expect(names()).toContain("ready.gguf");
  });

  test("崩溃残留的陈旧 sidecar、但字节其实齐了：照常出现", () => {
    expect(names()).toContain("stale-sidecar.gguf");
  });
});
