import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import path from "path";
import { getSetting, updateSettings, getActiveServerPort } from "./db/settings";
import { localModelPath, installedModelSize } from "./modelscope";
import {
  getAudioBaseDir,
  insertVoiceRecord,
  resolveAudioPath,
  voiceRecordToRow,
  type VoiceRecordRow,
} from "./voice";
import { ASR_PRESETS, DEFAULT_ASR_MODEL_FILE } from "../shared/modelscope";
import { runAsrAudioCpp } from "./asr-audiocpp";
import { getWhisperEngineInfo, resolveWhisperBinary } from "./whisper-engine";
import {
  normalizeSegments,
  num,
  type AsrSegment,
  type SegSource,
} from "./asr-parse";

export type { AsrSegment } from "./asr-parse";

export type AsrModelItem = {
  id: string;
  label: string;
  description: string;
  repo: string;
  fileName: string;
  sizeBytes: number;
  installedSize: number | null;
  installedPath: string | null;
};

export type AsrStatus = {
  engine: "none" | "whisper-cli" | "whisper-server";
  engineInstalled: boolean;
  engineVersion: string | null;
  binaryPath: string | null;
  serverRunning: boolean;
  activeModel: string | null;
  port: number;
};

export type AsrSource = "auto" | "local" | "remote";

export type AsrTranscript = {
  text: string;
  engine: string;
  segments: AsrSegment[];
  /** true when the provider returned per-segment speaker labels. */
  hasSpeakers: boolean;
  record?: VoiceRecordRow;
};

type Subprocess = ReturnType<typeof Bun.spawn>;

let serverProc: Subprocess | null = null;
let serverStatus: "stopped" | "starting" | "running" | "error" = "stopped";
let serverError = "";

// ---------------------------------------------------------------------------
// Model list & resolution
// ---------------------------------------------------------------------------

/** ASR presets enriched with install state (whisper.cpp models live in the model dir). */
export function listAsrModels(): AsrModelItem[] {
  return ASR_PRESETS.map((p) => {
    const pth = localModelPath(p.repo, p.fileName);
    const installed = existsSync(pth);
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      repo: p.repo,
      fileName: p.fileName,
      sizeBytes: p.sizeBytes,
      installedSize: installed ? installedModelSize(p.repo, p.fileName) : null,
      installedPath: installed ? pth : null,
    };
  });
}

/** 按引用解析本地模型路径：绝对路径直接返回，文件名则匹配预设仓库。 */
function resolveFile(ref: string): string | null {
  if (path.isAbsolute(ref) && existsSync(ref)) return ref;
  const preset = ASR_PRESETS.find((p) => p.fileName === ref);
  if (preset) {
    const pth = localModelPath(preset.repo, preset.fileName);
    if (existsSync(pth)) return pth;
  }
  return null;
}

/**
 * 解析本地 ASR 模型路径，优先级：
 * 1. 显式传入的模型（用户在界面上点「启动」→ whisper-server 用这个模型）；
 * 2. ASR_MODEL 设置（含默认值 Whisper large-v3-turbo）；
 * 3. 兜底：未配置任何模型时，默认使用 Whisper large-v3-turbo（已下载才可用）。
 *
 * 小模型（tiny/base/small）多语言转写效果差、中文几乎不可用：当设置指向这类
 * 模型而默认 turbo 已下载时，直接升级到 turbo（这是默认行为，不是用户当前选择）。
 */
export function resolveModelPath(model?: string): string | null {
  const explicit = model?.trim();
  if (explicit) {
    const p = resolveFile(explicit);
    if (p) return p;
  }
  const configured = getSetting("ASR_MODEL").trim();
  const conf = configured ? resolveFile(configured) : null;
  if (conf) {
    const base = path.basename(conf);
    if (
      (base === "tiny.bin" || base === "base.bin" || base === "small.bin") &&
      resolveFile(DEFAULT_ASR_MODEL_FILE)
    ) {
      return resolveFile(DEFAULT_ASR_MODEL_FILE)!;
    }
    return conf;
  }
  return resolveFile(DEFAULT_ASR_MODEL_FILE);
}

/**
 * 解析 ASR 识别语言：`auto`/空 表示交给 whisper 自动检测（此时不传参）。
 * 默认按设置 ASR_LANG（中文）强制指定，避免短句中文被误判成英文。
 */
