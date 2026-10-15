/**
 * 转写稿的「智能整理」：把已经转出来的稿子交给当前对话模型，产出摘要 / 待办 / 问答 /
 * 校对 / 翻译 / 标题。
 *
 * 为什么单独一个模块：语音识别只管把声音变成字，字变成**能用的东西**是另一件事 ——
 * 会议要待办、访谈要观点、课程要知识点。这些加工以前只能靠用户把稿子复制到对话页再手打
 * 一遍要求，而对话页拿不到「第几分钟谁说的」。
 *
 * 提示词一个字都不写在这里：动作清单与场景设定全在 `shared/asr-insights.ts`，
 * 界面上的按钮也从那一份渲染 —— 两边各写一份的结果是「按钮写着【行动项】、
 * 发出去的指令是【摘要】」这种看不出来的错位。
 *
 * 走的是与写词（`bun/music-lyrics.ts`）同一条路：当前对话模型 + `generateText`，
 * 用量记进统计，失败写 `app.log`。**不是流式**：这类加工通常十几秒内返回，
 * 一次性给结果比再引一条推送通道简单得多，界面上给的是「生成中」状态。
 */
import { generateText } from "ai";

import { logEvent } from "./app-log";
import { getChatModel, getChatModelLabel, getChatRequestModelId } from "./chat-model";
import { recordUsage } from "./stats";
import {
  ASR_INSIGHT_LIMITS,
  buildInsightMessages,
  buildTranscriptText,
  insightInputError,
  normalizeAction,
  normalizeScene,
  type AsrInsightRequest,
  type AsrInsightResult,
} from "../shared/asr-insights";

/** 网络层面的失败换个说法：让用户知道该去哪儿把模型跑起来，而不是只看到 "fetch failed"。 */
function friendlyError(message: string): string {
  if (/timeout|aborted/i.test(message)) {
    return `整理超时（模型 ${Math.round(ASR_INSIGHT_LIMITS.timeoutMs / 1000)} 秒没有返回）。稿子太长或模型太慢时可以先用「摘要」，或者换一个更快的模型。`;
  }
  if (/fetch failed|ECONNREFUSED|connect|socket/i.test(message)) {
    return "联系不上模型服务（本地推理服务没在运行？去 运行模型 页启动，或在 设置 → 云端模型 里启用一个厂商）";
  }
  return `整理失败：${message}`;
}

export async function runAsrInsight(params: AsrInsightRequest = {}): Promise<AsrInsightResult> {
  // webview 传来的值一律先校验：不认识的动作用不了（不是回落成摘要 —— 那会让用户
  // 点了 A 得到 B），场景不认识的回落默认。
  const action = normalizeAction(params.action);
  if (!action) {
    logEvent({
      level: "warn",
      source: "asr",
      event: "asr.insight.unknown_action",
      message: "未知的整理动作，请求被拒绝",
      detail: { action: params.action },
    });
    return { ok: false, error: "未知的整理动作" };
  }
  const scene = normalizeScene(params.scene);

  // 有分段就用分段拼（自带时间点与说话人），否则退回整段文本。
  const transcript = params.segments?.length
    ? buildTranscriptText(params.segments, { hasSpeakers: params.hasSpeakers })
    : (params.text ?? "").trim();

  const inputError = insightInputError({ action, transcript, question: params.question });
  if (inputError) return { ok: false, error: inputError, action, scene };

  const requestModel = getChatRequestModelId();
  if (!requestModel) {
    logEvent({
      level: "warn",
      source: "asr",
      event: "asr.insight.no_model",
      message: "没有可用的对话模型，整理被拒绝",
      detail: { action, scene },
    });
    return { ok: false, error: "没有可用的对话模型（设置 → 默认模型）", action, scene };
  }

  const model = getChatModelLabel() || requestModel;
  const { system, prompt } = buildInsightMessages({
    action,
    scene,
    transcript,
    question: params.question,
  });
  const startedAt = Date.now();

  try {
    const result = await generateText({
      model: getChatModel(),
      system,
      prompt,
      temperature: 0.3,
      maxOutputTokens: ASR_INSIGHT_LIMITS.maxOutputTokens,
      abortSignal: AbortSignal.timeout(ASR_INSIGHT_LIMITS.timeoutMs),
    });
    const text = (result.text ?? "").trim();
    const latencyMs = Date.now() - startedAt;
    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    if (!text) {
      logEvent({
        level: "error",
        source: "asr",
        event: "asr.insight.empty",
        message: "模型返回了空内容",
        detail: { action, scene, model, latencyMs },
      });
      return { ok: false, error: "模型没有返回内容，换一个模型或稍后重试", action, scene, model };
    }
    recordUsage(model, inputTokens, outputTokens);
    logEvent({
      level: "info",
      source: "asr",
      event: "asr.insight.done",
      message: `转写整理完成：${action}`,
      detail: { action, scene, model, transcriptChars: transcript.length, latencyMs, inputTokens, outputTokens },
    });
    return { ok: true, text, action, scene, model, latencyMs, inputTokens, outputTokens };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "asr",
      event: "asr.insight.failed",
      message,
      detail: { action, scene, model, transcriptChars: transcript.length, error: e },
    });
    return { ok: false, error: friendlyError(message), action, scene, model };
  }
}
