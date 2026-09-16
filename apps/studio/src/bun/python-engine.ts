/**
 * Python 引擎（mlx-lm / vLLM / SGLang）的一键安装内核。
 *
 * 应用自己建 venv 装包，而不是让用户去 pip install —— 装进 `<dataDir>/engines/<id>`，
 * 版本可复现、卸载干净、不污染用户的全局 Python（也避免"用户装过但版本对不上"这类
 * 说不清的问题）。做法与既有的媒体引擎（mflux / PaddleOCR）一致：uv 优先（快一个
 * 数量级），没有 uv 回退 `python -m venv` + pip；默认 PyPI 源失败自动换清华镜像重试。
 *
 * 与那两个模块的区别只有一点：这里把「建环境 → 装包 → 验证 → 写标记」抽成可复用的
 * 一份，日志与阶段由调用方注入（`InstallReporter`），因此引导页四个引擎共用同一条
 * 推送链路，测试也能用假 runner 跑完整流程而不真的装包。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";

import { logEvent } from "./app-log";
import { DEFAULT_COMMAND_TIMEOUT_MS, defaultCommandRunner, searchPath, type CommandRunner } from "./command-runner";
import {
  engineVersionFilePath,
  pythonEngineBin,
  pythonEngineDir,
  pythonEnginePython,
  type PythonEngineId,
} from "./engine-paths";

/**
 * 安装阶段（界面按它显示进度文案）。二进制安装与 pip 安装共用这一套词汇：
 * `downloading` / `extracting` 只有下载二进制的路径会发，`installing` 只有 pip 会发，
 * 其余阶段两条路径通用；`done` / `failed` 是终态。
 */
export type InstallPhase =
  | "preparing"
  | "downloading"
  | "extracting"
  | "installing"
  | "verifying"
  | "done"
  | "failed";

export type InstallReporter = {
  /** 一行日志（调用方拿去合批推送，见 bun/throttle.ts）。 */
  log: (text: string) => void;
  /** 阶段（`percent` 只在下载类安装里有意义）。 */
  phase: (phase: InstallPhase, message: string, percent?: number | null) => void;
};

export type PythonInstallOptions = {
  id: PythonEngineId;
  /** 展示名：日志与终态行里用（`安装成功：vLLM 0.9.2`）。 */
  label: string;
  /** pip 包名（可带 extras，如 `sglang[all]`）。 */
  packages: string[];
  /** 用来确认装好了的导入名（`python -c "import <probe>"`）。 */
  probeModule: string;
  /** 取版本号用的发行版名；缺省取第一个包名去掉 extras。 */
  distributionName?: string;
  reporter: InstallReporter;
  runner?: CommandRunner;
  /** 找系统 Python 的方式（测试注入假实现）。 */
  findPython?: () => string | null;
  /**
   * 找 uv 的方式。装了 uv 与没装是**两条命令形状**（`uv pip install --index-url` /
   * `pip3 install -i`），测试要把两条都钉住 —— 只钉住一条的话，本机恰好装着 uv 就绿、
   * CI（没有 uv）就红，而红的只是断言写错了，不是装不上去。
   */
  findUv?: () => string | null;
  /** 创建 venv 用的 Python；不传则自行查找。 */
  pythonPath?: string;
};

export type PythonInstallResult = {
  ok: boolean;
  error?: string;
  version?: string;
  python?: string;
};

/**
 * 已经被应用装好的引擎解释器：venv 里有 python 且目标模块导得进来。
 * 这是 runtimes 解析「用哪个 python 跑引擎」的唯一判据。
 */
export function resolveManagedPython(
  id: PythonEngineId,
  probeModule: string,
  runner: CommandRunner = defaultCommandRunner,
): string | null {
  const python = pythonEnginePython(id);
  if (!existsSync(python)) return null;
  const probe = runner.run([python, "-c", `import ${probeModule}`], 15_000);
  return probe.code === 0 ? python : null;
}

