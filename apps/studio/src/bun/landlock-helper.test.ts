import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  buildLandlockHelper,
  compileLandlockHelper,
  compilerCandidates,
  helperBinaryPath,
  helperSourcePath,
  landlockCommand,
  landlockHelper,
  probeLandlockWorkspace,
  resetLandlockHelperCache,
  resetLandlockCanaryCache,
  type HelperRunner,
} from "./landlock-helper";
import { landlockRulesetSpec } from "./agent-sandbox";

/**
 * Landlock 辅助程序（omni-landlock.c）的编译、探测与调用形状。
 *
 * 这个文件的特别之处：**辅助程序本体也在这里被测**。C 源码里有两块与内核无关的纯逻辑
 * ——参数解析与 JSON 规格解析——它们在任何平台上都能跑，所以就在 macOS 上真编一次、
 * 真喂几种规格进去：坏规格必须让辅助程序**拒绝执行命令**（宁可什么都不跑，
 * 也不能"看不懂规则就放行"）。真实拦截留给 Linux（scripts/landlock-e2e.ts + CI）。
 */
const workDir = mkdtempSync(path.join(tmpdir(), "omni-landlock-helper-"));

const hasCompiler = (): boolean =>
  compilerCandidates().some((compiler) => {
    const probe = Bun.spawnSync({
      cmd: compiler === "zig" ? ["zig", "version"] : [compiler, "--version"],
      stdout: "ignore",
      stderr: "ignore",
      timeout: 10_000,
    });
    return probe.exitCode === 0;
  });

const run = (cmd: string[], timeoutMs = 30_000) => {
  const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
};

/** 真编一次（走被测模块的编译路径，产物落在临时目录）。 */
function buildInto(dir: string): { ok: boolean; path?: string; reason?: string } {
  const result = compileLandlockHelper({
    platform: "linux",
    source: helperSourcePath(),
    binaryPath: path.join(dir, "omni-landlock"),
    force: true,
  });
  return result.ok ? { ok: true, path: result.path } : { ok: false, reason: result.reason };
}

beforeEach(() => {
  resetLandlockHelperCache();
});

afterEach(() => {
  resetLandlockHelperCache();
});

