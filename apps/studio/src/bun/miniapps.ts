/**
 * 小应用（Mini Apps）在**主进程**侧的三件事：能力探测、一次性文本补全、产物落盘。
 *
 * 界面上的应用中心只负责"能不能跑"和"跑起来"，真正干活的是这里：
 *   - `getMiniAppCapabilities()`：把生图 / 修图 / ASR / 对话四类能力问一遍，
 *     卡片据此显示「需配置」而不是让用户点进去撞一堵错误墙；
 *   - `completeText()`：一次性补全（会议纪要的总结、文案助手），与翻译页同一套
 *     后端解析（本地推理服务器 / 云端厂商），小应用不需要知道这些；
 *   - `saveMiniAppFile()`：小应用里的 canvas / 文本产物是 dataUrl，落盘走这里
 *     （文件名净化 + 体积上限 + 只认 data: 开头的 base64）。
 *
 * 这里刻意不 import electrobun：本模块要能在 `bun test` 里单独加载。落盘目录由
 * 调用方（RPC 层，那里本来就有 Utils）传进来。
 */
import { mkdirSync, existsSync, writeFileSync } from "fs";
import path from "path";

import { getSetting } from "./db/settings";
import { ensureServerReady, getChatBaseUrl, maxOutputTokens } from "./chat";
import { getChatModelLabel, getChatProviderLabel, getChatRequestModelId } from "./chat-model";
import { getImageGenConfig } from "./image-gen";
import { anyReadyModel } from "./bg-remove";
import { resolveCloudProvider } from "./cloud-providers";
import { getASRProviderConfig, listAsrModels } from "./asr";
import { logEvent } from "./app-log";
import { safeBaseName } from "./path-safety";
import type {
  MiniAppCapability,
  MiniAppCapabilitySnapshot,
  MiniAppCapabilityState,
} from "../shared/miniapps";

// ---------------------------------------------------------------------------
// 能力探测
// ---------------------------------------------------------------------------

function state(ready: boolean, label: string): MiniAppCapabilityState {
  return { ready, label };
}

/** 生图后端的人类可读名（就绪时显示"用的是什么"，让用户对得上设置页）。 */
function imageBackendLabel(): string {
  const cfg = getImageGenConfig();
  if (cfg.backend === "mlx") return `MLX · ${getSetting("MLX_MODEL") || "未选模型"}`;
  if (cfg.backend === "comfyui") return `ComfyUI · ${cfg.comfyBase || "未填地址"}`;
  if (!cfg.model) return "";
  // 生图厂商与"当前激活的对话厂商"不是同一件事：这里按生图自己存的 providerId 取名字。
  const provider = resolveCloudProvider(cfg.providerId);
  return `${provider?.name ?? "云端"} · ${cfg.model}`;
}

/**
 * 四类能力各自是否可用 + 用的是哪个后端。
 *
 * 判定口径与各功能页自己的"未配置"提示保持一致（同一个 resolve）：小应用说"能跑"
 * 而设置页说"没配"，是最容易让人失去信任的一类不一致。
 */
export function getMiniAppCapabilities(): MiniAppCapabilitySnapshot {
  const imageCfg = getImageGenConfig();
  const imageReady =
    imageCfg.backend === "mlx"
      ? Boolean(getSetting("MLX_MODEL"))
      : imageCfg.backend === "comfyui"
        ? Boolean(imageCfg.comfyBase)
        : Boolean(imageCfg.apiBase && imageCfg.model);
  // 参考图（以图改图）只有 OpenAI 兼容云端后端支持，见 image-gen.ts。
  const imageEditReady = imageReady && imageCfg.backend === "api";

  const chatReady = Boolean(getChatBaseUrl() && getChatRequestModelId());
  const chatLabel = getChatProviderLabel()
    ? `${getChatProviderLabel()} · ${getChatModelLabel()}`
    : getChatModelLabel();

  const provider = getASRProviderConfig();
  const localAsr = listAsrModels().find((m) => m.installedPath);
  const asrReady = Boolean(provider.base && provider.model) || Boolean(localAsr);
  const asrLabel = provider.base && provider.model ? provider.model : (localAsr?.label ?? "");

  const capabilities: Record<MiniAppCapability, MiniAppCapabilityState> = {
    image: state(imageReady, imageReady ? imageBackendLabel() : ""),
    imageEdit: state(imageEditReady, imageEditReady ? imageBackendLabel() : ""),
    chat: state(chatReady, chatReady ? chatLabel : ""),
    asr: state(asrReady, asrReady ? asrLabel : ""),
    // 本地抠图：引擎（ONNX WASM 运行时）随应用一起发，缺的只是权重文件，而权重能在
    // 小应用里自己下载 —— 所以这里**永远 ready**，label 只回答"模型在不在本地"。
    // 若按"权重已下载"判定 ready，没下过模型的用户会在应用中心就被拦在门外，
    // 而门里正是那个下载按钮。
    bgRemove: state(true, bgRemoveLabel()),
    // 纯本机处理（马赛克）：没有模型、没有厂商，也就没有"未配置"这回事。
    local: state(true, ""),
  };
  return capabilities;
}

