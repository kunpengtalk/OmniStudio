import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { listChatModels } from "../src/bun/chat-model";
import { getSetting, updateSettings } from "../src/bun/db/settings";

/**
 * 对话 / Agent 模型选择器与「选择模型启动」下拉看到的东西。
 *
 * 核心回归：vLLM / SGLang / MLX 的仓库是**一个模型**，选择器里必须是一条以
 * 上层文件夹命名的条目，而不是 `model-00001-of-00004.safetensors` 这样的分片名。
 */

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `omni-options-${prefix}-`));
}

function file(p: string, contents = "x"): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, contents);
}

/** 跑一段用例并复原被改动的设置，避免用例之间互相污染。 */
async function withSettings(
  patch: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const keys = Object.keys(patch);
  const before = Object.fromEntries(keys.map((k) => [k, getSetting(k as never)]));
  // 扫描还会读 Hugging Face 缓存（开发机上真有模型），指向空目录保证列表只来自本用例
  const hubBefore = process.env.HUGGINGFACE_HUB_CACHE;
  const emptyHub = tempDir("hub");
  process.env.HUGGINGFACE_HUB_CACHE = emptyHub;
  try {
    updateSettings(patch as never);
    await fn();
  } finally {
    updateSettings(before as never);
    if (hubBefore === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
    else process.env.HUGGINGFACE_HUB_CACHE = hubBefore;
    rmSync(emptyHub, { recursive: true, force: true });
  }
}

describe("模型选择器的本地模型条目", () => {
  test("整仓库模型是一条以文件夹命名的条目，不是分片文件", async () => {
    const dir = tempDir("repo");
    const repoDir = path.join(dir, "LiquidAI", "LFM2-1.2B-4bit");
    file(path.join(repoDir, "config.json"), "{}");
    file(path.join(repoDir, "model-00001-of-00004.safetensors"), "0123456789");
    file(path.join(repoDir, "model-00002-of-00004.safetensors"), "01234");
    file(path.join(repoDir, "model.safetensors.index.json"), "{}");

    try {
      await withSettings(
        { MODEL_DIRS: dir, INFERENCE_ENGINE: "vllm", SERVER_MODE: "local" },
        async () => {
          const { models } = await listChatModels();
          const local = models.filter((m) => m.type === "local");
          expect(local).toHaveLength(1);
          const opt = local[0]!;
          // 展示名是仓库名（slug），detail 是完整仓库路径，且标记为目录条目
          expect(opt.label).toBe("lfm2-1.2b-4bit");
          expect(opt.detail).toBe("LiquidAI/LFM2-1.2B-4bit");
          expect(opt.isDir).toBe(true);
          // 选中它时实际会用 vLLM（safetensors 目录），徽标不能显示成别的引擎
          expect(opt.engine).toBe("vllm");
          // value 是目录本身：与 LOCAL_MODEL_PATH 一致，选择器才显示得出当前模型
          expect(opt.value).toBe(repoDir);
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GGUF 仓库仍按量化逐个列出（每个量化都能单独加载）", async () => {
    const dir = tempDir("gguf");
    const repoDir = path.join(dir, "Qwen3-4B-GGUF");
    file(path.join(repoDir, "config.json"), "{}");
    file(path.join(repoDir, "Qwen3-4B-Q4_K_M.gguf"), "gguf");
    file(path.join(repoDir, "Qwen3-4B-Q8_0.gguf"), "gguf");

    try {
      await withSettings(
        { MODEL_DIRS: dir, INFERENCE_ENGINE: "llama.cpp", SERVER_MODE: "local" },
        async () => {
          const { models } = await listChatModels();
          const local = models.filter((m) => m.type === "local");
          expect(local.map((m) => m.label).sort()).toEqual([
            "qwen3-4b-q4_k_m",
            "qwen3-4b-q8_0",
          ]);
          expect(local.every((m) => !m.isDir)).toBe(true);
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
