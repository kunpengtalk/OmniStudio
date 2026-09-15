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

// ---------------------------------------------------------------------------
// 多模态直嵌（图片 / 语音 / 视频，知识库媒体单元专用）。与 callEmbeddings 并列，
// 复用同一套 base 解析 / 鉴权 / 超时 / 响应校验，callEmbeddings 本体零改动。
// ---------------------------------------------------------------------------

/** 一个多模态嵌入输入 = 一个媒体单元（一图 / 一音 / 一视频）+ 可选联合文本。 */
export type EmbeddingInput = {
  imageB64?: string;
  audioB64?: string;
  audioFormat?: string;
  videoB64?: string;
  videoFormat?: string;
  text?: string;
};

/** 某个 base 协商出的胜出请求形态（llama.cpp 形态要记 marker：每进程随机）。 */
type MultimodalFormat = { kind: "llamacpp"; marker: string } | { kind: "content" };

/**
 * 形态自适应（spike 终局协议，三轮迭代后落定）：llama.cpp 的 /v1/embeddings 只认
 * `{prompt_string, multimodal_data}` 形态，且 prompt_string 必须内嵌**该进程的
 * media marker**（GET /props 读，每进程随机——硬编码必报「media markers 数不匹配」）；
 * 远程 OpenAI / vLLM 只认 content 数组；**data-URI 字符串形态已证伪删除**（llama.cpp
 * 把整串 base64 当纯文本编码，token 数随 b64 长度线性——假成功、真错误向量）。
 * key = resolveEmbeddingBase 结果；marker 失效（服务重启换随机串，表现为 4xx/5xx
 * 且正文含 "media markers"）时重取刷新一次。
 */
const multimodalFormatCache = new Map<string, MultimodalFormat>();

/** content 数组形态的 input：媒体 part + 可选文本 part（联合成单向量）。 */
function multimodalContentParts(input: EmbeddingInput): unknown[] {
  const parts: unknown[] = [];
  if (input.imageB64) parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${input.imageB64}` } });
  if (input.audioB64) parts.push({ type: "input_audio", input_audio: { data: input.audioB64, format: input.audioFormat ?? "wav" } });
  if (input.videoB64) parts.push({ type: "input_video", input_video: { data: input.videoB64, format: input.videoFormat ?? "mp4" } });
  if (input.text) parts.push({ type: "text", text: input.text });
  return parts;
}

/**
 * llama.cpp 形态的 input：prompt_string 内嵌「每个媒体一个 marker」（+可选空格+文本
 * = 图文联合单向量，spike 实测 329 tok 形态；纯媒体退化 = 仅 marker），multimodal_data
 * 是**裸 base64**（无 data: 前缀），顺序与 marker 出现顺序一一对应。
 */
function multimodalLlamacppInput(
  input: EmbeddingInput,
  marker: string,
): { prompt_string: string; multimodal_data: string[] } {
  const b64s = multimodalMediaB64s(input);
  const prompt = [...b64s.map(() => marker), ...(input.text ? [input.text] : [])].join(" ");
  return { prompt_string: prompt, multimodal_data: b64s };
}

/** 读 llama.cpp 服务参数：media_marker 每进程随机，必须现取。探不到（404 / 超时 / 非 JSON / 非法超长）→ 普通远程。 */
async function fetchMediaMarker(base: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(`${base}/props`, { method: "GET", headers, signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { media_marker?: unknown };
    const marker = typeof json.media_marker === "string" ? json.media_marker.trim() : "";
    // 长度护栏：超长 marker 会被缓存进每个请求体（恶意 / 异常服务的请求放大面），弃用
    return marker && marker.length <= 256 ? marker : null;
  } catch {
    return null;
  }
}

/** 输入里的媒体裸 b64 列表（image → audio → video 稳定序；实际一个媒体单元只含一个媒体）。 */
function multimodalMediaB64s(input: EmbeddingInput): string[] {
  return [input.imageB64, input.audioB64, input.videoB64].filter((v): v is string => !!v);
}

function postEmbeddingRequest(base: string, headers: Record<string, string>, model: string, input: unknown): Promise<Response> {
  return fetch(`${base}/v1/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(120_000),
  });
}

/** 单 input 响应解析 + 校验，语义照 callEmbeddings：允许且仅允许单元素。 */
async function multimodalVectorFrom(cfg: EmbeddingConfig, res: Response): Promise<Float32Array> {
  const json = (await res.json()) as { data?: { embedding?: number[]; index?: number }[] };
  const data = json.data ?? [];
  if (data.length !== 1) throw new Error("嵌入服务返回数量与输入不一致");
  const first = data[0];
  if (!first || !Array.isArray(first.embedding)) throw new Error("嵌入服务返回格式异常");
  // 空向量守卫：llama.cpp 对「多模态嵌入尚未支持的模型」（如 WeMM，上游
  // ggml-org/llama.cpp#27938 仍是 open 的功能请求）会以 HTTP 200 返回全 null 的
  // embedding——null 进 Float32Array 静默变 0，维度校验照过，零向量入库后检索
  // 永不命中。在源头拒绝：任一元素为 null / 非有限数即报错，别等它变零。
  if (first.embedding.some((v) => v == null || !Number.isFinite(v))) {
    throw new Error(
      "嵌入服务返回了空向量（请求被接受但 embedding 含空值）——该嵌入模型可能不支持多模态输入，请检查该库的模态勾选与嵌入模型",
    );
  }
  const arr = new Float32Array(first.embedding);
  if (cfg.embeddingDim != null && arr.length !== cfg.embeddingDim) {
    throw new Error(`向量维度不一致（${arr.length} ≠ ${cfg.embeddingDim}），请检查嵌入模型`);
  }
  // 零向量守卫：合法嵌入向量必非零（L2 归一化模型恒为 1）；全零 = 服务端没有
  // 真正产出向量（典型：上游转换只做了「不崩」，嵌入头没接上）。
  let normSq = 0;
  for (let i = 0; i < arr.length; i++) normSq += arr[i]! * arr[i]!;
  if (normSq === 0) {
    throw new Error(
      "嵌入服务返回了零向量——该嵌入模型可能不支持多模态输入，请检查该库的模态勾选与嵌入模型",
    );
  }
  return arr;
}

