import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";

import { getSetting, updateSettings } from "./db/settings";
import { getDataDir } from "./paths";
import { getImagesBaseDir } from "./image-server";
import { convertFileToImages } from "./vllm";
import { downloadHttpFile, type DownloadProgress } from "./modelscope";
import { resolveOcrImage, saveOcrRecord, type OcrLine, type OcrResult } from "./ocr";
import type { PpOcrModelSize } from "../shared/ocr";

/**
 * PaddleOCR（PP-OCRv6）本地 OCR 引擎 —— 第三个 OCR 引擎（OCR 页顶部切换）。
 *
 * 实现与 mflux 生图（mlx-gen.ts）同构：官方 `paddleocr` + `paddlepaddle`
 * （CPU）装入独立 venv（`userData/engines/paddleocr`），主进程启动一个
 * 常驻 Python worker（`ppocr-worker.py`）走 JSON-lines stdio 协议。
 *
 * - 引擎加载一次常驻内存，识别请求直接走内存中的模型（首载自动下载
 *   PP-OCRv6 模型，medium 约 140MB）。
 * - 识别在独立进程执行，不阻塞 UI 线程；全程离线、无需 API Key。
 * - 安装日志与加载/识别阶段通过事件推送到前端实时展示。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type PpOcrPhase =
  | "idle"
  | "starting"
  | "downloading"
  | "loading"
  | "ready"
  | "recognizing"
  | "error";

export type PpOcrStatus = {
  pythonFound: boolean;
  pythonPath: string | null;
  /** paddleocr 是否已装入 venv（可启动 worker）。 */
  engineInstalled: boolean;
  version: string;
  engineDir: string | null;
  workerRunning: boolean;
  phase: PpOcrPhase;
  phaseMessage: string;
  modelSize: PpOcrModelSize;
  /** 上次「下载引擎」中途中断（标记文件残留且引擎未装好）。 */
  installInterrupted: boolean;
  /** 三个档位的模型就绪/半成品状态（det + rec）。 */
  models: PpOcrModelState[];
};

export type PpOcrModelState = {
  size: PpOcrModelSize;
  models: {
    det: { ready: boolean; partialBytes: number; totalBytes: number };
    rec: { ready: boolean; partialBytes: number; totalBytes: number };
  };
};

export type PpOcrModelKind = "det" | "rec";

export type PpOcrModel = {
  kind: PpOcrModelKind;
  /** 官方模型名（= 本地目录名）。 */
  name: string;
  /** 官方 BOS 直链（{name}_infer.tar）。 */
  url: string;
  /** tar 解压后产物字节数（已实测，用于进度展示）。 */
  sizeBytes: number;
};

/** 下载进度事件：单个模型文件的字节进度 + 估算速度。 */
export type PpOcrModelProgress = {
  size: PpOcrModelSize;
  model: string;
  kind: PpOcrModelKind;
  progress: {
    received: number;
    total: number | null;
    percent: number | null;
    speed: number;
  };
};

export type PpOcrRecognizedLine = {
  box: [number, number, number, number] | null;
  text: string;
  conf: number;
};

export type PpOcrRecognitionResult = {
  text: string;
  lines: PpOcrRecognizedLine[];
};

// ---------------------------------------------------------------------------
// 事件（安装日志 / 阶段），主进程转发到前端
// ---------------------------------------------------------------------------

type LogCallback = (text: string) => void;
const logListeners = new Set<LogCallback>();

export function onPpOcrInstallLog(cb: LogCallback): () => void {
  logListeners.add(cb);
  return () => logListeners.delete(cb);
}

function emitLog(text: string): void {
  for (const cb of logListeners) {
    try {
      cb(text);
    } catch {}
  }
}

type PhaseCallback = (phase: PpOcrPhase, message: string) => void;
const phaseListeners = new Set<PhaseCallback>();
let currentPhase: PpOcrPhase = "idle";
let currentPhaseMessage = "";

export function onPpOcrPhase(cb: PhaseCallback): () => void {
  phaseListeners.add(cb);
  return () => phaseListeners.delete(cb);
}

function emitPhase(phase: PpOcrPhase, message = ""): void {
  currentPhase = phase;
  currentPhaseMessage = message;
  for (const cb of phaseListeners) {
    try {
      cb(phase, message);
    } catch {}
  }
}

// --- 模型下载进度事件（主进程转发到前端，模型卡实时进度条） ---

const modelProgressListeners = new Set<(p: PpOcrModelProgress) => void>();

export function onPpOcrModelProgress(cb: (p: PpOcrModelProgress) => void): () => void {
  modelProgressListeners.add(cb);
  return () => modelProgressListeners.delete(cb);
}

