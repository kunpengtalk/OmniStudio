import { existsSync, mkdirSync, rmSync } from "fs";
import path from "path";

import { getSetting, updateSettings } from "./db/settings";
import { getDataDir } from "./paths";
import { getImagesBaseDir } from "./image-server";
import { convertFileToImages } from "./vllm";
import { resolveOcrImage, type OcrLine, type OcrResult } from "./ocr";
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

function normalizeModelSize(v?: string): PpOcrModelSize {
  return v === "tiny" || v === "small" || v === "medium" ? v : "medium";
}

export async function getPpOcrStatus(): Promise<PpOcrStatus> {
  const pythonPath = await findPython();
  const version = await getPpOcrVersion();
  const engineInstalled = version !== null && existsSync(venvBinary("python3"));
  const active = getActiveWorker();
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
  };
}

// ---------------------------------------------------------------------------
// 一键安装引擎（uv venv + pip，默认源失败自动换清华镜像）
// ---------------------------------------------------------------------------

export async function downloadPpOcrEngine(): Promise<{
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
      emitLog(`$ uv venv --python ${python} ${engineDir}`);
      const venv = Bun.spawnSync([uv, "venv", "--python", python, engineDir], {
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
      emitLog(`$ ${python} -m venv ${engineDir}`);
      const venv = Bun.spawnSync([python, "-m", "venv", engineDir], {
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
    await workerSend({ msg: "load", modelSize: size });
  } catch (e) {
    return { ok: false, error: `发送加载指令失败：${e instanceof Error ? e.message : e}` };
  }
  const r = await loadResult;
  if (r.ok) {
    emitLog(`PaddleOCR（PP-OCRv6 ${size}）已就绪，可开始识别。`);
  } else {
    emitLog(`PaddleOCR 启动失败：${r.error}`);
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
    w.pending.set(id, { resolve, reject });
    workerSend({ id, msg: "recognize", imagePath }).catch((e) => {
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
