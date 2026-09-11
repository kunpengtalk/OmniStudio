import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import path from "path";

import { db } from "./db";
import { documents, pages } from "./db/schema";
import { getSetting, updateSettings, getActiveServerPort } from "./db/settings";
import { getDataDir } from "./paths";
import { getImagesBaseDir } from "./image-server";
import { chatImageUrl } from "../shared/server-info";
import { ocrLangEntry, OCR_LANG_CATALOG, OCR_TESSDATA_RAW_BASE } from "../shared/ocr";
import { convertFileToImages, generate, type ModelEndpoint } from "./vllm";
import { getLocalModelName } from "./vllm/model";
import { getCurrentModelProfile } from "./vllm/model-profile";
import * as ServerManager from "./server-manager";

/**
 * OCR 本地引擎。
 *
 * 两种识别路径（与语音页一样在顶部切换引擎）：
 *
 * 1. **Tesseract（本地 C++）**：纯 C++ OCR 引擎，模型为各语言的 LSTM 语言包
 *    （<code>.traineddata），从 GitHub `tesseract-ocr/tessdata_fast` 直接下载，
 *    用 tesseract 命令单次识别：
 *
 *      tesseract <img> stdout -l <code> --tessdata-dir <dir> --psm <n> tsv
 *
 *    返回带行/词框的 TSV，解析后给出文本与版面信息。
 *
 * 2. **VLM 服务**：把图片交给当前推理服务器（llama.cpp / vLLM / OpenAI 兼容）
 *    上的视觉语言模型（Chandra / GLM-OCR / LightOnOCR 等）做版面识别与内容
 *    提取，复用现有的 vLLM pipeline。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type OcrLangModelInfo = {
  id: string;
  name: string;
  script: string;
  languages: string[];
  sizeBytes: number;
  description: string;
  downloaded: boolean;
  installedSize: number | null;
  installedPath: string | null;
  active: boolean;
};

export type OcrStatus = {
  tesseractInstalled: boolean;
  tesseractPath: string | null;
  tesseractVersion: string;
  /** 当前 OCR 引擎（"tesseract" | "vlm" | ""）。 */
  engine: string;
  activeModelId: string | null;
  activeModelPath: string | null;
  /** 主推理服务器状态（VLM 引擎需要）。 */
  serverStatus: ServerManager.ServerStatus;
};

export type OcrBox = { left: number; top: number; right: number; bottom: number };

export type OcrWord = OcrBox & { conf: number; text: string };

export type OcrLine = OcrBox & {
  conf: number;
  text: string;
  words: OcrWord[];
};

export type OcrResult = {
  text: string;
  engine: "tesseract" | "paddleocr";
  modelLabel: string;
  modelCode: string;
  /** psm 仅 Tesseract 路径使用（PaddleOCR 无此概念）。 */
  psm?: number;
  lines: OcrLine[];
};

export type OcrVlmResult = {
  markdown: string;
  raw: string;
  engine: "vlm";
  modelLabel: string;
  pages: { text: string; raw: string; images: string[]; error?: string }[];
  error?: string;
};

// ---------------------------------------------------------------------------
// 远程 OpenAI 兼容 provider（OCR 页单独配置，不依赖全局 SERVER_MODE）
// ---------------------------------------------------------------------------

export type OcrProviderConfig = {
  base: string;
  apiKey: string;
  model: string;
};

export function getOcrProviderConfig(): OcrProviderConfig {
  return {
    base: (getSetting("OCR_PROVIDER_BASE") || "").trim(),
    apiKey: (getSetting("OCR_PROVIDER_API_KEY") || "").trim(),
    model: (getSetting("OCR_PROVIDER_MODEL") || "").trim(),
  };
}

export function saveOcrProviderConfig(cfg: {
  base?: string;
  apiKey?: string;
  model?: string;
}): void {
  const settings: Record<string, string> = {};
  if (cfg.base !== undefined) settings.OCR_PROVIDER_BASE = cfg.base.trim();
  if (cfg.apiKey !== undefined) settings.OCR_PROVIDER_API_KEY = cfg.apiKey.trim();
  if (cfg.model !== undefined) settings.OCR_PROVIDER_MODEL = cfg.model.trim();
  updateSettings(settings);
}

