import { expect, test } from "bun:test";

import { extractDeadWorkerError, extractStartupError } from "./errors";

/** mlx_lm.server 遇到不认识的架构时真实打出来的那段（背景见 errors.ts）。 */
const UNSUPPORTED_MODEL_LOG = [
  "Exception in thread Thread-1 (_generate):",
  "Traceback (most recent call last):",
  "  File \"/site-packages/mlx_lm/server.py\", line 695, in _generate",
  "    self.model_provider.load_default()",
  "  File \"/site-packages/mlx_lm/utils.py\", line 255, in _get_classes",
  "    raise ValueError(msg)",
  "ValueError: Model type deepseek_v41 not supported.",
  "/site-packages/mlx_lm/server.py:1723: UserWarning: mlx_lm.server is not recommended for production",
  "Starting httpd at 127.0.0.1 on port 18010...",
].join("\n");

test("认出「服务起来了但模型加载线程已死」，并把 model_type 说出来", () => {
  const message = extractDeadWorkerError(UNSUPPORTED_MODEL_LOG);
  expect(message).toContain("deepseek_v41");
  expect(message).toContain("不会出图");
});

test("线程死在别的原因上：仍然按失败处理，带上异常行", () => {
  const logs = [
    "Exception in thread Thread-1 (_generate):",
    "OSError: [Errno 28] No space left on device",
  ].join("\n");
  const message = extractDeadWorkerError(logs);
  expect(message).toContain("No space left on device");
});

test("正常启动的日志不误报", () => {
  const logs = [
    "Fetching 12 files: 100%|##########| 12/12",
    "Starting httpd at 127.0.0.1 on port 18010...",
  ].join("\n");
  expect(extractDeadWorkerError(logs)).toBeNull();
});

test("extractStartupError 的既有行为不变（它只在进程退出 / 超时那条路上被调用）", () => {
  // 这段日志里最后一条错误行就是那条 ValueError —— 问题从来不在于它挑不出来，
  // 而在于服务没退出时根本没人去调它（新的 extractDeadWorkerError 补的就是这一步）。
  expect(extractStartupError(UNSUPPORTED_MODEL_LOG, "fallback")).toBe(
    "ValueError: Model type deepseek_v41 not supported.",
  );
  expect(extractStartupError("Error: unknown model architecture: 'spark2_5'", "fallback")).toContain(
    "unknown model architecture",
  );
});
