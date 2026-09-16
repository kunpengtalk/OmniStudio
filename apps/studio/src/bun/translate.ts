import { eq, desc } from "drizzle-orm";
import { db } from "./db";
import { translationRecords } from "./db/schema";
import { getSetting } from "./db/settings";
import { getChatModelLabel, getChatRequestModelId } from "./chat-model";
import { ensureServerReady, getChatBaseUrl, maxOutputTokens } from "./chat";
import { recordUsage } from "./stats";
import { currentUpstream, providerLabelFor, recordUsageEvent } from "./usage";
import { logEvent } from "./app-log";
import { estimateTokens } from "../shared/token-estimate";
import { translationLangLabel } from "../shared/translate";

export type TranslationRecordRow = {
  id: number;
  sourceLang: string;
  targetLang: string;
  text: string;
  result: string | null;
  model: string | null;
  createdAt: number;
};

/** 谷歌「浏览器同款」免费翻译接口（gtx）。走代理与否由全局设置决定（见 bun/proxy.ts）。 */
async function googleTranslate(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string> {
  const body = new URLSearchParams({
    client: "gtx",
    sl: sourceLang === "auto" ? "auto" : sourceLang,
    tl: targetLang,
    dt: "t",
    q: text,
  });
  const res = await fetch("https://translate.googleapis.com/translate_a/single", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`谷歌翻译请求失败 (HTTP ${res.status})`);
  const raw = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // 个别响应里会出现字面量 undefined（非合法 JSON），替换后再解析
    data = JSON.parse(raw.replace(/\bundefined\b/g, "null"));
  }
  const segments = (Array.isArray(data) ? (data as unknown[])[0] : undefined) as
    | unknown[]
    | undefined;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("谷歌翻译响应格式异常");
  }
  const out = segments
    .map((s) => (Array.isArray(s) ? String(s[0] ?? "") : ""))
    .join("");
  if (!out.trim()) throw new Error("谷歌翻译未返回译文");
  return out;
}

/**
 * 翻译一段文本，返回译文并把结果写入历史记录。
 * engine 为 "model" 时走当前对话模型（本地推理服务器 / OpenAI 兼容 API，
 * 模型与服务器配置完全复用聊天，本地模式下服务器未就绪会自动启动并等待）；
 * engine 为 "google" 时走谷歌浏览器同款免费接口，不依赖本地模型。
 */