/** 把用户填的地址规整成带 /v1 后缀的形式（兼容填不填 /v1 两种写法）。 */
function normalizeApiBase(base: string): string {
  let b = base.trim().replace(/\/+$/, "");
  if (b && !/\/v1$/i.test(b)) b = `${b}/v1`;
  return b;
}

/** 从 OpenAI 兼容 /v1/models 拉取可用模型列表。 */
export async function listOcrProviderModels(
  base: string,
  apiKey: string,
): Promise<string[]> {
  const cleanBase = normalizeApiBase(base);
  if (!cleanBase) throw new Error("Missing API base URL");
  const res = await fetch(`${cleanBase}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

// ---------------------------------------------------------------------------
// Tesseract 引擎检测
// ---------------------------------------------------------------------------

function getSearchPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/bin` : "",
  ];
  const current = process.env.PATH ?? "";
  return [...extra, current].join(":");
}

async function findTesseract(): Promise<string | null> {
  const p = Bun.which("tesseract", { PATH: getSearchPath() });
  return p ?? null;
}

export async function getTesseractVersion(bin: string): Promise<string> {
  try {
    const proc = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const out = `${proc.stdout} ${proc.stderr}`.toString();
    return (out.match(/tesseract\s+v?([\d.]+)/i)?.[1] ?? "").trim() || "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 引擎一键安装（brew install tesseract，日志实时广播到前端）
// ---------------------------------------------------------------------------

type TessLogCallback = (text: string) => void;
const tessLogListeners = new Set<TessLogCallback>();

/** 订阅 tesseract 安装日志（rpc 层转发到 webview）。 */
export function onTesseractInstallLog(cb: TessLogCallback): () => void {
  tessLogListeners.add(cb);
  return () => {
    tessLogListeners.delete(cb);
  };
}

function emitTessLog(text: string): void {
  for (const cb of tessLogListeners) {
    try {
      cb(text);
    } catch {}
  }
}

/**
 * 一键安装 tesseract 引擎（brew install，用户无需手动开终端），
 * 体验对齐 PaddleOCR 的「下载引擎」。未安装 Homebrew 时返回错误，
 * 保留「复制安装命令」作为手动兜底。
 */
export async function installTesseractEngine(): Promise<{ ok: boolean; error?: string }> {
  if (await findTesseract()) return { ok: true };
  const brew = Bun.which("brew", { PATH: getSearchPath() });
  if (!brew) {
    const err =
      "未找到 Homebrew，无法自动安装。请先安装 Homebrew（https://brew.sh），或点「复制安装命令」在终端手动执行。";
    emitTessLog(err);
    return { ok: false, error: err };
  }
  emitTessLog("$ brew install tesseract");
  const proc = Bun.spawn([brew, "install", "tesseract"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // 保留末尾若干行：失败时附在错误里，用户不必翻日志就能看到原因。
  const tail: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split("\n")) {
        if (!line.trim()) continue;
        emitTessLog(line.trimEnd());
        tail.push(line.trimEnd());
        if (tail.length > 30) tail.shift();
      }
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  if (code !== 0) {
    emitTessLog(`安装失败（退出码 ${code}）`);
    return { ok: false, error: `brew install tesseract 失败（退出码 ${code}）：\n${tail.join("\n")}` };
  }
  const bin = await findTesseract();
  if (bin) {
    emitTessLog("tesseract 安装成功。");
    return { ok: true };
  }
  return { ok: false, error: "安装命令已成功执行，但未检测到 tesseract，请重启应用后再试。" };
}

// ---------------------------------------------------------------------------
// 模型目录（tessdata）管理
// ---------------------------------------------------------------------------

function getTessdataDir(): string {
  return getDataDir("engines", "tessdata");
}

function langModelPath(modelId: string): string {
  return path.join(getTessdataDir(), `${modelId}.traineddata`);
}

export function listOcrModels(): OcrLangModelInfo[] {
  const activeModel = getSetting("OCR_TESSERACT_MODEL");
  return OCR_LANG_CATALOG.map((m) => {
    const p = langModelPath(m.id);
    const downloaded = existsSync(p);
    return {
      ...m,
      downloaded,
      installedSize: downloaded ? statSync(p).size : null,
      installedPath: downloaded ? p : null,
      active: downloaded && activeModel === m.id,
    };
  });
}

export async function getOcrStatus(): Promise<OcrStatus> {
  const bin = await findTesseract();
  const tesseractVersion = bin ? await getTesseractVersion(bin) : "";
  const engine = getSetting("OCR_ENGINE");
  const modelId = getSetting("OCR_TESSERACT_MODEL") || null;
  const modelPath = modelId && existsSync(langModelPath(modelId)) ? langModelPath(modelId) : null;
  return {
    tesseractInstalled: !!bin,
    tesseractPath: bin,
    tesseractVersion,
    engine,
    activeModelId: engine === "tesseract" ? modelId : null,
    activeModelPath: engine === "tesseract" ? modelPath : null,
    serverStatus: ServerManager.getStatus(),
  };
}

/** 下载语言模型（traineddata，tessdata_fast，GitHub raw，多镜像回退）。 */
export async function downloadOcrModel(modelId: string): Promise<{ ok: boolean; error?: string }> {
  const entry = ocrLangEntry(modelId);
  if (!entry) return { ok: false, error: "未知模型" };

  const dir = getTessdataDir();
  mkdirSync(dir, { recursive: true });
  const dest = langModelPath(modelId);

  const url = `${OCR_TESSDATA_RAW_BASE}${modelId}.traineddata`;
  // 国内镜像（GitHub 加速），依次回退。
  const mirrors = [url, `https://gh-proxy.com/${url}`, `https://ghfast.top/${url}`];

  let lastError = "";
  for (const u of mirrors) {
    try {
      const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // GitHub 404 / 代理错误页不是有效格式（traineddata 以二进制 magic 开头，
      // 不会是 "404"/"<!DOCTYPE" 文本）。
      const head = buf.subarray(0, 64).toString("utf8");
      if (buf.length < 1000 || head.startsWith("404") || head.startsWith("<!DO") || head.includes("Not Found")) {
        throw new Error(`无效的文件内容（${buf.length} 字节）`);
      }
      rmSync(dest, { force: true });
      await Bun.write(dest, buf);
      return { ok: true };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      rmSync(dest, { force: true });
    }
  }
  return { ok: false, error: `语言包下载失败：${lastError}` };
}

/** 启动/切换 Tesseract OCR 引擎到指定语言（下载后即可点击启动）。 */
export async function startOcr(modelId: string): Promise<{ ok: boolean; error?: string }> {
  const entry = ocrLangEntry(modelId);
  if (!entry) return { ok: false, error: "未知模型" };
  if (!existsSync(langModelPath(modelId))) {
    return { ok: false, error: "语言包尚未下载，请先点击下载" };
  }
  const bin = await findTesseract();
  if (!bin) {
    return { ok: false, error: "未检测到 Tesseract，请先安装（macOS: brew install tesseract）" };
  }
  updateSettings({ OCR_ENGINE: "tesseract", OCR_TESSERACT_MODEL: modelId });
  return { ok: true };
}

export async function stopOcr(): Promise<void> {
  updateSettings({ OCR_ENGINE: "", OCR_TESSERACT_MODEL: "" });
}

export function deleteOcrModel(modelId: string): { ok: boolean } {
  const entry = ocrLangEntry(modelId);
  if (!entry) return { ok: false };
  const p = langModelPath(modelId);
  try {
    rmSync(p, { force: true });
    rmSync(`${p}.download`, { force: true });
    // 清理空的 tessdata 目录。
    const dir = path.dirname(p);
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { force: true });
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
  if (getSetting("OCR_TESSERACT_MODEL") === modelId) {
    updateSettings({ OCR_TESSERACT_MODEL: "" });
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 图片暂存（选择/拖入识别）
// ---------------------------------------------------------------------------

/**
 * 「识别提取」页一次成功识别 → 存为侧边栏「OCR 记录」的一条文档记录
 * （documents + pages 各一行，与「文档处理」管线同表，点击即可回看识别文本）。
 * best-effort：记录写失败不影响识别结果返回。
 */
export function saveOcrRecord(input: { imagePath: string; markdown: string; raw?: string }): void {
  try {
    const file = Bun.file(input.imagePath);
    const now = Date.now();
    const doc = db
      .insert(documents)
      .values({
        path: input.imagePath,
        type: file.type || "image/png",
        size: file.size,
        status: "completed",
        totalPages: 1,
        processedPages: 1,
        completedAt: now,
      })
      .returning({ id: documents.id })
      .get();
    db.insert(pages)
      .values({
        documentId: doc.id,
        // 页码 0 基，与文档管线一致（详情页显示为 Page 1）。
        pageNumber: 0,
        markdown: input.markdown,
        // raw 供详情页 Raw/HTML 页签展示；为空则该页签自动禁用。
        raw: input.raw ?? input.markdown,
        status: "completed",
        completedAt: now,
      })
      .run();
  } catch {
    // ignore：识别结果已在界面上展示，记录保存失败不阻断流程
  }
}

const OCR_IMAGE_EXT_RE = /^\.(png|jpe?g|webp|bmp|tiff?|gif|heic|heif|pdf)$/;

export async function stageOcrImage(paths: string[]): Promise<{ ref: string; url: string }[]> {
  const dir = path.join(getImagesBaseDir(), "ocr", "in");
  mkdirSync(dir, { recursive: true });
  const out: { ref: string; url: string }[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const ext = path.extname(p).toLowerCase();
    if (!OCR_IMAGE_EXT_RE.test(ext)) continue;
    const name = `${crypto.randomUUID()}${ext}`;
    const dest = path.join(dir, name);
    await Bun.write(dest, Bun.file(p));
    const ref = `ocr/in/${name}`;
    out.push({ ref, url: chatImageUrl(ref) });
  }
  return out;
}

/** 把 OCR 暂存图片 ref（ocr/in/...）解析为绝对路径（限 images 目录内）。 */
export function resolveOcrImage(ref: string): string | null {
  const base = getImagesBaseDir();
  const resolved = path.resolve(base, ref);
  if (!resolved.startsWith(base + path.sep)) return null;
  return existsSync(resolved) ? resolved : null;
}

// ---------------------------------------------------------------------------
// Tesseract 识别
// ---------------------------------------------------------------------------

/** tesseract 的 TSV 输出行解析（含每个词的框与置信度）。 */
export function parseTesseractTsv(tsv: string): OcrLine[] {
  const lines: OcrLine[] = [];

  for (const raw of tsv.split("\n")) {
    const c = raw.split("\t");
    if (c.length < 12) continue;
    const level = Number(c[0]);
    if (level !== 5) continue;

    const wordNum = Number(c[5]);
    const left = Number(c[6]);
    const top = Number(c[7]);
    const width = Number(c[8]);
    const height = Number(c[9]);
    const conf = Number(c[10]);
    const text = (c[11] ?? "").trim();
    if (!text) continue;

    if (wordNum === 0) {
      // 行首行：带整行文本与行框。
      lines.push({
        left,
        top,
        right: left + width,
        bottom: top + height,
        conf,
        text,
        words: [],
      });
      continue;
    }

    // 词行：挂到其所属的行（按包含关系，向后找最近匹配）。
    let line: OcrLine | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      const cx = left + width / 2;
      const cy = top + height / 2;
      if (cx >= l.left && cx <= l.right && cy >= l.top && cy <= l.bottom) {
        line = l;
        break;
      }
      // 连续不匹配超过 3 行即放弃（不同区域）。
      if (i < lines.length - 3) break;
    }
    if (line) {
      line.words.push({ left, top, right: left + width, bottom: top + height, conf, text });
      line.left = Math.min(line.left, left);
      line.top = Math.min(line.top, top);
      line.right = Math.max(line.right, left + width);
      line.bottom = Math.max(line.bottom, top + height);
      line.conf = Math.min(line.conf, conf);
    }
    // 个别行无词行（孤立词）时，把词行自己作为一行。
    else {
      lines.push({
        left,
        top,
        right: left + width,
        bottom: top + height,
        conf,
        text: text,
        words: [{ left, top, right: left + width, bottom: top + height, conf, text }],
      });
    }
  }

  // 行文本留空时用词拼接兜底。
  for (const l of lines) {
    if (!l.text && l.words.length) {
      l.text = l.words.map((w) => w.text).join(" ").trim();
    }
  }
  return lines.filter((l) => l.text);
}

/**
 * 用 Tesseract 本地引擎识别一张图片（PNG/JPG/WebP/BMP/TIFF/HEIC，或 PDF 首页）。
 * 先归一化为 PNG 再交给 tesseract，带行/词框与置信度。失败抛出含 stderr 的错误。
 */
export async function runOcr(input: {
  imageRef: string;
  model?: string;
  psm?: number;
}): Promise<OcrResult> {
  const modelId = input.model?.trim() || getSetting("OCR_TESSERACT_MODEL");
  const entry = ocrLangEntry(modelId);
  if (!entry) throw new Error("请先在本地引擎中选择一个 Tesseract 语言模型");
  if (getSetting("OCR_ENGINE") !== "tesseract") {
    throw new Error("Tesseract 引擎未启用，请先在 OCR 页切换到 Tesseract 引擎");
  }

  const dir = getTessdataDir();
  if (!existsSync(langModelPath(modelId))) {
    throw new Error(`语言包未下载：${entry.name}`);
  }

  const abs = resolveOcrImage(input.imageRef);
  if (!abs) throw new Error("图片文件不存在");

  const bin = await findTesseract();
  if (!bin) {
    throw new Error("未检测到 Tesseract，请先安装（macOS: brew install tesseract）");
  }

  // 归一化为 PNG（顺带支持 HEIC / PDF 首页）。
  const images = await convertFileToImages(Bun.file(abs));
  if (!images.length) throw new Error("无法解析图片");
  const tmpDir = path.join(getImagesBaseDir(), "ocr", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpPng = path.join(tmpDir, `ocr-${crypto.randomUUID().slice(0, 8)}.png`);
  await images[0]!.png().toFile(tmpPng);

  const psm = Number.isFinite(input.psm) ? input.psm! : Number(getSetting("OCR_PSM") || 3);

  try {
    const args = [
      tmpPng,
      "stdout",
      "-l", modelId,
      "--tessdata-dir", dir,
      "--psm", String(psm),
    ];
    const proc = Bun.spawnSync([bin, ...args, "tsv"], { stdout: "pipe", stderr: "pipe" });
    const tsv = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    if (proc.exitCode !== 0 || !tsv.trim()) {
      throw new Error(stderr.trim().slice(-400) || `Tesseract 识别失败（退出码 ${proc.exitCode}）`);
    }
    const lines = parseTesseractTsv(tsv);

    // 若 TSV 无词（可能 --psm 模式不支持逐词输出），退化为纯文本识别。
    let text = lines.map((l) => l.text).join("\n");
    if (!text.trim()) {
      const plain = Bun.spawnSync([bin, tmpPng, "stdout", "-l", modelId, "--tessdata-dir", dir, "--psm", String(psm)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      text = plain.stdout.toString().trim();
    }

    if (!text.trim()) {
      throw new Error(stderr.trim().slice(-400) || "识别结果为空");
    }

    saveOcrRecord({ imagePath: abs, markdown: text, raw: text });
    return {
      text,
      engine: "tesseract",
      modelLabel: entry.name,
      modelCode: entry.id,
      psm,
      lines,
    };
  } finally {
    rmSync(tmpPng, { force: true });
  }
}

// ---------------------------------------------------------------------------
// VLM 服务识别（复用现有 vLLM pipeline）
// ---------------------------------------------------------------------------

/**
 * 用视觉语言模型识别一张图片/PDF。
 * profileId 用于在调用前写入 VLLM_MODEL_PROFILE（与文档流程共用同一配置域）。
 *
 * source 决定请求发到哪里：
 * - "local"（默认）：当前配置的本地推理引擎（llama.cpp / vLLM / SGLang 等）；
 * - "remote"：OCR 页单独配置的 OpenAI 兼容服务（OCR_PROVIDER_*），不依赖全局 SERVER_MODE。
 */
export async function runOcrVlm(input: {
  imageRef: string;
  profileId?: string;
  source?: "local" | "remote";
}): Promise<OcrVlmResult> {
  if (input.profileId) {
    updateSettings({ VLLM_MODEL_PROFILE: input.profileId });
  }

  // 本地/远程都显式构造 endpoint，互不依赖全局 SERVER_MODE。
  let endpoint: ModelEndpoint;
  let remoteLabel = "";
  if (input.source === "remote") {
    // 远程来源：使用 OCR 页自己的 OpenAI 兼容配置。
    const provider = getOcrProviderConfig();
    if (!provider.base) {
      throw new Error("请先在 OCR 页配置远程 OpenAI 兼容服务的 Base URL");
    }
    endpoint = {
      base: provider.base,
      apiKey: provider.apiKey,
      model: provider.model || undefined,
    };
    remoteLabel = provider.model || "remote";
  } else {
    // 本地来源：显式指向本地推理服务器（引擎为 vLLM / llama.cpp / SGLang 时即为本地对应引擎）。
    endpoint = {
      base: `http://localhost:${getActiveServerPort()}/v1`,
      model: getLocalModelName(),
    };
  }

  const abs = resolveOcrImage(input.imageRef);
  if (!abs) throw new Error("图片文件不存在");

  const images = await convertFileToImages(Bun.file(abs));
  if (!images.length) throw new Error("无法解析图片");

  const outDir = path.join(getImagesBaseDir(), "ocr", "out");
  mkdirSync(outDir, { recursive: true });

  const pages: OcrVlmResult["pages"] = [];
  let markdown = "";
  let rawAll = "";

  for (let i = 0; i < images.length; i++) {
    const results = await generate(
      [images[i]!],
      {
        include_images: true,
        include_headers_footers: true,
      },
      endpoint,
    );
    const r = results[0]!;

    if (r.error) {
      pages.push({ text: "", raw: "", images: [], error: r.errorMessage ?? "识别失败" });
      if (!pages[0]?.error) throw new Error(r.errorMessage ?? "识别失败");
      continue;
    }

    let pageMd = r.markdown;
    const urls: string[] = [];
    for (const [imgName, imgSharp] of Object.entries(r.images)) {
      const dest = path.join(outDir, `${Date.now()}-${i}-${imgName}`);
      await imgSharp.webp().toFile(dest);
      const ref = `ocr/out/${path.basename(dest)}`;
      urls.push(chatImageUrl(ref));
      pageMd = pageMd.replace(imgName, chatImageUrl(ref));
    }
    pages.push({ text: pageMd, raw: r.raw, images: urls });
    if (i > 0) markdown += `\n\n---\n\n`;
    markdown += pageMd;
    rawAll += r.raw;
  }

  if (pages.every((p) => !p.text && !p.error)) {
    throw new Error("识别结果为空");
  }

  saveOcrRecord({ imagePath: abs, markdown, raw: rawAll });
  return {
    markdown,
    raw: rawAll,
    engine: "vlm",
    modelLabel: remoteLabel || getCurrentModelProfile().label,
    pages,
    error: pages.find((p) => p.error)?.error,
  };
}
