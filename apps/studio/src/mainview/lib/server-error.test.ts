import { describe, expect, it, test } from "bun:test";

import { firstErrorLine, isEngineMissingError, persistedErrorMessage, serverErrorHint } from "./server-error";

/** 只关心「取到哪个键」，所以把 key 原样返回。 */
const t = (key: string) => key;

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

  it("引擎没装同时给「提示句 + 一键安装」两样：提示句来自这里，按钮靠上面的判定", () => {
    // 「没装」不是引擎启动失败的类别，分类器认不出这句话，所以单独兜一条 ——
    // 界面上一句「推理引擎未安装」+ 一个安装按钮，比只给原文更有用（issue #8）。
    expect(serverErrorHint(t, "llama-server not found on PATH")).toBe("server.error.hint.engine");
    expect(isEngineMissingError("llama-server not found on PATH")).toBe(true);
  });
});

describe("serverErrorHint", () => {
  test("有分类时直接用分类（主进程已经判过，不再就地猜）", () => {
    expect(serverErrorHint(t, "CUDA out of memory. Tried to allocate 2.00 GiB", "vram-insufficient")).toBe(
      "engine.error.hint.vram-insufficient",
    );
    // 即使原文和类型看起来不一致，也以主进程的类型为准：它见过完整日志，这里只有一行。
    expect(serverErrorHint(t, "something odd", "model-format")).toBe("engine.error.hint.model-format");
  });

  test("没有分类时就地分类，用的是同一张规则表", () => {
    expect(serverErrorHint(t, "ModuleNotFoundError: No module named 'mlx_lm'")).toBe(
      "engine.error.hint.missing-dependency",
    );
    expect(serverErrorHint(t, "ERROR: [Errno 98] Address already in use")).toBe(
      "engine.error.hint.port-in-use",
    );
    expect(serverErrorHint(t, "llama_model_load: failed to open model.gguf: bad magic")).toBe(
      "engine.error.hint.model-missing",
    );
  });

  test("架构不支持现在也认（老实现只认 llama.cpp 那一句原文）", () => {
    expect(serverErrorHint(t, "ValueError: Model type deepseek_v41 not supported.")).toBe(
      "engine.error.hint.model-format",
    );
  });

  test("本应用自己的状态文案仍然单独给提示", () => {
    expect(serverErrorHint(t, "No model configured")).toBe("server.error.hint.noModel");
    expect(serverErrorHint(t, "Server start timed out")).toBe("server.error.hint.timeout");
  });

  test("认不出来就不硬给建议，只留原文", () => {
    expect(serverErrorHint(t, "Process exited with code 1")).toBeNull();
    expect(serverErrorHint(t, "")).toBeNull();
    expect(serverErrorHint(t, undefined)).toBeNull();
  });
});

describe("persistedErrorMessage", () => {
  test("从落库的失败消息里取出原文", () => {
    expect(persistedErrorMessage("⚠️ CUDA out of memory")).toBe("CUDA out of memory");
    expect(persistedErrorMessage("正常回答")).toBeNull();
  });
});

describe("firstErrorLine", () => {
  // 真实形态：llama.cpp 的 stdout，带 ANSI 着色、时间戳前缀，最后一行是总结句。
  const FAILED_LOAD = [
    "\u001b[32m0.00.100.200 I srv  llama_server: loading model\u001b[0m",
    "\u001b[32m0.00.180.400 I srv  load_model: the slot context (8192) exceeds the training context of the model (512) - capping\u001b[0m",
    "\u001b[31m0.00.200.300 E srv  llama_model_load: error loading model: unknown model architecture: 'bert'\u001b[0m",
    "\u001b[31m0.00.201.900 E srv  llama_init_from_gpt_params: error loading model\u001b[0m",
    "0.00.202.000 E srv  llama_server: exiting due to model loading error",
  ].join("\n");

  test("给日志里第一条真正的错误行（不是最后那句『exiting due to model loading error』）", () => {
    const line = firstErrorLine(FAILED_LOAD);
    // 用户要贴的就是这一行：它才写明是架构不认识 / 张量形状不对 / 文件截断
    expect(line).toContain("unknown model architecture");
    // 只有「结论」的那句排在后面，不能被当成答案
    expect(line).not.toContain("exiting due to model loading error");
  });

  test("带颜色的日志要洗干净再给用户（ANSI 转义不能混进界面 / 剪贴板）", () => {
    expect(firstErrorLine(FAILED_LOAD)).not.toContain("\u001b");
  });

  test("只有总结句时也照样给这一句，不给 null", () => {
    const onlySummary = "0.00.202.000 E srv  llama_server: exiting due to model loading error";
    expect(firstErrorLine(onlySummary)).toContain("exiting due to model loading error");
  });

  test("没有错误行就是 null（正常加载的日志不该被读出错误）", () => {
    const ok = [
      "0.00.100.000 I srv  load_model: model loaded",
      "0.00.120.000 I srv  llama_server: listening on http://127.0.0.1:18191",
    ].join("\n");
    expect(firstErrorLine(ok)).toBeNull();
    expect(firstErrorLine("")).toBeNull();
    expect(firstErrorLine(undefined)).toBeNull();
  });

  test("别的引擎（Python 栈）也认：Traceback / Error 行", () => {
    const vllm = [
      "INFO: Loading model weights took 12.3 GB",
      "Traceback (most recent call last):",
      'ValueError: Bfloat16 is only supported on GPUs with compute capability >= 8.0',
    ].join("\n");
    expect(firstErrorLine(vllm)).toContain("compute capability");
  });

  test("超长的一行截断显示（日志行可以几百字符，卡片放不下）", () => {
    const long = `E srv error: ${"x".repeat(1000)}`;
    const line = firstErrorLine(long)!;
    expect(line.length).toBeLessThanOrEqual(301);
    expect(line.endsWith("…")).toBe(true);
  });
});