export async function runTranslation(params: {
  text: string;
  sourceLang?: string;
  targetLang: string;
  engine?: "model" | "google";
  /** false 时仅翻译不入库（同传等高频场景，避免刷爆历史记录）。 */
  save?: boolean;
}): Promise<{ text?: string; id?: number; error?: string }> {
  const text = (params.text ?? "").trim();
  if (!text || !params.targetLang) {
    // 这两个是"接口被错误调用"，不是翻译失败 —— 记 warn 就够了，但别静默：
    // 同传那条链路一次发几十个请求，参数错时会在这里刷出一片错误。
    logEvent({
      level: "warn",
      source: "translate",
      event: "translate.request.rejected",
      message: !text ? "待翻译文本为空" : "未指定目标语言",
      detail: { engine: params.engine ?? "model", targetLang: params.targetLang ?? null },
    });
    return { error: !text ? "待翻译文本不能为空" : "未指定目标语言" };
  }

  if (params.engine === "google") {
    try {
      const content = await googleTranslate(
        text,
        params.sourceLang ?? "auto",
        params.targetLang,
      );
      if (params.save === false) return { text: content };
      const record = db
        .insert(translationRecords)
        .values({
          sourceLang: params.sourceLang ?? "auto",
          targetLang: params.targetLang,
          text,
          result: content,
          model: "Google Translate",
        })
        .returning()
        .get();
      return { text: content, id: record.id };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 谷歌免费接口是最容易被网络环境挡住的一条路（墙 / 代理没配对），
      // 而 `_translate` source 此前一次都没被用过 —— 用户只说"翻译没反应"。
      logEvent({
        level: "error",
        source: "translate",
        event: "translate.google.failed",
        message,
        detail: {
          sourceLang: params.sourceLang ?? "auto",
          targetLang: params.targetLang,
          chars: text.length,
          error: e,
        },
      });
      return { error: message };
    }
  }

  // 请求里填本地服务器认的 id（MLX 是绝对路径）；记录与展示仍用服务名。
  const model = getChatRequestModelId();
  const modelLabel = getChatModelLabel() || model;
  const base = getChatBaseUrl();
  if (!model || !base) {
    logEvent({
      level: "error",
      source: "translate",
      event: "translate.model.not_configured",
      message: !model ? "未配置模型" : "未配置推理服务器",
      detail: { hasModel: Boolean(model), hasBase: Boolean(base) },
    });
    return { error: !model ? "未配置模型" : "未配置推理服务器" };
  }

  if (getSetting("SERVER_MODE") === "local") {
    const ready = await ensureServerReady();
    if (!ready.ok) {
      logEvent({
        level: "error",
        source: "translate",
        event: "translate.server.not_ready",
        message: ready.error || "推理服务器未就绪",
        detail: { model: modelLabel },
      });
      return { error: ready.error || "推理服务器未就绪" };
    }
  }

  const sourceLabel =
    params.sourceLang && params.sourceLang !== "auto"
      ? translationLangLabel(params.sourceLang)
      : "自动检测";
  const targetLabel = translationLangLabel(params.targetLang);

  const instruction =
    `你是专业的翻译引擎。请把下面的内容从「${sourceLabel}」翻译成「${targetLabel}」。` +
    `只输出译文本身，不要输出任何解释、注释或原文。` +
    `遇到代码、专有名词、人名地名或无法翻译的内容时，请原样保留。`;

  const apiKey = getSetting("VLLM_API_KEY");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "EMPTY") headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: text },
        ],
        // 译文长度与原文同量级；显式给上限，免得 mlx-lm 默认的 512 被推理模型的思考吃光。
        max_tokens: maxOutputTokens(),
        stream: false,
      }),
      signal: AbortSignal.timeout(600_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = body
        ? (() => {
            try {
              return JSON.parse(body)?.error?.message ?? body.slice(0, 300);
            } catch {
              return body.slice(0, 300);
            }
          })()
        : `HTTP ${res.status}`;
      logEvent({
        level: "error",
        source: "translate",
        event: "translate.model.failed",
        message: msg,
        detail: {
          status: res.status,
          model: modelLabel,
          base,
          targetLang: params.targetLang,
          chars: text.length,
        },
      });
      return { error: msg };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content?.trim() ?? "";
    recordUsage(modelLabel, json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0);
    // 整段翻译（长文档尤其）是实打实的一次调用，一样进用量账本。上游没回 usage
    // 时按送出去的提示与回来的译文估算，来源如实标注。
    const upstream = currentUpstream();
    recordUsageEvent({
      channel: "translate",
      upstream,
      provider: providerLabelFor(upstream),
      model: modelLabel,
      inputTokens: json.usage?.prompt_tokens ?? estimateTokens(instruction + text),
      outputTokens: json.usage?.completion_tokens ?? estimateTokens(content),
      estimated: json.usage == null,
    });
    if (!content) {
      logEvent({
        level: "error",
        source: "translate",
        event: "translate.model.empty",
        message: "模型未返回译文",
        detail: { model: modelLabel, targetLang: params.targetLang, chars: text.length },
      });
      return { error: "模型未返回译文" };
    }

    if (params.save === false) return { text: content };
    const record = db
      .insert(translationRecords)
      .values({
        sourceLang: params.sourceLang ?? "auto",
        targetLang: params.targetLang,
        text,
        result: content,
        model: modelLabel,
      })
      .returning()
      .get();

    return { text: content, id: record.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function listTranslationRecords(limit = 100): TranslationRecordRow[] {
  return db
    .select()
    .from(translationRecords)
    .orderBy(desc(translationRecords.createdAt))
    .limit(limit)
    .all()
    .map((r) => ({ ...r, createdAt: r.createdAt ?? 0 }));
}

export function deleteTranslationRecord(id: number): { ok: boolean } {
  db.delete(translationRecords).where(eq(translationRecords.id, id)).run();
  return { ok: true };
}
