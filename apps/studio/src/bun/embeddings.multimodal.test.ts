import { afterEach, describe, expect, mock, test } from "bun:test";
import { callEmbeddingsMultimodal, type EmbeddingConfig } from "./embeddings";

/**
 * callEmbeddingsMultimodal 形态自适应（llama.cpp prompt_string+multimodal_data vs
 * 远程 OpenAI content 数组）单测。
 *
 * 桩法照 chat.test.ts / cloud-providers.test.ts 先例：globalThis.fetch 赋值桩 +
 * afterEach 还原，**不用 mock.module**（cfg 的 base / apiKey 都显式给出 →
 * resolveEmbeddingBase / embeddingHeaders 不触设置表），所以不需要 .tests.ts
 * 子进程隔离。GET /props 与 POST /v1/embeddings 按 URL 与方法分流。
 * 每个用例用**不同 embeddingBase**：胜出形态按 base 缓存在模块级 Map 里，
 * 独立 base 保证用例间互不串缓存（也顺带验证缓存按 base 隔离）。
 */

const DIM = 4;
const VEC = [0.1, 0.2, 0.3, 0.4];
const MARKER_A = "<__media_testAAAA__>";
const MARKER_B = "<__media_testBBBB__>";
const baseCfg: EmbeddingConfig = {
  embeddingModel: "test-embed",
  embeddingBase: "",
  embeddingApiKey: "sk-test",
  embeddingDim: DIM,
};
const cfgFor = (base: string): EmbeddingConfig => ({ ...baseCfg, embeddingBase: base });

type Recorded = { method: string; url: string; input?: unknown; auth?: string };
let calls: Recorded[] = [];

interface StubOptions {
  /** GET /props 的响应；省略 = 模拟超时 / 网络失败（fetch 直接 reject）。 */
  props?: () => Response;
  /** POST /v1/embeddings 的响应，attempt 为第几次 POST（1 起）。 */
  post: (attempt: number) => Response;
}

function stubFetch(opts: StubOptions) {
  let postCount = 0;
  globalThis.fetch = mock(async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as { method?: string; body?: string; headers?: Record<string, string> };
    const u = String(url);
    if (u.endsWith("/props")) {
      calls.push({ method: i.method ?? "GET", url: u });
      if (!opts.props) throw new Error("props probe timed out");
      return opts.props();
    }
    postCount++;
    calls.push({
      method: i.method ?? "GET",
      url: u,
      input: JSON.parse(i.body ?? "{}").input,
      auth: i.headers?.Authorization,
    });
    return opts.post(postCount);
  }) as never;
}

const okVec = () => new Response(JSON.stringify({ data: [{ embedding: VEC, index: 0 }] }), { status: 200 });
const reject = (status: number, text: string) => new Response(text, { status });
const propsWith = (marker: string) => new Response(JSON.stringify({ media_marker: marker }), { status: 200 });
const dimVec = () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  calls = [];
});

