/**
 * OpenAI 兼容请求 / 流式响应的规整与解析。
 *
 * 请求侧：模型自带的 chat template（Qwen3 / Qwen3.5 等）里有
 *
 *   {%- if message.role == "system" %}
 *     {%- if not loop.first %}{{ raise_exception('System message must be at the beginning.') }}
 *
 * 也就是「开头**最多一条** system」——第二条哪怕紧跟在第一条后面，整个请求也会被模板
 * 拒掉，前端只看到 `⚠️ {"error": "System message must be at the beginning."}`。
 * 而我们的 system 有好几个来源：时间注入、场景提示词（extraSystem）、联网检索结果、
 * 知识库资料、记忆召回。llama.cpp / vLLM / 云端都容忍多条，MLX 上这些 Qwen 模型直接报错。
 *
 * 响应侧：思考流的字段名各引擎不一致（llama.cpp / vLLM 用 `reasoning_content`，
 * mlx-lm 用 `reasoning`），漏掉就会「回复空白 + 0 tokens」。
 */

type ChatMessage = { role: string; content: unknown };

/**
 * 把所有 system 消息合并成一条放在最前面（其余消息保持原顺序）。
 *
 * 只有一条 system 或没有 system 时原样返回；顺序按它们在数组里的位置拼起来，
 * 上下文类内容（检索 / 知识库 / 记忆）通常排在提示词与时间之后，符合直觉。
 */
export function mergeSystemMessages<T extends ChatMessage>(messages: T[]): T[] {
  const systems = messages.filter((m) => m.role === "system");
  if (systems.length <= 1) return messages;

  const content = systems
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n");

  const rest = messages.filter((m) => m.role !== "system");
  if (!content) return rest;
  return [{ role: "system", content } as T, ...rest];
}

/**
 * 从流式响应的一个 `delta` 里取出正文与思考文本。
 *
 * 思考字段各引擎叫法不同：llama.cpp / vLLM 是 `reasoning_content`，mlx-lm 是 `reasoning`；
 * 只认前者时，MLX 上整段思考会被丢掉 —— 界面表现为空白回复、tokens 统计为 0。
 */
export function parseChatDelta(delta: Record<string, unknown>): { content: string; reasoning: string } {
  const reasoning =
    typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0
      ? delta.reasoning_content
      : typeof delta.reasoning === "string" && delta.reasoning.length > 0
        ? delta.reasoning
        : "";
  const content = typeof delta.content === "string" ? delta.content : "";
  return { content, reasoning };
}
