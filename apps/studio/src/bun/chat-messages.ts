/**
 * OpenAI 兼容请求的 messages 规整。
 *
 * 起因：模型自带的 chat template（Qwen3 / Qwen3.5 等）里有
 *
 *   {%- if message.role == "system" %}
 *     {%- if not loop.first %}{{ raise_exception('System message must be at the beginning.') }}
 *
 * 也就是「开头**最多一条** system」——第二条哪怕紧跟在第一条后面，整个请求也会被模板
 * 拒掉，前端只看到 `⚠️ {"error": "System message must be at the beginning."}`。
 * 而我们的 system 有好几个来源：时间注入、场景提示词（extraSystem）、联网检索结果、
 * 知识库资料、记忆召回。llama.cpp / vLLM / 云端都容忍多条，MLX 上这些 Qwen 模型直接报错。
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
