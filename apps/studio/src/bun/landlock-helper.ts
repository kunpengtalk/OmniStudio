/**
 * Landlock 辅助程序（`omni-landlock`）的编译与探测。
 *
 * 为什么要有这一层：Landlock 只能发系统调用（`landlock_create_ruleset` /
 * `landlock_add_rule` / `landlock_restrict_self`），纯 JS 做不到，得有原生代码。
 * 那个原生代码就是同目录的 `omni-landlock.c`（随主进程一起打包，见 electrobun.config.ts）。
 *
 * 取舍：**源码进仓库、首次使用时现编**，而不是往仓库里放预编译二进制。
 * - 预编译二进制要按架构 / libc 各带一份，还得考虑签名与可执行位，仓库里全是噪音；
 * - 现编一次约 200ms，按**源码内容 hash** 缓存到 `<数据目录>/native/`，之后直接复用；
 * - 编译不了（没装 cc）就如实降级到 bubblewrap，绝不假装沙箱开着。
 */
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "fs";
import path from "path";

import { landlockRulesetSpec } from "./agent-sandbox";
import { logEvent } from "./app-log";
import { getDataDir } from "./paths";

export type CompiledHelper =
  | { ok: true; path: string; source: "cache" | "built" }
  | { ok: false; reason: string };

export type LandlockHelper =
  | { ok: true; path: string; abi: number; source: "cache" | "built" }
  | { ok: false; reason: string };

/** 源码与主进程同目录：dev 是 `src/bun/`，打包后是 `bun/`（build.copy 已列上）。 */
export function helperSourcePath(): string {
  return path.join(import.meta.dir, "omni-landlock.c");
}

/** 编译产物放数据目录，不进仓库、也不需要额外写权限。 */
export function helperBuildDir(): string {
  return getDataDir("native");
}

/** 按源码 hash 命名：源码一改就编新的，不会拿旧二进制去配新规格。 */
export function helperBinaryPath(source = helperSourcePath()): string {
  const hash = createHash("sha1")
    .update(process.platform)
    .update(process.arch)
    .update(existsSync(source) ? readFileSync(source) : source)
    .digest("hex")
    .slice(0, 12);
  return path.join(helperBuildDir(), `omni-landlock-${hash}`);
}

/** 依次尝试的编译器（`OMNI_LANDLOCK_CC` 可覆盖，测试与交叉编译用）。 */
export function compilerCandidates(): string[] {
  const override = process.env.OMNI_LANDLOCK_CC?.trim();
  if (override) return [override];
  return ["cc", "gcc", "clang", "zig"];
}

export type HelperRunner = {
  /** 跑一条命令，返回退出码与 stderr（默认用 Bun.spawnSync）。 */
  run: (cmd: string[], timeoutMs?: number) => { code: number; stdout: string; stderr: string };
};

