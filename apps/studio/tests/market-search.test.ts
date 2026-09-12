import { describe, expect, test } from "bun:test";

import {
  MODEL_SOURCE_META,
  classifyModel,
  engineSearchFormat,
  matchFormat,
  modelFormats,
  type MarketModel,
} from "../src/shared/modelscope";
import { buildSearchUrl as hfSearchUrl, buildTreeUrl } from "../src/bun/huggingface";
import { buildSearchUrl as msSearchUrl } from "../src/bun/modelscope";

// ---------------------------------------------------------------------------
// 引擎 → 检索格式的映射表（市场"跟随引擎"的格式过滤就是从这里派生）
// ---------------------------------------------------------------------------

describe("engineSearchFormat", () => {
  test("maps every engine to the format its weights use", () => {
    expect(engineSearchFormat("llama.cpp")).toBe("gguf");
    expect(engineSearchFormat("vllm")).toBe("safetensors");
    expect(engineSearchFormat("sglang")).toBe("safetensors");
    expect(engineSearchFormat("mlx")).toBe("mlx");
  });
});

// ---------------------------------------------------------------------------
// 检索请求：格式过滤必须是显式请求参数（而不是客户端遍历结果去猜）
// ---------------------------------------------------------------------------

describe("HuggingFace search url", () => {
  test("passes the format as the platform filter parameter", () => {
    const url = new URL(hfSearchUrl("https://hf-mirror.com", "qwen3", 1, 20, "gguf"));
    expect(url.searchParams.get("filter")).toBe("gguf");
    expect(url.searchParams.get("search")).toBe("qwen3");
    expect(url.searchParams.get("sort")).toBe("downloads");
  });

  test("omits the filter entirely when no format is selected", () => {
    const url = new URL(hfSearchUrl("https://hf-mirror.com", "qwen3", 1, 20));
    expect(url.searchParams.has("filter")).toBe(false);
  });

  test("paginates with limit/skip instead of page numbers", () => {
    const url = new URL(hfSearchUrl("https://hf-mirror.com", "qwen3", 3, 20, "mlx"));
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("skip")).toBe("40");
    expect(url.searchParams.get("filter")).toBe("mlx");
  });

  test("tree url asks for blob sizes", () => {
    expect(buildTreeUrl("https://hf-mirror.com", "Qwen/Qwen3-8B")).toBe(
      "https://hf-mirror.com/api/models/Qwen/Qwen3-8B/tree/main?recursive=true&blobs=true",
    );
  });
});

describe("ModelScope search url", () => {
  test("folds the format into the query because the API has no format filter", () => {
    const url = msSearchUrl("qwen3", 1, 20, "gguf");
    expect(url.searchParams.get("search")).toBe("qwen3 gguf");
    expect(url.searchParams.get("page_size")).toBe("20");
    expect(url.searchParams.has("filter")).toBe(false);
  });

  test("keeps the plain query when no format is selected", () => {
    expect(msSearchUrl("qwen3", 2, 20).searchParams.get("search")).toBe("qwen3");
  });
});

// ---------------------------------------------------------------------------
// 格式判定：只认平台元数据（tags / 仓库文件），不猜模型名
// ---------------------------------------------------------------------------

describe("modelFormats", () => {
  test("reads ModelScope library tags", () => {
    expect(modelFormats(["license:apache-2.0", "library:gguf", "library:pytorch"])).toEqual(["gguf"]);
    expect(modelFormats(["library:mlx", "library:safetensors", "custom_tag:mlx"])).toEqual([
      "safetensors",
      "mlx",
    ]);
  });

  test("reads Hugging Face tags", () => {
    expect(modelFormats(["gguf", "text-generation"])).toEqual(["gguf"]);
    expect(modelFormats(["mlx", "safetensors"])).toEqual(["safetensors", "mlx"]);
  });

  test("falls back to the real file list when tags say nothing", () => {
    expect(modelFormats([], ["README.md", "model-Q4_K_M.gguf"])).toEqual(["gguf"]);
    expect(modelFormats([], ["model.safetensors", "config.json"])).toEqual(["safetensors"]);
  });

  test("does not invent a format from a model name", () => {
    // 名字里有 GGUF 但没有标签也没有文件清单 → 不下结论
    expect(modelFormats(["text-generation"])).toEqual([]);
  });

  test("unknown format metadata never filters a result out", () => {
    expect(matchFormat([], "gguf")).toBe(true);
    expect(matchFormat(["gguf"], "gguf")).toBe(true);
    expect(matchFormat(["safetensors"], "gguf")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 分类：两个平台的标签形态不同，都要能归类
// ---------------------------------------------------------------------------

function model(partial: Partial<MarketModel> & { id: string }): MarketModel {
  return {
    name: partial.id,
    description: "",
    downloads: 0,
    likes: 0,
    license: "",
    tasks: [],
    tags: [],
    fileSize: 0,
    params: 0,
    createdAt: "",
    lastModified: "",
    source: "modelscope",
    formats: [],
    fileCount: 0,
    ...partial,
  };
}

describe("classifyModel", () => {
  test("recognizes ModelScope task tags", () => {
    expect(classifyModel(model({ id: "some/repo", tasks: ["text-generation"] }))).toBe("chat");
    expect(classifyModel(model({ id: "some/repo", tasks: ["text-to-speech"] }))).toBe("tts");
    expect(classifyModel(model({ id: "some/repo", tasks: ["automatic-speech-recognition"] }))).toBe("asr");
    expect(classifyModel(model({ id: "some/repo", tasks: ["text-to-image"] }))).toBe("image");
  });

  test("recognizes Hugging Face pipeline tags carried in tags", () => {
    expect(classifyModel(model({ id: "org/model", tags: ["text-generation"] }))).toBe("chat");
    expect(classifyModel(model({ id: "org/model", tags: ["text-to-speech"] }))).toBe("tts");
    expect(classifyModel(model({ id: "org/model", tags: ["automatic-speech-recognition"] }))).toBe("asr");
    expect(classifyModel(model({ id: "org/model", tags: ["text-to-image"] }))).toBe("image");
  });

  test("treats VLM (image-text-to-text) as chat", () => {
    expect(classifyModel(model({ id: "org/model", tasks: ["image-text-to-text"] }))).toBe("chat");
  });

  test("unrelated repos fall through to other", () => {
    expect(classifyModel(model({ id: "org/random-embeddings" }))).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// 来源元数据：每个平台的展示名与实际域名
// ---------------------------------------------------------------------------

describe("MODEL_SOURCE_META", () => {
  test("names the real host each platform's bytes come from", () => {
    expect(MODEL_SOURCE_META.modelscope.host).toBe("modelscope.cn");
    expect(MODEL_SOURCE_META.huggingface.host).toBe("hf-mirror.com");
  });
});
