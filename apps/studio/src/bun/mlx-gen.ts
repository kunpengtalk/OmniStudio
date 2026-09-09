import { existsSync, rmSync, readdirSync, readFileSync, readlinkSync, statSync } from "fs";
import path from "path";
import { Utils } from "electrobun/bun";

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
  return path.join(Utils.paths.userData, "engines", "mflux");
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

async function doDownloadMlxModel(
  modelId: string,
): Promise<{ ok: boolean; error?: string }> {
  const model = findMlxModel(modelId) ?? MLX_MODELS[0]!;
  const py = enginePython();
  if (!existsSync(py)) {
    return { ok: false, error: "MLX 引擎未安装，请先点击「下载引擎」" };
  }

  emitLog(`开始下载模型权重：${model.label} …`);
  emitProgress({
    modelId,
    fileName: "",
    received: 0,
    total: 0,
    doneBytes: 0,
    allBytes: 0,
    filesDone: 0,
    filesTotal: 0,
    percent: 0,
    stage: "downloading",
  });

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
        emitProgress(buildProgress(st, "downloading"));
      } else if (line.startsWith("OK")) {
        st.stage = "done";
        emitProgress(buildProgress(st, "done"));
      } else if (line.startsWith("ERROR ")) {
        st.error = line.slice(6);
        st.stage = "error";
        emitProgress(buildProgress(st, "error"));
      }
    }
  })();

  // tqdm 字节进度（stderr）→ 更新当前文件 received
  let singleRun = {
    repo: "",
    allBytes: 0,
    curFile: "",
    curStart: 0,
    curSize: 0,
    curReceived: 0,
    doneBytes: 0,
    filesDone: 0,
    filesTotal: 0,
    stage: "downloading" as "downloading" | "done" | "error",
    error: "",
  };
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
    emitLog(`模型 ${model.label} 下载完成。`);
    emitProgress({ ...buildProgress(singleRun, "done"), percent: 100 });
    return { ok: true };
  }
  const err =
    singleRun.error ||
    stderrTail.slice(-5).join(" | ") ||
    `模型权重下载失败（退出码 ${code}）`;
  emitLog(`模型 ${model.label} 下载失败：${err}`);
  emitProgress({ ...buildProgress(singleRun, "error"), percent: 0 });
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

/**
 * 判断单个缓存文件是否“完整可用”。HF 在下载中途会用 `.incomplete` 后缀标记
 * 尚未完成的 blob，真正下完才去掉后缀并建立 snapshots 软链。所以：
 *  - 软链目标带 `.incomplete` → 未下完
 *  - 软链目标是空文件（0 字节）→ 未下完
 *  - 软链目标指向不存在的 blob → 悬空，未下完
 * 只有真正解析到一份非空的完整 blob 才算可用。
 */
function cacheFileComplete(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    if (st.size <= 0) return false;
    if (p.includes(".incomplete")) return false;
    return true;
  } catch {
    return false;
  }
}

function readlinkSafe(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return "";
  }
}

/** 读取 .safetensors.index.json，返回其中声明的所有 .safetensors shard 文件名。 */
function indexJsonShards(file: string): string[] {
  try {
    const raw = readFileSync(file, "utf8");
    const obj = JSON.parse(raw) as { weight_map?: Record<string, string> };
    const map = obj?.weight_map ?? {};
    return Array.from(new Set(Object.values(map))).filter((v) =>
      v.endsWith(".safetensors"),
    );
  } catch {
    return [];
  }
}

/**
 * 严格检查一片 snapshot 是否“完整可用”。
 *
 * 仅靠“看看软链完不完整”是不够的：那些压根没开始下载的分片（例如 transformer 的
 * 大 shard）在 snapshot 里连软链都没有，看起来像“已下载”。所以这里额外读取模型自带
 * 的 *.safetensors.index.json，把其中声明的所有分片都当作“必需文件”逐一核对：
 *  1. 每个软链/文件必须解析到完整的非空 blob（非 .incomplete、非悬空、非 0 字节）。
 *  2. index.json 里声明的每个 .safetensors 分片都必须真实存在且完整。
 *  满足以上两点且确实含 .safetensors 权重才算下载完成，否则一律视为未完成。
 */
