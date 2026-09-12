/**
 * 冒烟测试用的假 OpenAI 兼容嵌入服务：
 * - POST /v1/embeddings：按 token 哈希生成 32 维确定性向量（相同词 → 相同方向，
 *   语义近似靠共享 token 重叠近似，足够验证余弦排序逻辑）；
 * - GET /v1/models：返回 fake-embed。
 */
const PORT = Number(process.env.FAKE_EMBED_PORT ?? 18777);

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function embed(text: string): number[] {
  const dim = 32;
  const vec = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]/g) ?? [];
  for (const tk of tokens) {
    const h = hashToken(tk);
    const i1 = h % dim;
    const i2 = (h >>> 8) % dim;
    vec[i1] = (vec[i1] ?? 0) + (h % 2 === 0 ? 1 : -1) * 1;
    vec[i2] = (vec[i2] ?? 0) + (h % 2 === 0 ? 1 : -1) * 0.6;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

const server = Bun.serve({
  port: PORT,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ data: [{ id: "fake-embed" }] });
    }
    if (url.pathname === "/v1/embeddings" && req.method === "POST") {
      const body = (await req.json()) as { input?: string | string[] };
      const input = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      return Response.json({
        data: input.map((text, index) => ({ index, embedding: embed(text) })),
      });
    }
    // 冒烟测试用：/v1/rerank，按查询词与文档的字符重合度打分（确定性）。
    if (url.pathname === "/v1/rerank" && req.method === "POST") {
      const body = (await req.json()) as {
        query?: string;
        documents?: { id?: unknown; text?: string }[];
        top_n?: number;
      };
      const query = String(body.query ?? "");
      const docs = body.documents ?? [];
      const overlap = (text: string): number => {
        const q = new Set((query.match(/[a-z0-9]+|[\u3400-\u9fff]/g) ?? []).map((s) => s.toLowerCase()));
        let hit = 0;
        let total = 0;
        for (const m of text.toLowerCase().matchAll(/[a-z0-9]+|[\u3400-\u9fff]/g)) {
          total++;
          if (q.has(m[0])) hit++;
        }
        return total === 0 ? 0 : Math.min(1, hit / Math.max(3, total * 0.3));
      };
      const scored = docs
        .map((d, index) => ({ index, id: d.id, score: overlap(String(d.text ?? "")) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Number(body.top_n ?? docs.length));
      return Response.json({
        results: scored.map((s) => ({ index: s.index, document: { id: s.id }, relevance_score: s.score })),
      });
    }
    // 冒烟测试用：流式 chat completions，回显所有 system 提示里命中的引用编号。
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = (await req.json()) as { messages?: { role: string; content: unknown }[] };
      const systemText = (body.messages ?? [])
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      const cited = [...systemText.matchAll(/\[(\d+)\] 来源：/g)].map((m) => `[${m[1]}]`);
      const reply = cited.length > 0 ? `根据资料${cited.join("")}回答完毕。` : "（无知识库上下文）";
      const stream = new ReadableStream({
        start(controller) {
          const chunk = (delta: string) =>
            `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
          controller.enqueue(new TextEncoder().encode(chunk(reply) + "data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`fake embedding server on http://127.0.0.1:${server.port}`);
