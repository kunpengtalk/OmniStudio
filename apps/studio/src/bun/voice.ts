import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import path from "path";
import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { voiceRecords, type MediaSource } from "./db/schema";
import { getSetting, updateSettings, getActiveServerPort } from "./db/settings";
import { getImagesBaseDir } from "./image-server";
import { chatImageUrl } from "../shared/server-info";
import { TTS_REFERENCE_AUDIO_FIELD } from "../shared/tts-reference-audio";
import { edgeSynthesize } from "./edge-tts";
import { synthesizeCallLocal } from "./tts-local";

export type VoiceRecordKind = "tts" | "asr" | "clone";

export type VoiceRecordRow = {
  id: number;
  kind: VoiceRecordKind;
  status: "done" | "failed";
  source: MediaSource;
  model: string | null;
  voice: string | null;
  text: string | null;
  audioUrl: string | null;
  /** 音频在 images 根目录下的相对路径（如 audio/tts-xxx.mp3），供复用与读取。 */
  audioPath: string | null;
  refAudioPath: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
};

export type VoiceClone = {
  id: string;
  name: string;
  model: string | null;
  audioUrl: string | null;
  refAudioPath: string | null;
  createdAt: number;
};

type RecordRow = typeof voiceRecords.$inferSelect;

const AUDIO_EXT_RE = /^\.(mp3|wav|m4a|aac|flac|ogg|opus|webm|mp4|wma)$/;

/** TTS/ASR audio files live under the images dir so the image server can serve them. */
export function getAudioBaseDir(): string {
  return path.join(getImagesBaseDir(), "audio");
}

function getBaseUrl(): string {
  const isLocal = getSetting("SERVER_MODE") === "local";
  if (isLocal) {
    const host = getSetting("SERVER_HOST") || "127.0.0.1";
    const port = getActiveServerPort();
    return `http://${host}:${port}`;
  }
  return (getSetting("VLLM_API_BASE") || "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function authHeaders(): Record<string, string> {
  const apiKey = getSetting("VLLM_API_KEY");
  if (apiKey && apiKey !== "EMPTY") return { Authorization: `Bearer ${apiKey}` };
  return {};
}

export function resolveAudioPath(ref: string): string | null {
  const base = getImagesBaseDir();
  const resolved = path.resolve(base, ref);
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.text().catch(() => "");
  if (body) {
    try {
      return JSON.parse(body)?.error?.message ?? body.slice(0, 300);
    } catch {
      return body.slice(0, 300);
    }
  }
  return `${fallback} (${res.status})`;
}

export function voiceRecordToRow(r: RecordRow): VoiceRecordRow {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    source: r.source,
    model: r.model,
    voice: r.voice,
    text: r.text,
    audioUrl: r.audioPath ? chatImageUrl(r.audioPath) : null,
    audioPath: r.audioPath,
    refAudioPath: r.refAudioPath,
    durationMs: r.durationMs,
    error: r.error,
    createdAt: r.createdAt ?? 0,
  };
}