describe("编译与探测", () => {
  test("非 Linux 不折腾编译：直接说明只在 Linux 上可用", () => {
    const result = buildLandlockHelper({ platform: "darwin", source: helperSourcePath() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Linux");
  });

  test("源码缺失时给出可诊断的理由（不是一句含糊的编译失败）", () => {
    const result = buildLandlockHelper({
      platform: "linux",
      source: path.join(workDir, "not-there.c"),
      binaryPath: path.join(workDir, "x"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("源码缺失");
  });

  test("没有编译器时如实降级（理由里带上编译器名字）", () => {
    const calls: string[][] = [];
    const runner: HelperRunner = {
      run: (cmd) => {
        calls.push(cmd);
        return { code: -1, stdout: "", stderr: "" };
      },
    };
    const result = buildLandlockHelper({
      platform: "linux",
      source: helperSourcePath(),
      binaryPath: path.join(workDir, "never-built"),
      runner,
      force: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((cmd) => cmd.includes(helperSourcePath()))).toBe(true);
  });

  test("产物名按源码 hash：源码变了不会拿旧二进制配新规格", () => {
    const a = helperBinaryPath(helperSourcePath());
    const fake = path.join(workDir, "fake.c");
    writeFileSync(fake, "int main(void){return 0;}\n");
    expect(helperBinaryPath(fake)).not.toBe(a);
    // 同一份源码稳定（否则每次启动都重编）。
    expect(helperBinaryPath(helperSourcePath())).toBe(a);
  });

  test("调用形状：`--spec <json> -- <shell> -c <命令>`，规格走 argv 不落临时文件", () => {
    const cmd = landlockCommand("/x/omni-landlock", '{"v":1}', "/bin/bash", "echo hi");
    expect(cmd).toEqual(["/x/omni-landlock", "--spec", '{"v":1}', "--", "/bin/bash", "-c", "echo hi"]);
  });

  test("编译器不存在（spawnSync 抛异常）时如实降级，不是把异常扔给调用方", () => {
    // Bun.spawnSync 找不到可执行文件是**抛**而不是返回非零码。没接住的话，这台机器上
    // 打开沙箱设置页、以及之后每一次 bash 调用都会炸，而"没装 cc"恰恰是最该走降级的场景。
    const prev = process.env.OMNI_LANDLOCK_CC;
    process.env.OMNI_LANDLOCK_CC = "no-such-compiler-omni-xyz";
    try {
      const result = buildLandlockHelper({
        platform: "linux",
        source: helperSourcePath(),
        binaryPath: path.join(workDir, "never-built-2"),
        force: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("no-such-compiler-omni-xyz");
    } finally {
      if (prev === undefined) delete process.env.OMNI_LANDLOCK_CC;
      else process.env.OMNI_LANDLOCK_CC = prev;
    }
  });

  test("缓存产物被写坏：自动重编一次，而不是永久报「内核不支持」", () => {
    const binary = path.join(workDir, "poisoned");
    writeFileSync(binary, "corrupt");
    let compiles = 0;
    let probes = 0;
    // 编译命令是 [cc, -std=c11, -O2, -o, <产物>, <源码>]，产物在倒数第二位。
    const runner: HelperRunner = {
      run: (cmd) => {
        if (cmd[1] === "--probe") {
          probes++;
          return readFileSync(cmd[0]!, "utf8") === "good"
            ? { code: 0, stdout: "3\n", stderr: "" }
            : { code: 2, stdout: "", stderr: "not a binary" };
        }
        writeFileSync(cmd[cmd.length - 2]!, "good");
        compiles++;
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const result = buildLandlockHelper({
      platform: "linux",
      source: helperSourcePath(),
      binaryPath: binary,
      runner,
    });
    expect(compiles).toBe(1); // 缓存写坏 → 真重编了一次
    expect(probes).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.abi).toBe(3);
  });

  test("canary：辅助程序说「规则在这个文件系统上不生效」时如实拒绝（不硬上）", () => {
    // 这条分支在 CI 里没有天然样本（runner 上没有 FUSE 数据挂载），但它是
    // "不兼容文件系统 → 换回 bwrap / 如实降级"的唯一入口，不能没人测。
    // 用注入的 runner 直接喂辅助程序那条 stderr：plumbing 对不对与内核无关。
    const reason =
      "omni-landlock: canary check failed for /work after restricting (No such file or directory): " +
      "Landlock rules do not take effect on this filesystem";
    const runner: HelperRunner = {
      run: (cmd) =>
        cmd[1] === "--probe"
          ? { code: 0, stdout: "3\n", stderr: "" }
          : { code: 125, stdout: "", stderr: reason },
    };
    const probe = probeLandlockWorkspace("/work", {
      binary: "/bin/true",
      runner,
      refresh: true,
    });
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("canary");
    // 与 omni-landlock.c 里的原文一致（少一个 s 就会以为这段 plumbing 没生效）。
    expect(probe.reason).toContain("do not take effect on this filesystem");
  });

  test("canary：通过时 ok，且带上工作区与档位做缓存键（换档位要重探）", () => {
    let probes = 0;
    const runner: HelperRunner = {
      run: (cmd) => {
        if (cmd[1] !== "--probe") probes += 1;
        return { code: 0, stdout: "3\n", stderr: "" };
      },
    };
    const first = probeLandlockWorkspace("/work", { binary: "/bin/true", runner, refresh: true });
    expect(first.ok).toBe(true);
    expect(first.reason).toBeNull();
    // 同一工作区 + 同一档位命中缓存，不再真跑。
    probeLandlockWorkspace("/work", { binary: "/bin/true", runner });
    expect(probes).toBe(1);
    // 换档位是另一条缓存键：必须重探（read-only 的规则集不同）。
    probeLandlockWorkspace("/work", { binary: "/bin/true", runner, mode: "read-only" });
    expect(probes).toBe(2);
  });

  test("缓存产物探测失败且重编也编不出来：如实报不支持，不抛异常", () => {
    const binary = path.join(workDir, "poisoned-2");
    writeFileSync(binary, "corrupt");
    const runner: HelperRunner = {
      run: (cmd) =>
        cmd[1] === "--probe"
          ? { code: 2, stdout: "", stderr: "not a binary" }
          : { code: -1, stdout: "", stderr: "cc 不可用" },
    };
    const result = buildLandlockHelper({
      platform: "linux",
      source: helperSourcePath(),
      binaryPath: binary,
      runner,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Landlock");
  });

  test("缓存：探测过一次就不再重来（失败结果也缓存）", () => {
    const first = landlockHelper();
    const second = landlockHelper();
    // 同一进程内重复调用：编译与探测都不重来，返回的是同一个结果对象。
    expect(second).toEqual(first);
    resetLandlockHelperCache();
    // 清掉进程内缓存后重探：**结论**必须一致。唯一允许的差异是 source ——
    // 第一次可能要现编（built），第二次起复用同一份产物（cache）。
    // 早先这里直接 toEqual，在 macOS 上碰巧成立（平台检查让三次都是同一个失败对象），
    // 到了 Linux 真编一次就挂 —— 那是"只在开发机上成立"的断言。
    const third = landlockHelper();
    expect(third.ok).toBe(first.ok);
    if (first.ok && third.ok) {
      expect(third.path).toBe(first.path);
      expect(third.abi).toBe(first.abi);
    } else if (!first.ok && !third.ok) {
      expect(third.reason).toBe(first.reason);
    }
  });
});

/**
 * 真编一次辅助程序，验证它与内核无关的那半截：参数解析 + 规格解析。
 * 内核那半截在 macOS 上必然失败（没有 Landlock），正确行为是**明确拒绝执行命令**。
 */
describe("辅助程序本体（真编译）", () => {
  const compiles = hasCompiler();
  let binary: string | null = null;

  beforeEach(() => {
    if (!compiles || binary) return;
    const built = buildInto(workDir);
    binary = built.ok ? built.path! : null;
  });

  test.if(compiles)("--probe 在没有 Landlock 的平台上退出 2 并说明原因", () => {
    expect(binary).toBeTruthy();
    const probe = run([binary!, "--probe"]);
    if (process.platform === "linux") {
      // Linux 上要么支持（打印 ABI 数字），要么明确说不支持 —— 两种都算"如实"。
      if (probe.code === 0) expect(Number.parseInt(probe.stdout.trim(), 10)).toBeGreaterThanOrEqual(1);
      else expect(probe.stderr).toContain("Landlock");
    } else {
      expect(probe.code).toBe(2);
      expect(probe.stderr.toLowerCase()).toMatch(/landlock|probe failed/);
    }
  });

  test.if(compiles)("坏规格：拒绝执行命令（退出 125，命令的副作用不会发生）", () => {
    expect(binary).toBeTruthy();
    const marker = path.join(workDir, "should-not-exist.txt");
    const bad = [
      "not json",
      '{"handled":["write_file"],"rules":', // 截断
      '{"handled":[],"rules":[]}', // 没有任何被处理的权限
      '{"rules":[{"path":"/tmp"}]}', // 没有 handled
      '{"handled":["write_file"],"rules":[{}]}', // 规则没路径
      '{"handled":["write_file"],"rules":[{"path":"/tmp"}]} trailing', // 尾部垃圾
      '{"handled":["write_file"],"rules":[{"path":"/tmp","access":"write_file"}]}', // access 不是数组
    ];
    const outcomes = bad.map((spec) => {
      const result = run([binary!, "--spec", spec, "--", "/bin/sh", "-c", `echo x > ${marker}`]);
      return { spec, result, markerWritten: existsSync(marker) };
    });
    // 一次列出全部不合格的（而不是断在第一条）：报错里带着规格原文与 stderr，
    // 否则只知道"有一条坏了"，不知道是哪条、为什么。
    const wrong = outcomes
      .filter(({ result }) => result.code !== 125 || !result.stderr.includes("omni-landlock:"))
      .map(({ spec, result }) => `${spec} → 退出码 ${result.code}，stderr：${result.stderr.trim()}`);
    expect(wrong).toEqual([]);
    // 任何一条坏规格都不许留下副作用。
    for (const { markerWritten } of outcomes) expect(markerWritten).toBe(false);
  });

  test.if(compiles)("缺 `--` 或缺命令：用法错误，而不是默默跑起来", () => {
    expect(binary).toBeTruthy();
    const noSep = run([binary!, "--spec", '{"handled":["write_file"],"rules":[]}']);
    expect(noSep.code).toBe(125);
    const noCmd = run([binary!, "--spec", '{"handled":["write_file"],"rules":[]}', "--"]);
    expect(noCmd.code).toBe(125);
    const usage = run([binary!]);
    expect(usage.code).toBe(125);
    expect(usage.stderr).toContain("usage");
  });

  test.if(compiles)("真规格：macOS 上被内核挡下（ENOSYS），Linux 上能跑起来", () => {
    expect(binary).toBeTruthy();
    const spec = landlockRulesetSpec({ workspace: workDir, mode: "workspace-write" });
    const result = run([binary!, "--spec", spec, "--", "/bin/sh", "-c", "exit 0"]);
    if (process.platform === "linux") {
      // Linux：规格合法 → 应当真的执行了命令（退出码来自命令本身）。
      if (result.code === 125) expect(result.stderr).toContain("Landlock");
      else expect(result.code).toBe(0);
    } else {
      expect(result.code).toBe(125);
      expect(result.stderr).toContain("Landlock");
    }
  });

  test.if(compiles)("规格由 landlockRulesetSpec() 生成时字段齐全（handled 非空、rules 有序）", () => {
    const spec = JSON.parse(
      landlockRulesetSpec({ workspace: workDir, mode: "read-only", authorizedFolders: [] }),
    ) as { handled: string[]; rules: { path: string; access: string[] }[]; version: number };
    expect(spec.version).toBe(1);
    expect(spec.handled.length).toBeGreaterThan(0);
    expect(spec.rules.some((rule) => rule.path === "/")).toBe(true);
    // 辅助程序认得的权限名与策略侧的拼写必须一致（拼错就是"声明了却没生效"）。
    const known = new Set([
      "execute",
      "write_file",
      "read_file",
      "read_dir",
      "remove_dir",
      "remove_file",
      "make_char",
      "make_dir",
      "make_reg",
      "make_sock",
      "make_fifo",
      "make_block",
      "make_sym",
      "refer",
      "truncate",
    ]);
    for (const bit of spec.handled) expect(known.has(bit)).toBe(true);
    expect(readFileSync(helperSourcePath(), "utf8")).toContain("truncate");
  });

  test.if(compiles)("禁网规格被辅助程序拒绝（net 规则没实现，不能假装拦住了）", () => {
    expect(binary).toBeTruthy();
    const spec = landlockRulesetSpec({ workspace: workDir, mode: "workspace-write", allowNetwork: false });
    const result = run([binary!, "--spec", spec, "--", "/bin/sh", "-c", "exit 0"]);
    expect(result.code).toBe(125);
    expect(result.stderr).toContain("network denial is not implemented");
  });

  test.if(compiles)("C 源码里认得策略侧会用的每一个权限名（拼错 = 声明了却没生效）", () => {
    // 策略侧改名而辅助程序没跟上，是"看起来有沙箱、实际少拦一种"的经典来源。
    // 这条不需要内核支持：直接对比两侧的名字表。
    const source = readFileSync(helperSourcePath(), "utf8");
    for (const bit of [
      "execute",
      "write_file",
      "read_file",
      "read_dir",
      "remove_dir",
      "remove_file",
      "make_char",
      "make_dir",
      "make_reg",
      "make_sock",
      "make_fifo",
      "make_block",
      "make_sym",
      "refer",
      "truncate",
    ]) {
      expect(source).toContain(`"${bit}"`);
    }
    // 内核常量：syscall 号与版本探测标志写死在这里，改动必须是被有意为之。
    expect(source).toContain("#define LL_CREATE_RULESET 444");
    expect(source).toContain("#define LL_ADD_RULE 445");
    expect(source).toContain("#define LL_RESTRICT_SELF 446");
  });

  test.if(compiles)("canary 参数进 argv：`--canary <路径>` 在 `--` 之前", () => {
    const cmd = landlockCommand("/x/omni-landlock", "{}", "/bin/sh", "ls", "/work/ws");
    expect(cmd).toEqual([
      "/x/omni-landlock",
      "--spec",
      "{}",
      "--canary",
      "/work/ws",
      "--",
      "/bin/sh",
      "-c",
      "ls",
    ]);
  });

  test.if(!compiles)("没有编译器时跳过（但明确记下跳过了什么）", () => {
    expect(compiles).toBe(false);
  });
});
