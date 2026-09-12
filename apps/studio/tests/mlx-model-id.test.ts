import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { getChatRequestModelId, getLocalRequestModelId } from "../src/bun/chat-model";
import { getSetting, updateSettings } from "../src/bun/db/settings";
import { setActiveModel } from "../src/bun/model-store";
import { resolveMlxModel } from "../src/bun/runtimes/mlx";

/**
 * MLX 的模型 id 规则。
 *
 * mlx_lm.server 没有 `--served-model-name`：`--model` 给本地目录时，它对外暴露的 id
 * 是**解析后的绝对路径**（`/v1/models` 里就是它）。请求里填服务名 slug 时，它会拿这个
 * 名字去 HuggingFace 找仓库（本地目录不是 repo id），结果是 Repository Not Found /
 * 卡在下载上 —— 表现出来就是「发消息一直没有返回」。
 */

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `omni-mlx-${prefix}-`));
}

async function withSettings(
  patch: Record<string, string>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const keys = Object.keys(patch);
  const before = Object.fromEntries(keys.map((k) => [k, getSetting(k as never)]));
  try {
    updateSettings(patch as never);
    await fn();
  } finally {
    updateSettings(before as never);
  }
}

describe("MLX 请求模型 id", () => {
  test("本地目录 → 解析后的绝对路径（mlx_lm.server 暴露的就是它）", async () => {
    const modelDir = path.join(tempDir("dir"), "LFM2.5-2.6B-MLX");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(modelDir, "config.json"), "{}");
    try {
      await withSettings(
        // 带一个 `..` 段，验证确实做了 resolve
        { LOCAL_MODEL_PATH: path.join(modelDir, "..", path.basename(modelDir)), LOCAL_MODEL_NAME: "lfm2.5-2.6b-mlx", CHAT_MODEL: "lfm2.5-2.6b-mlx", INFERENCE_ENGINE: "mlx", SERVER_MODE: "local" },
        () => {
          const resolved = resolveMlxModel();
          expect(resolved.model).toBeDefined();
          expect(resolved.requestModelId).toBe(modelDir);
          expect(getChatRequestModelId()).toBe(modelDir);
        },
      );
    } finally {
      rmSync(modelDir, { recursive: true, force: true });
    }
  });

  test("MLX_MODEL 是 repo id 时原样返回（缓存里有就能直接加载）", async () => {
    await withSettings(
      {
        MLX_MODEL: "pipenetwork/DeepSeek-V4.1-Flash-MLX-mixed-4_8bit",
        INFERENCE_ENGINE: "mlx",
        SERVER_MODE: "local",
      },
      () => {
        expect(resolveMlxModel().requestModelId).toBe(
          "pipenetwork/DeepSeek-V4.1-Flash-MLX-mixed-4_8bit",
        );
        expect(getChatRequestModelId()).toBe("pipenetwork/DeepSeek-V4.1-Flash-MLX-mixed-4_8bit");
      },
    );
  });

  test("MLX_MODEL 是本地目录时优先于 LOCAL_MODEL_PATH，并同样取绝对路径", async () => {
    const dir = tempDir("mlx-model");
    const other = tempDir("other");
    try {
      await withSettings(
        { MLX_MODEL: dir, LOCAL_MODEL_PATH: other, INFERENCE_ENGINE: "mlx", SERVER_MODE: "local" },
        () => {
          expect(resolveMlxModel().requestModelId).toBe(dir);
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("其它引擎不受影响：仍然用服务名 slug", async () => {
    const modelDir = tempDir("noselect");
    try {
      await withSettings(
        {
          LOCAL_MODEL_PATH: modelDir,
          LOCAL_MODEL_NAME: "qwen3-4b-q4_k_m",
          CHAT_MODEL: "qwen3-4b-q4_k_m",
          INFERENCE_ENGINE: "llama.cpp",
          SERVER_MODE: "local",
        },
        () => {
          expect(getChatRequestModelId()).toBe("qwen3-4b-q4_k_m");
        },
      );
    } finally {
      rmSync(modelDir, { recursive: true, force: true });
    }
  });

  test("远端模式不换算（id 就是云端模型 id）", async () => {
    await withSettings(
      {
        SERVER_MODE: "remote",
        CHAT_MODEL: "deepseek-chat",
        INFERENCE_ENGINE: "mlx",
        LOCAL_MODEL_PATH: "/tmp/whatever",
      },
      () => {
        expect(getChatRequestModelId()).toBe("deepseek-chat");
      },
    );
  });

  test("网关这类已确定走本地的调用不看 SERVER_MODE（云端模式下也能拿到本地 id）", async () => {
    const root = tempDir("local-only");
    const repoDir = path.join(root, "My-MLX-4bit");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, "config.json"), "{}");
    writeFileSync(path.join(repoDir, "model.safetensors"), "st");
    try {
      await withSettings(
        {
          SERVER_MODE: "remote",
          CHAT_MODEL: "",
          LOCAL_MODEL_PATH: repoDir,
          LOCAL_MODEL_NAME: "my-mlx-4bit",
          INFERENCE_ENGINE: "mlx",
        },
        () => {
          // 本地 id 不看 SERVER_MODE：已确定走本地的调用（网关）也能拿到它
          expect(getLocalRequestModelId()).toBe(repoDir);
          // 而按当前模式取名字仍然照旧（云端模式 + 没配 CHAT_MODEL → 空）
          expect(getChatRequestModelId()).toBe("");
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("在模型库挑了 MLX 目录模型后，引擎面板的部署预设不再盖住它", async () => {
    const root = tempDir("pick");
    const repoDir = path.join(root, "My-MLX-4bit");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, "config.json"), "{}");
    writeFileSync(path.join(repoDir, "model.safetensors"), "st");
    try {
      await withSettings(
        {
          INFERENCE_ENGINE: "mlx",
          SERVER_MODE: "local",
          MLX_MODEL: "pipenetwork/DeepSeek-V4.1-Flash-MLX-mixed-4_8bit",
        },
        () => {
          expect(setActiveModel(repoDir).ok).toBe(true);
          // 挑完具体模型：加载目标就是它，部署预设被清掉，请求 id 也跟着它
          expect(getSetting("LOCAL_MODEL_PATH")).toBe(repoDir);
          expect(getSetting("MLX_MODEL")).toBe("");
          expect(resolveMlxModel().requestModelId).toBe(repoDir);
          expect(getChatRequestModelId()).toBe(repoDir);
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