export function resolveAsrLanguage(input?: string): string | null {
  const lang = (input ?? getSetting("ASR_LANG") ?? "auto").trim().toLowerCase();
  return lang && lang !== "auto" ? lang : null;
}

export async function getAsrStatus(): Promise<AsrStatus> {
  const [server, cli] = await Promise.all([
    resolveWhisperBinary("whisper-server"),
    resolveWhisperBinary("whisper-cli"),
  ]);
  const engine = server ? "whisper-server" : cli ? "whisper-cli" : "none";
  return {
    engine,
    engineInstalled: engine !== "none",
    engineVersion: (await getWhisperEngineInfo()).version,
    binaryPath: server ?? cli ?? null,
    serverRunning: serverStatus === "running",
    activeModel: getSetting("ASR_MODEL") || null,
    port: Number(getSetting("ASR_PORT") || 18081),
  };
}

// ---------------------------------------------------------------------------
// whisper-server lifecycle
// ---------------------------------------------------------------------------

export async function startAsr(model?: string): Promise<{ ok: boolean; error?: string }> {
  const modelPath = resolveModelPath(model);
  if (!modelPath) {
    return { ok: false, error: "请先下载并选择一个本地 ASR 模型" };
  }
  const serverBin = await resolveWhisperBinary("whisper-server");
  if (!serverBin) {
    return {
      ok: false,
      error: "未找到 whisper-server，请在引擎状态里点击「安装引擎」自动下载，或以其他方式安装 whisper.cpp",
    };
  }

  await stopAsr();

  const port = Number(getSetting("ASR_PORT") || 18081);
  serverStatus = "starting";
  serverError = "";

  const proc = Bun.spawn(
    [serverBin, "-m", modelPath, "--host", "127.0.0.1", "--port", String(port)],
    { stdout: "pipe", stderr: "pipe" },
  );
  serverProc = proc;

  const errChunks: Uint8Array[] = [];
  if (proc.stderr && typeof proc.stderr !== "number") {
    void (async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        errChunks.push(value);
      }
    })();
  }
  proc.exited
    .then((code) => {
      if (serverProc === proc) serverProc = null;
      if (serverStatus === "running" && code !== 0) {
        serverStatus = "error";
        serverError = Buffer.concat(errChunks).toString("utf8").slice(-500);
      } else {
        serverStatus = "stopped";
      }
    })
    .catch(() => {
      if (serverProc === proc) serverProc = null;
      serverStatus = "stopped";
    });

  const health = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    // The status is mutated from the process-exit callback, so TS cannot
    // narrow it here; widen the snapshot back to the full union.
    const snap = serverStatus as "stopped" | "starting" | "running" | "error";
    if (snap === "error" || (snap === "stopped" && !serverProc)) break;
    try {
      const r = await fetch(health, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        serverStatus = "running";
        updateSettings({ ASR_MODEL: modelPath });
        return { ok: true };
      }
    } catch {
      // not ready yet
    }
  }

  if (serverStatus !== "running") {
    serverStatus = "error";
    return { ok: false, error: serverError || "whisper-server 启动超时，请检查模型是否正确" };
  }
  return { ok: true };
}

export async function stopAsr(): Promise<void> {
  const proc = serverProc;
  serverProc = null;
  serverStatus = "stopped";
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // already dead
  }
  await Promise.race([
    proc.exited.then(() => true).catch(() => true),
    Bun.sleep(3000).then(() => false),
  ]);
  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}

function buildTranscript(text: string, segments: AsrSegment[], engine: string): AsrTranscript {
  const hasSpeakers = segments.some((s) => s.speaker !== undefined);
  return { text, engine, segments, hasSpeakers };
}

// ---------------------------------------------------------------------------
// OpenAI 兼容 ASR provider（三方服务：Base URL + API Key + 模型）
// ---------------------------------------------------------------------------

export type ASRProviderConfig = {
  base: string;
  apiKey: string;
  model: string;
};

export function getASRProviderConfig(): ASRProviderConfig {
  return {
    base: (getSetting("ASR_PROVIDER_BASE") || "").trim(),
    apiKey: (getSetting("ASR_PROVIDER_API_KEY") || "").trim(),
    model: (getSetting("ASR_PROVIDER_MODEL") || "").trim(),
  };
}

