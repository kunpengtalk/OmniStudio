import { eq, desc } from "drizzle-orm";
import { db } from "./db";
import { translationRecords } from "./db/schema";
import { getSetting } from "./db/settings";
import { getChatModelLabel, getChatRequestModelId } from "./chat-model";
import { ensureServerReady, getChatBaseUrl, maxOutputTokens } from "./chat";
import { recordUsage } from "./stats";
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

/** 谷歌「浏览器同款」免费翻译接口（gtx），国内网络自动走系统代理。 */
let cachedProxy: string | null | undefined;

async function detectSystemProxy(): Promise<string | null> {
  if (cachedProxy !== undefined) return cachedProxy;
  try {
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["scutil", "--proxy"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const get = (k: string) =>
        out.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
      const enabled = get("HTTPSEnable") || get("HTTPEnable");
      const host = get("HTTPSProxy") || get("HTTPProxy");
      const port = get("HTTPSPort") || get("HTTPPort");
      cachedProxy = enabled === "1" && host && port ? `http://${host}:${port}` : null;
      return cachedProxy;
    }
  } catch {
    // 探测失败按无代理处理
  }
  cachedProxy = null;
  return null;
}

async function googleTranslate(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string> {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || (await detectSystemProxy());
  const prev = process.env.HTTPS_PROXY;
  if (proxy) process.env.HTTPS_PROXY = proxy;
  try {
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
  } finally {
    if (prev === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prev;
  }
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
  if (!text) return { error: "待翻译文本不能为空" };
  if (!params.targetLang) return { error: "未指定目标语言" };

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
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 请求里填本地服务器认的 id（MLX 是绝对路径）；记录与展示仍用服务名。
  const model = getChatRequestModelId();
  const modelLabel = getChatModelLabel() || model;
  const base = getChatBaseUrl();
  if (!model || !base) {
    return { error: !model ? "未配置模型" : "未配置推理服务器" };
  }

  if (getSetting("SERVER_MODE") === "local") {
    const ready = await ensureServerReady();
    if (!ready.ok) return { error: ready.error || "推理服务器未就绪" };
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
      return { error: msg };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content?.trim() ?? "";
    recordUsage(modelLabel, json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0);
    if (!content) return { error: "模型未返回译文" };

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
