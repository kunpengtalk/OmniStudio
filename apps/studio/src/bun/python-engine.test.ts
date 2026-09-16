import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";

import type { CommandResult, CommandRunner } from "./command-runner";
import { engineVersionFilePath, pythonEngineDir, pythonEnginePython } from "./engine-paths";
import {
  findSystemPython,
  installPythonEngine,
  probeVersion,
  pythonMinorVersion,
  readPythonEngineVersion,
  resolveManagedPython,
  type InstallPhase,
  type InstallReporter,
} from "./python-engine";

/**
 * Python 引擎（mlx-lm / vLLM / SGLang）安装内核的回归。
 *
 * 用例全部走假 runner：不真的建 venv、不真的连 PyPI —— 跑测试的机器上可能根本没有
 * Python，CI 更不该因为一次 pip 装包而慢上几分钟。被钉住的是**决策**：什么时候跳过、
 * 默认源失败怎么换镜像、装完怎么验证、验证不过怎么清理。
 */
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const id of ["mlx-lm", "vllm", "sglang"] as const) {
    rmSync(pythonEngineDir(id), { recursive: true, force: true });
  }
});

/** 预置一个"已装好"的 venv（假解释器文件 + VERSION 标记）。 */
function seedInstalled(id: "mlx-lm" | "vllm" | "sglang", version: string): void {
  const python = pythonEnginePython(id);
  mkdirSync(dirname(python), { recursive: true });
  writeFileSync(python, "#!/bin/sh\n");
  created.push(pythonEngineDir(id));
  writeFileSync(engineVersionFilePath(id), `${version}\n`, "utf8");
}

function reporter(): InstallReporter & { lines: string[]; phases: InstallPhase[] } {
  const lines: string[] = [];
  const phases: InstallPhase[] = [];
  return { lines, phases, log: (text) => lines.push(text), phase: (phase) => phases.push(phase) };
}

/**
 * 假 runner：`venv` 造出解释器文件，`pip install` 按脚本返回退出码，导入探测按脚本给版本。
 * 断言里会用到 `calls`，所以把调用原样记下来。
 *
 * **流式执行也要假**（runStreaming）：真的去跑 `python -m venv` / `uv venv` 就等于测试
 * 真的建环境、真的联网 —— 跑测试的机器上可能根本没有 Python。
 */
function fakeRunner(options: {
  /** pip 第几次调用成功（1 = 首次就成功；2 = 默认源失败、换镜像后成功；0 = 都失败）。 */
  pipSucceedsAt?: number;
  /** 装完之后 `import` 探测是否成功。 */
  probeOk?: boolean;
  probeVersion?: string;
  /** venv 创建是否失败（缺 python3-venv 的现场）。 */
  venvFails?: boolean;
}): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let pipCalls = 0;

  const handle = (cmd: string[]): CommandResult | null => {
    const joined = cmd.join(" ");
    if (joined.includes("--version") && cmd.length === 2) {
      return { code: 0, stdout: "Python 3.12.6\n", stderr: "" };
    }
    if (joined.includes("import importlib.metadata")) {
      if (options.probeOk === false) return { code: 1, stdout: "", stderr: "ModuleNotFoundError" };
      return { code: 0, stdout: `${options.probeVersion ?? "1.2.3"}\n`, stderr: "" };
    }
    // 模块导入探测（`-c "import mlx_lm"`）：装没装好的唯一判据
    if (joined.includes("-c")) {
      return options.probeOk === false
        ? { code: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'mlx_lm'" }
        : { code: 0, stdout: "", stderr: "" };
    }
    return null;
  };

  return {
    calls,
    run: (cmd) => handle(cmd) ?? { code: -1, stdout: "", stderr: `unexpected: ${cmd.join(" ")}` },
    runStreaming: async (cmd, onLine) => {
      calls.push(cmd);
      const joined = cmd.join(" ");
      if (joined.includes("venv")) {
        if (options.venvFails) {
          onLine("ensurepip is not available");
          return 1;
        }
        // venv 目标目录是命令的最后一个参数
        const target = cmd[cmd.length - 1]!;
        mkdirSync(dirname(pythonEnginePythonFor(target)), { recursive: true });
        writeFileSync(pythonEnginePythonFor(target), "#!/bin/sh\n");
        created.push(target);
        onLine("created virtual environment");
        return 0;
      }
      if (joined.includes("pip") && joined.includes("install")) {
        pipCalls += 1;
        const succeedAt = options.pipSucceedsAt ?? 1;
        // succeedAt = 第几次 pip 调用开始成功（1 = 首次就成功，2 = 换镜像后成功，0 = 都失败）
        if (succeedAt > 0 && pipCalls >= succeedAt) {
          onLine("Successfully installed");
          return 0;
        }
        onLine("ERROR: could not find a version that satisfies the requirement");
        return 1;
      }
      onLine(`unexpected: ${joined}`);
      return -1;
    },
  };
}