export function saveASRProviderConfig(cfg: {
  base?: string;
  apiKey?: string;
  model?: string;
}): void {
  const settings: Record<string, string> = {};
  if (cfg.base !== undefined) settings.ASR_PROVIDER_BASE = cfg.base.trim();
  if (cfg.apiKey !== undefined) settings.ASR_PROVIDER_API_KEY = cfg.apiKey.trim();
  if (cfg.model !== undefined) settings.ASR_PROVIDER_MODEL = cfg.model.trim();
  updateSettings(settings);
}

function getMainRemoteBaseUrl(): string {
  const isLocal = getSetting("SERVER_MODE") === "local";
  if (isLocal) {
    const host = getSetting("SERVER_HOST") || "127.0.0.1";
    const port = getActiveServerPort();
    return `http://${host}:${port}`;
  }
  return (getSetting("VLLM_API_BASE") || "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

// ---------------------------------------------------------------------------
// Local engine transcription (segments via verbose_json / cli JSON)
// ---------------------------------------------------------------------------

async function postToServer(
  audioPath: string,
  diarize = false,
  lang: string | null = null,
): Promise<AsrTranscript> {
  const port = Number(getSetting("ASR_PORT") || 18081);
  const base = `http://127.0.0.1:${port}`;
  const post = async (endpoint: string, verbose: boolean) => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([await Bun.file(audioPath).arrayBuffer()], { type: "audio/wav" }),
      path.basename(audioPath),
    );
    if (verbose) form.append("response_format", "verbose_json");
    // 显式语言：避免短句中文被 whisper 自动检测误判为英文。
    if (lang) form.append("language", lang);
    // whisper-server 的双声道说话人分离（须同时提交 response_format=verbose_json）。
    if (diarize) form.append("diarize", "true");
    return await fetch(`${base}${endpoint}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(600_000),
    });
  };

  // 老版本用 OpenAI 兼容端点；新版 whisper.cpp（≥1.8）移除了它，回退 /inference。
  let endpoint = "/v1/audio/transcriptions";
  let res = await post(endpoint, true);
  if (res.status === 404) {
    endpoint = "/inference";
    res = await post(endpoint, true);
  }
  // 老版本 whisper-server 可能不认识 verbose_json，回退到普通 JSON。
  if (!res.ok && /response_format|unsupported.*format|invalid.*format/i.test(await res.clone().text())) {
    res = await post(endpoint, false);
  }
  if (!res.ok) throw new Error(`ASR 请求失败（${res.status}）: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json().catch(() => null)) as SegSource & { data?: SegSource } | null;
  const src: SegSource = json?.segments || json?.data?.segments
    ? (json as SegSource | null) ?? {}
    : (json?.data as SegSource | undefined) ?? {};
  const text = src.text ?? "";
  const segments = normalizeSegments(src);
  if (!text && segments.length === 0) {
    const plain = ((json as { text?: string } | null)?.text ?? "") as string;
    if (plain) return buildTranscript(plain, [], "whisper-server");
    throw new Error("转写结果为空");
  }
  return buildTranscript(text || segments.map((s) => s.text).join(""), segments, "whisper-server");
}

async function runCli(
  bin: string,
  modelPath: string,
  audioPath: string,
  lang: string | null = null,
): Promise<AsrTranscript> {
  const tmp = path.join(getAudioBaseDir(), "tmp");
  mkdirSync(tmp, { recursive: true });
  const outBase = path.join(tmp, `whisper-${crypto.randomUUID().slice(0, 8)}`);
  const args = [bin, "-m", modelPath, "-f", audioPath, "-otxt", "-oj", "-of", outBase, "--no-prints"];
  if (lang) args.push("-l", lang);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stderr =
    proc.stderr && typeof proc.stderr !== "number"
      ? await new Response(proc.stderr).text()
      : "";
  const code = await proc.exited;

  const txtPath = `${outBase}.txt`;
  const jsonPath = `${outBase}.json`;
  let text = "";
  let segments: AsrSegment[] = [];
  try {
    if (code === 0 && existsSync(jsonPath)) {
      const json = JSON.parse(readFileSync(jsonPath, "utf8")) as
        | { transcription?: SegSource["segments"]; segments?: SegSource["segments"] }
        | null;
      const arr = json?.transcription ?? json?.segments ?? [];
      if (Array.isArray(arr)) {
        // whisper.cpp CLI reports times in centiseconds; convert to seconds.
        segments = arr
          .map((s) => ({
            start: (num(s.offsets?.from) ?? num(s.start) ?? 0) / 100,
            end: (num(s.offsets?.to) ?? num(s.end) ?? num(s.offsets?.from) ?? num(s.start) ?? 0) / 100,
            text: (s.text ?? "").trim(),
          }))
          .filter((s) => s.text && s.end > s.start);
        text = segments.map((s) => s.text).join(" ");
      }
    }
    if (!text && code === 0 && existsSync(txtPath)) {
      text = readFileSync(txtPath, "utf8").trim();
    }
  } catch {
    segments = [];
    text = "";
  }

  for (const p of [txtPath, jsonPath, `${outBase}.wav`]) rmSync(p, { force: true });

  if (!text) throw new Error(stderr.trim().slice(-400) || `whisper-cli 转写失败（退出码 ${code}）`);
  return buildTranscript(text, segments, "whisper-cli");
}

// ---------------------------------------------------------------------------
// Remote OpenAI-compatible transcription (verbose_json, optional diarization)
// ---------------------------------------------------------------------------

async function postRemoteForm(input: {
  base: string;
  apiKey: string;
  audioPath: string;
  model?: string;
  diarize?: boolean;
  verbose: boolean;
  language?: string | null;
}): Promise<{ text: string; segments: AsrSegment[] }> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([await Bun.file(input.audioPath).arrayBuffer()], { type: "audio/mpeg" }),
    path.basename(input.audioPath),
  );
  if (input.model?.trim()) form.append("model", input.model.trim());
  if (input.verbose) form.append("response_format", "verbose_json");
  // Some OpenAI-compatible providers expose diarization behind this flag.
  if (input.diarize) form.append("diarize", "true");
  // 显式语言提示（OpenAI 兼容端点标准字段）。
  if (input.language) form.append("language", input.language);

  const headers: Record<string, string> = {};
  if (input.apiKey && input.apiKey !== "EMPTY") headers.Authorization = `Bearer ${input.apiKey}`;

  const res = await fetch(`${input.base}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    headers,
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`ASR 请求失败（${res.status}）: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json().catch(() => null)) as SegSource & { data?: SegSource } | null;
  const src: SegSource = json?.segments || json?.data?.segments
    ? (json as SegSource | null) ?? {}
    : (json?.data as SegSource | undefined) ?? {};
  const text = src.text ?? "";
  const segments = normalizeSegments(src);
  if (!text && segments.length === 0) {
    const plain = ((json as { text?: string } | null)?.text ?? "") as string;
    if (plain) return { text: plain, segments: [] };
    throw new Error("转写结果为空");
  }
  return { text: text || segments.map((s) => s.text).join(""), segments };
}

