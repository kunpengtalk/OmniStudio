import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  addModelDir,
  getExtraModelDirs,
  getHfHubCacheDir,
  previewModelDir,
  removeModelDir,
  resolveRuntimeTarget,
  scanHfCache,
  scanPlainDir,
  validateModelDir,
} from "../src/bun/model-scan";
import { deleteLocalModel, listInstalledModels } from "../src/bun/model-store";
import { getModelsBaseDir } from "../src/bun/modelscope";

// 每个用例一个临时目录，避免互相干扰（数据目录由 test-preload 隔离）。
function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `omni-scan-${prefix}-`));
}

function file(p: string, contents = "x"): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, contents);
}

// ---------------------------------------------------------------------------
// 运行时加载目标：目录型仓库要整目录加载，GGUF 是单文件
// ---------------------------------------------------------------------------

describe("resolveRuntimeTarget", () => {
  test("keeps .gguf as a file even inside a repo directory", () => {
    const dir = tempDir("target-gguf");
    file(path.join(dir, "config.json"), "{}");
    file(path.join(dir, "model-Q4_K_M.gguf"), "gguf");
    expect(resolveRuntimeTarget(path.join(dir, "model-Q4_K_M.gguf"))).toBe(
      path.join(dir, "model-Q4_K_M.gguf"),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves sharded safetensors to its repository directory", () => {
    const dir = tempDir("target-st");
    file(path.join(dir, "config.json"), "{}");
    file(path.join(dir, "model-00001-of-00002.safetensors"), "st");
    // vLLM / SGLang 加载的是目录，单个分片文件是加载不了的
    expect(resolveRuntimeTarget(path.join(dir, "model-00001-of-00002.safetensors"))).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps a lone safetensors file when there is no config.json", () => {
    const dir = tempDir("target-lone");
    file(path.join(dir, "weights.safetensors"), "st");
    expect(resolveRuntimeTarget(path.join(dir, "weights.safetensors"))).toBe(
      path.join(dir, "weights.safetensors"),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("passes directories through", () => {
    const dir = tempDir("target-dir");
    file(path.join(dir, "model.safetensors"), "st");
    expect(resolveRuntimeTarget(dir)).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 普通目录扫描：任意结构都要能认出来
// ---------------------------------------------------------------------------

describe("scanPlainDir", () => {
  test("finds models at any depth and directly in the root", () => {
    const root = tempDir("plain");
    file(path.join(root, "root-model.gguf"), "a");
    file(path.join(root, "Qwen3-8B", "model-Q4_K_M.gguf"), "b");
    file(path.join(root, "vendor", "nested", "deep", "model.safetensors"), "c");
    file(path.join(root, "README.md"), "not a model");
    file(path.join(root, ".git", "config"), "ignored");

    const models = scanPlainDir(root, "external");
    const names = models.map((m) => `${m.repo}/${m.fileName}`).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual([
      `${path.basename(root)}/root-model.gguf`,
      "Qwen3-8B/model-Q4_K_M.gguf",
      "vendor/nested/deep/model.safetensors",
    ].sort((a, b) => a.localeCompare(b)));
    expect(models.every((m) => m.origin === "external")).toBe(true);
    expect(models.find((m) => m.fileName.endsWith(".safetensors"))?.kind).toBe("safetensors");
    rmSync(root, { recursive: true, force: true });
  });

  test("follows symlinked weight files (HF-style links)", () => {
    const root = tempDir("plain-link");
    file(path.join(root, "blobs", "abc123"), "payload");
    mkdirSync(path.join(root, "Qwen3-4B"), { recursive: true });
    symlinkSync(
      path.join(root, "blobs", "abc123"),
      path.join(root, "Qwen3-4B", "model.gguf"),
    );
    const models = scanPlainDir(root, "managed");
    expect(models.map((m) => m.fileName)).toEqual(["model.gguf"]);
    expect(models[0]!.size).toBe("payload".length);
    // blobs 目录里的无扩展名文件不会被当成模型
    expect(models.every((m) => m.fileName !== "abc123")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("ignores non-weight files only", () => {
    const root = tempDir("plain-other");
    file(path.join(root, "repo", "tokenizer.json"), "{}");
    file(path.join(root, "repo", "pytorch_model.bin"), "bin");
    const models = scanPlainDir(root, "external");
    expect(models.map((m) => m.fileName)).toEqual(["pytorch_model.bin"]);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Hugging Face 缓存：一个仓库聚合成一行
// ---------------------------------------------------------------------------

describe("scanHfCache", () => {
  test("groups a cached repo into one row with the real weight size", () => {
    const hub = tempDir("hfcache");
    const repoDir = path.join(hub, "models--org--Model-MLX-4bit");
    const snapshots = path.join(repoDir, "snapshots");
    const rev = path.join(snapshots, "abc123def");
    file(path.join(repoDir, "blobs", "w1"), "0123456789");
    file(path.join(repoDir, "blobs", "w2"), "01234");
    file(path.join(snapshots, "abc123def", "config.json"), "{}");
    symlinkSync(path.join(repoDir, "blobs", "w1"), path.join(rev, "model.safetensors"));
    symlinkSync(path.join(repoDir, "blobs", "w2"), path.join(rev, "vae.safetensors"));

    const models = scanHfCache(hub);
    expect(models).toHaveLength(1);
    const m = models[0]!;
    expect(m.repo).toBe("org/Model-MLX-4bit");
    expect(m.fileName).toBe("Model-MLX-4bit");
    expect(m.isDir).toBe(true);
    expect(m.source).toBe("huggingface");
    expect(m.kind).toBe("safetensors");
    expect(m.path).toBe(rev);
    expect(m.size).toBe(15);
    rmSync(hub, { recursive: true, force: true });
  });

  test("picks the revision that actually has weights and skips empty entries", () => {
    const hub = tempDir("hfcache-revs");
    const repoDir = path.join(hub, "models--org--Model-GGUF");
    file(path.join(repoDir, "blobs", "small"), "small");
    file(path.join(repoDir, "blobs", "large"), "0123456789abc");
    // 旧 revision 只有残缺的 .incomplete，新 revision 才是完整的
    file(path.join(repoDir, "snapshots", "old", "model.gguf.incomplete"), "junk");
    mkdirSync(path.join(repoDir, "snapshots", "new"), { recursive: true });
    symlinkSync(
      path.join(repoDir, "blobs", "large"),
      path.join(repoDir, "snapshots", "new", "model-Q4_K_M.gguf"),
    );
    // 没有 snapshot 的缓存条目直接跳过
    mkdirSync(path.join(hub, "models--org--Broken", "blobs"), { recursive: true });

    const models = scanHfCache(hub);
    expect(models.map((m) => m.repo)).toEqual(["org/Model-GGUF"]);
    expect(models[0]!.kind).toBe("gguf");
    expect(models[0]!.size).toBe(13);
    rmSync(hub, { recursive: true, force: true });
  });

  test("hub dir honours HUGGINGFACE_HUB_CACHE", () => {
    const prev = process.env.HUGGINGFACE_HUB_CACHE;
    process.env.HUGGINGFACE_HUB_CACHE = "/tmp/custom-hf-hub";
    expect(getHfHubCacheDir()).toBe("/tmp/custom-hf-hub");
    if (prev === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
    else process.env.HUGGINGFACE_HUB_CACHE = prev;
  });
});

// ---------------------------------------------------------------------------
// 目录管理：校验 + 添加 / 移除
// ---------------------------------------------------------------------------

describe("model dir management", () => {
  test("rejects missing dirs, the app download dir and duplicates", () => {
    expect(validateModelDir("/definitely/not/here").ok).toBe(false);
    expect(validateModelDir(getModelsBaseDir()).ok).toBe(false);
  });

  test("preview + add writes MODEL_DIRS and counts models", () => {
    const dir = tempDir("add");
    const before = getExtraModelDirs();
    try {
      expect(addModelDir(dir).ok).toBe(false); // 空目录：认不出模型就不加
      file(path.join(dir, "Qwen3-4B", "model.gguf"), "gguf");
      const preview = previewModelDir(dir);
      expect(preview.ok).toBe(true);
      expect(preview.count).toBe(1);
      const res = addModelDir(dir);
      expect(res.ok).toBe(true);
      expect(res.count).toBe(1);
      expect(getExtraModelDirs()).toContain(dir);
      // 重复添加被拒
      expect(addModelDir(dir).ok).toBe(false);
      expect(removeModelDir(dir).ok).toBe(true);
      expect(getExtraModelDirs()).not.toContain(dir);
    } finally {
      updateDirsBack(before);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scanned user folders show up in the installed list", () => {
    const dir = tempDir("listed");
    const before = getExtraModelDirs();
    try {
      file(path.join(dir, "My-Model", "weights.safetensors"), "st");
      file(path.join(dir, "My-Model", "config.json"), "{}");
      addModelDir(dir);
      const listed = listInstalledModels().find((m) => m.fileName === "weights.safetensors");
      expect(listed).toBeDefined();
      expect(listed!.origin).toBe("external");
      expect(listed!.size).toBe(2);
      expect(listed!.kind).toBe("safetensors");
    } finally {
      updateDirsBack(before);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function updateDirsBack(dirs: string[]): void {
  // 直接复原设置，避免用例之间互相污染
  const { updateSettings } = require("../src/bun/db/settings") as typeof import("../src/bun/db/settings");
  updateSettings({ MODEL_DIRS: dirs.join(",") });
}

// ---------------------------------------------------------------------------
// 删除路径白名单（路径来自 webview，不可信）
// ---------------------------------------------------------------------------

describe("deleteLocalModel", () => {
  test("refuses paths outside the known model locations", () => {
    const outside = tempDir("outside");
    const victim = path.join(outside, "important.txt");
    file(victim, "do not delete");
    const res = deleteLocalModel(victim);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(require("fs").existsSync(victim)).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  test("deletes files inside the app download dir", () => {
    const target = path.join(getModelsBaseDir(), "scan-test-repo", "model.gguf");
    file(target, "gguf");
    const res = deleteLocalModel(target);
    expect(res.ok).toBe(true);
    expect(res.freed).toBe(4);
    expect(require("fs").existsSync(target)).toBe(false);
  });

  test("deleting an HF cache path removes the whole cache entry", () => {
    const hub = getHfHubCacheDir();
    const entry = path.join(hub, "models--org--Cached-Model");
    const snapshotFile = path.join(entry, "snapshots", "rev", "model.safetensors");
    file(path.join(entry, "blobs", "w"), "weights!");
    file(snapshotFile, "weights!");
    const res = deleteLocalModel(snapshotFile);
    expect(res.ok).toBe(true);
    // 整个 models-- 条目都没了（否则只删软链一个字节都释放不出来）
    expect(require("fs").existsSync(entry)).toBe(false);
  });
});