function snapshotComplete(dir: string): boolean {
  // 收集所有 index.json 声明的必需分片。
  const required = new Set<string>();
  const present = new Set<string>();
  let sawSafetensors = false;
  let sawIndex = false;
  try {
    const walk = (d: string): boolean => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (!walk(p)) return false;
        } else if (entry.isSymbolicLink() || entry.isFile()) {
          const complete =
            entry.isSymbolicLink()
              ? cacheFileComplete(path.resolve(d, readlinkSafe(p)))
              : cacheFileComplete(p);
          if (!complete) return false;
          if (entry.name.endsWith(".safetensors")) {
            present.add(entry.name);
            sawSafetensors = true;
          } else if (entry.name.endsWith(".safetensors.index.json")) {
            sawIndex = true;
            for (const shard of indexJsonShards(p)) required.add(shard);
          }
        }
      }
      return true;
    };
    if (!walk(dir)) return false;

    // 有 index.json 分片声明的模型：每个必需分片都必须已就位。
    if (sawIndex) {
      for (const shard of required) {
        if (!present.has(shard)) return false;
      }
    }
    return sawSafetensors;
  } catch {
    return false;
  }
}

/**
 * 严格判断某个 MLX 模型权重是否已完整下载（纯文件系统检查，不发 HTTP、不起 Python）。
 * 不只“看到有 .safetensors 就算”，而是要求 snapshot 内每个文件（含软链指向的 blob）
 * 都完整、非空、未带 .incomplete 后缀，且把 *.safetensors.index.json 中声明的全部分片
 * 都核对到位。这样能拦截“下载中途失败/残留 .incomplete/缺分片/悬空软链”导致的假完成态，
 * 避免模型明明没下完却在 start 时挂起重下、甚至报“启动失败”。
 */
export function isMlxModelDownloaded(modelId: string): boolean {
  const repo = MLX_MODEL_REPOS[modelId];
  if (!repo) return false;
  const snapshots = hfSnapshotDir(repo);
  if (!existsSync(snapshots)) return false;
  try {
    for (const rev of readdirSync(snapshots)) {
      const revDir = path.join(snapshots, rev);
      if (!statSync(revDir).isDirectory()) continue;
      if (snapshotComplete(revDir)) return true;
    }
  } catch {}
  return false;
}

/** 返回已下载（可生成）的 MLX 模型 id 列表。 */
export function getDownloadedMlxModelsSync(): string[] {
  return MLX_MODELS.filter((m) => isMlxModelDownloaded(m.id)).map((m) => m.id);
}

/** 已下载模型快照（带缓存 TTL，避免主进程反复扫描磁盘）。 */
let downloadedCache: { at: number; ids: string[] } | null = null;
export function getDownloadedMlxModels(): string[] {
  const now = Date.now();
  if (downloadedCache && now - downloadedCache.at < 3000) {
    return downloadedCache.ids;
  }
  const ids = getDownloadedMlxModelsSync();
  downloadedCache = { at: now, ids };
  return ids;
}

/** 主动失效已下载缓存（下载完成后调用）。 */
export function invalidateDownloadedMlxCache(): void {
  downloadedCache = null;
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/** 当前进行中的 MLX 生成进程（防重复启动）。 */
let activeGenerate: Promise<number> | null = null;

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
export async function generateWithMlx(
  params: MlxGenerateParams,
): Promise<{ ok: boolean; error?: string }> {
  const model = findMlxModel(params.modelId) ?? MLX_MODELS[0]!;
  const bin = venvBinary(model.cmd);
  if (!existsSync(bin)) {
    return { ok: false, error: "MLX 引擎未安装，请先点击「下载引擎」" };
  }
  // 不再允许生成时自动下载：必须先在「下载模型」里把权重下载好。
  if (!isMlxModelDownloaded(model.id)) {
    return {
      ok: false,
      error: `模型「${model.label}」尚未下载，请先点击「下载模型」（约 ${model.approxSizeGb}GB）`,
    };
  }
  // 全局只允许一个生成进程，避免连点/多窗口时像之前那样堆一堆 mflux 进程互抢。
  if (activeGenerate) {
    return { ok: false, error: "上一次生图仍在进行中，请稍候或等它完成" };
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
