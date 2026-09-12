import {
  existsSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import path from "path";
import { getDataDir } from "./paths";
import { getSetting } from "./db/settings";

/**
 * MLX 本地生图引擎（Apple Silicon）。
 *
 * 基于 mflux（https://github.com/mflux-community/mflux）—— 多个主流生图模型
 * （FLUX.1 / FLUX.2 / Z-Image 等）的 MLX 原生移植，通过 pip 安装到
 * userData/engines/mflux 独立 venv，按模型家族调用对应 CLI：
 *
 *   mflux-generate-z-image-turbo --prompt "…" --width 1024 --height 1024 \
 *     --steps 9 --seed 42 --output out.png -q 8
 *   mflux-generate --model dev|schnell …
 *   mflux-generate-flux2 --model flux2-klein-9b …
 *
 * 模型权重由 mflux 在首次生成时自动从 HuggingFace 下载并缓存
 * （默认 ~/Library/Caches/mflux），无需应用侧管理下载。
 */

// ---------------------------------------------------------------------------
// 模型目录
// ---------------------------------------------------------------------------

export type MlxModelInfo = {
  id: string;
  label: string;
  description: string;
  /** mflux 的 CLI 可执行名。 */
  cmd: string;
  /** 传给 --model 的内置模型名（无则不需要）。 */
  modelArg: string | null;
  defaultSteps: number;
  /** 权重近似大小（FP16），量化后显著更小。 */
  approxSizeGb: number;
};

export const MLX_MODELS: MlxModelInfo[] = [
  {
    id: "z-image-turbo",
    label: "Z-Image Turbo (6B)",
    description: "快速、轻量、真实感强，9 步出图，8-bit 量化后约 6GB 内存",
    cmd: "mflux-generate-z-image-turbo",
    modelArg: null,
    defaultSteps: 9,
    approxSizeGb: 12,
  },
  {
    id: "flux-schnell",
    label: "FLUX.1 Schnell (12B)",
    description: "4 步蒸馏模型，速度与质量均衡，8-bit 量化约 12GB 内存",
    cmd: "mflux-generate",
    modelArg: "schnell",
    defaultSteps: 4,
    approxSizeGb: 24,
  },
  {
    id: "flux2-klein-9b",
    label: "FLUX.2 Klein 9B",
    description: "新一代 FLUX 蒸馏模型，质量好，支持编辑能力",
    cmd: "mflux-generate-flux2",
    modelArg: "flux2-klein-9b",
    defaultSteps: 4,
    approxSizeGb: 18,
  },
  {
    id: "flux-dev",
    label: "FLUX.1 Dev (12B)",
    description: "完整版 FLUX，质量最高但较慢（约 50 步），建议 32GB+ 内存并量化",
    cmd: "mflux-generate",
    modelArg: "dev",
    defaultSteps: 50,
    approxSizeGb: 24,
  },
];

export function findMlxModel(id: string): MlxModelInfo | null {
  return MLX_MODELS.find((m) => m.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// 引擎环境（venv）管理
// ---------------------------------------------------------------------------

export type MlxGenStatus = {
  /** 平台是否支持（Apple Silicon macOS）。 */
  supported: boolean;
  /** 是否找到 python3（>= 3.10 由用户环境保证，检测时提示）。 */
  pythonFound: boolean;
  pythonPath: string | null;
  /** venv + mflux 是否已安装。 */
  engineInstalled: boolean;
  version: string | null;
  binDir: string | null;
};

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

/** mflux venv 根目录（userData/engines/mflux，结构为标准 python venv）。 */
function getEngineDir(): string {
  return getDataDir("engines", "mflux");
}

function getVenvBinDir(): string {
  return path.join(getEngineDir(), "bin");
}

function venvBinary(name: string): string {
  return path.join(getVenvBinDir(), name);
}

async function findPython(): Promise<string | null> {
  const candidates = [
    "python3.12",
    "python3.13",
    "python3.11",
    "python3.10",
    "python3",
    "python3.14",
  ];
  for (const name of candidates) {
    const p = Bun.which(name, { PATH: getSearchPath() });
    if (!p) continue;
    const v = await getPythonVersion(p);
    if (v && v >= 10 && v <= 14) return p;
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

// ---------------------------------------------------------------------------
// 安装日志广播（供主进程推送到前端实时展示）
// ---------------------------------------------------------------------------

type LogCallback = (text: string) => void;
const logListeners = new Set<LogCallback>();

export function onInstallLog(cb: LogCallback): () => void {
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

/** 逐行读取子进程输出并转发到日志。 */
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

async function getMfluxVersion(): Promise<string | null> {
  const py = venvBinary("python3");
  if (!existsSync(py)) return null;
  try {
    const proc = Bun.spawnSync(
      [py, "-c", "import importlib.metadata as m; print(m.version('mflux'))"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = proc.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

export async function getMlxGenStatus(): Promise<MlxGenStatus> {
  const supported = process.platform === "darwin" && process.arch === "arm64";
  const pythonPath = await findPython();
  const version = await getMfluxVersion();
  const generateBin = venvBinary("mflux-generate");
  return {
    supported,
    pythonFound: !!pythonPath,
    pythonPath,
    engineInstalled: version !== null && existsSync(generateBin),
    version,
    binDir: version ? getVenvBinDir() : null,
  };
}

/**
 * 一键安装 mflux 引擎。
 *
 * 策略：
 * 1. 优先使用 uv（速度快一个量级）：`uv venv` + `uv pip install mflux`；
 *    没有 uv 时回退到 `python3 -m venv` + pip。
 * 2. Python 版本优先 3.12 / 3.13（依赖轮子最全），3.14 兜底。
 * 3. 默认 PyPI 源失败时自动用清华镜像重试一次。
 * 4. 已有 venv 的 Python 版本与目标不一致时删掉重建，避免旧环境损坏。
 *
 * 全程日志通过 onInstallLog 广播，主进程转发到前端实时展示。
 */
export async function downloadMlxEngine(): Promise<{
  ok: boolean;
  error?: string;
  version?: string;
}> {
  if (!(process.platform === "darwin" && process.arch === "arm64")) {
    return { ok: false, error: "MLX 引擎仅支持 Apple Silicon (arm64) 的 macOS" };
  }
  const python = await findPython();
  if (!python) {
    return { ok: false, error: "未找到 python3，请先安装 Python 3.10+（brew install python）" };
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

  // ---- 安装 mflux（默认源失败自动换清华镜像重试） ----
  const mirror = "https://pypi.tuna.tsinghua.edu.cn/simple";
  const runInstall = async (indexArgs: string[]): Promise<number> => {
    const cmd = uv
      ? [uv, "pip", "install", "--python", enginePython, "--upgrade", "mflux", ...indexArgs]
      : [venvBinary("pip3"), "install", "--upgrade", "mflux", ...indexArgs];
    emitLog(`$ ${cmd.join(" ")}`);
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    await Promise.all([
      streamLines(proc.stdout),
      streamLines(proc.stderr, true),
    ]);
    return await proc.exited;
  };

  let code = await runInstall([]);
  if (code !== 0) {
    emitLog(`默认 PyPI 源安装失败（退出码 ${code}），改用清华镜像重试…`);
    code = await runInstall(["-i", mirror]);
  }
  if (code !== 0) {
    emitLog("mflux 安装失败");
    return {
      ok: false,
      error: `mflux 安装失败（退出码 ${code}）。可能是网络问题，请检查代理/网络后重试，详见安装日志。`,
    };
  }

  const version = await getMfluxVersion();
  emitLog(version ? `安装成功：mflux ${version}` : "安装成功");
  return { ok: true, version: version ?? undefined };
}

// ---------------------------------------------------------------------------
// 模型权重下载（先下载、后生成；带进度）
// ---------------------------------------------------------------------------

export type MlxModelDownloadProgress = {
  modelId: string;
  /** 当前正在下载的文件（相对仓库路径）。 */
  fileName: string;
  /** 当前文件已接收/总字节。 */
  received: number;
  total: number;
  /** 已下载完成的累计字节 / 仓库总字节。 */
  doneBytes: number;
  allBytes: number;
  /** 已下载文件数 / 总文件数。 */
  filesDone: number;
  filesTotal: number;
  /** 整体百分比 0-100。 */
  percent: number;
  /** downloading | done | error */
  stage: "downloading" | "done" | "error";
};

type MlxProgressCallback = (p: MlxModelDownloadProgress) => void;
const progressListeners = new Set<MlxProgressCallback>();

export function onMlxModelProgress(cb: MlxProgressCallback): () => void {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

function emitProgress(p: MlxModelDownloadProgress): void {
  for (const cb of progressListeners) {
    try {
      cb(p);
    } catch {}
  }
}

/** venv 内 python3 可执行文件。 */
function enginePython(): string {
  return venvBinary("python3");
}

/** 模型权重预下载脚本的绝对路径。 */
function modelHelperScript(): string {
  return path.join(import.meta.dir, "mlx-model.py");
}

/** 解析脚本 stdout/stderr 输出的 tqdm 字节进度（如 “1.2G/2.4G”）。 */
function parseBytes(s: string): { current: number; total: number } | null {
  const m = s.match(/(\d+(?:\.\d+)?)([KMG]?)B\/(\d+(?:\.\d+)?)([KMG]?)B/);
  if (!m) return null;
  const unit = (v: string) => (v === "K" ? 1e3 : v === "M" ? 1e6 : v === "G" ? 1e9 : 1);
  return {
    current: parseFloat(m[1]!) * unit(m[2]!),
    total: parseFloat(m[3]!) * unit(m[4]!),
  };
}

/**
 * 预下载某个 MLX 模型的权重（调用 venv 内的 mlx-model.py）。
 * 不阻塞 UI：返回 Promise，过程中经 onMlxModelProgress 推送进度、
 * onInstallLog 推送日志，结束（成功/失败）后 Promise resolve。
 * 同一模型的重复调用会复用进行中的下载，不会起多个进程。
 */
const activeMlxDownloads = new Map<string, Promise<{ ok: boolean; error?: string }>>();

export function downloadMlxModel(modelId: string): Promise<{ ok: boolean; error?: string }> {
  const existing = activeMlxDownloads.get(modelId);
  if (existing) return existing;
  const p = doDownloadMlxModel(modelId).finally(() => {
    activeMlxDownloads.delete(modelId);
    // 下载结束（成功/失败）后失效缓存，让下一次查询重新扫盘得到最新状态。
    invalidateDownloadedMlxCache();
  });
  activeMlxDownloads.set(modelId, p);
  return p;
}

/**
 * 杀掉同模型的残留下载进程（上一次会话崩溃/被强杀、或外部启动的孤儿进程）。
 * 它们会占着 HF 缓存锁并和新下载进程争抢同一批 blob，导致新进程报“退出码 2”。
 * 通过命令行匹配可靠的 `mlx-model.py download <modelId>` 特征，避免误杀无关进程。
 */
function killOrphanMlxDownloads(modelId: string): void {
  try {
    const scriptName = path.basename(modelHelperScript());
    const out = Bun.spawnSync(["pgrep", "-f", `${scriptName} download ${modelId}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const pids = out.stdout
      .toString()
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
    for (const pid of pids) {
      // 跳过自己（当前进程不是 python，不会匹配，这里做防御）。
      if (pid === process.pid) continue;
      try {
        process.kill(pid, "SIGKILL");
        emitLog(`已清理残留的模型下载进程 (PID ${pid})`);
      } catch {}
    }
  } catch {
    // pgrep 不存在或失败时静默忽略。
  }
}

async function doDownloadMlxModel(
  modelId: string,
): Promise<{ ok: boolean; error?: string }> {
  const model = findMlxModel(modelId) ?? MLX_MODELS[0]!;
  const py = enginePython();
  if (!existsSync(py)) {
    return { ok: false, error: "MLX 引擎未安装，请先点击「下载引擎」" };
  }

  // 已完整下载 → 直接成功（顺带清掉可能残留的进度记录）。
  if (await isMlxModelDownloaded(model.id)) {
    clearDownloadState(model.id);
    emitLog(`模型 ${model.label} 已完整下载，无需重复下载。`);
    return { ok: true };
  }

  emitLog(`开始下载模型权重：${model.label} …`);

  // 先清理可能残留的“上一个会话/外部遗留”的同模型下载进程。
  // 否则两个进程同时写同一份 HF 缓存会互相抢锁，导致本次下载报“退出码 2”等失败。
  killOrphanMlxDownloads(model.id);

  // 断点续传：先从持久化进度恢复起始值，进度条接着走而不是从 0 重新开始。
  const prev = readDownloadState(model.id);
  let singleRun = {
    repo: "",
    allBytes: prev?.allBytes ?? 0,
    curFile: "",
    curStart: 0,
    curSize: 0,
    curReceived: 0,
    doneBytes: prev?.doneBytes ?? 0,
    filesDone: prev?.filesDone ?? 0,
    filesTotal: 0,
    stage: "downloading" as "downloading" | "done" | "error",
    error: "",
  };

  function snapshotState(): MlxModelDownloadState {
    const all = singleRun.allBytes || 1;
    const done = singleRun.doneBytes + Math.min(singleRun.curReceived, singleRun.curSize);
    return {
      modelId: model.id,
      doneBytes: Math.min(done, singleRun.allBytes || done),
      allBytes: singleRun.allBytes,
      filesDone: singleRun.filesDone,
      filesTotal: singleRun.filesTotal,
      percent: Math.min(100, Math.round((done / all) * 100)),
      updatedAt: Date.now(),
    };
  }

  // 进度续存：关键节点（文件完成/失败）强制写，进行中 2s 节流，避免高频写盘。
  let lastPersistAt = 0;
  const persist = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPersistAt < 2000) return;
    lastPersistAt = now;
    writeDownloadState(snapshotState());
  };

  emitProgress({
    modelId,
    fileName: "",
    received: 0,
    total: 0,
    doneBytes: singleRun.doneBytes,
    allBytes: singleRun.allBytes,
    filesDone: singleRun.filesDone,
    filesTotal: 0,
    percent: snapshotState().percent,
    stage: "downloading",
  });
  persist(true);

  const proc = Bun.spawn(
    [py, modelHelperScript(), "download", model.id],
    { stdout: "pipe", stderr: "pipe" },
  );

  const parser = (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) await handleLine(line.trim());
      }
    }
    if (buf.trim()) await handleLine(buf.trim());

    function handleLine(line: string) {
      // 统一状态
      const st = singleRun;
      if (line.startsWith("REPO ")) {
        st.repo = line.slice(5);
      } else if (line.startsWith("TOTAL ")) {
        st.allBytes = Number(line.slice(6)) || 0;
      } else if (line.startsWith("FILE ")) {
        const parts = line.split(" ");
        const file = parts[1] ?? "";
        const startByte = Number(parts[2]) || 0;
        const fileSize = Number(parts[3]) || 0;
        st.filesTotal += 1;
        st.curFile = file;
        st.curStart = startByte;
        st.curSize = fileSize;
        emitProgress(buildProgress(st, "downloading"));
      } else if (line.startsWith("DONE ")) {
        st.filesDone += 1;
        st.doneBytes = st.curStart + st.curSize;
        persist();
        emitProgress(buildProgress(st, "downloading"));
      } else if (line.startsWith("OK")) {
        st.stage = "done";
        emitProgress(buildProgress(st, "done"));
      } else if (line.startsWith("ERROR ")) {
        st.error = line.slice(6);
        st.stage = "error";
        persist(true);
        emitProgress(buildProgress(st, "error"));
      }
    }
  })();

  // tqdm 字节进度（stderr）→ 更新当前文件 received
  const stderrTail: string[] = [];
  const stderrReader = proc.stderr.getReader();
  const stderrDec = new TextDecoder();
  let sbuf = "";
  (async () => {
    for (;;) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      sbuf += stderrDec.decode(value, { stream: true });
      const lines = sbuf.split("\r");
      sbuf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        stderrTail.push(line);
        if (stderrTail.length > 50) stderrTail.shift();
        const b = parseBytes(line);
        if (b && singleRun.curSize > 0) {
          // tqdm 报的是当前文件内已接收字节，回写后再广播，前端进度条才会动。
          singleRun.curReceived = Math.min(b.current, singleRun.curSize);
          persist();
          emitProgress(buildProgress(singleRun, "downloading"));
        }
      }
    }
  })();

  function buildProgress(
    st: typeof singleRun,
    stage: "downloading" | "done" | "error",
  ): MlxModelDownloadProgress {
    const all = st.allBytes || 1;
    // 整体百分比 = 已完成文件 + 当前文件的部分进度，下载大文件时不会长时间停住。
    const part = st.stage === "downloading" ? Math.min(st.curReceived, st.curSize) : 0;
    const percent =
      stage === "done"
        ? 100
        : Math.min(100, Math.round((((st.doneBytes + part) / all) * 10000) / 100));
    return {
      modelId: model.id,
      fileName: st.curFile,
      received: st.curReceived,
      total: st.curSize,
      doneBytes: st.doneBytes,
      allBytes: st.allBytes,
      filesDone: st.filesDone,
      filesTotal: st.filesTotal,
      percent,
      stage,
    };
  }

  const [code] = await Promise.all([proc.exited, parser]);
  const done = singleRun.stage === "done" || code === 0 && !singleRun.error;
  if (done && singleRun.stage !== "error") {
    clearDownloadState(model.id);
    emitLog(`模型 ${model.label} 下载完成。`);
    emitProgress({ ...buildProgress(singleRun, "done"), percent: 100 });
    return { ok: true };
  }
  const err =
    singleRun.error ||
    stderrTail.slice(-5).join(" | ") ||
    `模型权重下载失败（退出码 ${code}）`;
  // 保存失败现场（已下载多少/剩多少），下次点「继续下载」从这里接着下。
  persist(true);
  emitLog(`模型 ${model.label} 下载失败：${err}`);
  emitProgress(buildProgress(singleRun, "error"));
  return { ok: false, error: err };
}

/** 模型 id → HuggingFace 仓库（与 mlx-model.py 保持一致）。 */
const MLX_MODEL_REPOS: Record<string, string> = {
  "z-image-turbo": "Tongyi-MAI/Z-Image-Turbo",
  "flux-schnell": "black-forest-labs/FLUX.1-schnell",
  "flux2-klein-9b": "black-forest-labs/FLUX.2-klein-9B",
  "flux-dev": "black-forest-labs/FLUX.1-dev",
};

/** HF 仓库对应的本地缓存 snapshots 目录。 */
function hfSnapshotDir(repo: string): string {
  const home = process.env.HOME ?? "";
  const name = `models--${repo.replace("/", "--")}`;
  return path.join(home, ".cache", "huggingface", "hub", name, "snapshots");
}
/** 单个模型的 Python check 结果缓存（避免 3s 轮询时反复起 Python 进程）。 */
const checkCache = new Map<string, { at: number; ok: boolean }>();

/** 用便携的本地检查快速拦截“明显没下完”的情况：连 snapshot 都没有就不用起 Python 了。 */
function snapshotDirExists(modelId: string): boolean {
  const repo = MLX_MODEL_REPOS[modelId];
  if (!repo) return false;
  return existsSync(hfSnapshotDir(repo));
}

/**
 * 权威判断某个 MLX 模型权重是否已完整下载。
 *
 * 拿到“完整”这件事，不能只看 snapshot 里已有的文件是否完好——下载进行到一半时，
 * 已经下载完的那部分（如 text_encoder）看起来是完好的，但 transformer/vae 还没下，
 * 绝不能因此误判“已下载”。所以这里直接调用 venv 内的 mlx-model.py check：它通过
 * mflux 自己的 WeightDefinition + HF 仓库文件树，列出模型**应包含的全部文件**，再以
 * local_files_only 校验这些文件是否全部就位，返回 OK 才算真正下完。
 *
 * 结果带短缓存，避免频繁轮询时反复起 Python。
 */
export async function isMlxModelDownloaded(modelId: string): Promise<boolean> {
  if (!snapshotDirExists(modelId)) return false;
  const cached = checkCache.get(modelId);
  if (cached && Date.now() - cached.at < 5000) return cached.ok;
  const py = enginePython();
  if (!existsSync(py)) return false;
  try {
    const proc = Bun.spawnSync(
      [py, modelHelperScript(), "check", modelId],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    const out = proc.stdout.toString();
    const ok = proc.exitCode === 0 && /\bOK\b/.test(out);
    checkCache.set(modelId, { at: Date.now(), ok });
    return ok;
  } catch {
    return false;
  }
}

/** 失效某个模型的 check 缓存（下载完成/开始后调用）。 */
function invalidateModelCheck(modelId: string): void {
  checkCache.delete(modelId);
}

/** 返回已下载（可生成）的 MLX 模型 id 列表。 */
export async function getDownloadedMlxModelsSync(): Promise<string[]> {
  const result: string[] = [];
  for (const m of MLX_MODELS) {
    if (await isMlxModelDownloaded(m.id)) result.push(m.id);
  }
  return result;
}

/** 已下载模型快照（带缓存 TTL，避免主进程反复扫描磁盘/起 Python）。 */
let downloadedCache: { at: number; ids: string[] } | null = null;
export async function getDownloadedMlxModels(): Promise<string[]> {
  const now = Date.now();
  if (downloadedCache && now - downloadedCache.at < 3000) {
    return downloadedCache.ids;
  }
  const ids = await getDownloadedMlxModelsSync();
  downloadedCache = { at: now, ids };
  return ids;
}

/** 主动失效已下载缓存（下载完成后调用）。 */
export function invalidateDownloadedMlxCache(): void {
  downloadedCache = null;
  checkCache.clear();
}

// ---------------------------------------------------------------------------
// 下载进度持久化（断点续传 / 「继续下载」）
// ---------------------------------------------------------------------------

export type MlxModelDownloadState = {
  modelId: string;
  /** 已下载字节（含当前文件已接收部分）。 */
  doneBytes: number;
  /** 仓库总字节。 */
  allBytes: number;
  filesDone: number;
  filesTotal: number;
  /** 整体百分比 0-100。 */
  percent: number;
  updatedAt: number;
};

/** 进度记录目录（userData/mlx-downloads/<modelId>.json），全程磁盘持久化。 */
function downloadStateDir(): string {
  return getDataDir("mlx-downloads");
}

function downloadStatePath(modelId: string): string {
  return path.join(downloadStateDir(), `${modelId}.json`);
}

function readDownloadState(modelId: string): MlxModelDownloadState | null {
  try {
    const j = JSON.parse(
      readFileSync(downloadStatePath(modelId), "utf8"),
    ) as MlxModelDownloadState;
    if (!j || typeof j.doneBytes !== "number") return null;
    return j;
  } catch {
    return null;
  }
}

function writeDownloadState(st: MlxModelDownloadState): void {
  try {
    mkdirSync(downloadStateDir(), { recursive: true });
    writeFileSync(downloadStatePath(st.modelId), JSON.stringify(st), "utf8");
  } catch {
    // 进度持久化失败不阻塞下载本身。
  }
}

function clearDownloadState(modelId: string): void {
  try {
    rmSync(downloadStatePath(modelId), { force: true });
  } catch {}
}

/** 各模型最近一次持久化的下载进度（UI 据此展示「继续下载（已下载 X%）」）。 */
export async function getMlxModelDownloadStates(): Promise<MlxModelDownloadState[]> {
  const dir = downloadStateDir();
  if (!existsSync(dir)) return [];
  const out: MlxModelDownloadState[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const modelId = f.slice(0, -".json".length);
    if (!MLX_MODELS.some((m) => m.id === modelId)) continue;
    // 已完整下载的残留记录直接清掉，不给 UI 留错误状态。
    if (await isMlxModelDownloaded(modelId)) {
      clearDownloadState(modelId);
      continue;
    }
    const st = readDownloadState(modelId);
    if (st) out.push(st);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 常驻生图 worker（启动一次模型、反复生成；当前支持 Z-Image 系列）
//
// 一次性 CLI 每次生图都要新起进程并重新加载权重 + 即时量化（几十秒到一分钟），
// UI 上表现为“点了生图半天没反应”。worker 把模型加载一次常驻内存，
// 之后的生图直接走内存模型，几秒出图；启动/加载/生成各阶段通过
// onMlxGenPhase 推送，UI 分步展示。
// ---------------------------------------------------------------------------

export type MlxGenPhase = {
  modelId: string;
  /** idle | starting | loading | loaded | generating | error */
  phase: "idle" | "starting" | "loading" | "loaded" | "generating" | "error";
  /** 加载/生成已耗时（秒）。 */
  seconds?: number;
  /** 当前扩散步 / 总步数。 */
  step?: number;
  total?: number;
  message?: string;
};

type MlxGenPhaseCallback = (p: MlxGenPhase) => void;
const phaseListeners = new Set<MlxGenPhaseCallback>();

/** 订阅生图阶段事件（「启动/加载/生成 n/N」分步展示用）。 */
export function onMlxGenPhase(cb: MlxGenPhaseCallback): () => void {
  phaseListeners.add(cb);
  return () => phaseListeners.delete(cb);
}

function emitPhase(p: MlxGenPhase): void {
  for (const cb of phaseListeners) {
    try {
      cb(p);
    } catch {}
  }
}

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

type ActiveWorker = {
  modelId: string;
  quantize: number;
  proc: PipeProc;
  pendingLoad: { resolve: (r: { ok: boolean; error?: string }) => void } | null;
  pendingGen: { resolve: (r: { ok: boolean; error?: string }) => void } | null;
};

let activeWorker: ActiveWorker | null = null;

/**
 * 空闲自动卸载：常驻 worker 会一直占着数 GB 内存/显存，空闲超过
 * IMG_MLX_IDLE_MINUTES 分钟就让它退出（0 = 不自动卸载）。
 */
let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;

function cancelIdleUnload(): void {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
    idleUnloadTimer = null;
  }
}

function scheduleIdleUnload(): void {
  cancelIdleUnload();
  if (!activeWorker) return;
  const minutes = Number(getSetting("IMG_MLX_IDLE_MINUTES") ?? "");
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  idleUnloadTimer = setTimeout(() => {
    idleUnloadTimer = null;
    if (!activeWorker || activeWorker.pendingGen || activeWorker.pendingLoad) return;
    emitLog(`MLX 生图已空闲 ${minutes} 分钟，自动卸载模型释放内存（可在设置 IMG_MLX_IDLE_MINUTES 调整）。`);
    void stopMlxModel();
  }, minutes * 60_000);
}

function mlxWorkerScript(): string {
  return path.join(import.meta.dir, "mlx-worker.py");
}

/** 当前已启动（常驻）的模型；没有则 null。 */
export function getMlxActiveModel(): { modelId: string; quantize: number } | null {
  if (!activeWorker || activeWorker.proc.exitCode !== null) return null;
  return { modelId: activeWorker.modelId, quantize: activeWorker.quantize };
}

function handleWorkerLine(line: string): void {
  const w = activeWorker;
  if (!w) return;
  let obj: { type?: string; phase?: string; seconds?: number; message?: string };
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  switch (obj.type) {
    case "phase":
      if (obj.phase === "loading") {
        emitPhase({ modelId: w.modelId, phase: "loading", seconds: obj.seconds ?? 0 });
      } else if (obj.phase === "generating") {
        emitPhase({ modelId: w.modelId, phase: "generating" });
      }
      break;
    case "loaded": {
      emitPhase({ modelId: w.modelId, phase: "loaded", seconds: obj.seconds });
      const l = w.pendingLoad;
      w.pendingLoad = null;
      l?.resolve({ ok: true });
      break;
    }
    case "done": {
      const g = w.pendingGen;
      w.pendingGen = null;
      g?.resolve({ ok: true });
      break;
    }
    case "error": {
      const err = obj.message ?? "worker 错误";
      if (w.pendingLoad) {
        const l = w.pendingLoad;
        w.pendingLoad = null;
        l.resolve({ ok: false, error: err });
      } else if (w.pendingGen) {
        const g = w.pendingGen;
        w.pendingGen = null;
        g.resolve({ ok: false, error: err });
      }
      emitPhase({ modelId: w.modelId, phase: "error", message: err });
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
  const edec = new TextDecoder();
  let ebuf = "";
  (async () => {
    const reader = w.proc.stderr.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      ebuf += edec.decode(value, { stream: true });
      const lines = ebuf.split("\r");
      ebuf = lines.pop() ?? "";
      for (const line of lines) {
        // mflux 的 tqdm 步进条：`33%|██▌ | 3/9 [..]` → “生成中 3/9”
        const m = line.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) {
          emitPhase({
            modelId: w.modelId,
            phase: "generating",
            step: Number(m[1]),
            total: Number(m[2]),
          });
        }
      }
    }
  })();
}

async function workerSend(obj: Record<string, unknown>): Promise<void> {
  const w = activeWorker;
  if (!w) throw new Error("worker 未运行");
  await w.proc.stdin.write(new TextEncoder().encode(JSON.stringify(obj) + "\n"));
  w.proc.stdin.flush?.();
}

/**
 * 启动并加载模型到常驻 worker（模型驻留内存，之后生图不再重载权重，大幅提速）。
 * 同一模型已启动 → 直接返回 already；切换模型/量化会自动停掉旧 worker。
 */
export async function startMlxModel(
  modelId: string,
  quantize = 8,
): Promise<{ ok: boolean; error?: string; already?: boolean }> {
  if (!(process.platform === "darwin" && process.arch === "arm64")) {
    return { ok: false, error: "MLX 引擎仅支持 Apple Silicon (arm64) 的 macOS" };
  }
  const model = findMlxModel(modelId) ?? MLX_MODELS[0]!;
  const py = enginePython();
  if (!existsSync(py)) {
    return { ok: false, error: "MLX 引擎未安装，请先点击「下载引擎」" };
  }
  if (!(await isMlxModelDownloaded(model.id))) {
    return { ok: false, error: `模型「${model.label}」尚未下载，请先点「下载模型」` };
  }
  const q = quantize > 0 ? quantize : 0;
  const cur = getMlxActiveModel();
  if (cur && cur.modelId === model.id && cur.quantize === q) {
    return { ok: true, already: true };
  }
  await stopMlxModel();

  emitLog(`启动模型：${model.label}${q ? `（量化 ${q}）` : ""}…`);
  emitPhase({ modelId: model.id, phase: "starting" });
  let proc: PipeProc;
  try {
    proc = Bun.spawn([py, mlxWorkerScript()], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    }) as unknown as PipeProc;
  } catch (e) {
    const err = `启动 worker 失败：${e instanceof Error ? e.message : e}`;
    emitPhase({ modelId: model.id, phase: "error", message: err });
    return { ok: false, error: err };
  }
  activeWorker = {
    modelId: model.id,
    quantize: q,
    proc,
    pendingLoad: null,
    pendingGen: null,
  };
  pumpWorkerStreams();
  const loadResult = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    activeWorker!.pendingLoad = { resolve };
  });
  // worker 在加载完成前意外退出 → 兜底报错而不是永远 pending。
  // 生成过程中退出（OOM / 崩溃）同样立即结算：否则 UI 要等 30 分钟超时才知道失败。
  void proc.exited.then((code) => {
    const w = activeWorker;
    if (!w) return;
    if (w.pendingLoad) {
      const l = w.pendingLoad;
      w.pendingLoad = null;
      l.resolve({ ok: false, error: `worker 进程提前退出（退出码 ${code}）` });
    }
    if (w.pendingGen) {
      const g = w.pendingGen;
      w.pendingGen = null;
      g.resolve({ ok: false, error: `worker 进程在生成过程中退出（退出码 ${code}）` });
    }
    // 死掉的 worker 不能再接指令：清引用，后续生图自动回落 CLI 路径。
    if (activeWorker === w) activeWorker = null;
    cancelIdleUnload();
    emitPhase({ modelId: w.modelId, phase: "error", message: `worker 退出（退出码 ${code}）` });
  });
  try {
    await workerSend({ msg: "load", model: model.id, quantize: q });
  } catch (e) {
    return { ok: false, error: `发送加载指令失败：${e instanceof Error ? e.message : e}` };
  }
  const r = await loadResult;
  if (r.ok) {
    emitLog(`模型 ${model.label} 已加载完成，可快速生图。`);
    // 加载完就进入空闲计时：用户只是加载后没生图时，别让模型一直常驻。
    scheduleIdleUnload();
  } else {
    emitLog(`模型 ${model.label} 加载失败：${r.error}`);
  }
  return r;
}

/** 停止常驻 worker，释放显存/内存。 */
export async function stopMlxModel(): Promise<{ ok: boolean }> {
  cancelIdleUnload();
  const w = activeWorker;
  activeWorker = null;
  if (!w) return { ok: true };
  const modelId = w.modelId;
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
  emitPhase({ modelId, phase: "idle" });
  return { ok: true };
}

/** 走常驻 worker 生成（模型已加载，通常几秒出图）。 */
function generateViaWorker(params: MlxGenerateParams): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const w = activeWorker;
    if (!w) {
      resolve({ ok: false, error: "worker 未运行" });
      return;
    }
    let settled = false;
    const settle = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timeout = setTimeout(() => {
      if (w.pendingGen) w.pendingGen = null;
      settle({ ok: false, error: "worker 生成超时（超过 30 分钟），已终止等待" });
    }, 30 * 60_000);
    w.pendingGen = {
      resolve: (r) => {
        clearTimeout(timeout);
        settle(r);
      },
    };
    workerSend({
      msg: "generate",
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      steps: params.steps,
      seed: params.seed ?? 42,
      guidance: null,
      negative_prompt: "",
      output: params.outputPath,
    }).catch((e) => settle({ ok: false, error: `发送生成指令失败：${e instanceof Error ? e.message : e}` }));
  });
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/** 当前进行中的 MLX 生成（防重复启动；CLI 或 worker 路径共用此锁）。 */
let activeGenerate: Promise<unknown> | null = null;

export type MlxGenerateParams = {
  modelId: string;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed?: number;
  /** 量化位数（3/4/5/6/8），0 或不传表示不量化。 */
  quantize?: number;
  /** 输出 PNG 的绝对路径。 */
  outputPath: string;
};

/** 调用 mflux CLI 生成一张图片（阻塞直到进程退出）。 */
async function generateWithMlxInner(
  params: MlxGenerateParams,
): Promise<{ ok: boolean; error?: string }> {
  const model = findMlxModel(params.modelId) ?? MLX_MODELS[0]!;
  const bin = venvBinary(model.cmd);
  if (!existsSync(bin)) {
    return { ok: false, error: "MLX 引擎未安装，请先点击「下载引擎」" };
  }
  // 不再允许生成时自动下载：必须先在「下载模型」里把权重下载好。
  if (!(await isMlxModelDownloaded(model.id))) {
    return {
      ok: false,
      error: `模型「${model.label}」尚未下载，请先点击「下载模型」（约 ${model.approxSizeGb}GB）`,
    };
  }
  // 全局只允许一个生成进程，避免连点/多窗口时像之前那样堆一堆 mflux 进程互抢。
  if (activeGenerate) {
    return { ok: false, error: "上一次生图仍在进行中，请稍候或等它完成" };
  }

  // 常驻 worker 已启动同模型 → 直接走内存中的模型生成，不再新起进程重载权重。
  const worker = getMlxActiveModel();
  if (worker && worker.modelId === model.id) {
    const w = generateViaWorker(params);
    activeGenerate = w.finally(() => {
      activeGenerate = null;
    });
    return w;
  }

  const args: string[] = [];
  if (model.modelArg) args.push("--model", model.modelArg);
  args.push(
    "--prompt",
    params.prompt,
    "--width",
    String(params.width),
    "--height",
    String(params.height),
    "--steps",
    String(params.steps),
    "--output",
    params.outputPath,
  );
  if (params.seed !== undefined && Number.isFinite(params.seed)) {
    args.push("--seed", String(params.seed));
  }
  if (params.quantize && params.quantize > 0) {
    args.push("-q", String(params.quantize));
  }

  // 超时保护：进程挂住（网络/内存等）时不再让 UI 永远停在“生图当中”。
  const TIMEOUT_MS = 30 * 60_000;
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  activeGenerate = proc.exited;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, TIMEOUT_MS);

  try {
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (timedOut) {
      return {
        ok: false,
        error: `mflux 生成超时（超过 ${TIMEOUT_MS / 60_000} 分钟），已终止进程，请重试`,
      };
    }
    if (code !== 0) {
      const tail = stderr.trim().split("\n").slice(-6).join("\n");
      return {
        ok: false,
        error: tail || `mflux 生成失败（退出码 ${code}）`,
      };
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
    activeGenerate = null;
  }
}

/** 生图入口：生成期间取消空闲计时，结束后重新计时（见 scheduleIdleUnload）。 */
export async function generateWithMlx(
  params: MlxGenerateParams,
): Promise<{ ok: boolean; error?: string }> {
  cancelIdleUnload();
  try {
    return await generateWithMlxInner(params);
  } finally {
    scheduleIdleUnload();
  }
}