/** 本地抠图能力的说明文案：就绪时显示用的是哪个模型，否则说明可以进去下。 */
function bgRemoveLabel(): string {
  const ready = anyReadyModel();
  return ready ? `本地 · ${ready}` : "本地引擎 · 进入后可下载模型";
}

// ---------------------------------------------------------------------------
// 一次性文本补全
// ---------------------------------------------------------------------------

export type CompleteTextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompleteTextParams = {
  system?: string;
  messages: CompleteTextMessage[];
  maxTokens?: number;
  temperature?: number;
};

/** 小应用能塞进来的文本上限：一次性补全不是长文档管道，超了直接拒（而不是让请求挂死）。 */
const MAX_INPUT_CHARS = 60_000;

/**
 * 一次不带流式的对话补全 —— 翻译页用同一套后端，但那条路径只做翻译。
 *
 * 与 `translate.ts` 保持同样的解析顺序：先看本地推理服务器是否就绪（本地模式），
 * 再用 `getChatBaseUrl()` + `getChatRequestModelId()` 拼请求；失败一律写日志，
 * 因为小应用里看到的只有一句错误文案。
 */
export async function completeText(
  params: CompleteTextParams,
): Promise<{ text: string; model?: string; error?: string }> {
  const messages = (params.messages ?? []).filter(
    (m) => m && typeof m.content === "string" && m.content.length > 0,
  );
  const system = params.system?.trim();
  if (messages.length === 0 && !system) return { text: "", error: "没有可用的输入内容" };

  const chars =
    messages.reduce((n, m) => n + m.content.length, 0) + (system?.length ?? 0);
  if (chars > MAX_INPUT_CHARS) {
    return {
      text: "",
      error: `输入过长（${chars} 字符，上限 ${MAX_INPUT_CHARS}）——请先分段再发送`,
    };
  }

  const base = getChatBaseUrl();
  const model = getChatRequestModelId();
  if (!base || !model) {
    logEvent({
      level: "warn",
      source: "miniapp",
      event: "miniapp.text.not_configured",
      message: !model ? "未配置对话模型" : "未配置推理服务器",
      detail: { hasModel: Boolean(model), hasBase: Boolean(base) },
    });
    return { text: "", error: !model ? "未配置对话模型" : "未配置推理服务器" };
  }

  if (getSetting("SERVER_MODE") === "local") {
    const ready = await ensureServerReady();
    if (!ready.ok) {
      logEvent({
        level: "error",
        source: "miniapp",
        event: "miniapp.text.server_not_ready",
        message: ready.error || "推理服务器未就绪",
        detail: { model },
      });
      return { text: "", error: ready.error || "推理服务器未就绪" };
    }
  }

  const apiKey = getSetting("VLLM_API_KEY");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "EMPTY") headers.Authorization = `Bearer ${apiKey}`;

  const payload: Record<string, unknown> = {
    model,
    messages: system ? [{ role: "system", content: system }, ...messages] : messages,
    max_tokens: params.maxTokens ?? maxOutputTokens(),
    stream: false,
  };
  if (typeof params.temperature === "number") payload.temperature = params.temperature;

  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const message = body
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
        source: "miniapp",
        event: "miniapp.text.failed",
        message,
        detail: { status: res.status, model, chars },
      });
      return { text: "", error: message };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text) {
      logEvent({
        level: "warn",
        source: "miniapp",
        event: "miniapp.text.empty",
        message: "模型返回了空内容",
        detail: { model, chars },
      });
      return { text: "", model, error: "模型没有返回内容" };
    }
    return { text, model };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "miniapp",
      event: "miniapp.text.failed",
      message,
      detail: { model, chars, error: e },
    });
    return { text: "", error: message };
  }
}

// ---------------------------------------------------------------------------
// 产物落盘
// ---------------------------------------------------------------------------

/** 单个小应用产物的体积上限（解码前 base64 长度按 ~1.37 倍折算）。 */
const MAX_DATA_URL_BYTES = 24 * 1024 * 1024;

const DATA_URL_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
};

export type SaveMiniAppFileResult = { ok: boolean; path?: string; error?: string };

/**
 * 把 `data:<mime>;base64,<...>` 存成文件（重名自动加序号，不覆盖已存在的文件）。
 *
 * 目录由调用方给（RPC 层传系统下载目录）。文件名过 `safeBaseName`，扩展名按 mime
 * 决定而不是听小应用的 —— 否则一个叫 `x.sh` 的 PNG 就会带着可执行后缀落进下载目录。
 */