export function insertVoiceRecord(data: {
  kind: VoiceRecordKind;
  source?: MediaSource;
  model?: string | null;
  voice?: string | null;
  text?: string | null;
  audioPath?: string | null;
  refAudioPath?: string | null;
  durationMs?: number | null;
  error?: string | null;
}): RecordRow {
  return db
    .insert(voiceRecords)
    .values({
      kind: data.kind,
      source: data.source ?? "manual",
      model: data.model ?? null,
      voice: data.voice ?? null,
      text: data.text ?? null,
      audioPath: data.audioPath ?? null,
      refAudioPath: data.refAudioPath ?? null,
      durationMs: data.durationMs ?? null,
      error: data.error ?? null,
    })
    .returning()
    .get();
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export function listVoiceRecords(kind?: VoiceRecordKind): VoiceRecordRow[] {
  const q = db.select().from(voiceRecords);
  const rows = kind
    ? q.where(eq(voiceRecords.kind, kind))
    : q;
  return rows.orderBy(desc(voiceRecords.createdAt)).limit(200).all().map(voiceRecordToRow);
}

export function deleteVoiceRecord(id: number): void {
  const row = db.select().from(voiceRecords).where(eq(voiceRecords.id, id)).get();
  if (row && row.kind === "tts" && row.audioPath) {
    // TTS outputs are uniquely owned; clean up the audio file.
    const abs = resolveAudioPath(row.audioPath);
    if (abs) rmSync(abs, { force: true });
  }
  db.delete(voiceRecords).where(eq(voiceRecords.id, id)).run();
}

// ---------------------------------------------------------------------------
// Audio staging (user-picked files)
// ---------------------------------------------------------------------------

export async function stageAudio(paths: string[]): Promise<{ ref: string; url: string }[]> {
  const dir = path.join(getAudioBaseDir(), "in");
  mkdirSync(dir, { recursive: true });
  const out: { ref: string; url: string }[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const ext = path.extname(p).toLowerCase();
    if (!AUDIO_EXT_RE.test(ext)) continue;
    const name = `${crypto.randomUUID()}${ext}`;
    const dest = path.join(dir, name);
    await Bun.write(dest, Bun.file(p));
    const ref = `audio/in/${name}`;
    out.push({ ref, url: chatImageUrl(ref) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI 兼容 TTS provider（三方服务：Base URL + API Key + 模型）
// ---------------------------------------------------------------------------

export type TTSProviderConfig = {
  base: string;
  apiKey: string;
  model: string;
};

export function getTTSProviderConfig(): TTSProviderConfig {
  return {
    base: (getSetting("TTS_PROVIDER_BASE") || "").trim(),
    apiKey: (getSetting("TTS_PROVIDER_API_KEY") || "").trim(),
    model: (getSetting("TTS_PROVIDER_MODEL") || "").trim(),
  };
}

export function saveTTSProviderConfig(cfg: {
  base?: string;
  apiKey?: string;
  model?: string;
}): void {
  const settings: Record<string, string> = {};
  if (cfg.base !== undefined) settings.TTS_PROVIDER_BASE = cfg.base.trim();
  if (cfg.apiKey !== undefined) settings.TTS_PROVIDER_API_KEY = cfg.apiKey.trim();
  if (cfg.model !== undefined) settings.TTS_PROVIDER_MODEL = cfg.model.trim();
  updateSettings(settings);
}

/** 把用户填的地址规整成带 /v1 后缀的形式（兼容填不填 /v1 两种写法）。 */
function normalizeApiBase(base: string): string {
  let b = base.trim().replace(/\/+$/, "");
  if (b && !/\/v1$/i.test(b)) b = `${b}/v1`;
  return b;
}

/** 从 OpenAI 兼容 /v1/models 拉取可用模型列表。 */
export async function listProviderModels(
  base: string,
  apiKey: string,
): Promise<string[]> {
  const cleanBase = normalizeApiBase(base);
  if (!cleanBase) throw new Error("Missing API base URL");
  const res = await fetch(`${cleanBase}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to list models"));
  const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

/** OpenAI 兼容 /v1/audio/speech，返回 mp3 字节（不入库）。 */
async function synthesizeOpenAiAudio(input: {
  text: string;
  voice?: string;
  model?: string;
  base?: string;
  apiKey?: string;
  referenceAudioRef?: string;
}): Promise<Buffer> {
  const provider = getTTSProviderConfig();
  const base = input.base?.trim() || provider.base || getBaseUrl();
  if (!base) throw new Error("No inference server configured");

  const model = input.model?.trim() || provider.model || getSetting("TTS_MODEL") || undefined;
  const hasRef = !!input.referenceAudioRef;
  // 有参考音频时，参考音频即音色来源，不再回退到默认 alloy 音色。
  const voice = input.voice?.trim() || (hasRef ? "" : getSetting("TTS_VOICE") || "alloy");
  const apiKey = input.apiKey?.trim() || provider.apiKey || getSetting("VLLM_API_KEY");

  let referenceAudioB64: string | undefined;
  if (hasRef) {
    const abs = resolveAudioPath(input.referenceAudioRef!);
    if (!abs || !existsSync(abs)) throw new Error("Reference audio not found");
    referenceAudioB64 = readFileSync(abs).toString("base64");
  }

  const res = await fetch(`${normalizeApiBase(base)}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey && apiKey !== "EMPTY" ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      input: input.text,
      ...(voice ? { voice } : {}),
      response_format: "mp3",
      ...(referenceAudioB64 ? { [TTS_REFERENCE_AUDIO_FIELD]: referenceAudioB64 } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "TTS request failed"));
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 通话逐句合成：优先本地 audio.cpp TTS（合成快、无网络延迟，适合逐句播报），
 * 其次用 TTS 页配置的三方 provider，最后回退 Edge（免密钥）。
 * 不落库、不写 voice_records，避免一句一记录污染语音历史。
 */
export async function synthesizeCallSpeech(
  text: string,
): Promise<{ buffer: Buffer; engine: "local" | "provider" | "edge" }> {
  const local = await synthesizeCallLocal(text);
  if (local) return { buffer: local, engine: "local" };
  const provider = getTTSProviderConfig();
  if (provider.base) {
    const buffer = await synthesizeOpenAiAudio({ text });
    return { buffer, engine: "provider" };
  }
  const voice = getSetting("TTS_EDGE_VOICE") || "zh-CN-XiaoxiaoNeural";
  return { buffer: await edgeSynthesize(text, voice), engine: "edge" };
}

export async function runTTS(input: {
  text: string;
  voice?: string;
  model?: string;
  base?: string;
  apiKey?: string;
  referenceAudioRef?: string;
  source?: MediaSource;
}): Promise<VoiceRecordRow> {
  const buf = await synthesizeOpenAiAudio(input);
  const dir = getAudioBaseDir();
  mkdirSync(dir, { recursive: true });
  const name = `tts-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.mp3`;
  await Bun.write(path.join(dir, name), buf);

  const ref = `audio/${name}`;
  const hasRef = !!input.referenceAudioRef;
  const record = insertVoiceRecord({
    kind: "tts",
    source: input.source,
    model: input.model?.trim() || getSetting("TTS_MODEL") || null,
    voice: input.voice?.trim() || (hasRef ? "" : getSetting("TTS_VOICE") || "alloy"),
    text: input.text,
    audioPath: ref,
    refAudioPath: input.referenceAudioRef ?? null,
  });
  return voiceRecordToRow(record);
}

/** 微软 Edge 在线 TTS（免费、无需密钥）。 */
export async function runTTSEdge(input: {
  text: string;
  voice: string;
  source?: MediaSource;
}): Promise<VoiceRecordRow> {
  const voice = input.voice?.trim() || getSetting("TTS_EDGE_VOICE") || "zh-CN-XiaoxiaoNeural";
  const buf = await edgeSynthesize(input.text, voice);
  const dir = getAudioBaseDir();
  mkdirSync(dir, { recursive: true });
  const name = `tts-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.mp3`;
  await Bun.write(path.join(dir, name), buf);

  const ref = `audio/${name}`;
  const record = insertVoiceRecord({
    kind: "tts",
    source: input.source,
    model: "Edge TTS（在线免费）",
    voice,
    text: input.text,
    audioPath: ref,
  });
  return voiceRecordToRow(record);
}

// ---------------------------------------------------------------------------
// ASR
// ---------------------------------------------------------------------------

export async function runASR(input: {
  audioRef: string;
  model?: string;
}): Promise<VoiceRecordRow> {
  const abs = resolveAudioPath(input.audioRef);
  if (!abs || !existsSync(abs)) throw new Error("Audio file not found");
  const base = getBaseUrl();
  if (!base) throw new Error("No inference server configured");

  const model = input.model?.trim() || undefined;
  const mime = "audio/mpeg";
  const form = new FormData();
  form.append(
    "file",
    new Blob([await Bun.file(abs).arrayBuffer()], { type: mime }),
    path.basename(abs),
  );
  if (model) form.append("model", model);

  const res = await fetch(`${base}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    headers: authHeaders(),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "ASR request failed"));

  const json = (await res.json().catch(() => null)) as
    | { text?: string; data?: { text?: string } }
    | null;
  const text = json?.text ?? json?.data?.text ?? "";
  if (!text) throw new Error("Transcription returned no text");

  const record = insertVoiceRecord({
    kind: "asr",
    model: model ?? null,
    text,
    audioPath: input.audioRef,
  });
  return voiceRecordToRow(record);
}

// ---------------------------------------------------------------------------
// Voice clones
// ---------------------------------------------------------------------------

function getClones(): VoiceClone[] {
  try {
    const raw = getSetting("VOICE_CLONES") || "[]";
    const list = JSON.parse(raw) as VoiceClone[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persistClones(clones: VoiceClone[]) {
  updateSettings({ VOICE_CLONES: JSON.stringify(clones) });
}

export function listVoiceClones(): VoiceClone[] {
  return getClones();
}

export async function createVoiceClone(input: {
  name: string;
  audioRef: string;
  model?: string;
}): Promise<VoiceClone> {
  const abs = resolveAudioPath(input.audioRef);
  if (!abs || !existsSync(abs)) throw new Error("Reference audio not found");

  const dir = getAudioBaseDir();
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(abs) || ".wav";
  const fileName = `clone-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  const ref = `audio/${fileName}`;
  await Bun.write(path.join(dir, fileName), Bun.file(abs));

  const clone: VoiceClone = {
    id: crypto.randomUUID(),
    name: input.name.trim() || path.basename(abs, path.extname(abs)),
    model: input.model?.trim() || getSetting("TTS_MODEL") || null,
    audioUrl: chatImageUrl(ref),
    refAudioPath: ref,
    createdAt: Date.now(),
  };
  persistClones([clone, ...getClones()]);

  // Record the cloning activity so it shows in the voice record list.
  insertVoiceRecord({
    kind: "clone",
    model: clone.model,
    text: clone.name,
    audioPath: ref,
  });

  return clone;
}

export function deleteVoiceClone(id: string): void {
  persistClones(getClones().filter((c) => c.id !== id));
}
