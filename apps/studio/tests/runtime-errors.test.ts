import { describe, expect, test } from "bun:test";

import { extractStartupError } from "../src/bun/runtimes/errors";

/**
 * 启动错误提取：日志里翻出真正的原因，别把警告当好错报出来。
 */
describe("extractStartupError", () => {
  test("mlx-lm 的 UserWarning 不算错误（否则服务器跑着也挂着「错误」）", () => {
    const logs = [
      "$ mlx_lm.server --model /models/My-MLX-4bit --host 127.0.0.1 --port 18010",
      "UserWarning: mlx_lm.server is not recommended for production as it only implements basic security checks.",
      "2026-09-12 18:11:15,423 - INFO - Starting httpd at 127.0.0.1 on port 18010...",
      "[server is ready]",
      "You are using a model of type qwen3_5_moe to instantiate a model of type . This is not supported for all configurations of models and can yield errors.",
    ].join("\n");
    expect(extractStartupError(logs, "Server failed to become ready within timeout")).toBe(
      "Server failed to become ready within timeout",
    );
  });

  test("警告之后的真实错误仍然能翻出来", () => {
    const logs = [
      "You are using a model of type qwen3_5_moe ... can yield errors.",
      "ValueError: Unknown model architecture: 'spark2_5'",
      "[server exited with code 1]",
    ].join("\n");
    expect(extractStartupError(logs, "Process exited with code 1")).toContain(
      "Unknown model architecture",
    );
  });

  test("没有错误行时回落到调用方给的兜底文案", () => {
    expect(extractStartupError("loading weights...\n[server is ready]", "fallback")).toBe("fallback");
  });
});
