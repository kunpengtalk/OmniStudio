import { randomUUID } from "crypto";

import * as ImageGen from "./image-gen";
import * as MlxGen from "./mlx-gen";

/**
 * Agent 的「需要用户介入」通道。
 *
 * 生图这类会花钱 / 依赖本地资源的动作，Agent 自己判断不了两件事：用户想用哪个后端 /
 * 哪个模型，以及本地模型有没有准备好。这里让工具在开跑之前把问题抛给界面
 * （弹窗 → 用户配置或选择 → 回传），拿到结果再继续同一次工具调用：
 *
 *   generate_image
 *     → 检查后端就绪（缺配置 / 缺模型 / 缺引擎）
 *     → 弹窗让用户配好并确认
 *     → 用户没指定模型时扫一遍候选；有多个候选再弹一次让他确认用哪个
 *     → 用确认后的配置生图
 *
 * 界面侧通过 `onMediaSetup` 收到 payload 渲染弹窗，并调用 RPC `resolveMediaSetup` 回传；
 * Agent 被中断（停止按钮）时用 `cancelMediaSetup()` 让等待中的工具立即收尾。
 */

export type MediaSetupReason = "missing-config" | "missing-assets" | "choose-model";

export type MediaSetupCandidate = {
  id: string;
  label: string;
  /** 补充说明（体积 / 来源 / 下载状态）。 */
  note?: string;
  /** 已经可以直接用（已下载，或远端扫描到的模型）。 */
  ready?: boolean;
};

export type MediaSetupBackendOption = {
  id: ImageGen.ImageGenBackend;
  /** i18n key，界面按当前语言渲染。 */
  labelKey: string;
  ready: boolean;
  /** 一句话状态（已填的地址 / 缺什么）。 */
  note?: string;
};

export type MediaSetupPayload = {
  id: string;
  kind: "image";
  reason: MediaSetupReason;
  /** 给用户看的一句话：为什么弹这个窗。 */
  message: string;
  backend: ImageGen.ImageGenBackend;
  config: {
    apiBase: string;
    apiKey: string;
    comfyBase: string;
    model: string;
  };
  candidates: MediaSetupCandidate[];
  backends: MediaSetupBackendOption[];
};

export type MediaSetupAnswer = {
  action: "confirm" | "cancel";
  backend?: string;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  comfyBase?: string;
};

export type MediaSetupListener = (payload: MediaSetupPayload) => void;

const listeners = new Set<MediaSetupListener>();
const pending = new Map<
  string,
  { finish: (answer: MediaSetupAnswer) => void; timer: ReturnType<typeof setTimeout> }
>();