/**
 * 多模态嵌入：逐条发送（每请求 1 个 input，一个媒体单元一个向量）。首次对某
 * resolved base 先 GET /props 读 media_marker 定形态——拿到 → llama.cpp 形态
 * （被拒再换 content 数组重试一次）；拿不到（404 / 超时，普通 OpenAI 兼容远程）→
 * content 数组形态（llama.cpp 形态无法构造，失败即报）。胜出形态按 base 缓存；
 * 缓存的 marker 失效（4xx/5xx 且正文含 "media markers"）→ 重取刷新再试一次。
 * 纯媒体（无 text）只发媒体部分（退化路径）。两种形态都被拒 → 抛错（含「嵌入
 * 服务拒绝了多模态输入」+ 各形态 HTTP 状态 + 正文前 200 字，供上层拼接
 * 「检查模态勾选 / 嵌入模型」指引）。
 */
export async function callEmbeddingsMultimodal(cfg: EmbeddingConfig, inputs: EmbeddingInput[]): Promise<Float32Array[]> {
  const model = cfg.embeddingModel.trim();
  if (!model) throw new Error("未配置嵌入模型");
  const base = resolveEmbeddingBase(cfg);
  if (!base) throw new Error("未配置嵌入服务地址");
  const headers = embeddingHeaders(cfg.embeddingApiKey);

  const out: Float32Array[] = [];
  for (const input of inputs) {
    out.push(await embedMediaUnit(cfg, base, headers, model, input));
  }
  return out;
}

// 单个媒体单元:形态协商 / 缓存 / marker 失效刷新都在这一层。
async function embedMediaUnit(
  cfg: EmbeddingConfig,
  base: string,
  headers: Record<string, string>,
  model: string,
  input: EmbeddingInput,
): Promise<Float32Array> {
  const httpFail = (prefix: string, status: number, body: string): Error =>
    new Error(`${prefix}（HTTP ${status}）${body.slice(0, 200)}`);
  const cached = multimodalFormatCache.get(base);

  // 缓存命中 content 形态:直用(远程形态无 marker 可失效)
  if (cached?.kind === "content") {
    const res = await postEmbeddingRequest(base, headers, model, multimodalContentParts(input));
    if (!res.ok) throw httpFail("嵌入请求失败", res.status, await res.text().catch(() => ""));
    return multimodalVectorFrom(cfg, res);
  }

  // 缓存命中 llama.cpp 形态:直用;正文含 "media markers" 说明 marker 已失效
  // (服务重启换随机串)→ 重取刷新再试一次
  if (cached?.kind === "llamacpp") {
    const res = await postEmbeddingRequest(base, headers, model, [multimodalLlamacppInput(input, cached.marker)]);
    if (res.ok) return multimodalVectorFrom(cfg, res);
    const body = await res.text().catch(() => "");
    if (!/media markers/i.test(body)) throw httpFail("嵌入请求失败", res.status, body);
    const fresh = await fetchMediaMarker(base, headers);
    if (!fresh) {
      // 重取也拿不到(服务下线 / 已换形态):清缓存,下次调用走全新协商,不背死 marker
      multimodalFormatCache.delete(base);
      throw httpFail("嵌入请求失败", res.status, body);
    }
    const retry = await postEmbeddingRequest(base, headers, model, [multimodalLlamacppInput(input, fresh)]);
    if (!retry.ok) throw httpFail("嵌入请求失败", retry.status, await retry.text().catch(() => ""));
    const vec = await multimodalVectorFrom(cfg, retry);
    multimodalFormatCache.set(base, { kind: "llamacpp", marker: fresh });
    return vec;
  }

  // 该 base 还没协商过:GET /props 定形态
  const marker = await fetchMediaMarker(base, headers);
  if (marker) {
    const res = await postEmbeddingRequest(base, headers, model, [multimodalLlamacppInput(input, marker)]);
    if (res.ok) {
      const vec = await multimodalVectorFrom(cfg, res);
      multimodalFormatCache.set(base, { kind: "llamacpp", marker });
      return vec;
    }
    // 有 props 却拒 prompt_string 形态:换 content 数组形态重试一次
    const st = res.status;
    const alt = await postEmbeddingRequest(base, headers, model, multimodalContentParts(input));
    if (!alt.ok) {
      const body = await alt.text().catch(() => "");
      throw new Error(`嵌入服务拒绝了多模态输入（prompt_string 形态 HTTP ${st}、content 数组形态 HTTP ${alt.status}）${body.slice(0, 200)}`);
    }
    const vec = await multimodalVectorFrom(cfg, alt);
    multimodalFormatCache.set(base, { kind: "content" });
    return vec;
  }

  // 探不到 props(404 / 超时)= 普通 OpenAI 兼容远程:只能 content 数组,失败即报
  const res = await postEmbeddingRequest(base, headers, model, multimodalContentParts(input));
  if (!res.ok) throw httpFail("嵌入服务拒绝了多模态输入", res.status, await res.text().catch(() => ""));
  const vec = await multimodalVectorFrom(cfg, res);
  multimodalFormatCache.set(base, { kind: "content" });
  return vec;
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
