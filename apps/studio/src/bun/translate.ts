import { getSetting } from "./db/settings";
import { getChatModelName } from "./chat-model";
import { ensureServerReady, getChatBaseUrl } from "./chat";
import { recordUsage } from "./stats";
import { translationLangLabel } from "../shared/translate";

/**
 * 翻译一段文本：把原文发给当前对话模型，返回译文。
 * 模型与服务器配置完全复用聊天（getChatModelName / SERVER_MODE / VLLM_API_*），
 * 本地模式下若推理服务器未就绪会自动启动并等待。
 */
export async function runTranslation(params: {
  text: string;
  sourceLang?: string;
  targetLang: string;
}): Promise<{ text?: string; error?: string }> {
  const text = (params.text ?? "").trim();
  if (!text) return { error: "待翻译文本不能为空" };
  if (!params.targetLang) return { error: "未指定目标语言" };

  const model = getChatModelName();
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
    recordUsage(model, json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0);
    return { text: content };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
