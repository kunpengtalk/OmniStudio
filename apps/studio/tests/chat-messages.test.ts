import { describe, expect, test } from "bun:test";

import { mergeSystemMessages, parseChatDelta } from "../src/bun/chat-messages";

/**
 * Qwen 系 chat template 只允许开头一条 system：
 *   {%- if message.role == "system" %}{%- if not loop.first %}{{ raise_exception('System message must be at the beginning.') }}
 * 我们这边 system 有多个来源（时间注入 / 场景提示词 / 联网检索 / 知识库资料 / 记忆召回），
 * 不合并的话这些 Qwen 模型会整请求报错（实测 mlx_lm.server 会返回
 * {"error": "System message must be at the beginning."}）。
 */
describe("mergeSystemMessages", () => {
  test("多条 system 合并成一条放最前，顺序按原位置拼", () => {
    const merged = mergeSystemMessages([
      { role: "system", content: "场景提示词" },
      { role: "system", content: "现在是 2026-09-12。" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好呀" },
      { role: "system", content: "参考资料：[1] xxx" },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0]!.role).toBe("system");
    expect(merged[0]!.content).toBe("场景提示词\n\n现在是 2026-09-12。\n\n参考资料：[1] xxx");
    expect(merged.slice(1)).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好呀" },
    ]);
  });

  test("只有一条 system 时原样返回（连引用都不换）", () => {
    const input = [
      { role: "system", content: "只有一条" },
      { role: "user", content: "hi" },
    ];
    expect(mergeSystemMessages(input)).toBe(input);
  });

  test("没有任何 system 时原样返回", () => {
    const input = [{ role: "user", content: "hi" }];
    expect(mergeSystemMessages(input)).toBe(input);
  });

  test("非字符串内容也能合并（不丢信息）", () => {
    const merged = mergeSystemMessages([
      { role: "system", content: [{ type: "text", text: "结构化内容" }] },
      { role: "system", content: "文本内容" },
      { role: "user", content: "hi" },
    ]);
    expect(merged).toHaveLength(2);
    expect(String(merged[0]!.content)).toContain("结构化内容");
    expect(String(merged[0]!.content)).toContain("文本内容");
  });

  test("空白 system 被丢掉（不会变成一条空 system）", () => {
    const merged = mergeSystemMessages([
      { role: "system", content: "   " },
      { role: "system", content: "" },
      { role: "user", content: "hi" },
    ]);
    expect(merged).toEqual([{ role: "user", content: "hi" }]);
  });
});

/**
 * 流式增量的思考字段：llama.cpp / vLLM 用 `reasoning_content`，mlx-lm 用 `reasoning`。
 * 只认前者时 MLX 的整段思考都会被丢掉（界面空白 + 0 tokens）。
 */
describe("parseChatDelta", () => {
  test("llama.cpp / vLLM 的 reasoning_content", () => {
    expect(parseChatDelta({ reasoning_content: "想想" })).toEqual({
      content: "",
      reasoning: "想想",
    });
  });

  test("mlx-lm 的 reasoning", () => {
    expect(parseChatDelta({ reasoning: "Thinking Process: ..." })).toEqual({
      content: "",
      reasoning: "Thinking Process: ...",
    });
  });

  test("正文与思考同时到达时都能取到", () => {
    expect(parseChatDelta({ content: "答案", reasoning: "草稿" })).toEqual({
      content: "答案",
      reasoning: "草稿",
    });
  });

  test("两者都在时优先 reasoning_content（同一条里不会同时出现）", () => {
    expect(parseChatDelta({ reasoning_content: "A", reasoning: "B" }).reasoning).toBe("A");
  });

  test("空串 / 缺失 / 其它字段名都不算内容", () => {
    expect(parseChatDelta({})).toEqual({ content: "", reasoning: "" });
    expect(parseChatDelta({ reasoning: "" })).toEqual({ content: "", reasoning: "" });
    expect(parseChatDelta({ thinking: "x", reasoning: "" }).reasoning).toBe("");
    expect(parseChatDelta({ role: "assistant" })).toEqual({ content: "", reasoning: "" });
  });
});