function emitModelProgress(p: PpOcrModelProgress): void {
  for (const cb of modelProgressListeners) {
    try {
      cb(p);
    } catch {}
  }
}

function formatBytesH(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

/** 逐行读取子进程输出并转发到安装日志。 */
async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onError = false,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) emitLog((onError ? "[stderr] " : "") + line.trimEnd());
      }
    }
    if (buf.trim()) emitLog((onError ? "[stderr] " : "") + buf.trimEnd());
  } catch {
    // 流中断忽略
  }
}

// ---------------------------------------------------------------------------
// 引擎目录 / Python 探测
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

/** venv 根目录（userData/engines/paddleocr，标准 python venv）。 */
function getEngineDir(): string {
  return getDataDir("engines", "paddleocr");
}

function getVenvBinDir(): string {
  return path.join(getEngineDir(), "bin");
}

function venvBinary(name: string): string {
  return path.join(getVenvBinDir(), name);
}

/**
 * 找系统 Python。优先 3.11 / 3.12 / 3.10 —— paddlepaddle 官方轮子主要覆盖
 * 3.8–3.12，避开 3.13+（可能没有对应轮子导致安装失败）。
 */
async function findPython(): Promise<string | null> {
  const candidates = ["python3.11", "python3.12", "python3.10", "python3"];
  for (const name of candidates) {
    const p = Bun.which(name, { PATH: getSearchPath() });
    if (!p) continue;
    const v = await getPythonVersion(p);
    if (v && v >= 10 && v <= 12) return p;
  }
  return null;
}

