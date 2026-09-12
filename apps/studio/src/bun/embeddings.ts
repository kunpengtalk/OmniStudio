/**
 * OpenAI 兼容嵌入客户端（知识库与记忆库共用）。
 *
 * 零主进程依赖：只用 fetch + 设置表，`omi` CLI 在应用未运行时也能直接调用
 * （本地推理服务在跑就有向量，不在跑就由调用方退化为关键词检索）。
 */
import { getSetting, getActiveServerPort } from "./db/settings";

export type EmbeddingConfig = {
  embeddingModel: string;
  embeddingBase: string;
  embeddingApiKey: string;
  embeddingDim: number | null;
};

/** 解析嵌入请求的 base（不带 /v1）：显式配置 > 云服务商槽位 > 本地推理服务。 */
export function resolveEmbeddingBase(cfg: Pick<EmbeddingConfig, "embeddingBase">): string {
  const trimBase = (v: string) => v.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (cfg.embeddingBase.trim()) return trimBase(cfg.embeddingBase);
  if (getSetting("SERVER_MODE") === "remote") return trimBase(getSetting("VLLM_API_BASE"));
  const host = getSetting("SERVER_HOST") || "127.0.0.1";
  return `http://${host}:${getActiveServerPort()}`;
}

export function embeddingHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = apiKey.trim() || getSetting("VLLM_API_KEY");
  if (key && key !== "EMPTY") headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** 调 OpenAI 兼容 /v1/embeddings，批大小 32，全部成功才返回。 */
export async function callEmbeddings(cfg: EmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
  const model = cfg.embeddingModel.trim();
  if (!model) throw new Error("未配置嵌入模型");
  const base = resolveEmbeddingBase(cfg);
  if (!base) throw new Error("未配置嵌入服务地址");

  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const res = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: embeddingHeaders(cfg.embeddingApiKey),
      body: JSON.stringify({ model, input: batch }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`嵌入请求失败（HTTP ${res.status}）${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: { embedding?: number[]; index?: number }[] };
    const data = json.data ?? [];
    if (data.length !== batch.length) throw new Error("嵌入服务返回数量与输入不一致");
    const ordered = new Map<number, number[]>();
    for (const d of data) {
      if (!Array.isArray(d.embedding)) throw new Error("嵌入服务返回格式异常");
      ordered.set(d.index ?? ordered.size, d.embedding);
    }
    for (let j = 0; j < batch.length; j++) {
      const vec = ordered.get(j);
      if (!vec) throw new Error("嵌入服务返回缺少向量");
      const arr = new Float32Array(vec);
      if (cfg.embeddingDim != null && arr.length !== cfg.embeddingDim) {
        throw new Error(`向量维度不一致（${arr.length} ≠ ${cfg.embeddingDim}），请检查嵌入模型`);
      }
      out.push(arr);
    }
  }
  return out;
}

export function encodeEmbedding(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64");
}

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
