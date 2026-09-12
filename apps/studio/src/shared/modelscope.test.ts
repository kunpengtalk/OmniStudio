import { describe, expect, test } from "bun:test";

import {
  classifyModelName,
  filterModelIds,
  isChatModelCategory,
  MODEL_CATEGORY_SETS,
  modelNameFromRef,
  type ModelCategory,
} from "./modelscope";

/**
 * 模型分类是"挑模型"的唯一依据：分类判错，模型就会从对应场景的选择器里消失
 * （或混进不该出现的场景）。这里的用例都取自各服务商真实的 /v1/models 返回。
 */
describe("classifyModelName", () => {
  const cases: [string, ModelCategory][] = [
    // 对话 / VLM
    ["Qwen/Qwen3.5-35B-A3B", "chat"],
    ["deepseek-chat", "chat"],
    ["deepseek-v4-flash", "chat"],
    ["gpt-5", "chat"],
    ["claude-sonnet-4", "chat"],
    ["gemini-2.5-pro", "chat"],
    ["glm-4.5", "chat"],
    ["moonshot-v1-128k", "chat"],
    ["Qwen/Qwen2.5-VL-7B-Instruct", "chat"],
    ["unsloth/Qwen3.5-4B-GGUF", "chat"],
    ["Qwen/Qwen3.5-4B", "chat"],
    ["ZhipuAI/cogvlm2-llama3-chinese-chat-19B", "chat"],
    // 嵌入
    ["text-embedding-3-small", "embedding"],
    ["BAAI/bge-m3", "embedding"],
    ["BAAI/bge-large-zh-v1.5", "embedding"],
    ["Qwen/Qwen3-Embedding-8B", "embedding"],
    ["sentence-transformers/all-MiniLM-L6-v2", "embedding"],
    ["intfloat/multilingual-e5-large", "embedding"],
    ["jinaai/jina-embeddings-v3", "embedding"],
    // 重排（必须在嵌入之前判：bge-reranker 也含 bge）
    ["BAAI/bge-reranker-v2-m3", "rerank"],
    ["Qwen/Qwen3-Reranker-8B", "rerank"],
    ["jinaai/jina-reranker-v2-base-multilingual", "rerank"],
    ["netease-youdao/bce-reranker-base_v1", "rerank"],
    // 语音合成
    ["tts-1", "tts"],
    ["gpt-4o-mini-tts", "tts"],
    ["FunAudioLLM/CosyVoice2-0.5B", "tts"],
    ["fishaudio/fish-speech-1.5", "tts"],
    ["IndexTeam/IndexTTS-2", "tts"],
    ["speech-02-turbo", "tts"],
    ["sambert-zhichu-v1", "tts"],
    // 语音识别 / 转录
    ["whisper-1", "asr"],
    ["openai/whisper-large-v3", "asr"],
    ["FunAudioLLM/SenseVoiceSmall", "asr"],
    ["paraformer-realtime-v2", "asr"],
    ["qwen3-asr-flash", "asr"],
    // 生图
    ["dall-e-3", "image"],
    ["gpt-image-1", "image"],
    ["black-forest-labs/FLUX.1-schnell", "image"],
    ["AI-ModelScope/stable-diffusion-xl-base-1.0", "image"],
    ["Kwai-Kolors/Kolors", "image"],
    ["doubao-seedream-3-0-t2i", "image"],
    ["wanx-v1", "image"],
    ["imagen-3.0-generate-002", "image"],
    // 生视频
    ["doubao-seedance-1-0-pro", "video"],
    ["MiniMax-Hailuo-02", "video"],
    ["Wan-AI/Wan2.2-T2V-A14B", "video"],
    ["kling-v1", "video"],
    ["veo-3", "video"],
    // 认不出来 —— 保持 other（对话选择器仍然保留，不能藏掉）
    ["o3-mini", "other"],
    ["step-audio-2", "other"],
  ];

  for (const [id, expected] of cases) {
    test(`${id} → ${expected}`, () => {
      expect(classifyModelName(id)).toBe(expected);
    });
  }
});

describe("filterModelIds", () => {
  const ids = ["deepseek-chat", "text-embedding-3-small", "BAAI/bge-reranker-v2-m3", "tts-1"];

  test("只留目标分类", () => {
    expect(filterModelIds(ids, MODEL_CATEGORY_SETS.embedding).ids).toEqual([
      "text-embedding-3-small",
    ]);
    expect(filterModelIds(ids, MODEL_CATEGORY_SETS.rerank).ids).toEqual([
      "BAAI/bge-reranker-v2-m3",
    ]);
  });

  test("keepOther：认不出的保留（对话选择器用）", () => {
    const withUnknown = [...ids, "o3-mini"];
    expect(filterModelIds(withUnknown, MODEL_CATEGORY_SETS.chat, { keepOther: true }).ids).toEqual([
      "deepseek-chat",
      "o3-mini",
    ]);
  });

  test("relax：一个都没命中时回退全量并标记", () => {
    const onlyChat = ["deepseek-chat", "o3-mini"];
    const picked = filterModelIds(onlyChat, MODEL_CATEGORY_SETS.tts, { relax: true });
    expect(picked.ids).toEqual(onlyChat);
    expect(picked.relaxed).toBe(true);
  });

  test("relax 不会把空列表变成非空", () => {
    const picked = filterModelIds([], MODEL_CATEGORY_SETS.tts, { relax: true });
    expect(picked.ids).toEqual([]);
    expect(picked.relaxed).toBe(false);
  });
});

describe("isChatModelCategory", () => {
  test("chat 与未分类都能当对话模型，其余不行", () => {
    expect(isChatModelCategory("chat")).toBe(true);
    expect(isChatModelCategory("other")).toBe(true);
    for (const category of ["embedding", "rerank", "tts", "asr", "image", "video"] as const) {
      expect(isChatModelCategory(category)).toBe(false);
    }
  });
});

describe("modelNameFromRef", () => {
  test("路径型引用只取最后一段：界面上不出现 /Users/… 这种路径", () => {
    // LM Studio / MLX 的目录
    expect(modelNameFromRef("/Users/me/.lmstudio/models/abenzerps/Apodex-1.1-mini-MLX-4bit")).toBe(
      "Apodex-1.1-mini-MLX-4bit",
    );
    // 权重文件去掉扩展名，保留量化后缀（下载下来叫什么就叫什么）
    expect(modelNameFromRef("/models/Qwen3-4B-Q4_K_M.gguf")).toBe("Qwen3-4B-Q4_K_M");
    expect(modelNameFromRef("~/models/bge-m3")).toBe("bge-m3");
    expect(modelNameFromRef("/models/Qwen__Qwen3.5-4B")).toBe("Qwen3.5-4B");
  });

  test("repo id / 服务名原样保留（斜杠是名字的一部分）", () => {
    expect(modelNameFromRef("mlx-community/Qwen3-8B-4bit")).toBe("mlx-community/Qwen3-8B-4bit");
    expect(modelNameFromRef("qwen3-8b")).toBe("qwen3-8b");
    expect(modelNameFromRef("deepseek-chat")).toBe("deepseek-chat");
  });

  test("空值回落到 fallback", () => {
    expect(modelNameFromRef("", "—")).toBe("—");
    expect(modelNameFromRef("   ", "—")).toBe("—");
  });
});