/** 安装标记里的版本号（`VERSION` 文件由安装器写，排障与界面展示都读它）。 */
export function readPythonEngineVersion(id: PythonEngineId): string | null {
  try {
    return readFileSync(engineVersionFilePath(id), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 找 Python
// ---------------------------------------------------------------------------

/** 目标解释器：3.12 / 3.13 的轮子最全，3.11 / 3.10 兜底，3.14 也认。 */
const PYTHON_CANDIDATES = ["python3.12", "python3.13", "python3.11", "python3.10", "python3", "python3.14"];

export function pythonMinorVersion(bin: string, runner: CommandRunner = defaultCommandRunner): number | null {
  const proc = runner.run([bin, "--version"], DEFAULT_COMMAND_TIMEOUT_MS);
  const match = `${proc.stdout} ${proc.stderr}`.match(/Python\s+3\.(\d+)\./);
  return match ? Number(match[1]) : null;
}

/** 系统 Python：优先版本合适的那几个，找不到返回 null（界面提示用户装 Python）。 */
export function findSystemPython(runner: CommandRunner = defaultCommandRunner): string | null {
  for (const name of PYTHON_CANDIDATES) {
    const path = Bun.which(name, { PATH: searchPath() });
    if (!path) continue;
    const minor = pythonMinorVersion(path, runner);
    if (minor !== null && minor >= 10 && minor <= 14) return path;
  }
  return null;
}

/** 读发行版版本号；模块导不进来返回 null（这就是"装没装好"的判据）。 */
export function probeVersion(
  python: string,
  distribution: string,
  runner: CommandRunner = defaultCommandRunner,
): string | null {
  const script = `import importlib.metadata as m; print(m.version(${JSON.stringify(distribution)}))`;
  const proc = runner.run([python, "-c", script], 20_000);
  if (proc.code !== 0) return null;
  return proc.stdout.trim().split("\n").pop()?.trim() || null;
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

/** 默认 PyPI 源不通时换清华镜像重试一次（与 mflux / PaddleOCR 同一做法）。 */
const PYPI_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";

export async function installPythonEngine(options: PythonInstallOptions): Promise<PythonInstallResult> {
  const runner = options.runner ?? defaultCommandRunner;
  const { reporter, id, label } = options;
  const distribution = options.distributionName ?? options.packages[0]!.replace(/\[.*\]$/, "");

  /**
   * 唯一的出口：终端日志（`安装成功：…` / `… 安装失败`）、阶段与 app.log 都只在这里
   * 打一次。前端靠收尾行判断"这批日志里有终态"→ 刷新引擎状态，漏打一次就等于界面
   * 永远停在"安装中"。
   */
  const finish = (result: PythonInstallResult, why?: string): PythonInstallResult => {
    reporter.log(
      result.ok ? `安装成功：${label}${result.version ? ` ${result.version}` : ""}\n` : `${label} 安装失败\n`,
    );
    logEvent({
      level: result.ok ? "info" : "error",
      source: "server",
      event: result.ok ? "engine.install.ok" : "engine.install.failed",
      message: result.ok
        ? `${label} 安装完成${result.version ? `（${result.version}）` : ""}`
        : `${label} 安装失败`,
      detail: { engine: id, version: result.version, python: result.python, why, error: result.error },
    });
    reporter.phase(
      result.ok ? "done" : "failed",
      result.ok ? `安装完成：${label}` : (result.error ?? `${label} 安装失败`),
    );
    return result;
  };

  // 已经装好且模块导得进来：直接返回，别把几百 MB 再下一遍。
  const existing = resolveManagedPython(id, options.probeModule, runner);
  if (existing) {
    const version = probeVersion(existing, distribution, runner) ?? readPythonEngineVersion(id) ?? undefined;
    reporter.log(`${label} 已安装${version ? `（${version}）` : ""}，跳过。\n`);
    return { ok: true, version, python: existing };
  }

  reporter.phase("preparing", `准备安装 ${label}`);
  const python = options.pythonPath ?? (options.findPython ?? (() => findSystemPython(runner)))();
  if (!python) {
    const error = "未找到 Python 3.10+，请先安装 Python（macOS：brew install python；Linux：apt install python3 python3-venv）";
    reporter.log(`${error}\n`);
    return finish({ ok: false, error }, "python-not-found");
  }

  const engineDir = pythonEngineDir(id);
  const uv = (options.findUv ?? (() => Bun.which("uv", { PATH: searchPath() })))();
  const venvPython = pythonEnginePython(id);

  try {
    if (!existsSync(venvPython)) {
      // 上次装到一半留下的目录：删掉重建，比在半个环境上继续装靠谱。
      if (existsSync(engineDir)) {
        reporter.log(`发现未完成的安装，重建虚拟环境：${engineDir}\n`);
        rmSync(engineDir, { recursive: true, force: true });
      }
      mkdirSync(engineDir, { recursive: true });
      const venvCmd = uv ? [uv, "venv", "--python", python, engineDir] : [python, "-m", "venv", engineDir];
      reporter.log(`$ ${venvCmd.join(" ")}\n`);
      const venvCode = await runner.runStreaming(venvCmd, (line) => reporter.log(`${line}\n`));
      if (venvCode !== 0 || !existsSync(venvPython)) {
        const error =
          "创建虚拟环境失败，请确认 Python 带有 venv 模块（Debian / Ubuntu 需 apt install python3-venv）";
        reporter.log(`${error}\n`);
        return finish({ ok: false, error }, "venv-failed");
      }
    } else {
      reporter.log(`复用已有虚拟环境：${engineDir}\n`);
    }

    reporter.phase("installing", `安装 ${label}`);
    const installWith = (indexArgs: string[]) =>
      uv
        ? [
            uv,
            "pip",
            "install",
            "--python",
            venvPython,
            "--upgrade",
            "--no-progress",
            ...options.packages,
            ...indexArgs,
          ]
        : [pythonEngineBin(id, "pip3"), "install", "--upgrade", ...options.packages, ...indexArgs];

    const first = installWith([]);
    reporter.log(`$ ${first.join(" ")}\n`);
    let code = await runner.runStreaming(first, (line) => reporter.log(`${line}\n`));
    if (code !== 0) {
      const mirrored = installWith(uv ? ["--index-url", PYPI_MIRROR] : ["-i", PYPI_MIRROR]);
      reporter.log(`默认 PyPI 源安装失败（退出码 ${code}），改用清华镜像重试…\n$ ${mirrored.join(" ")}\n`);
      code = await runner.runStreaming(mirrored, (line) => reporter.log(`${line}\n`));
    }
    if (code !== 0) {
      const error = `安装失败（退出码 ${code}），请检查网络与代理设置；完整输出见上方日志`;
      reporter.log(`${error}\n`);
      return finish({ ok: false, error }, `pip-exit-${code}`);
    }

    reporter.phase("verifying", `验证 ${label}`);
    const version = probeVersion(venvPython, distribution, runner);
    if (version === null) {
      // 包管理器说成功、模块却导入不了：把这半个环境删掉，免得下次被判成"已安装"。
      rmSync(engineDir, { recursive: true, force: true });
      const error = `安装完成但 ${label} 无法导入，环境已清理，请重试`;
      reporter.log(`${error}\n`);
      return finish({ ok: false, error }, "probe-failed");
    }

    try {
      writeFileSync(engineVersionFilePath(id), `${version}\n`, "utf8");
    } catch {
      // 标记文件写不进去不影响使用（版本号还能从 importlib.metadata 读）
    }
    // 终态（日志行 + 阶段 + app.log）统一由 finish 打，这里不重复发一次。
    return finish({ ok: true, version, python: venvPython });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    reporter.log(`${error}\n`);
    return finish({ ok: false, error }, "exception");
  }
}
