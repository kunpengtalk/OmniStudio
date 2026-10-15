/**
 * 「智能整理」的真实调用链测试：起一个假的 OpenAI 兼容端点，让 `runAsrInsight` 真跑一遍
 * ——模型解析 → 组提示词 → `generateText` → 用量与日志。
 *
 * 与 `shared/asr-insights.test.ts` 的分工：那边验**提示词内容**（纯函数），这边验
 * **点下按钮之后真正发生的事**：请求打到哪个地址、填的是哪个模型名、稿子有没有带上时间点、
 * 失败时返回的是不是人能看懂的那句话。提示词对不对看不出调用链断没断。
 */
import { afterAll, beforeEach, expect, test } from "bun:test";

import { logEvent, readAppLogs } from "./app-log";
import { updateSettings } from "./db/settings";
import { runAsrInsight } from "./asr-insights";

type Captured = { path: string; model?: string; messages: { role: string; content: string }[] };

let captured: Captured[] = [];
/**
 * 端点行为开关：正常 / 返回空内容 / 认证失败。
 * 失败用 401 而不是 500：AI SDK 对 5xx 会自动重试（退避好几秒），测试等不起；
 * 而 401 本来就是这里最常见的真实失败（密钥或模型名不对），且不重试。
 */
let behaviour: "ok" | "empty" | "boom" = "ok";

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as {
      model?: string;
      messages?: { role: string; content: string }[];
    };
    captured.push({
      path: new URL(req.url).pathname,
      model: body.model,
      messages: body.messages ?? [],
    });
    if (behaviour === "boom") {
      return Response.json(
        { error: { message: "Incorrect API key provided", type: "invalid_request_error" } },
        { status: 401 },
      );
    }
    return Response.json({
      id: "cmpl-1",
      object: "chat.completion",
      created: 0,
      model: body.model ?? "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: behaviour === "empty" ? "" : "### 摘要\n\n- 结论一" },
          finish_reason: "stop",
        },
      ],
      // OpenAI 口径的字段名：适配层把它映射成 inputTokens / outputTokens。
      usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
    });
  },
});

afterAll(() => server.stop(true));

beforeEach(() => {
  captured = [];
  behaviour = "ok";
  // 云端槽位：地址指向假端点，模型名走 VLLM_MODEL_NAME（本地模式读的是另一套键）。
  updateSettings({
    SERVER_MODE: "remote",
    VLLM_API_BASE: `http://127.0.0.1:${server.port}/v1`,
    VLLM_API_KEY: "EMPTY",
    VLLM_MODEL_NAME: "test-model",
  });
});

const SEGMENTS = [
  { start: 0, end: 2, text: "开场白", speaker: 0 },
  { start: 65, end: 68, text: "第二个问题", speaker: 1 },
];

test("一次整理：请求打到 /chat/completions，稿子带时间点与说话人，结果与用量回得来", async () => {
  const result = await runAsrInsight({ action: "summary", scene: "meeting", segments: SEGMENTS });

  expect(result.ok).toBe(true);
  expect(result.text).toContain("摘要");
  expect(result.action).toBe("summary");
  expect(result.scene).toBe("meeting");
  expect(result.model).toBe("test-model");
  expect(result.inputTokens).toBe(1200);
  expect(result.outputTokens).toBe(80);
  expect(typeof result.latencyMs).toBe("number");

  expect(captured).toHaveLength(1);
  const sent = captured[0]!;
  expect(sent.path).toBe("/v1/chat/completions");
  expect(sent.model).toBe("test-model");
  // system 是规则，user 是「场景 + 动作 + 转写稿」。
  expect(sent.messages[0]!.role).toBe("system");
  expect(sent.messages[0]!.content).toContain("不要补");
  const prompt = sent.messages[1]!.content;
  expect(prompt).toContain("会议记录");
  expect(prompt).toContain("结构化摘要"); // 摘要那条指令
  expect(prompt).not.toContain("- [ ] 事项"); // 别的动作的指令不该混进来
  expect(prompt).toContain("--- 转写稿开始 ---");
  expect(prompt).toContain("[0:00] 说话人 1：开场白");
  expect(prompt).toContain("[1:05] 说话人 2：第二个问题");

  // 用量与成功都留了日志（失败路径可排障是本仓库的硬要求）。
  expect(readAppLogs({ source: "asr", event: "asr.insight.done" }).length).toBeGreaterThan(0);
});

