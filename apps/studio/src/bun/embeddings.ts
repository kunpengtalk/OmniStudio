/**
 * OpenAI 兼容嵌入客户端（知识库与记忆库共用）。
 *
 * 依赖只有 fetch + 设置表 + 已启动模型注册表（只读），`omi` CLI 在应用未运行时
 * 也能直接调用 —— 应用不在跑时注册表为空，resolveEmbeddingBackend() 恒为 null，
 * 自然回落到原有链路（本地推理服务在跑就有向量，不在跑就由调用方退化为关键词检索）。
 */
import { getSetting, getActiveServerPort } from "./db/settings";
import { resolveEmbeddingBackend } from "./model-servers";

export type EmbeddingConfig = {
  embeddingModel: string;
  embeddingBase: string;
  embeddingApiKey: string;
  embeddingDim: number | null;
};

/**
 * 全局默认嵌入配置（`EMBEDDING_MODEL` / `EMBEDDING_BASE` / `EMBEDDING_API_KEY`）的
 * **唯一 bun 侧读取点**。
 *
 * 它只在两个「写入时」被消费：新建知识库（knowledge.createKb 把三字段快照进 KB 行）
 * 与 KB 设置页的「启用向量检索」按钮；共享记忆则在解析时读它作为显式值的兜底
 * （见 memory.memoryEmbeddingConfig）。**不**参与 resolveEmbeddingBase 的层级 ——
 * 全局默认对既有 KB 没有追溯效果，既有 KB 的端点与维度不会被悄悄改道
 * （维度漂移只会在检索时才以「向量维度不一致」暴露）。
 */
export function globalEmbeddingDefaults(): { model: string; base: string; apiKey: string } {
  return {
    model: getSetting("EMBEDDING_MODEL").trim(),
    base: getSetting("EMBEDDING_BASE").trim(),
    apiKey: getSetting("EMBEDDING_API_KEY").trim(),
  };
}

/** 解析嵌入请求的 base（不带 /v1）：显式配置 > 运行中嵌入实例 > 云端 remote > 聊天活动端口。 */
export function resolveEmbeddingBase(cfg: Pick<EmbeddingConfig, "embeddingBase">): string {
  const trimBase = (v: string) => v.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (cfg.embeddingBase.trim()) return trimBase(cfg.embeddingBase);
  // 用户显式启动的本地嵌入实例是最强意图信号，排在 remote 之上：remote 模式下
  // KB 嵌入今天指向云端 chat provider 本就是坏的，本地嵌入实例才是能真出向量的后端。
  const backend = resolveEmbeddingBackend();
  if (backend) return trimBase(backend);
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