/** 假 runner 里 venv 目标目录 → 该 id 的解释器路径（测试只造 mlx-lm 的环境）。 */
function pythonEnginePythonFor(venvDir: string): string {
  return `${venvDir}/bin/python3`;
}

/**
 * 装包那几条命令（不区分 uv 与 pip 两种形状）。
 *
 * 别按字面串 `"pip install"` 过滤：`pip3 install` 里没有那个子串（"pip3" 后面是 "3"），
 * 而有没有 uv 又取决于跑测试的机器 —— 这正是 CI 上唯一红掉的那条断言（本机有 uv、CI 没有）。
 * 两条形状都只在装包命令里带独立的 `install` 参数，用它判定。
 */
function installCalls(calls: string[][]): string[][] {
  return calls.filter((cmd) => cmd.includes("install"));
}

describe("找 Python 与版本探测", () => {
  test("解析 3.x 的 minor 版本", () => {
    const run: CommandRunner = {
      run: () => ({ code: 0, stdout: "Python 3.12.6\n", stderr: "" }),
      runStreaming: async () => 0,
    };
    expect(pythonMinorVersion("/usr/bin/python3", run)).toBe(12);
    expect(findSystemPython(run)).not.toBeNull(); // 本机 / CI 上总有一个 python3 才跑得到这里
  });

  test("版本号读不出来时当作不可用", () => {
    const run: CommandRunner = {
      run: () => ({ code: -1, stdout: "", stderr: "not found" }),
      runStreaming: async () => -1,
    };
    expect(pythonMinorVersion("/nope/python3", run)).toBeNull();
  });
});

describe("resolveManagedPython", () => {
  test("venv 没有解释器 → null（没装过）", () => {
    const run = fakeRunner({});
    expect(resolveManagedPython("mlx-lm", "mlx_lm", run)).toBeNull();
  });

  test("解释器在、但模块导不进来 → null（半个环境不算装好）", () => {
    const python = pythonEnginePython("mlx-lm");
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "#!/bin/sh\n");
    created.push(pythonEngineDir("mlx-lm"));

    const broken = fakeRunner({ probeOk: false });
    expect(resolveManagedPython("mlx-lm", "mlx_lm", broken)).toBeNull();

    const ok = fakeRunner({ probeOk: true });
    expect(resolveManagedPython("mlx-lm", "mlx_lm", ok)).toBe(python);
  });
});

describe("probeVersion", () => {
  test("读得到版本号，读不到返回 null", () => {
    expect(probeVersion("/x/python3", "mlx-lm", fakeRunner({ probeVersion: "0.28.4" }))).toBe("0.28.4");
    expect(probeVersion("/x/python3", "mlx-lm", fakeRunner({ probeOk: false }))).toBeNull();
  });
});