async function transcribeRemote(
  audioPath: string,
  model?: string,
  diarize?: boolean,
  useProvider = true,
  language?: string | null,
): Promise<AsrTranscript> {
  const provider = getASRProviderConfig();
  const configured = useProvider && !!provider.base;
  const base = configured ? provider.base : getMainRemoteBaseUrl();
  if (!base) throw new Error("没有可用的推理服务（本地引擎或远程服务）");
  const apiKey = configured
    ? provider.apiKey || getSetting("VLLM_API_KEY")
    : getSetting("VLLM_API_KEY");
  const m =
    model?.trim() || (configured ? provider.model : "") || undefined;

  try {
    const r = await postRemoteForm({ base, apiKey, audioPath, model: m, diarize, verbose: true, language });
    return buildTranscript(r.text, r.segments, "remote");
  } catch (e) {
    // Some providers reject the verbose_json param; retry without it.
    if (e instanceof Error && /response_format/i.test(e.message)) {
      const r = await postRemoteForm({ base, apiKey, audioPath, model: m, diarize: false, verbose: false, language });
      return buildTranscript(r.text, r.segments, "remote");
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Transcription entry point
// ---------------------------------------------------------------------------

async function pickLocalEngine(): Promise<{ serverBin: string | null; cliBin: string | null }> {
  const [serverBin, cliBin] = await Promise.all([
    resolveWhisperBinary("whisper-server"),
    resolveWhisperBinary("whisper-cli"),
  ]);
  return { serverBin, cliBin };
}

/**
 * Transcribe audio with one of three engines:
 * - "local": the local whisper.cpp engine (whisper-server preferred, else whisper-cli)
 * - "remote": the configured OpenAI-compatible ASR provider (or the main inference server)
 * - "auto": provider → local → main server (default)
 *
 * `wavBase64` is 16k mono 16-bit PCM WAV produced by the webview mic recorder;
 * `audioRef` is a staged file (mp3/wav/m4a…).
 */
export async function transcribeAudio(input: {
  audioRef?: string;
  wavBase64?: string;
  model?: string;
  save?: boolean;
  source?: AsrSource;
  diarize?: boolean;
  /** 识别语言码（zh/en/…）；auto/空 表示由 whisper 自动检测。 */
  language?: string;
}): Promise<AsrTranscript> {
  let audioPath: string | null = null;
  let audioRef: string | null = input.audioRef ?? null;

  if (input.wavBase64) {
    const dir = path.join(getAudioBaseDir(), "in");
    mkdirSync(dir, { recursive: true });
    const name = `rec-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.wav`;
    await Bun.write(path.join(dir, name), Buffer.from(input.wavBase64, "base64"));
    audioRef = `audio/in/${name}`;
    audioPath = path.join(dir, name);
  } else if (input.audioRef) {
    audioPath = resolveAudioPath(input.audioRef);
  }

  if (!audioPath || !existsSync(audioPath)) throw new Error("音频文件不存在");

  const source = input.source ?? "auto";
  const lang = resolveAsrLanguage(input.language);
  const provider = getASRProviderConfig();
  const { serverBin, cliBin } = await pickLocalEngine();
  const hasLocal = !!(serverBin || cliBin);

  const saveRecord = (result: AsrTranscript, model: string | null): AsrTranscript => {
    if (input.save) {
      const record = insertVoiceRecord({
        kind: "asr",
        model,
        text: result.text,
        audioPath: audioRef ?? undefined,
      });
      result.record = voiceRecordToRow(record);
    }
    return result;
  };

  const runWhisperLocal = async (): Promise<{ transcript: AsrTranscript; modelLabel: string }> => {
    const modelPath = resolveModelPath(input.model);
    if (!modelPath) throw new Error("请先下载并选择一个本地 ASR 模型");
    let transcript: AsrTranscript;
    if (serverBin) {
      if (serverStatus !== "running" || getSetting("ASR_MODEL") !== modelPath) {
        const r = await startAsr(modelPath);
        if (!r.ok) throw new Error(r.error);
      }
      transcript = await postToServer(audioPath, input.diarize, lang);
    } else {
      transcript = await runCli(cliBin!, modelPath, audioPath, lang);
    }
    return { transcript, modelLabel: path.basename(modelPath) };
  };

  const runAudioCpp = async (): Promise<AsrTranscript> => {
    const r = await runAsrAudioCpp({ audioPath, model: input.model });
    return { text: r.text, engine: r.engine, segments: [], hasSpeakers: false };
  };

  const remoteResult = (useProvider: boolean) =>
    transcribeRemote(audioPath, input.model, input.diarize, useProvider, lang);

  // 显式远程：优先用配置的 OpenAI 兼容 provider，未配置时回退主推理服务。
  if (source === "remote") {
    const useProvider = !!provider.base;
    return saveRecord(
      await remoteResult(useProvider),
      input.model || (useProvider ? provider.model : "") || null,
    );
  }

  // 显式本地引擎：audio.cpp 或 whisper.cpp。
  if (source === "local") {
    if (getSetting("ASR_ENGINE") === "audiocpp") {
      return saveRecord(await runAudioCpp(), getSetting("ASR_AUDIOCPP_MODEL") || null);
    }
    if (!hasLocal) throw new Error("未检测到 whisper.cpp，请先安装（brew install whisper-cpp）或使用 OpenAI 兼容 API");
    const { transcript, modelLabel } = await runWhisperLocal();
    return saveRecord(transcript, input.model ? input.model : modelLabel);
  }

  // 自动：本地引擎优先（audio.cpp → whisper.cpp），都没有时回退主推理服务。
  if (getSetting("ASR_ENGINE") === "audiocpp") {
    return saveRecord(await runAudioCpp(), getSetting("ASR_AUDIOCPP_MODEL") || null);
  }
  if (hasLocal) {
    const { transcript, modelLabel } = await runWhisperLocal();
    return saveRecord(transcript, modelLabel);
  }
  return saveRecord(
    await remoteResult(false),
    input.model || null,
  );
}