test("没有分段时退回整段文本", async () => {
  const result = await runAsrInsight({ action: "title", text: "  这是一段纯文本稿  " });
  expect(result.ok).toBe(true);
  expect(captured[0]!.messages[1]!.content).toContain("这是一段纯文本稿");
});

test("空稿件：直接拒绝，不发请求", async () => {
  const result = await runAsrInsight({ action: "summary", segments: [], text: "   " });
  expect(result.ok).toBe(false);
  expect(result.error).toBe("还没有转写内容可以整理");
  expect(captured).toHaveLength(0);
});

test("认不出的动作被拒绝，且不会回落成摘要（点了 A 得到 B 更糟）", async () => {
  const result = await runAsrInsight({ action: "rm -rf", segments: SEGMENTS });
  expect(result.ok).toBe(false);
  expect(result.error).toBe("未知的整理动作");
  expect(captured).toHaveLength(0);
});

test("提问类动作缺问题时拒绝；认不出的场景回落默认而不是报错", async () => {
  const missing = await runAsrInsight({ action: "custom", segments: SEGMENTS });
  expect(missing.ok).toBe(false);
  expect(missing.error).toBe("这个动作需要先写一个问题");

  const fallback = await runAsrInsight({
    action: "summary",
    scene: "not-a-scene",
    segments: SEGMENTS,
  });
  expect(fallback.ok).toBe(true);
  expect(fallback.scene).toBe("general");
  // 回落后用的是通用场景的设定，而不是随便挑一个。
  expect(captured[0]!.messages[1]!.content).toContain("按通用文稿处理");
});

test("没有可用的对话模型：给出指向设置的说法，不发请求", async () => {
  updateSettings({ VLLM_MODEL_NAME: "" });
  const result = await runAsrInsight({ action: "summary", segments: SEGMENTS });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("没有可用的对话模型");
  expect(captured).toHaveLength(0);
});

test("模型返回空内容：当失败处理（不能落一张空白卡片）", async () => {
  behaviour = "empty";
  const result = await runAsrInsight({ action: "summary", segments: SEGMENTS });
  expect(result.ok).toBe(false);
  expect(result.error).toBe("模型没有返回内容，换一个模型或稍后重试");
  expect(readAppLogs({ source: "asr", event: "asr.insight.empty" }).length).toBeGreaterThan(0);
});

test("上游拒绝（401）：错误换成人能看懂的一句话，并写进 app.log", async () => {
  behaviour = "boom";
  const before = readAppLogs({ source: "asr", event: "asr.insight.failed" }).length;
  const result = await runAsrInsight({ action: "summary", segments: SEGMENTS });
  expect(result.ok).toBe(false);
  // 不是把 "AI_APICallError" 之类的原始异常直接甩给用户。
  expect(result.error).not.toContain("AI_");
  expect(readAppLogs({ source: "asr", event: "asr.insight.failed" }).length).toBe(before + 1);
});

test("日志里不出现转写正文（内容可能敏感，日志只记条数与模型）", async () => {
  logEvent({
    level: "info",
    source: "asr",
    event: "asr.insight.test.marker",
    message: "标记",
  });
  await runAsrInsight({ action: "summary", segments: [{ start: 0, end: 1, text: "绝密的会议内容", speaker: 0 }] });
  const entries = readAppLogs({ source: "asr", limit: 50 });
  const dumped = JSON.stringify(entries);
  expect(dumped).not.toContain("绝密的会议内容");
});