describe("callEmbeddingsMultimodal 形态自适应", () => {
  test("props 探到 marker → llama.cpp 形态:prompt_string=marker+空格+text,multimodal_data 裸 b64", async () => {
    const base = "http://mm-llamacpp-joint";
    stubFetch({ props: () => propsWith(MARKER_A), post: () => okVec() });
    const [vec] = await callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD", text: "一只橘猫" }]);
    expect(vec).toEqual(new Float32Array(VEC));
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1]!.url).toBe(`${base}/v1/embeddings`);
    expect(calls[1]!.auth).toBe("Bearer sk-test");
    expect(calls[1]!.input).toEqual([{ prompt_string: `${MARKER_A} 一只橘猫`, multimodal_data: ["QUJD"] }]);
  });

  test("纯媒体退化:prompt_string 仅 marker,无尾随空格", async () => {
    stubFetch({ props: () => propsWith(MARKER_A), post: () => okVec() });
    await callEmbeddingsMultimodal(cfgFor("http://mm-llamacpp-pure"), [{ imageB64: "QUJD" }]);
    expect(calls[1]!.input).toEqual([{ prompt_string: MARKER_A, multimodal_data: ["QUJD"] }]);
  });

  test("props 404(普通远程)→ content 数组形态(image_url+text part)", async () => {
    const base = "http://mm-remote-404";
    stubFetch({ props: () => reject(404, "not found"), post: () => okVec() });
    const [vec] = await callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD", text: "橘猫" }]);
    expect(vec).toEqual(new Float32Array(VEC));
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1]!.input).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
      { type: "text", text: "橘猫" },
    ]);
  });

  test("props 超时(网络失败)→ content 数组形态", async () => {
    stubFetch({ post: () => okVec() }); // 不给 props → fetch reject
    const [vec] = await callEmbeddingsMultimodal(cfgFor("http://mm-remote-timeout"), [
      { audioB64: "QVVESU8=", audioFormat: "mp3" },
    ]);
    expect(vec).toEqual(new Float32Array(VEC));
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]); // props 尝试被记录但失败被吞
    expect(calls[1]!.input).toEqual([{ type: "input_audio", input_audio: { data: "QVVESU8=", format: "mp3" } }]);
  });

  test("按 base 缓存 llama.cpp 形态:第二次直接 POST 同 marker,不再探 props", async () => {
    let propsCount = 0;
    stubFetch({ props: () => (propsCount++, propsWith(MARKER_A)), post: () => okVec() });
    await callEmbeddingsMultimodal(cfgFor("http://mm-cache-llamacpp"), [{ imageB64: "QUJD", text: "a" }]);
    await callEmbeddingsMultimodal(cfgFor("http://mm-cache-llamacpp"), [{ imageB64: "QUJD", text: "b" }]);
    expect(propsCount).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
    expect(calls[2]!.input).toEqual([{ prompt_string: `${MARKER_A} b`, multimodal_data: ["QUJD"] }]);
  });

  test("content 形态同样按 base 缓存:props 只探一次", async () => {
    let propsCount = 0;
    stubFetch({ props: () => (propsCount++, reject(404, "no")), post: () => okVec() });
    await callEmbeddingsMultimodal(cfgFor("http://mm-cache-content"), [{ imageB64: "QUJD" }]);
    await callEmbeddingsMultimodal(cfgFor("http://mm-cache-content"), [{ imageB64: "QUJD", text: "x" }]);
    expect(propsCount).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
    expect(calls[2]!.input).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
      { type: "text", text: "x" },
    ]);
  });

  test("marker 失效(正文含 media markers)→ 重取 props 刷新再试,缓存更新为新 marker", async () => {
    let propsCount = 0;
    stubFetch({
      props: () => (propsCount++, propsWith(propsCount === 1 ? MARKER_A : MARKER_B)),
      post: (n) => (n === 1 ? okVec() : n === 2 ? reject(500, "number of media markers in text (0) does not match number of bitmaps") : okVec()),
    });
    const base = "http://mm-marker-stale";
    // 第一次:props 拿 marker A,POST 成功,缓存 {llamacpp, marker A}
    await callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD", text: "联合" }]);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    // 第二次:marker A 失效(500 + media markers 字样)→ 重取 props(marker B)再试成功
    const [vec] = await callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD", text: "联合" }]);
    expect(vec).toEqual(new Float32Array(VEC));
    expect(propsCount).toBe(2);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "GET", "POST"]);
    expect(calls[1]!.input).toEqual([{ prompt_string: `${MARKER_A} 联合`, multimodal_data: ["QUJD"] }]);
    expect(calls[4]!.input).toEqual([{ prompt_string: `${MARKER_B} 联合`, multimodal_data: ["QUJD"] }]);
    // 刷新后的 marker 已进缓存:第三次调用不再探 props
    calls = [];
    await callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD" }]);
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(calls[0]!.input).toEqual([{ prompt_string: MARKER_B, multimodal_data: ["QUJD"] }]);
  });

  test("缓存形态失败但正文无 media markers 字样 → 不重探 props,普通错误", async () => {
    let propsCount = 0;
    stubFetch({
      props: () => (propsCount++, propsWith(MARKER_A)),
      post: (n) => (n === 1 ? okVec() : reject(503, "overloaded")),
    });
    const base = "http://mm-plain-fail";
    await callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD" }]);
    let msg = "";
    try {
      await callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD" }]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("嵌入请求失败");
    expect(msg).toContain("HTTP 503");
    expect(propsCount).toBe(1);
  });

  test("有 props 但 prompt_string 形态被拒 → 换 content 数组重试一次;两形态都拒 → 指引错误", async () => {
    stubFetch({
      props: () => propsWith(MARKER_A),
      post: () => reject(500, '"input" elements must be a string'),
    });
    let msg = "";
    try {
      await callEmbeddingsMultimodal(cfgFor("http://mm-both-reject"), [{ imageB64: "QUJD" }]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("嵌入服务拒绝了多模态输入");
    expect(msg).toContain("prompt_string 形态 HTTP 500");
    expect(msg).toContain("content 数组形态 HTTP 500");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
  });

  test("无 props 且 content 形态被拒 → 指引错误(单形态,含 HTTP 状态与正文)", async () => {
    stubFetch({ props: () => reject(404, "no"), post: () => reject(400, "invalid image_url") });
    let msg = "";
    try {
      await callEmbeddingsMultimodal(cfgFor("http://mm-content-reject"), [{ imageB64: "QUJD" }]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("嵌入服务拒绝了多模态输入");
    expect(msg).toContain("HTTP 400");
    expect(msg).toContain("invalid image_url");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  test("维度不一致抛错(content 形态 200 但向量长度错)", async () => {
    stubFetch({ props: () => reject(404, "no"), post: () => dimVec() });
    await expect(callEmbeddingsMultimodal(cfgFor("http://mm-dim"), [{ imageB64: "QUJD" }])).rejects.toThrow(
      "向量维度不一致",
    );
  });

  // 空向量守卫：llama.cpp 对「多模态嵌入尚未支持的模型」（实测 WeMM-Embedding-9B +
  // mmproj，b10964：HTTP 200、图像正常编码进 token，embedding 却全 null——null 进
  // Float32Array 静默变 0、维度校验照过）必须在这里被拦下，否则零向量入库后检索永不
  // 命中，是比直接报错恶劣得多的静默损坏。
  test("空向量守卫:200 但 embedding 全 null → 明确报错,不静默产出零向量", async () => {
    stubFetch({
      props: () => propsWith(MARKER_A),
      post: () => new Response(JSON.stringify({ data: [{ embedding: [null, null, null, null], index: 0 }] }), { status: 200 }),
    });
    await expect(callEmbeddingsMultimodal(cfgFor("http://mm-null-vec"), [{ imageB64: "QUJD" }])).rejects.toThrow(
      "空向量",
    );
  });

  test("零向量守卫:200 且 embedding 全 0 → 明确报错", async () => {
    stubFetch({
      props: () => propsWith(MARKER_A),
      post: () => new Response(JSON.stringify({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] }), { status: 200 }),
    });
    await expect(callEmbeddingsMultimodal(cfgFor("http://mm-zero-vec"), [{ imageB64: "QUJD" }])).rejects.toThrow(
      "零向量",
    );
  });

  test("多 input 逐条发送:每请求 1 个 input;音频/视频 content part 形态正确", async () => {
    stubFetch({ props: () => reject(404, "no"), post: () => okVec() });
    const vecs = await callEmbeddingsMultimodal(cfgFor("http://mm-multi-content"), [
      { audioB64: "QVVESU8=", audioFormat: "mp3" },
      { videoB64: "VklERU8=", videoFormat: "mov" },
    ]);
    expect(vecs).toHaveLength(2);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(calls[2]!.input).toEqual([{ type: "input_video", input_video: { data: "VklERU8=", format: "mov" } }]);
  });

  test("props 返回超长 marker(10KB)→ 长度护栏弃用,走 content 数组形态", async () => {
    stubFetch({ props: () => propsWith("M".repeat(10_240)), post: () => okVec() });
    const [vec] = await callEmbeddingsMultimodal(cfgFor("http://mm-marker-huge"), [{ imageB64: "QUJD", text: "x" }]);
    expect(vec).toEqual(new Float32Array(VEC));
    // 超长 marker 未进请求体:POST body 是 content 数组形态
    expect(calls[1]!.input).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
      { type: "text", text: "x" },
    ]);
  });

  test("marker 失效且重取失败 → 清缓存抛错;下次调用走全新协商(props 恢复后新 marker 生效)", async () => {
    let propsCount = 0;
    stubFetch({
      props: () => (propsCount++, propsCount === 2 ? reject(404, "gone") : propsWith(propsCount === 1 ? MARKER_A : MARKER_B)),
      post: (n) => (n === 1 ? okVec() : n === 2 ? reject(500, "number of media markers in text (0) does not match") : okVec()),
    });
    const base = "http://mm-marker-refresh-clear";
    // 建立缓存 {llamacpp, marker A}
    await callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD" }]);
    // marker A 失效 + props 重取 404 → 抛错且缓存被清
    await expect(callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD" }])).rejects.toThrow("嵌入请求失败");
    // 下一次调用走全新协商:props 重探(marker B)→ POST 直接用 marker B
    const [vec] = await callEmbeddingsMultimodal(cfgFor(base), [{ imageB64: "QUJD", text: "x" }]);
    expect(vec).toEqual(new Float32Array(VEC));
    expect(propsCount).toBe(3);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "GET", "GET", "POST"]);
    expect(calls[5]!.input).toEqual([{ prompt_string: `${MARKER_B} x`, multimodal_data: ["QUJD"] }]);
  });
});
