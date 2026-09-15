import { describe, expect, test } from "bun:test";

import { MODEL_COMMAND_LIMIT, isRunnableLocalModel, modelCommandDetail, modelCommandOptions } from "./model-command";

/**
 * `/model` 的候选清单（对齐 Codex 的 `/model`）。
 *
 * 规则必须与右下角的模型选择器一致：本地只列**已启动**的实例（没启动的选中要么等冷启动、
 * 要么报错），云端只列用户添加过的对话模型；当前模型排最前，这样 `/model` 直接回车
 * 就是"不换"，不会误切到列表里的第一个。
 */
const local = (over: Partial<Parameters<typeof modelCommandOptions>[0][number]> = {}) => ({
  type: "local" as const,
  value: "qwen3-8b",
  label: "qwen3-8b",
  detail: "127.0.0.1:8080",
  state: "running",
  isActive: false,
  ...over,
});
const api = (over: Partial<Parameters<typeof modelCommandOptions>[0][number]> = {}) => ({
  type: "api" as const,
  value: "gpt-5",
  label: "gpt-5",
  providerId: "openai",
  providerName: "OpenAI",
  isActive: false,
  ...over,
});

describe("/model 候选清单", () => {
  test("本地只列已启动的实例（stopped 的选了也用不了）", () => {
    expect(isRunnableLocalModel({ state: "running" })).toBe(true);
    expect(isRunnableLocalModel({ state: "starting" })).toBe(true);
    expect(isRunnableLocalModel({ state: "stopped" })).toBe(false);
    const options = modelCommandOptions([
      local({ value: "a", state: "running" }),
      local({ value: "b", state: "stopped" }),
      local({ value: "c", state: "starting" }),
    ]);
    expect(options.map((option) => option.value)).toEqual(["a", "c"]);
  });

  test("云端模型都留着（厂商已启用才会出现在这份清单里）", () => {
    const options = modelCommandOptions([api({ value: "gpt-5" }), api({ value: "claude-x", providerId: "anthropic", providerName: "Anthropic" })]);
    expect(options.map((option) => option.value)).toEqual(["gpt-5", "claude-x"]);
  });

  test("当前模型排最前（`/model` 回车 = 不换）", () => {
    const options = modelCommandOptions([
      local({ value: "first" }),
      api({ value: "current-one", isActive: true }),
      local({ value: "third" }),
    ]);
    expect(options[0]!.value).toBe("current-one");
    expect(options[0]!.isActive).toBe(true);
  });

  test("按名称 / id / 详情 / 厂商过滤", () => {
    const models = [
      local({ value: "qwen3-8b", label: "Qwen3 8B", detail: "127.0.0.1:8080" }),
      api({ value: "gpt-5", label: "GPT-5", providerName: "OpenAI" }),
    ];
    expect(modelCommandOptions(models, "qwen").map((o) => o.value)).toEqual(["qwen3-8b"]);
    expect(modelCommandOptions(models, "8080").map((o) => o.value)).toEqual(["qwen3-8b"]);
    expect(modelCommandOptions(models, "openai").map((o) => o.value)).toEqual(["gpt-5"]);
    expect(modelCommandOptions(models, "不存在的模型")).toEqual([]);
    expect(modelCommandOptions(models, "  ")).toHaveLength(2);
  });

  test("候选数量有上限（列表太长反而挑不动）", () => {
    const many = Array.from({ length: MODEL_COMMAND_LIMIT + 8 }, (_, index) => api({ value: `m-${index}`, label: `模型 ${index}` }));
    expect(modelCommandOptions(many)).toHaveLength(MODEL_COMMAND_LIMIT);
  });

  test("副标题：本地给地址、云端给厂商", () => {
    expect(modelCommandDetail(local({ detail: "127.0.0.1:8080" }))).toBe("127.0.0.1:8080");
    expect(modelCommandDetail(api({ providerName: "OpenAI" }))).toBe("OpenAI");
  });
});