const defaultRunner: HelperRunner = {
  run: (cmd, timeoutMs = 30_000) => {
    try {
      const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
      return {
        code: proc.exitCode ?? -1,
        stdout: proc.stdout?.toString() ?? "",
        stderr: proc.stderr?.toString() ?? "",
      };
    } catch (err) {
      // 找不到可执行文件时 Bun.spawnSync 是**抛异常**而不是返回非零退出码。不接住的话
      // 「这台机器没装 cc」就会炸穿到沙箱状态页与每一次 bash 调用，而这个模块的全部
      // 意义正是"编译不了就如实降级"。统一折成 -1，让上面的候选循环照常继续。
      return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * 只编译（不发系统调用）：成功 = 本机有编译器且源码编得过。
 * 与探测分开是刻意的 —— "编得出来"和"内核支持"是两件独立的失败源，
 * 分开报才知道该装编译器还是该换后端。
 */
export function compileLandlockHelper(opts: {
  platform?: string;
  source?: string;
  binaryPath?: string;
  runner?: HelperRunner;
  /** 忽略已编译产物，强制重编（改完源码或怀疑产物被换过时用）。 */
  force?: boolean;
} = {}): CompiledHelper {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return { ok: false, reason: "Landlock 只在 Linux 上可用" };

  const source = opts.source ?? helperSourcePath();
  const runner = opts.runner ?? defaultRunner;
  if (!existsSync(source)) return { ok: false, reason: `辅助程序源码缺失：${source}` };

  const binary = opts.binaryPath ?? helperBinaryPath(source);
  const cached = existsSync(binary) && !opts.force;
  if (!cached) {
    ensureHelperBuildDir();
    // 编到临时名再改名过去：产物名只由**源码 hash** 决定，一旦被写坏（编译器被杀、
    // 磁盘写满留下的半个文件）就永远是那个名字，"存在即可用"会让它一辈子被当成
    // 有效缓存 —— 表面上沙箱不可用，实则再也编不回来。
    const tmp = `${binary}.tmp-${process.pid}`;
    let lastError = "没有可用的 C 编译器（cc / gcc / clang）";
    let built = false;
    for (const compiler of compilerCandidates()) {
      // zig 不是 cc 兼容的调用形式：`zig cc -o out src` 才对，这里给参数留个位置。
      const cmd =
        compiler === "zig"
          ? ["zig", "cc", "-std=c11", "-O2", "-o", tmp, source]
          : [compiler, "-std=c11", "-O2", "-o", tmp, source];
      const result = runner.run(cmd, 60_000);
      if (result.code === 0 && existsSync(tmp)) {
        try {
          renameSync(tmp, binary);
          built = true;
          break;
        } catch (err) {
          lastError = `无法落盘编译产物：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      rmSync(tmp, { force: true });
      lastError =
        result.code === -1
          ? `${compiler} 不可用`
          : `${compiler} 编译失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`;
    }
    if (!built) {
      rmSync(tmp, { force: true });
      logEvent({
        level: "warn",
        source: "agent",
        event: "agent.sandbox.landlock-build-failed",
        message: `Landlock 辅助程序编译失败，降级到 bubblewrap：${lastError}`,
      });
      return { ok: false, reason: lastError };
    }
    try {
      chmodSync(binary, 0o755);
    } catch {
      /* 权限位设不上不致命（多数文件系统默认就带可执行位） */
    }
  }

  return { ok: true, path: binary, source: cached ? "cache" : "built" };
}

/**
 * 编译 + 探测内核 ABI（探测含一次真实调用：`--probe` 会去发 `landlock_create_ruleset`）。
 * 外部交互都走 runner，单测可注入假实现。
 */
export function buildLandlockHelper(
  opts: Parameters<typeof compileLandlockHelper>[0] = {},
): LandlockHelper {
  let compiled = compileLandlockHelper(opts);
  if (!compiled.ok) return compiled;
  const runner = opts.runner ?? defaultRunner;
  let probe = runner.run([compiled.path, "--probe"], 10_000);
  if (probe.code !== 0 && compiled.source === "cache") {
    // 复用产物的探测失败有两种可能：内核确实不支持，或者这份缓存被换过 / 截断了。
    // 前者重编也没用，但重编的代价只有约 200ms —— 不重试的话，被写坏的产物会让
    // 「内核不支持」这个错误结论一直挂着，用户重装编译器也救不回来。
    const retried = compileLandlockHelper({ ...opts, binaryPath: compiled.path, force: true });
    if (retried.ok) {
      compiled = retried;
      probe = runner.run([compiled.path, "--probe"], 10_000);
    }
  }
  if (probe.code !== 0) {
    const detail = (probe.stderr || probe.stdout).trim().slice(0, 200) || `退出码 ${probe.code}`;
    return { ok: false, reason: `内核不支持 Landlock 或辅助程序起不来：${detail}` };
  }
  const abi = Number.parseInt(probe.stdout.trim(), 10);
  if (!Number.isFinite(abi) || abi < 1) {
    return { ok: false, reason: `辅助程序返回的 ABI 版本看不懂：${probe.stdout.trim().slice(0, 80)}` };
  }
  return { ok: true, path: compiled.path, abi, source: compiled.source };
}

let cachedHelper: LandlockHelper | null = null;

/**
 * 带缓存的结果（探测含编译，不能在每次包装命令时都跑一遍）。
 * 失败结果也缓存：没有编译器的机器上每次命令都试一遍编译毫无意义。
 */
export function landlockHelper(opts: { refresh?: boolean } = {}): LandlockHelper {
  if (cachedHelper && !opts.refresh) return cachedHelper;
  cachedHelper = buildLandlockHelper();
  return cachedHelper;
}

/** 测试用：清掉缓存（也可用来改完源码后强制重探）。 */
export function resetLandlockHelperCache(): void {
  cachedHelper = null;
}

export function landlockHelperAvailable(): boolean {
  return landlockHelper().ok;
}

/** 确保编译目录存在（编译前调用；失败交给编译本身去报）。 */
export function ensureHelperBuildDir(): void {
  try {
    mkdirSync(helperBuildDir(), { recursive: true });
  } catch {
    /* 编不出来会在 buildLandlockHelper 里变成如实的降级理由 */
  }
}

/**
 * 包一条命令：`omni-landlock --spec '<json>' [--canary <工作区>] -- <shell> -c '<命令>'`。
 * 规格直接走 argv（不落临时文件）：调用方用的是 argv 数组，没有 shell 解析，
 * 路径里的引号不会变成注入；规格本身也就几 KB。
 */
export function landlockCommand(
  binary: string,
  spec: string,
  shell: string,
  command: string,
  canary?: string,
): string[] {
  const canaryArgs = canary ? ["--canary", canary] : [];
  return [binary, "--spec", spec, ...canaryArgs, "--", shell, "-c", command];
}

/**
 * canary 探测：这套规则在**这个工作区所在的文件系统**上真的生效吗？
 *
 * 为什么需要：Landlock 的规则匹配基于 inode，遇到 FUSE 类文件系统（Docker Desktop 的
 * 共享目录、部分网络盘）会**整片落空** —— 表现是"连工作区都读不了"，每条命令都
 * Permission denied。这不是理论：Linux 容器里第一次跑端到端就撞上了（/work 是
 * fakeowner/gRPC-FUSE 挂载）。真出现时应当判为"Landlock 在这台机器上不可用"，
 * 换回 bubblewrap 或如实降级，而不是让用户对着一堆 Permission denied 猜。
 *
 * 做法就是真跑一次：拿同一个规格去限制一个什么都不做的进程，让它按规则读一次工作区。
 */
const canaryCache = new Map<string, { ok: boolean; reason: string | null }>();

export function probeLandlockWorkspace(
  workspace: string,
  opts: {
    binary?: string;
    mode?: "workspace-write" | "read-only";
    runner?: HelperRunner;
    refresh?: boolean;
  } = {},
): { ok: boolean; reason: string | null } {
  const mode = opts.mode ?? "workspace-write";
  const key = `${workspace}|${mode}`;
  if (!opts.refresh) {
    const cached = canaryCache.get(key);
    if (cached) return cached;
  }
  const helper = opts.binary
    ? { ok: true as const, path: opts.binary }
    : landlockHelper({ refresh: opts.refresh });
  if (!helper.ok) {
    const result = { ok: false, reason: helper.reason };
    canaryCache.set(key, result);
    return result;
  }
  const runner = opts.runner ?? defaultRunner;
  const probe = runner.run(
    [
      helper.path,
      "--spec",
      landlockRulesetSpec({ workspace, mode, authorizedFolders: [] }),
      "--canary",
      workspace,
      "--",
      "/bin/true",
    ],
    15_000,
  );
  const result =
    probe.code === 0
      ? { ok: true, reason: null }
      : {
          ok: false,
          reason: (probe.stderr || probe.stdout).trim().slice(0, 240) || `退出码 ${probe.code}`,
        };
  canaryCache.set(key, result);
  return result;
}

/** 测试用：清掉 canary 缓存。 */
export function resetLandlockCanaryCache(): void {
  canaryCache.clear();
}
