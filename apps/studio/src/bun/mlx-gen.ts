import { existsSync, rmSync } from "fs";
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
// 生成
// ---------------------------------------------------------------------------

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

  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  if (code !== 0) {
    const tail = stderr.trim().split("\n").slice(-6).join("\n");
    return {
      ok: false,
      error: tail || `mflux 生成失败（退出码 ${code}）`,
    };
  }
  return { ok: true };
}