export function saveMiniAppFile(params: {
  name: string;
  dataUrl: string;
  directory: string;
}): SaveMiniAppFileResult {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    (params.dataUrl ?? "").trim(),
  );
  if (!match) {
    logEvent({
      level: "warn",
      source: "miniapp",
      event: "miniapp.save.rejected",
      message: "不是合法的 base64 dataUrl",
      detail: { name: params.name, prefix: (params.dataUrl ?? "").slice(0, 40) },
    });
    return { ok: false, error: "只接受 base64 的 data: 地址" };
  }
  const mime = match[1]!.toLowerCase();
  const ext = DATA_URL_EXT[mime];
  if (!ext) return { ok: false, error: `不支持的文件类型：${mime}` };

  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.byteLength === 0) return { ok: false, error: "内容为空" };
  if (bytes.byteLength > MAX_DATA_URL_BYTES) {
    return {
      ok: false,
      error: `文件过大（${Math.round(bytes.byteLength / 1024 / 1024)}MB，上限 ${MAX_DATA_URL_BYTES / 1024 / 1024}MB）`,
    };
  }

  const raw = safeBaseName(params.name) || `miniapp-${Date.now()}`;
  const stem = path.basename(raw, path.extname(raw)).slice(0, 80) || `miniapp-${Date.now()}`;
  const directory = params.directory;
  if (!directory) return { ok: false, error: "保存目录不可用" };

  try {
    mkdirSync(directory, { recursive: true });
    let dest = path.join(directory, `${stem}.${ext}`);
    let i = 1;
    while (existsSync(dest)) {
      dest = path.join(directory, `${stem} (${i}).${ext}`);
      i++;
    }
    writeFileSync(dest, bytes);
    return { ok: true, path: dest };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "miniapp",
      event: "miniapp.save.failed",
      message,
      detail: { name: raw, mime, bytes: bytes.byteLength, directory },
    });
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// 读回用户刚选的文件
// ---------------------------------------------------------------------------

/**
 * 小应用要显示用户选的文件，但沙箱 iframe 里拿不到本地路径（`file://` 在
 * opaque origin 下打不开）—— 于是由宿主读成 dataUrl 带回去。
 *
 * **必须在宿主侧先过 `isDialogPickedPath`**（调用方做）：这条路径直接来自 iframe，
 * 不校验就等于给了小应用一个"读磁盘任意文件"的接口。
 */
const MAX_READ_BYTES = 32 * 1024 * 1024;

export const MINIAPP_READABLE_EXT = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "wav",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "flac",
  "webm",
  "mp4",
  "txt",
  "md",
  "json",
] as const;

const READ_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "video/webm",
  mp4: "video/mp4",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
};

export async function readPickedFileAsDataUrl(
  filePath: string,
): Promise<{ ok: boolean; dataUrl?: string; name?: string; size?: number; error?: string }> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = READ_MIME[ext];
  if (!mime) {
    logEvent({
      level: "warn",
      source: "miniapp",
      event: "miniapp.read.rejected",
      message: "不支持的文件类型",
      detail: { ext },
    });
    return { ok: false, error: `不支持的文件类型：.${ext}` };
  }
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return { ok: false, error: "文件不存在" };
    const size = file.size;
    if (size > MAX_READ_BYTES) {
      return {
        ok: false,
        error: `文件过大（${Math.round(size / 1024 / 1024)}MB，上限 ${MAX_READ_BYTES / 1024 / 1024}MB）`,
      };
    }
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${base64}`,
      name: path.basename(filePath),
      size,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "miniapp",
      event: "miniapp.read.failed",
      message,
      detail: { ext, error: e },
    });
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// 小应用自报的日志
// ---------------------------------------------------------------------------

/**
 * 小应用写进 app.log 的转义口。
 *
 * 小应用跑在 iframe 里，它自己的报错宿主看不见（跨源、不许读它的 console），
 * 于是"点了没反应"就完全没有线索 —— 这条通道是排查的唯一入口，必须留着；
 * 但也必须限流，否则一个循环里报错的小应用能把 2MB 的日志刷爆、把别人的记录挤掉。
 */
const LOG_BUDGET_PER_MINUTE = 30;
let logWindowStart = 0;
let logWindowCount = 0;

export function logFromMiniApp(params: {
  appId: string;
  event: string;
  message?: string;
  detail?: unknown;
}): { ok: boolean; dropped?: boolean } {
  const now = Date.now();
  if (now - logWindowStart > 60_000) {
    logWindowStart = now;
    logWindowCount = 0;
  }
  logWindowCount += 1;
  if (logWindowCount > LOG_BUDGET_PER_MINUTE) return { ok: true, dropped: true };

  logEvent({
    level: "info",
    source: "miniapp",
    event: `miniapp.${params.appId}.${params.event}`.slice(0, 120),
    message: (params.message ?? "").slice(0, 500),
    detail: { appId: params.appId, detail: params.detail },
  });
  return { ok: true };
}