describe("installPythonEngine", () => {
  test("装好一次：建 venv → pip install → 验证 → 写版本标记 → 收尾行", async () => {
    const report = reporter();
    const result = await installPythonEngine({
      id: "mlx-lm",
      label: "MLX",
      packages: ["mlx-lm"],
      probeModule: "mlx_lm",
      reporter: report,
      runner: fakeRunner({ probeVersion: "0.28.4" }),
      findPython: () => "/usr/bin/python3.12",
    });

    expect(result).toEqual({ ok: true, version: "0.28.4", python: pythonEnginePython("mlx-lm") });
    expect(readPythonEngineVersion("mlx-lm")).toBe("0.28.4");
    expect(report.phases).toEqual(["preparing", "installing", "verifying", "done"]);
    expect(report.lines[report.lines.length - 1]).toBe("安装成功：MLX 0.28.4\n");
  });

  test("已经装好就跳过：不再下一次 pip", async () => {
    seedInstalled("mlx-lm", "0.28.4");
    const run = fakeRunner({ probeVersion: "0.28.4" });
    const report = reporter();

    const result = await installPythonEngine({
      id: "mlx-lm",
      label: "MLX",
      packages: ["mlx-lm"],
      probeModule: "mlx_lm",
      reporter: report,
      runner: run,
      findPython: () => "/usr/bin/python3.12",
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.28.4");
    expect(installCalls(run.calls)).toHaveLength(0);
    expect(report.lines.some((line) => line.includes("已安装"))).toBe(true);
  });

  test("默认 PyPI 源失败 → 自动换清华镜像重试一次", async () => {
    const report = reporter();
    const run = fakeRunner({ pipSucceedsAt: 2, probeVersion: "0.28.4" });
    const result = await installPythonEngine({
      id: "mlx-lm",
      label: "MLX",
      packages: ["mlx-lm"],
      probeModule: "mlx_lm",
      reporter: report,
      runner: run,
      findPython: () => "/usr/bin/python3.12",
      // 钉住"机器上没有 uv"这条形状：本机恰好装着 uv 时走的是 `uv pip install
      // --index-url`，只按字面串 "pip install" 断言会在这里变红（CI 上就是这么红的）。
      findUv: () => null,
    });

    expect(result.ok).toBe(true);
    const pipCalls = installCalls(run.calls);
    expect(pipCalls).toHaveLength(2);
    expect(pipCalls[0]!.join(" ")).toContain("pip3 install");
    expect(pipCalls[1]!.join(" ")).toContain("-i https://pypi.tuna.tsinghua.edu.cn/simple");
    expect(report.lines.some((line) => line.includes("清华镜像"))).toBe(true);
  });

  test("有 uv 时走 uv 那条形状（venv 与 index 参数都不一样）", async () => {
    const report = reporter();
    const run = fakeRunner({ pipSucceedsAt: 2, probeVersion: "0.28.4" });
    const result = await installPythonEngine({
      id: "mlx-lm",
      label: "MLX",
      packages: ["mlx-lm"],
      probeModule: "mlx_lm",
      reporter: report,
      runner: run,
      findPython: () => "/usr/bin/python3.12",
      findUv: () => "/opt/homebrew/bin/uv",
    });

    expect(result.ok).toBe(true);
    // venv 由 uv 建，装包走 `uv pip install`，重试时用 `--index-url`（不是 pip 的 `-i`）
    expect(run.calls.some((cmd) => cmd[0] === "/opt/homebrew/bin/uv" && cmd[1] === "venv")).toBe(true);
    const pipCalls = installCalls(run.calls);
    expect(pipCalls).toHaveLength(2);
    expect(pipCalls[0]!.slice(0, 3)).toEqual(["/opt/homebrew/bin/uv", "pip", "install"]);
    expect(pipCalls[1]!.join(" ")).toContain("--index-url https://pypi.tuna.tsinghua.edu.cn/simple");
  });

  test("两次都失败：如实报错，收尾行走失败分支", async () => {
    const report = reporter();
    const result = await installPythonEngine({
      id: "vllm",
      label: "vLLM",
      packages: ["vllm"],
      probeModule: "vllm",
      reporter: report,
      runner: fakeRunner({ pipSucceedsAt: 0 }),
      findPython: () => "/usr/bin/python3.12",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("退出码");
    expect(result.error).toContain("网络与代理");
    expect(report.lines[report.lines.length - 1]).toBe("vLLM 安装失败\n");
    expect(report.phases[report.phases.length - 1]).toBe("failed");
  });

  test("pip 说成功但模块导不进来：清掉这半个环境，不留下「已安装」的假象", async () => {
    const report = reporter();
    const result = await installPythonEngine({
      id: "vllm",
      label: "vLLM",
      packages: ["vllm"],
      probeModule: "vllm",
      reporter: report,
      runner: fakeRunner({ probeOk: false }),
      findPython: () => "/usr/bin/python3.12",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法导入");
    expect(existsSync(pythonEngineDir("vllm"))).toBe(false);
  });

  test("没有 Python：直接说清要先装什么，不去建环境", async () => {
    const report = reporter();
    const run = fakeRunner({});
    const result = await installPythonEngine({
      id: "mlx-lm",
      label: "MLX",
      packages: ["mlx-lm"],
      probeModule: "mlx_lm",
      reporter: report,
      runner: run,
      findPython: () => null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Python 3.10+");
    expect(run.calls.some((cmd) => cmd.join(" ").includes("venv"))).toBe(false);
    expect(existsSync(pythonEngineDir("mlx-lm"))).toBe(false);
  });

  test("venv 建不起来（缺 python3-venv）：提示装系统包，不留半截环境", async () => {
    const run = fakeRunner({ venvFails: true });
    const report = reporter();
    const result = await installPythonEngine({
      id: "sglang",
      label: "SGLang",
      packages: ["sglang[all]"],
      probeModule: "sglang",
      reporter: report,
      runner: run,
      findPython: () => "/usr/bin/python3.11",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("python3-venv");
    expect(report.phases[report.phases.length - 1]).toBe("failed");
  });

  test("上次装到一半留下的目录：重建，不在半个环境上继续", async () => {
    // 只有目录、没有解释器 —— 上一次中途挂掉的现场
    const dir = pythonEngineDir("mlx-lm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/leftover`, "x");
    created.push(dir);

    const report = reporter();
    const result = await installPythonEngine({
      id: "mlx-lm",
      label: "MLX",
      packages: ["mlx-lm"],
      probeModule: "mlx_lm",
      reporter: report,
      runner: fakeRunner({ probeVersion: "0.28.4" }),
      findPython: () => "/usr/bin/python3.12",
    });

    expect(result.ok).toBe(true);
    expect(existsSync(`${dir}/leftover`)).toBe(false);
    expect(report.lines.some((line) => line.includes("重建虚拟环境"))).toBe(true);
  });
});