/** 等用户确认的最长时间：用户可能要去装引擎 / 下模型。 */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function onMediaSetup(cb: MediaSetupListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 中断所有等待中的弹窗（用户点了停止、或会话被重置）。 */
export function cancelMediaSetup(): void {
  for (const entry of [...pending.values()]) entry.finish({ action: "cancel" });
}

/**
 * 推一个弹窗并等用户回答。
 * 没有界面在监听时（CLI / 测试）直接按"取消"返回，避免工具调用挂到超时。
 */
export function requestMediaSetup(
  input: Omit<MediaSetupPayload, "id">,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MediaSetupAnswer> {
  if (listeners.size === 0) return Promise.resolve({ action: "cancel" });

  // 同一时刻只留一个待确认弹窗：新的来了就把旧的按取消收尾，避免弹窗叠加。
  cancelMediaSetup();

  const id = randomUUID();
  const payload: MediaSetupPayload = { id, ...input };

  return new Promise<MediaSetupAnswer>((resolve) => {
    let done = false;
    const finish = (answer: MediaSetupAnswer) => {
      if (done) return;
      done = true;
      const entry = pending.get(id);
      if (entry) clearTimeout(entry.timer);
      pending.delete(id);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = () => finish({ action: "cancel" });

    if (opts.signal?.aborted) return finish({ action: "cancel" });
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => finish({ action: "cancel" }), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    pending.set(id, { finish, timer });
    for (const cb of listeners) {
      try {
        cb(payload);
      } catch {
        // 界面监听抛错不应该影响工具调用。
      }
    }
  });
}

/** 界面回传用户的选择（RPC `resolveMediaSetup` 调用）。 */
export function resolveMediaSetup(id: string, answer: MediaSetupAnswer): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.finish(answer);
  return true;
}

/** 弹窗里的用户选择落盘到生图配置（只覆盖用户实际改过的字段）。 */
export function applyMediaSetupAnswer(answer: MediaSetupAnswer): void {
  if (answer.action !== "confirm") return;
  const patch: Partial<ImageGen.ImageGenConfig> = {};
  if (answer.backend === "api" || answer.backend === "mlx" || answer.backend === "comfyui") {
    patch.backend = answer.backend;
  }
  if (answer.apiBase !== undefined) patch.apiBase = answer.apiBase;
  if (answer.apiKey !== undefined) patch.apiKey = answer.apiKey;
  if (answer.comfyBase !== undefined) patch.comfyBase = answer.comfyBase;
  if (answer.model !== undefined) patch.model = answer.model;
  if (Object.keys(patch).length > 0) ImageGen.saveImageGenConfig(patch);
}

// ---------------------------------------------------------------------------
// 候选模型 / 后端状态
// ---------------------------------------------------------------------------

/** 扫描某个后端下可用的模型（弹窗里「扫描模型」与工具侧的二次确认共用）。 */
export async function scanSetupCandidates(input: {
  kind?: string;
  backend?: string;
  base?: string;
  apiKey?: string;
}): Promise<{ candidates: MediaSetupCandidate[]; error?: string }> {
  if ((input.kind ?? "image") !== "image") return { candidates: [], error: "暂不支持该素材类型" };
  const cfg = ImageGen.getImageGenConfig();
  const backend = (input.backend as ImageGen.ImageGenBackend) || cfg.backend;

  try {
    if (backend === "mlx") {
      const downloaded = new Set(await MlxGen.getDownloadedMlxModels());
      let engineInstalled = false;
      try {
        engineInstalled = (await MlxGen.getMlxGenStatus()).engineInstalled;
      } catch {
        // 探测失败按未安装处理，候选照给（界面会提示先装引擎）。
      }
      return {
        candidates: MlxGen.MLX_MODELS.map((m) => ({
          id: m.id,
          label: m.label,
          note: `${m.approxSizeGb} GB · ${m.description}`,
          ready: engineInstalled && downloaded.has(m.id),
        })),
      };
    }
    if (backend === "comfyui") {
      const base = (input.base ?? cfg.comfyBase).trim();
      if (!base) return { candidates: [], error: "请先填写 ComfyUI 地址" };
      const models = await ImageGen.listComfyCheckpoints(base);
      return { candidates: models.map((m) => ({ id: m, label: m, ready: true })) };
    }
    const base = (input.base ?? cfg.apiBase).trim();
    if (!base) return { candidates: [], error: "请先填写服务地址" };
    const models = await ImageGen.listImageApiModels(base, (input.apiKey ?? cfg.apiKey).trim());
    return { candidates: models.map((m) => ({ id: m, label: m, ready: true })) };
  } catch (e) {
    return { candidates: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** 三个生图后端 + 各自是否就绪（弹窗顶部让用户切换用）。 */
export async function imageBackendOptions(): Promise<MediaSetupBackendOption[]> {
  const cfg = ImageGen.getImageGenConfig();
  let mlxReady = false;
  let mlxNote = "无法检测";
  try {
    const status = await MlxGen.getMlxGenStatus();
    const downloaded = await MlxGen.getDownloadedMlxModels();
    mlxReady = status.engineInstalled && downloaded.length > 0;
    mlxNote = !status.engineInstalled
      ? "引擎未安装"
      : downloaded.length > 0
        ? `已下载 ${downloaded.length} 个模型`
        : "还没有下载模型";
  } catch {
    // 保持默认提示。
  }
  return [
    {
      id: "api",
      labelKey: "image.backend.cloud",
      ready: !!cfg.apiBase && !!cfg.model,
      note: cfg.apiBase || "未填服务地址",
    },
    { id: "mlx", labelKey: "image.backend.mlx", ready: mlxReady, note: mlxNote },
    {
      id: "comfyui",
      labelKey: "image.backend.comfyui",
      ready: !!cfg.comfyBase && !!cfg.model,
      note: cfg.comfyBase || "未填服务地址",
    },
  ];
}

// ---------------------------------------------------------------------------
// 生图前的就绪检查
// ---------------------------------------------------------------------------

type ImageReadiness =
  | { ok: true }
  | { ok: false; reason: MediaSetupReason; message: string };

async function checkImageReadiness(
  cfg: ImageGen.ImageGenConfig,
  /** 本次实际要用的模型（工具调用里显式指定时优先）。 */
  model: string,
): Promise<ImageReadiness> {
  if (cfg.backend === "api") {
    if (!cfg.apiBase) {
      return {
        ok: false,
        reason: "missing-config",
        message: "生图后端是「OpenAI 兼容 API」，但还没填写服务地址（Base URL）。",
      };
    }
    if (!model) {
      return { ok: false, reason: "choose-model", message: "服务地址已填，但还没选定生图模型。" };
    }
    return { ok: true };
  }

  if (cfg.backend === "comfyui") {
    if (!cfg.comfyBase) {
      return {
        ok: false,
        reason: "missing-config",
        message: "生图后端是本地 ComfyUI，但还没填写服务地址。",
      };
    }
    if (!model) {
      return { ok: false, reason: "choose-model", message: "ComfyUI 地址已填，但还没选定 checkpoint。" };
    }
    return { ok: true };
  }

  // mlx：引擎 → 权重 → 选定模型，三者齐了才能跑。
  let engineInstalled = false;
  try {
    engineInstalled = (await MlxGen.getMlxGenStatus()).engineInstalled;
  } catch {
    // 探测失败按未安装处理。
  }
  if (!engineInstalled) {
    return {
      ok: false,
      reason: "missing-assets",
      message: "本地 MLX 生图引擎还没安装（需要在弹窗里安装，或到「图像」页处理）。",
    };
  }
  const downloaded = await MlxGen.getDownloadedMlxModels();
  if (downloaded.length === 0) {
    return {
      ok: false,
      reason: "missing-assets",
      message: "MLX 引擎已安装，但还没有下载任何生图模型权重。",
    };
  }
  if (model && !downloaded.includes(model)) {
    return {
      ok: false,
      reason: "missing-assets",
      message: `选定的 MLX 模型「${model}」还没下载好。`,
    };
  }
  if (!model) {
    return {
      ok: false,
      reason: "choose-model",
      message: "MLX 引擎与模型权重都就绪了，请确认用哪个模型生图。",
    };
  }
  return { ok: true };
}

function dialogPayload(
  reason: MediaSetupReason,
  message: string,
  cfg: ImageGen.ImageGenConfig,
  extra: { candidates?: MediaSetupCandidate[]; backends: MediaSetupBackendOption[] },
): Omit<MediaSetupPayload, "id"> {
  return {
    kind: "image",
    reason,
    message,
    backend: cfg.backend,
    config: {
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      comfyBase: cfg.comfyBase,
      model: cfg.model,
    },
    candidates: extra.candidates ?? [],
    backends: extra.backends,
  };
}

const CANCEL_MESSAGE =
  "用户取消了这次生图的配置（弹窗里点了取消）。本轮不要重试生图，直接告诉用户：需要先在弹窗或「图像」页把生图后端与模型准备好，之后让你继续。";

/**
 * 生图前的准备：该弹窗就弹窗，拿到用户确认后返回最终要用的模型。
 * 调用方（generate_image）用返回的模型去生成；`ok: false` 时把 message 交回给模型。
 */
export async function prepareImageGeneration(
  opts: { signal?: AbortSignal; explicitModel?: string } = {},
): Promise<{ ok: true; model: string } | { ok: false; message: string }> {
  let cfg = ImageGen.getImageGenConfig();
  let state = await checkImageReadiness(cfg, opts.explicitModel?.trim() || cfg.model);

  if (!state.ok) {
    const answer = await requestMediaSetup(
      dialogPayload(state.reason, state.message, cfg, { backends: await imageBackendOptions() }),
      { signal: opts.signal },
    );
    if (answer.action !== "confirm") return { ok: false, message: CANCEL_MESSAGE };
    applyMediaSetupAnswer(answer);
    cfg = ImageGen.getImageGenConfig();
    state = await checkImageReadiness(cfg, opts.explicitModel?.trim() || cfg.model);
  }

  // 用户没在弹窗里指定模型（比如只填了地址）：扫一遍候选，多个候选再确认一次用哪个。
  if (!opts.explicitModel?.trim() && !cfg.model) {
    const { candidates, error } = await scanSetupCandidates({ kind: "image", backend: cfg.backend });
    const ready = candidates.filter((c) => c.ready !== false);
    if (ready.length === 0) {
      // 有两种"没有可用候选"：扫不到（地址/服务不通），或扫到了但都还没下载好。
      const detail =
        candidates.length > 0
          ? "候选模型都还没下载完成（或本地引擎未安装）"
          : (error ?? "没有扫描到可用模型");
      return {
        ok: false,
        message: `生图后端仍未就绪：${detail}。先不要重试生图，等用户准备好再继续。`,
      };
    }
    if (ready.length === 1) {
      ImageGen.saveImageGenConfig({ model: ready[0]!.id });
    } else {
      const picked = await requestMediaSetup(
        dialogPayload(
          "choose-model",
          `生图后端已就绪，扫描到 ${ready.length} 个可用模型，请确认用哪个生图。`,
          ImageGen.getImageGenConfig(),
          { candidates: ready, backends: await imageBackendOptions() },
        ),
        { signal: opts.signal },
      );
      if (picked.action !== "confirm") return { ok: false, message: CANCEL_MESSAGE };
      applyMediaSetupAnswer(picked);
      // 用户没点具体模型时用第一个候选，避免又回到"缺模型"的状态。
      if (!picked.model?.trim()) ImageGen.saveImageGenConfig({ model: ready[0]!.id });
    }
    cfg = ImageGen.getImageGenConfig();
    state = await checkImageReadiness(cfg, opts.explicitModel?.trim() || cfg.model);
  }

  if (!state.ok) {
    return {
      ok: false,
      message: `${state.message}（用户还没完成准备，先不要重试生图；等他准备好再继续。）`,
    };
  }
  return { ok: true, model: opts.explicitModel?.trim() || cfg.model };
}