/** 返回 Python 的 minor 版本（3.x 中的 x），解析失败返回 null。 */
async function getPythonVersion(bin: string): Promise<number | null> {
  try {
    const proc = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const m = `${proc.stdout} ${proc.stderr}`.toString().match(/Python\s+3\.(\d+)\./);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** 读取 venv 里已安装的 paddleocr 版本（未安装返回 null）。 */
async function getPpOcrVersion(): Promise<string | null> {
  const py = venvBinary("python3");
  if (!existsSync(py)) return null;
  try {
    const proc = Bun.spawnSync(
      [py, "-c", "import importlib.metadata as m; print(m.version('paddleocr'))"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = proc.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function normalizeModelSize(_v?: string): PpOcrModelSize {
  // 只保留 medium 一档（tiny / small 已下线），历史设置值一律归一到 medium。
  return "medium";
}

function ppOcrModelStateOf(model: PpOcrModel): {
  ready: boolean;
  partialBytes: number;
  totalBytes: number;
} {
  return {
    ready: isModelDirReady(model),
    partialBytes: scanPartialBytes(model),
    totalBytes: model.sizeBytes,
  };
}

export async function getPpOcrStatus(): Promise<PpOcrStatus> {
  const pythonPath = await findPython();
  const version = await getPpOcrVersion();
  const engineInstalled = version !== null && existsSync(venvBinary("python3"));
  const active = getActiveWorker();
  const sizes = ["medium"] as const;
  return {
    pythonFound: !!pythonPath,
    pythonPath,
    engineInstalled,
    version: version ?? "",
    engineDir: engineInstalled ? getEngineDir() : null,
    workerRunning: !!active && active.proc.exitCode === null,
    phase: active && active.proc.exitCode === null ? currentPhase : "idle",
    phaseMessage: currentPhaseMessage,
    modelSize: normalizeModelSize(getSetting("PPOCR_MODEL_SIZE")),
    installInterrupted: !engineInstalled && existsSync(installMarkerPath()),
    models: sizes.map((size) => {
      const models = ppOcrCatalog(size);
      return {
        size,
        models: {
          det: ppOcrModelStateOf(models.det),
          rec: ppOcrModelStateOf(models.rec),
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 一键安装引擎（uv venv + pip，默认源失败自动换清华镜像）
// ---------------------------------------------------------------------------

/** 「下载引擎」进行中的标记文件；重启后残留且引擎未装好 → 提示安装中断。 */
function installMarkerPath(): string {
  return path.join(getEngineDir(), ".installing");
}

/**
 * 一键安装 paddleocr + paddlepaddle 引擎。全程日志经 onPpOcrInstallLog 广播；
 * 安装期间写 .installing 标记，结束（成功/失败）删除 —— 重启后靠标记识别「上次安装中断」。
 */
let engineInstallInFlight: Promise<{ ok: boolean; error?: string; version?: string }> | null = null;

export function downloadPpOcrEngine(): Promise<{
  ok: boolean;
  error?: string;
  version?: string;
}> {
  // 防重入：双击/并发调用复用同一次安装。
  if (engineInstallInFlight) return engineInstallInFlight;
  engineInstallInFlight = (async () => {
    try {
      // 上次安装被中断（.installing 标记跨重启残留）→ venv 状态不可信，
      // 自动清掉残留后重装；models/（已下模型 + 断点分片）保留。
      if (existsSync(installMarkerPath())) {
        emitLog("检测到上次安装中断，自动清理残留虚拟环境后重装（已下载模型保留）…");
        cleanVenvKeepModels();
      }
      mkdirSync(getEngineDir(), { recursive: true });
      writeFileSync(installMarkerPath(), String(Date.now()));
    } catch {
      // 标记写失败不影响安装
    }
    try {
      return await doDownloadPpOcrEngine();
    } finally {
      try {
        rmSync(installMarkerPath(), { force: true });
      } catch {}
      engineInstallInFlight = null;
    }
  })();
  return engineInstallInFlight;
}

/** 清掉引擎目录里的虚拟环境残留；models/（已下模型 + 下载分片）保留，
 * 断点续传不受影响。中断重装 / 手动清理时调用。 */
function cleanVenvKeepModels(): void {
  try {
    for (const entry of readdirSync(getEngineDir())) {
      if (entry === "models") continue;
      rmSync(path.join(getEngineDir(), entry), { recursive: true, force: true });
    }
  } catch {
    // ignore：清不干净时 uv venv --clear 会兜底重建
  }
}

/** 清理引擎（删除虚拟环境，保留已下载模型），装坏后可重置重装。 */
export async function cleanupPpOcrEngine(): Promise<{ ok: boolean; error?: string }> {
  if (engineInstallInFlight) {
    return { ok: false, error: "引擎正在安装中，请等安装结束后再清理" };
  }
  try {
    await stopPpOcr();
  } catch {
    // worker 未运行时忽略
  }
  cleanVenvKeepModels();
  try {
    rmSync(installMarkerPath(), { force: true });
  } catch {}
  emitLog("已清理 PaddleOCR 引擎残留（已下载的模型保留），可重新点「下载引擎」安装");
  return { ok: true };
}

async function doDownloadPpOcrEngine(): Promise<{
  ok: boolean;
  error?: string;
  version?: string;
}> {
  const python = await findPython();
  if (!python) {
    return {
      ok: false,
      error: "未找到 python3，请先安装 Python 3.10–3.12（macOS: brew install python）",
    };
  }

  const engineDir = getEngineDir();
  const enginePython = venvBinary("python3");
  const pyMinor = await getPythonVersion(python);

  // venv 已存在但 Python 版本与目标不一致 → 删掉重建（旧的可能是损坏环境）。
  if (existsSync(enginePython)) {
    const envMinor = await getPythonVersion(enginePython);
    if (envMinor !== null && pyMinor !== null && envMinor !== pyMinor) {
      emitLog(`venv Python ${envMinor} 与目标 ${pyMinor} 不一致，重建虚拟环境…`);
      try {
        rmSync(engineDir, { recursive: true, force: true });
      } catch (e) {
        return { ok: false, error: `重建虚拟环境失败：${e instanceof Error ? e.message : e}` };
      }
    }
  }

  const uv = Bun.which("uv", { PATH: getSearchPath() });

  // ---- 创建 venv ----
  if (!existsSync(enginePython)) {
    if (uv) {
      // --clear：engineDir 已被上面的 mkdirSync 预先创建（写 .installing 标记），
      // 且失败重试时目录里可能残留半成品 —— 不带 --clear，uv 会因「目录已存在」
      // 直接拒绝创建虚拟环境，安装永远无法重试。
      emitLog(`$ uv venv --clear --python ${python} ${engineDir}`);
      const venv = Bun.spawnSync([uv, "venv", "--clear", "--python", python, engineDir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (venv.exitCode !== 0) {
        return {
          ok: false,
          error: venv.stderr.toString().slice(0, 500) || "创建虚拟环境失败",
        };
      }
    } else {
      emitLog(`$ ${python} -m venv --clear ${engineDir}`);
      const venv = Bun.spawnSync([python, "-m", "venv", "--clear", engineDir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (venv.exitCode !== 0) {
        return {
          ok: false,
          error: venv.stderr.toString().slice(0, 500) || "创建虚拟环境失败",
        };
      }
    }
    // venv 的 --clear 会连带删掉 .installing 标记，这里补写 —— 后续 pip 安装
    // 耗时最长，重启后的「安装中断」检测主要靠它。
    try {
      writeFileSync(installMarkerPath(), String(Date.now()));
    } catch {}
  }

  // ---- 安装 paddleocr + paddlepaddle（CPU 版；默认源失败自动换清华镜像重试） ----
  const mirror = "https://pypi.tuna.tsinghua.edu.cn/simple";
  const runInstall = async (indexArgs: string[]): Promise<number> => {
    const cmd = uv
      ? [uv, "pip", "install", "--python", enginePython, "--upgrade", "paddleocr", "paddlepaddle", ...indexArgs]
      : [venvBinary("pip3"), "install", "--upgrade", "paddleocr", "paddlepaddle", ...indexArgs];
    emitLog(`$ ${cmd.join(" ")}`);
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    await Promise.all([streamLines(proc.stdout), streamLines(proc.stderr, true)]);
    return await proc.exited;
  };

  let code = await runInstall([]);
  if (code !== 0) {
    emitLog(`默认 PyPI 源安装失败（退出码 ${code}），改用清华镜像重试…`);
    code = await runInstall(["-i", mirror]);
  }
  if (code !== 0) {
    emitLog("paddleocr 安装失败");
    return {
      ok: false,
      error: `paddleocr 安装失败（退出码 ${code}）。可能是网络问题，请检查代理/网络后重试，详见安装日志。`,
    };
  }

  const version = await getPpOcrVersion();
  emitLog(version ? `安装成功：paddleocr ${version}` : "安装成功");
  return { ok: true, version: version ?? undefined };
}

// ---------------------------------------------------------------------------
// PP-OCRv6 模型下载（自管理：进度 + 断点续传 + 取消 + 跨重启记忆）
//
// 模型由应用自己下载到 <dataDir>/engines/paddleocr/models/，worker 只按本地
// 目录加载（text_detection_model_dir / text_recognition_model_dir），完全离线、
// 不触发 paddle 内部下载。单个模型 = 一份官方 tar（BOS 直链），断点续传由
// downloadHttpFile 的 .partN 分片自动完成：中断/取消保留分片，下次调用
// 从已有字节续传 —— 即「记忆断点续传」。
// ---------------------------------------------------------------------------

const PPOCR_MODEL_BASE =
  "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0";

/** 单个模型的信息（下载地址 + 已实测产物字节）。 */
function ppOcrModel(size: string, kind: PpOcrModelKind, sizeBytes: number): PpOcrModel {
  const name = `PP-OCRv6_${size}_${kind}`;
  return { kind, name, url: `${PPOCR_MODEL_BASE}/${name}_infer.tar`, sizeBytes };
}

const PPOCR_MODEL_CATALOG: Record<PpOcrModelSize, { det: PpOcrModel; rec: PpOcrModel }> = {
  medium: {
    det: ppOcrModel("medium", "det", 62_227_968),
    rec: ppOcrModel("medium", "rec", 76_851_200),
  },
};

function ppOcrCatalog(size: PpOcrModelSize): { det: PpOcrModel; rec: PpOcrModel } {
  return PPOCR_MODEL_CATALOG[size] ?? PPOCR_MODEL_CATALOG.medium;
}

function getModelsDir(): string {
  return getDataDir("engines", "paddleocr", "models");
}

function getModelDir(name: string): string {
  return path.join(getModelsDir(), name);
}

function getDownloadsDir(): string {
  return path.join(getModelsDir(), "downloads");
}

/** 模型目录是否已就绪（inference.json/pdmodel + pdiparams + yml 三件套齐）。 */
function isModelDirReady(model: PpOcrModel): boolean {
  const dir = getModelDir(model.name);
  const hasProgram =
    existsSync(path.join(dir, "inference.json")) || existsSync(path.join(dir, "inference.pdmodel"));
  return (
    hasProgram &&
    existsSync(path.join(dir, "inference.pdiparams")) &&
    existsSync(path.join(dir, "inference.yml"))
  );
}

/** 扫描 downloads 目录的 .tar / .partN 残留，返回已下载字节数（半成品进度）。 */
function scanPartialBytes(model: PpOcrModel): number {
  const dir = getDownloadsDir();
  let total = 0;
  try {
    for (const n of readdirSync(dir)) {
      if (n === `${model.name}.tar` || n.startsWith(`${model.name}.tar.part`)) {
        total += statSync(path.join(dir, n)).size;
      }
    }
  } catch {
    // ignore
  }
  return total;
}

/** 解压官方 tar（唯一内层 {name}_infer/ 目录拍平到目标模型目录，幂等可重入）。 */
function extractModelTar(model: PpOcrModel, tarPath: string): void {
  const destDir = getModelDir(model.name);
  const tmp = path.join(getModelsDir(), `.tmp-${model.name}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const proc = Bun.spawnSync(["tar", "-xf", tarPath, "-C", tmp], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        proc.stderr.toString().slice(0, 300).trim() || `tar 解压失败（退出码 ${proc.exitCode}）`,
      );
    }
    // 先清掉上次解压的半成品，保证幂等（Windows 下 rename 到已存在文件会失败）。
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    const entries = readdirSync(tmp);
    const inner =
      entries.length === 1 && statSync(path.join(tmp, entries[0]!)).isDirectory()
        ? path.join(tmp, entries[0]!)
        : tmp;
    for (const f of readdirSync(inner)) {
      renameSync(path.join(inner, f), path.join(destDir, f));
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function isAbortError(e: unknown): boolean {
  if (e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message))) return true;
  return e instanceof DOMException && e.name === "AbortError";
}

/** 进行中的单模型下载（并行防重 + 等待复用）。 */
const modelDownloadPromises = new Map<
  string,
  Promise<{ ok: boolean; canceled?: boolean; error?: string; already?: boolean }>
>();
const activeModelDownloads = new Map<string, AbortController>();

/** 下载单个模型（已就绪直接返回；进行中则等待同一个 promise，避免重复下载）。 */
function downloadPpOcrModel(
  size: PpOcrModelSize,
  model: PpOcrModel,
): Promise<{ ok: boolean; canceled?: boolean; error?: string; already?: boolean }> {
  if (isModelDirReady(model)) return Promise.resolve({ ok: true, already: true });
  const inflight = modelDownloadPromises.get(model.name);
  if (inflight) return inflight;

  const p = doDownloadPpOcrModel(size, model).finally(() => {
    modelDownloadPromises.delete(model.name);
    activeModelDownloads.delete(model.name);
  });
  modelDownloadPromises.set(model.name, p);
  return p;
}

async function doDownloadPpOcrModel(
  size: PpOcrModelSize,
  model: PpOcrModel,
): Promise<{ ok: boolean; canceled?: boolean; error?: string; already?: boolean }> {
  const dir = getDownloadsDir();
  mkdirSync(dir, { recursive: true });
  const tarPath = path.join(dir, `${model.name}.tar`);
  const controller = new AbortController();
  activeModelDownloads.set(model.name, controller);

  const started = scanPartialBytes(model);
  emitLog(`下载模型：${model.name}（${formatBytesH(model.sizeBytes)}）${started > 0 ? `，已下载 ${formatBytesH(started)} 续传` : ""}…`);
  emitModelProgress({
    size,
    model: model.name,
    kind: model.kind,
    progress: { received: started, total: model.sizeBytes, percent: (started / model.sizeBytes) * 100, speed: 0 },
  });

  let last = { time: Date.now(), received: started };
  const onProgress = (p: DownloadProgress) => {
    const now = Date.now();
    const speed =
      p.received >= last.received
        ? (p.received - last.received) / Math.max(1, (now - last.time) / 1000)
        : 0;
    last = { time: now, received: p.received };
    emitModelProgress({
      size,
      model: model.name,
      kind: model.kind,
      progress: {
        received: p.received,
        total: model.sizeBytes,
        percent: p.total ? (p.received / model.sizeBytes) * 100 : null,
        speed,
      },
    });
  };

  try {
    const { size: downloaded } = await downloadHttpFile(
      model.url,
      tarPath,
      onProgress,
      controller.signal,
    );
    if (downloaded < model.sizeBytes) {
      throw new Error(`下载不完整（${downloaded}/${model.sizeBytes} 字节）`);
    }
    emitLog(`模型下载完成，解压 ${model.name}…`);
    extractModelTar(model, tarPath);
    if (!isModelDirReady(model)) throw new Error("模型解压后校验失败，请重新下载");
    try {
      rmSync(tarPath, { force: true });
    } catch {
      // ignore
    }
    emitLog(`模型就绪：${model.name}`);
    emitModelProgress({
      size,
      model: model.name,
      kind: model.kind,
      progress: { received: downloaded, total: downloaded, percent: 100, speed: 0 },
    });
    return { ok: true };
  } catch (e) {
    if (isAbortError(e) || controller.signal.aborted) {
      emitLog(`已取消下载：${model.name}（分片已保留，可继续）`);
      emitModelProgress({
        size,
        model: model.name,
        kind: model.kind,
        progress: {
          received: scanPartialBytes(model),
          total: model.sizeBytes,
          percent: null,
          speed: 0,
        },
      });
      return { ok: false, canceled: true };
    }
    const err = e instanceof Error ? e.message : String(e);
    emitLog(`模型下载失败：${model.name}：${err}`);
    emitModelProgress({
      size,
      model: model.name,
      kind: model.kind,
      progress: {
        received: scanPartialBytes(model),
        total: model.sizeBytes,
        percent: null,
        speed: 0,
      },
    });
    return { ok: false, error: err };
  }
}

/** 下载指定档位的检测 + 识别两个模型（缺哪个下哪个），等待全部完成。 */
export async function downloadPpOcrModels(
  size: PpOcrModelSize,
): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  const models = ppOcrCatalog(size);
  const results = await Promise.all([
    downloadPpOcrModel(size, models.det),
    downloadPpOcrModel(size, models.rec),
  ]);
  if (results.some((r) => r.canceled)) return { ok: false, canceled: true, error: "下载已取消" };
  const failed = results.find((r) => !r.ok && !r.already);
  return failed ? { ok: false, error: failed.error ?? "模型下载失败" } : { ok: true };
}

/** 取消指定档位的进行中下载（保留分片，可后续续传）。 */
export function cancelPpOcrModelDownload(size: PpOcrModelSize): { ok: boolean } {
  const models = ppOcrCatalog(size);
  for (const m of [models.det, models.rec]) {
    const c = activeModelDownloads.get(m.name);
    if (c) {
      try {
        c.abort();
      } catch {
        // ignore
      }
    }
  }
  return { ok: true };
}

/** 清空指定档位的未完成分片（重新下载前把半成品清掉）。 */
export function deletePpOcrPartialModels(size: PpOcrModelSize): { ok: boolean } {
  const models = ppOcrCatalog(size);
  const dir = getDownloadsDir();
  for (const m of [models.det, models.rec]) {
    if (isModelDirReady(m)) continue;
    const c = activeModelDownloads.get(m.name);
    if (c) {
      try {
        c.abort();
      } catch {
        // ignore
      }
    }
    try {
      for (const n of readdirSync(dir)) {
        if (n === `${m.name}.tar` || n.startsWith(`${m.name}.tar.part`)) {
          rmSync(path.join(dir, n), { force: true });
        }
      }
    } catch {
      // ignore
    }
  }
  return { ok: true };
}

/** 删除指定档位的全部模型文件（已就绪 + 半成品分片），可重新下载。 */
export async function deletePpOcrModels(size: PpOcrModelSize): Promise<{ ok: boolean }> {
  try {
    await stopPpOcr();
  } catch {
    // worker 未运行时忽略
  }
  cancelPpOcrModelDownload(size);
  const models = ppOcrCatalog(size);
  for (const m of [models.det, models.rec]) {
    try {
      rmSync(getModelDir(m.name), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  // 模型目录已删，这里顺带清掉残留的 tar / .partN 分片。
  return deletePpOcrPartialModels(size);
}

/** 确保档位模型已就绪；缺则自动下载（进度经 onPpOcrModelProgress 上报）。 */
async function ensurePpOcrModels(size: PpOcrModelSize): Promise<void> {
  const models = ppOcrCatalog(size);
  const missing = [models.det, models.rec].filter((m) => !isModelDirReady(m));
  if (missing.length === 0) return;
  emitPhase("downloading", `正在下载 PP-OCRv6 ${size} 模型（${missing.length}/2）…`);
  const r = await downloadPpOcrModels(size);
  if (!r.ok) {
    emitPhase("idle", "");
    throw new Error(r.canceled ? "模型下载已取消" : (r.error ?? "模型下载失败"));
  }
  emitPhase("ready", "");
}

// ---------------------------------------------------------------------------
// 常驻 Python worker（JSON-lines over stdio）
// ---------------------------------------------------------------------------

/** spawn 配置 { stdout/stderr: "pipe", stdin: "pipe" } 时的子进程形态。 */
type PipeProc = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: {
    write: (chunk: Uint8Array) => number | Promise<number>;
    flush?: () => void;
  };
  exited: Promise<number>;
  exitCode: number | null;
  kill: () => void;
};

type PendingRecognize = {
  resolve: (r: PpOcrRecognitionResult) => void;
  reject: (e: Error) => void;
};

type ActiveWorker = {
  modelSize: PpOcrModelSize;
  proc: PipeProc;
  pendingLoad: { resolve: (r: { ok: boolean; error?: string }) => void } | null;
  pending: Map<number, PendingRecognize>;
};

let activeWorker: ActiveWorker | null = null;
let opSeq = 1;

function ppOcrWorkerScript(): string {
  return path.join(import.meta.dir, "ppocr-worker.py");
}

function getActiveWorker(): ActiveWorker | null {
  if (!activeWorker || activeWorker.proc.exitCode !== null) return null;
  return activeWorker;
}

/** 当前已启动（常驻）的模型档位；没有则 null。 */
export function getPpOcrActive(): { modelSize: PpOcrModelSize } | null {
  const w = getActiveWorker();
  return w ? { modelSize: w.modelSize } : null;
}

function handleWorkerLine(line: string): void {
  const w = activeWorker;
  if (!w) return;
  let obj: {
    type?: string;
    id?: number;
    phase?: string;
    seconds?: number;
    message?: string;
    result?: PpOcrRecognitionResult;
  };
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  switch (obj.type) {
    case "phase":
      if (obj.phase === "downloading") {
        emitPhase("downloading", obj.message ?? "");
      } else if (obj.phase === "loading") {
        emitPhase("loading", `正在加载模型… ${obj.seconds ?? 0}s`);
      } else if (obj.phase === "recognizing") {
        emitPhase("recognizing", "");
      }
      break;
    case "loaded": {
      emitPhase("ready", `模型已加载完成（${obj.seconds ?? 0}s）`);
      const l = w.pendingLoad;
      w.pendingLoad = null;
      l?.resolve({ ok: true });
      break;
    }
    case "recognized": {
      const p = w.pending.get(obj.id ?? -1);
      w.pending.delete(obj.id ?? -1);
      if (p) p.resolve(obj.result ?? { text: "", lines: [] });
      emitPhase("ready", "");
      break;
    }
    case "error": {
      const err = obj.message ?? "worker 错误";
      if (obj.id != null && w.pending.has(obj.id)) {
        const p = w.pending.get(obj.id)!;
        w.pending.delete(obj.id);
        p.reject(new Error(err));
      } else if (w.pendingLoad) {
        const l = w.pendingLoad;
        w.pendingLoad = null;
        l.resolve({ ok: false, error: err });
      }
      emitPhase("error", err);
      break;
    }
  }
}

function pumpWorkerStreams(): void {
  const w = activeWorker;
  if (!w) return;
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    const reader = w.proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) handleWorkerLine(line.trim());
      }
    }
  })();
  // stderr 里是 paddle 的日志噪音，转发到安装日志便于排查。
  void streamLines(w.proc.stderr, true);
}

async function workerSend(obj: Record<string, unknown>): Promise<void> {
  const w = activeWorker;
  if (!w) throw new Error("worker 未运行");
  await w.proc.stdin.write(new TextEncoder().encode(JSON.stringify(obj) + "\n"));
  w.proc.stdin.flush?.();
}

/**
 * 启动并加载常驻 worker（引擎驻留内存，之后识别不再重载权重）。
 * 同一档位已启动 → 直接返回 already；切换档位会自动停掉旧 worker。
 * 首次启动会自动下载 PP-OCRv6 模型（medium 约 140MB），下载/加载阶段
 * 通过 onPpOcrPhase 上报。
 */
export async function startPpOcr(
  modelSize?: PpOcrModelSize,
): Promise<{ ok: boolean; error?: string; already?: boolean }> {
  const size = normalizeModelSize(modelSize ?? getSetting("PPOCR_MODEL_SIZE"));
  const py = venvBinary("python3");
  if (!existsSync(py)) {
    return { ok: false, error: "PaddleOCR 引擎未安装，请先点击「下载引擎」" };
  }
  if (!(await getPpOcrVersion())) {
    return { ok: false, error: "PaddleOCR 引擎未安装完整，请重新点击「下载引擎」" };
  }
  // 模型缺失时自动下载（进度实时上报），下载完才启动 worker。
  try {
    await ensurePpOcrModels(size);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const cur = getActiveWorker();
  if (cur && cur.modelSize === size) {
    return { ok: true, already: true };
  }
  await stopPpOcr();

  emitLog(`启动 PaddleOCR worker（PP-OCRv6 ${size}）…`);
  emitPhase("starting", "");
  let proc: PipeProc;
  try {
    proc = Bun.spawn([py, ppOcrWorkerScript()], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    }) as unknown as PipeProc;
  } catch (e) {
    const err = `启动 worker 失败：${e instanceof Error ? e.message : e}`;
    emitPhase("error", err);
    return { ok: false, error: err };
  }
  activeWorker = {
    modelSize: size,
    proc,
    pendingLoad: null,
    pending: new Map(),
  };
  const w = activeWorker;
  pumpWorkerStreams();

  // worker 在加载/识别期间意外退出 → 兜底报错而不是永远 pending。
  void proc.exited.then((code) => {
    if (activeWorker !== w) return; // 已被 stopPpOcr 主动清理
    activeWorker = null;
    if (w.pendingLoad) {
      w.pendingLoad.resolve({ ok: false, error: `worker 进程提前退出（退出码 ${code}）` });
      w.pendingLoad = null;
    }
    for (const [, p] of w.pending) p.reject(new Error(`worker 进程退出（退出码 ${code}）`));
    w.pending.clear();
    emitPhase("idle", "");
  });

  const loadResult = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    activeWorker!.pendingLoad = { resolve };
  });
  try {
    const models = ppOcrCatalog(size);
    await workerSend({
      msg: "load",
      modelSize: size,
      detDir: getModelDir(models.det.name),
      recDir: getModelDir(models.rec.name),
    });
  } catch (e) {
    return { ok: false, error: `发送加载指令失败：${e instanceof Error ? e.message : e}` };
  }
  // 加载超时兜底：worker 构造期间若被 paddle 内部行为卡死（典型：运行时
  // 联网拉取缺失模型而网络不通），没有任何回复会永远 pending —— 界面无限
  // 「识别中…」。超时则杀掉 worker 报错，用户可重试。
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([
    loadResult,
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      loadTimer = setTimeout(
        () => resolve({ ok: false, error: "模型加载超时（5 分钟），已停止引擎，请重试" }),
        300_000,
      );
    }),
  ]);
  if (loadTimer) clearTimeout(loadTimer);
  if (r.ok) {
    emitLog(`PaddleOCR（PP-OCRv6 ${size}）已就绪，可开始识别。`);
  } else {
    emitLog(`PaddleOCR 启动失败：${r.error}`);
    await stopPpOcr();
  }
  return r;
}

/** 停止常驻 worker，释放内存。 */
export async function stopPpOcr(): Promise<{ ok: boolean }> {
  const w = activeWorker;
  activeWorker = null;
  emitPhase("idle", "");
  if (!w) return { ok: true };
  try {
    await w.proc.stdin.write(new TextEncoder().encode('{"msg":"quit"}\n'));
    w.proc.stdin.flush?.();
  } catch {}
  const t = setTimeout(() => {
    try {
      w.proc.kill();
    } catch {}
  }, 3000);
  try {
    await w.proc.exited;
  } catch {}
  clearTimeout(t);
  return { ok: true };
}

function recognizeViaWorker(imagePath: string): Promise<PpOcrRecognitionResult> {
  const w = getActiveWorker();
  if (!w) throw new Error("worker 未运行，请先启动 PaddleOCR 引擎");
  const id = opSeq++;
  return new Promise<PpOcrRecognitionResult>((resolve, reject) => {
    // 识别超时兜底：predict 卡死时杀掉 worker 并报错，避免界面无限「识别中…」。
    const timer = setTimeout(() => {
      if (!w.pending.delete(id)) return;
      reject(new Error("识别超时（3 分钟），已停止引擎，请重试"));
      void stopPpOcr();
    }, 180_000);
    w.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    workerSend({ id, msg: "recognize", imagePath }).catch((e) => {
      clearTimeout(timer);
      w.pending.delete(id);
      reject(e);
    });
  });
}

// ---------------------------------------------------------------------------
// 识别入口
// ---------------------------------------------------------------------------

/**
 * 用本地 PaddleOCR（PP-OCRv6）识别一张图片（PNG/JPG/WebP/BMP/TIFF/HEIC，
 * 或 PDF 首页）。先归一化为 PNG 再交给常驻 worker，输出行级文本框与置信度
 * （结构同 Tesseract 路径的 OcrResult）。
 */
export async function runPpOcr(input: {
  imageRef: string;
  modelSize?: PpOcrModelSize;
}): Promise<OcrResult> {
  const size = normalizeModelSize(input.modelSize ?? getSetting("PPOCR_MODEL_SIZE"));
  updateSettings({ PPOCR_MODEL_SIZE: size });
  if (getSetting("OCR_ENGINE") !== "paddleocr") {
    throw new Error("PaddleOCR 引擎未启用，请先在 OCR 页切换到 PaddleOCR 引擎");
  }
  if (!existsSync(venvBinary("python3")) || !(await getPpOcrVersion())) {
    throw new Error("PaddleOCR 引擎未安装，请先点击「下载引擎」");
  }

  const abs = resolveOcrImage(input.imageRef);
  if (!abs) throw new Error("图片文件不存在");

  const images = await convertFileToImages(Bun.file(abs));
  if (!images.length) throw new Error("无法解析图片");
  const tmpDir = path.join(getImagesBaseDir(), "ocr", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpPng = path.join(tmpDir, `ppocr-${crypto.randomUUID().slice(0, 8)}.png`);

  try {
    await images[0]!.png().toFile(tmpPng);
    const started = await startPpOcr(size);
    if (!started.ok) throw new Error(started.error ?? "PaddleOCR 启动失败");
    const result = await recognizeViaWorker(tmpPng);
    if (!result.lines.length && !result.text.trim()) {
      throw new Error("识别结果为空");
    }
    const lines: OcrLine[] = result.lines.map((l) => {
      const box = l.box ?? [0, 0, 0, 0];
      return {
        left: box[0],
        top: box[1],
        right: box[2],
        bottom: box[3],
        conf: l.conf,
        text: l.text,
        words: [],
      };
    });
    saveOcrRecord({ imagePath: abs, markdown: result.text, raw: result.text });
    return {
      text: result.text,
      engine: "paddleocr",
      modelLabel: `PP-OCRv6 ${size}`,
      modelCode: size,
      psm: undefined,
      lines,
    };
  } finally {
    try {
      rmSync(tmpPng, { force: true });
    } catch {
      // ignore
    }
  }
}
