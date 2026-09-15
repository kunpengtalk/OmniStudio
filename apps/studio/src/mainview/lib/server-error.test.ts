import { describe, expect, it } from "bun:test";

import { isEngineMissingError, serverErrorHint } from "./server-error";

describe("isEngineMissingError", () => {
  it("认出各引擎的『没装』报错 —— 本地模型页据此在报错下面挂一键安装（issue #8）", () => {
    const engineMissing = [
      "llama-server not found on PATH",
      "vllm not found. install with pip install vllm",
      "sglang not found",
      "mlx 未安装",
    ];
    for (const error of engineMissing) {
      expect(`${error} → ${isEngineMissingError(error)}`).toBe(`${error} → true`);
    }
  });

  it("别的启动失败不能被当成引擎缺失（否则会挂出装不上的按钮）", () => {
    const other = [
      null,
      undefined,
      "",
      "unknown model architecture: FooForCausalLM",
      "no model configured",
      "server start timed out",
    ];
    for (const error of other) {
      expect(`${String(error)} → ${isEngineMissingError(error)}`).toBe(`${String(error)} → false`);
    }
  });

  it("serverErrorHint 仍然给出引擎提示（判定抽成函数后行为不变）", () => {
    const t = (key: string) => key;
    expect(serverErrorHint(t, "llama-server not found on PATH")).toBe("server.error.hint.engine");
    expect(serverErrorHint(t, "unknown model architecture: X")).toBe("server.error.hint.arch");
    expect(serverErrorHint(t, "whatever")).toBe(null);
  });
});
