/**
 * 命令沙箱（对齐 Codex 的 workspace-write 沙箱，macOS 用 Seatbelt 落地）。
 *
 * 为什么需要：权限闸门管得住**工具**（写文件 / 读工作区外的文件），却管不住
 * `bash` 里的一行命令 —— `cat ~/.ssh/id_rsa`、`curl -d @… 某处`、
 * `echo x > ~/Library/…` 都不经过我们的路径校验。Codex 的答案是让内核来管：
 * 把命令跑在平台沙箱里，写只能落在工作区（+ 临时目录 + 用户已授权的目录）。
 *
 * 这里的取舍：
 * - **默认关闭**（`AGENT_SANDBOX_MODE=off`）：本地开发场景里 `npm install`、
 *   启动 dev server 都很常见，先在用户明确开启后再生效；
 * - 两个后端：macOS 走 `sandbox-exec`（Seatbelt），Linux 走 **bubblewrap**（bwrap）——
 *   两者都是"先只读挂载整个文件系统，再把白名单目录挂成可写"，语义一致；
 *   Windows 与没装 bwrap 的 Linux 一律**降级为不沙箱**并在状态里说明（不假装已启用）。
 *   Linux 的 **Landlock** 目前只做到"策略生成"（`landlockRuleset`）：它要直接发系统
 *   调用，纯 JS 做不了，需要一个原生辅助程序（Codex 是 Rust 侧实现的）—— 策略先以
 *   纯函数 + 稳定 JSON 落地，辅助程序到位后只管"读规格 → 发系统调用"，不用把口径在
 *   两边各写一遍；没辅助程序就照实说，不用"看起来支持"糊过去；
 * - 凭据路径（~/.ssh、~/.aws、应用数据目录…）**读也一并拒绝** —— 提示词注入
 *   最想拿到的就是这些，而工具层的黑名单只覆盖了 read_file 这类工具；
 * - 网络默认放行（`AGENT_SANDBOX_NETWORK=1`）：Codex 默认禁网，但本地工作流里
 *   禁网会让装依赖 / 拉模型直接失败；需要严格模式时把它关掉。
 */
import { existsSync, realpathSync } from "fs";
import os from "os";
import path from "path";

import { getSetting } from "./db/settings";
import { logEvent } from "./app-log";
import { landlockCommand, landlockHelper, probeLandlockWorkspace } from "./landlock-helper";
import { getDataDir, isOmniDataPath } from "./paths";

/**
 * 沙箱档位（对齐 Codex 的 SandboxPolicy）：
 * - `off`：不沙箱（默认）；
 * - `workspace-write`：可写工作区（+ 临时目录 + 已授权目录），写到别处由内核拦下；
 * - `read-only`：只读 —— 工作区与用户目录**一律不可写**，只有临时目录例外
 *   （测试运行器 / 编译器都要写 TMPDIR，一点不让写等于把只读模式变成不可用）。
 *   `danger-full-access` 就是 `off`，不单独设档。
 */
export type SandboxMode = "off" | "workspace-write" | "read-only";

export const SANDBOX_MODES: SandboxMode[] = ["off", "workspace-write", "read-only"];

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (SANDBOX_MODES as string[]).includes(value);
}

/** 当前沙箱模式。 */
export function sandboxMode(): SandboxMode {
  const raw = getSetting("AGENT_SANDBOX_MODE");
  return isSandboxMode(raw) ? raw : "off";
}

/** 沙箱里是否允许联网（默认允许，见文件头说明）。 */
export function sandboxAllowsNetwork(): boolean {
  return getSetting("AGENT_SANDBOX_NETWORK") !== "0";
}

/**
 * 沙箱后端：macOS 的 Seatbelt、Linux 的 bubblewrap / Landlock，或没有。
 *
 * Linux 上**首选 bwrap**：它能把凭据目录整个挖空（读也拿不到）并隔离 PID / 网络；
 * Landlock 是内核级的兜底 —— 不需要装任何东西、容器里也能用，但规则只能"允许"，
 * 挡不住读（详见 landlockRuleset 的说明）。两者都不可用才降级为不沙箱。
 */
export type SandboxBackend = "seatbelt" | "bwrap" | "landlock" | "none";

export function sandboxBackend(platform: string = process.platform): SandboxBackend {
  if (platform === "darwin") return "seatbelt";
  if (platform === "linux") return "bwrap";
  return "none";
}

/**
 * 实际会用哪个后端（带能力探测；探测结果可以注入，便于单测）。
 * 与 `sandboxBackend()` 的分工：那个回答"这个平台的首选是什么"，
 * 这个回答"这台机器上现在真能用哪个"。
 */
export type SandboxBackendPreference = "auto" | "bwrap" | "landlock";

export function sandboxBackendPreference(): SandboxBackendPreference {
  const raw = getSetting("AGENT_SANDBOX_BACKEND");
  return raw === "bwrap" || raw === "landlock" ? raw : "auto";
}

export function effectiveSandboxBackend(
  platform: string = process.platform,
  opts: { bwrapReady?: boolean; landlockReady?: boolean; prefer?: SandboxBackendPreference } = {},
): SandboxBackend {
  const preferred = sandboxBackend(platform);
  if (preferred !== "bwrap") return preferred;
  const prefer = opts.prefer ?? sandboxBackendPreference();
  const bwrapReady = opts.bwrapReady ?? bwrapAvailable();
  const landlockReady = opts.landlockReady ?? landlockHelper().ok;
  if (prefer === "landlock") return landlockReady ? "landlock" : "bwrap";
  if (prefer === "bwrap") return "bwrap";
  if (bwrapReady) return "bwrap"; // auto：bwrap 优先（能连凭据目录读取一起挡）
  return landlockReady ? "landlock" : "bwrap"; // 都没有：仍报首选后端，由 supported=false 交代
}

/**
 * bwrap 是否真的能用。只看 `which` 不够：容器里常常装了 bwrap 却没有
 * 非特权 user namespace（`bwrap` 一跑就报 "No permissions to create new namespace"）。
 * 所以探一次真实的空沙箱，结果缓存住（每次开沙箱都探一遍太贵）。
 */
let bwrapProbe: boolean | null = null;

export function bwrapAvailable(opts: { refresh?: boolean } = {}): boolean {
  if (bwrapProbe !== null && !opts.refresh) return bwrapProbe;
  try {
    const probe = Bun.spawnSync({
      // 最小可用沙箱：只读挂根 + 换个 /dev，跑一个 true。
      cmd: ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "true"],
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5000,
    });
    bwrapProbe = probe.exitCode === 0;
  } catch {
    bwrapProbe = false;
  }
  if (bwrapProbe === false && sandboxBackend() === "bwrap") {
    logEvent({
      level: "warn",
      source: "agent",
      event: "agent.sandbox.no-bwrap",
      message: "本机没有可用的 bubblewrap（未安装，或容器里不允许非特权 user namespace），Linux 沙箱降级为不沙箱",
      detail: { platform: process.platform },
    });
  }
  return bwrapProbe;
}

/** 测试用：重置 bwrap 探测缓存。 */
export function resetBwrapProbe(): void {
  bwrapProbe = null;
}

/**
 * 本平台是否有可用的沙箱实现。
 * macOS 有 Seatbelt；Linux 要看 bwrap 探测结果（可以用 `bwrapReady` 注入结果做单测）；
 * 其它平台返回 false，调用方据此降级为不沙箱**并把状态告诉用户**。
 */
export function sandboxSupported(
  platform: string = process.platform,
  opts: { bwrapReady?: boolean; landlockReady?: boolean } = {},
): boolean {
  const backend = sandboxBackend(platform);
  if (backend === "seatbelt") return true;
  if (backend === "bwrap") {
    // Linux：bubblewrap 或 Landlock 有一个能用就算支持（后者是兜底）。
    return (opts.bwrapReady ?? bwrapAvailable()) || (opts.landlockReady ?? landlockHelper().ok);
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Landlock（Linux 5.13+ 的内核级沙箱）
 *
 * 为什么只做到"策略生成"：Landlock 没有命令行工具，必须直接发
 * `landlock_create_ruleset` / `landlock_add_rule` / `landlock_restrict_self`
 * 三个系统调用 —— 纯 JS 发不了，需要一个原生辅助程序（Codex 是 Rust 侧实现的）。
 * 所以这里把**策略本身**做成纯函数与稳定 JSON：等辅助程序到位，它只需要做
 * "读规则 → 发系统调用"这一件事，策略不用在两边各写一遍（写两遍必然漂移）。
 *
 * 一个必须讲清楚的限制：**Landlock 规则只能"允许"，不能"拒绝"**。
 * 因此 bwrap / Seatbelt 上"把凭据目录挖空"这一手它表达不了 —— 想挡住
 * `~/.ssh` 的读取，要么在辅助程序里先做 bind mount（等于它自己实现 bwrap），
 * 要么依赖工具层的凭据黑名单。这个事实写在 ruleset 的 `unsupported` 里，
 * 不让调用方以为"生成完策略就等于拦住了一切"。
 * ---------------------------------------------------------------------- */

/** Landlock 的访问权位（对应内核里的 LANDLOCK_ACCESS_FS_*）。 */
export type LandlockAccess =
  | "execute"
  | "write_file"
  | "read_file"
  | "read_dir"
  | "remove_dir"
  | "remove_file"
  | "make_char"
  | "make_dir"
  | "make_reg"
  | "make_sock"
  | "make_fifo"
  | "make_block"
  | "make_sym"
  | "refer"
  | "truncate";

/** 只读用得到的位：读文件、列目录、执行。 */
const LANDLOCK_READ_ACCESS: LandlockAccess[] = ["execute", "read_file", "read_dir"];
/**
 * 可写用得到的位：只读的那些 + 写 / 删 / 建 / 截断 / 跨目录改名。
 *
 * `refer`（ABI 2+，rename / link 跨目录重定位所需的权限）必须一起处理：
 * Landlock 只处理你声明的权限，不声明就等于**永远放行**。
 */
const LANDLOCK_WRITE_ACCESS: LandlockAccess[] = [
  ...LANDLOCK_READ_ACCESS,
  "write_file",
  "remove_file",
  "remove_dir",
  "make_reg",
  "make_dir",
  "make_sym",
  "truncate",
  "refer",
];

/**
 * 设备文件/设备目录所需的权限位：只读 + 只写，**不给** make_* / remove_*
 * （它们本来就是设备，沙箱里不需要再造删）。
 */
const LANDLOCK_DEVICE_FILE_ACCESS: LandlockAccess[] = ["read_file", "write_file"];

/**
 * Landlock 下必须放行的设备路径。
 *
 * 为什么必须放行：Landlock 的 `write_file` 覆盖**所有**以写方式打开的路径 ——
 * 包括 `/dev/null`。不放行的话 `cmd 2>/dev/null` 这种到处都是的写法会直接失败
 * （这不是推测：Linux 端到端第一次跑就把这条踩出来了）。
 * `/dev/pts` 与 `/dev/shm` 是目录：pty 分配要 `make_char`、共享内存要 `make_reg`，
 * 所以这两个给完整的写权限集。
 */
export function sandboxDevicePaths(): string[] {
  return [
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
    "/dev/ptmx",
    "/dev/pts",
    "/dev/shm",
  ];
}

export type LandlockRule = { path: string; access: LandlockAccess[] };

export type LandlockRuleset = {
  mode: SandboxMode;
  /**
   * 要"处理"（= 可能拒绝）的权限集合。Landlock 的语义是**只处理你声明的权限**，
   * 没声明的照旧放行 —— 所以要把写相关的位都列进来，否则写了也不拦。
   */
  handled: LandlockAccess[];
  /** 允许规则：`/` 只给读，可写目录再单独给一组（Landlock 规则是叠加的允许集）。 */
  rules: LandlockRule[];
  network: "allowed" | "denied";
  /** 这个后端**表达不了**的意图（如实列出来，别让调用方以为都拦住了）。 */
  unsupported: string[];
};

/**
 * 按沙箱档位算出 Landlock 规则集（纯函数：不探测、不读设置）。
 * 口径与 Seatbelt / bwrap 两侧保持一致：临时目录在只读档里也可写
 * （测试运行器与编译器要写 TMPDIR），已授权目录只在 workspace-write 档可写。
 */
export function landlockRuleset(opts: {
  workspace: string;
  mode?: SandboxMode;
  authorizedFolders?: string[];
  allowNetwork?: boolean;
  /** 路径必须存在才写进规则（Landlock 对不存在的路径加规则会 ENOENT）。 */
  existingOnly?: (target: string) => boolean;
}): LandlockRuleset {
  const mode = opts.mode ?? sandboxMode();
  const exists = opts.existingOnly ?? existsSync;
  const rules: LandlockRule[] = [{ path: "/", access: [...LANDLOCK_READ_ACCESS] }];

  const writable = new Set<string>(sandboxTempRoots().map((dir) => path.resolve(dir)));
  if (mode === "workspace-write") {
    writable.add(path.resolve(opts.workspace));
    for (const folder of opts.authorizedFolders ?? []) writable.add(path.resolve(folder));
  }
  for (const dir of writable) {
    if (!exists(dir)) continue;
    rules.push({ path: dir, access: [...LANDLOCK_WRITE_ACCESS] });
  }

  // 设备例外：不给的话连 `2>/dev/null` 都会失败（见 sandboxDevicePaths 的说明）。
  for (const device of sandboxDevicePaths()) {
    if (!exists(device)) continue;
    const isDir = device === "/dev/pts" || device === "/dev/shm";
    rules.push({
      path: device,
      access: [...(isDir ? LANDLOCK_WRITE_ACCESS : LANDLOCK_DEVICE_FILE_ACCESS)],
    });
  }

  return {
    mode,
    handled: [...LANDLOCK_WRITE_ACCESS],
    rules,
    network: opts.allowNetwork === false ? "denied" : "allowed",
    unsupported: [
      "Landlock 规则是「只允许」模型：挡不住「在大范围允许里挖掉一个子目录」（凭据目录的读拦截要靠 bind mount 或工具层黑名单）",
      ...(opts.allowNetwork === false
        ? ["网络拦截需要 Landlock ABI 4（Linux 6.7+）的 net 规则；更早的内核只能靠别的机制（bwrap 用 --unshare-net）"]
        : []),
    ],
  };
}

/**
 * 交给原生辅助程序的规格（稳定 JSON：路径排序去重，同一档位永远序列化成同一串）——
 * 辅助程序只做"读它 → 发系统调用"，策略不在两边各写一遍。
 */
export function landlockRulesetSpec(opts: Parameters<typeof landlockRuleset>[0]): string {
  const ruleset = landlockRuleset(opts);
  const rules = [...ruleset.rules]
    .sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1))
    .map((rule) => ({ path: rule.path, access: [...rule.access].sort() }));
  return JSON.stringify({ version: 1, ...ruleset, rules });
}

/**
 * Landlock 的可用性：**策略已就绪、辅助程序还没有**（原生代码不是这一层能提供的）。
 * 内核版本只作为展示用的弱信号 —— 真正的能力探测得由辅助程序自己发系统调用。
 */
export function landlockStatus(): {
  policyReady: boolean;
  helperAvailable: boolean;
  abi: number | null;
  reason: string | null;
  note: string;
} {
  const platform = process.platform;
  if (platform !== "linux") {
    return {
      policyReady: true,
      helperAvailable: false,
      abi: null,
      reason: "Landlock 只在 Linux 上可用",
      note: "Landlock 只适用于 Linux（本机用的是另一套后端）",
    };
  }
  const helper = landlockHelper();
  return {
    policyReady: true,
    helperAvailable: helper.ok,
    abi: helper.ok ? helper.abi : null,
    reason: helper.ok ? null : helper.reason,
    note: helper.ok
      ? `Landlock 可用（内核 ABI ${helper.abi}，辅助程序已就绪）；` +
        "bwrap 装了的话优先用 bwrap（它能连凭据目录的读取一起挡住）"
      : `Landlock 不可用（${helper.reason}），Linux 上退回 bubblewrap`,
  };
}

/** 沙箱里要"挖空"的凭据目录：bwrap 用 tmpfs 盖住它们（读也拿不到）。 */
export function existingCredentialPaths(): string[] {
  return sandboxCredentialPaths().filter((target) => existsSync(target));
}

/**
 * 生成 bwrap 的 argv（**不含** 开头的 `bwrap`，结尾是 shell + 命令）。
 *
 * 形态是"先整体只读、再把白名单覆盖成可写"：
 * `--ro-bind / /` → 整个根只读；`--bind <dir> <dir>` 把工作区 / 临时目录 /
 * 已授权目录挂成可写；`--tmpfs <凭据目录>` 把凭据目录挖空（读也读不到）；
 * `--unshare-pid --die-with-parent` 隔离进程并保证父进程退出时一起收摊；
 * 关掉联网时加 `--unshare-net`。
 *
 * 纯函数：不探测、不读设置，方便在 macOS 上直接单测（Linux 的端到端留给 Linux runner）。
 */
export function bwrapArgs(opts: {
  workspace: string;
  shell: string;
  command: string;
  mode?: SandboxMode;
  authorizedFolders?: string[];
  allowNetwork?: boolean;
}): string[] {
  const mode = opts.mode ?? sandboxMode();
  const args: string[] = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];

  // 临时目录始终可写：测试运行器 / 编译器 / 包管理器都要写 TMPDIR，
  // 一点不让写等于把沙箱变成不可用（与 macOS 侧同一个取舍）。
  const writable = [...sandboxTempRoots()];
  if (mode === "workspace-write") writable.push(opts.workspace, ...(opts.authorizedFolders ?? []));
  for (const dir of writable) {
    const resolved = path.resolve(dir);
    if (!existsSync(resolved)) continue;
    args.push("--bind", resolved, resolved);
  }

  // 凭据目录挖空：bwrap 没有"按路径拒绝读"的写法，用空的 tmpfs 盖住最直接。
  for (const target of existingCredentialPaths()) {
    args.push("--tmpfs", target);
  }

  args.push("--unshare-pid", "--die-with-parent", "--new-session");
  if (opts.allowNetwork === false) args.push("--unshare-net");
  args.push(opts.shell, "-c", opts.command);
  return args;
}

/**
 * 凭据路径黑名单：与 `agent-tools.ts` 的 SECRET_PATH_PATTERNS 同一批意图，
 * 这里以绝对路径子串的形式给 seatbelt 用（读也拒）。
 */
export function sandboxCredentialPaths(home = process.env.HOME ?? "/"): string[] {
  const paths = [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".kube"),
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
    path.join(home, ".git-credentials"),
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    path.join(home, ".omni"),
    path.join(home, "Library", "Keychains"),
  ];
  // 本应用的数据目录**必须按 paths.ts 的真实规则算**（`<appData>/<标识>/<频道>`），
  // 不能写死一个名字：写死之后这个条目永远匹配不到任何东西，而设置表里存着全部云端
  // API Key —— 等于"注释说读也拒，实际什么都没拦"。dev / canary / 正式频道各有
  // 一份数据，通向任意一份都等于拿到密钥，所以标识目录整体拒掉。
  const dataDir = getDataDir();
  paths.push(dataDir);
  const identifierDir = path.dirname(dataDir);
  if (isOmniDataPath(identifierDir)) paths.push(identifierDir);
  return paths;
}

/** 可写目录：工作区（含 realpath，macOS 上 /tmp 是 /private/tmp 的软链）、临时目录、已授权目录。 */
export function sandboxWritableRoots(workspace: string, authorized: string[] = []): string[] {
  const roots = new Set<string>();
  const add = (value: string) => {
    if (!value) return;
    const resolved = path.resolve(value);
    roots.add(resolved);
    // seatbelt 按真实路径匹配：/tmp/x 与 /private/tmp/x 是两条不同的子路径。
    try {
      roots.add(realpathSync(resolved));
    } catch {
      // 目录不存在就只留解析后的路径
    }
  };
  add(workspace);
  add(os.tmpdir());
  add("/tmp");
  add("/private/tmp");
  add("/var/folders");
  for (const folder of authorized) add(folder);
  return [...roots];
}

/** 转义 seatbelt 字符串字面量里的反斜杠与引号。 */
function seatbeltString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 把路径列表展开成 seatbelt 的 `(subpath …)` 过滤器。
 *
 * **必须带上 realpath**：macOS 上 `/tmp` 是 `/private/tmp`、`/var` 是 `/private/var`，
 * 而 seatbelt 是按真实路径匹配的 —— 只写 `/var/folders/...` 的策略拦不住内核眼里的
 * `/private/var/folders/...`（实测：凭据目录的读拦截会整个失效）。
 */
function subpathFilters(targets: string[]): string {
  const expanded = new Set<string>();
  for (const target of targets) {
    if (!target) continue;
    const resolved = path.resolve(target);
    expanded.add(resolved);
    try {
      expanded.add(realpathSync(resolved));
    } catch {
      // 路径不存在（比如还没建的授权目录）就只留解析后的形式
    }
  }
  return [...expanded].map((value) => `(subpath "${seatbeltString(value)}")`).join(" ");
}

/** 临时目录：只读模式下唯一允许写入的地方（工具链需要 TMPDIR）。 */
export function sandboxTempRoots(): string[] {
  return [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
}

/** 设备节点等：命令里 `> /dev/null`、`2>/dev/stderr` 太常见，永不放行就没法用了。 */
const DEVICE_WRITE_LITERALS = [
  '(literal "/dev/null")',
  '(literal "/dev/stdout")',
  '(literal "/dev/stderr")',
  '(literal "/dev/dtracehelper")',
  '(literal "/dev/tty")',
].join(" ");

/**
 * 生成 Seatbelt 策略。三种形态：
 *
 * - **workspace-write + 允许联网**（默认档）：`allow default` + `deny file-write*` 再放行
 *   可写目录 —— 只拦"写到工作区外"，对 `npm install`、启 dev server 这类工作流最友好；
 * - **workspace-write + 禁网**：`deny default` + 显式放行进程 / 读 / 可写目录；
 * - **read-only**：`deny default` + 放行进程 / 读 / 临时目录写 —— 工作区与用户目录
 *   一律不可写（写工作区同样被内核拒绝），网络按开关。
 *
 * 三种形态都会**额外拒绝凭据目录的读取**。
 */
export function sandboxProfile(opts: {
  workspace: string;
  authorizedFolders?: string[];
  allowNetwork?: boolean;
  mode?: SandboxMode;
}): string {
  const mode = opts.mode ?? sandboxMode();
  const denyCredentials = subpathFilters(sandboxCredentialPaths());

  if (mode === "read-only") {
    // 只读：不认已授权目录（它们照样是"用户目录"，只读模式就是不写）。
    const allowWrites = `(allow file-write* ${subpathFilters(sandboxTempRoots())} ${DEVICE_WRITE_LITERALS})`;
    return [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow ipc-posix-shm)",
      "(allow file-read*)",
      allowWrites,
      `(deny file-read* ${denyCredentials})`,
      ...(opts.allowNetwork === false ? [] : ["(allow network*)"]),
    ].join("");
  }

  const writable = subpathFilters(sandboxWritableRoots(opts.workspace, opts.authorizedFolders ?? []));
  const allowWrites = `(allow file-write* ${writable} ${DEVICE_WRITE_LITERALS})`;

  if (opts.allowNetwork === false) {
    return [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow file-read*)",
      allowWrites,
      `(deny file-read* ${denyCredentials})`,
    ].join("");
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    allowWrites,
    `(deny file-read* ${denyCredentials})`,
  ].join("");
}

export type WrappedCommand = {
  /** 实际执行的 argv（不经过 shell 拼接）。 */
  cmd: string[];
  /** 生效的沙箱模式（"off" 表示没包沙箱）。 */
  mode: SandboxMode;
  /** 实际生效的后端（"none" = 没包沙箱）；调用方据此解释拦截信息。 */
  backend: SandboxBackend;
  /** 想开但开不了时的原因（界面与日志要如实说明）。 */
  degradedReason?: string;
};

/**
 * 按当前设置把一条 shell 命令包进沙箱。
 * 关闭 / 平台不支持时原样返回，`degradedReason` 说明为什么没生效。
 */
export function wrapShellCommand(
  command: string,
  opts: {
    workspace: string;
    shell: string;
    authorizedFolders?: string[];
    platform?: string;
    /** 测试注入：Linux 上 bwrap 是否可用（不传就现场探测）。 */
    bwrapReady?: boolean;
    /** 测试注入：Landlock 辅助程序是否可用（不传就现场探测/现编）。 */
    landlockReady?: boolean;
    /** 测试注入：canary 探测（工作区所在文件系统上规则是否生效）是否通过。 */
    landlockCanaryReady?: boolean;
  },
): WrappedCommand {
  const mode = sandboxMode();
  const shell = [opts.shell, "-c", command];
  if (mode === "off") return { cmd: shell, mode, backend: "none" };
  const platform = opts.platform ?? process.platform;
  let backend = effectiveSandboxBackend(platform, {
    bwrapReady: opts.bwrapReady,
    landlockReady: opts.landlockReady,
  });
  const prefer = sandboxBackendPreference();

  if (backend === "none") {
    return {
      cmd: shell,
      mode,
      backend,
      degradedReason: `当前平台（${platform}）还没有沙箱实现，命令按未沙箱执行`,
    };
  }
  if (
    backend === "bwrap" &&
    !sandboxSupported(platform, { bwrapReady: opts.bwrapReady, landlockReady: opts.landlockReady })
  ) {
    return {
      cmd: shell,
      mode,
      backend: "none",
      degradedReason:
        `Linux 沙箱依赖 bubblewrap（bwrap）或 Landlock，本机两样都不可用（后端偏好：${prefer}）：` +
        "bwrap 未安装或容器里不允许非特权 user namespace；Landlock 辅助程序也编不出来" +
        "（需要 C 编译器，内核要 5.13+）。命令按未沙箱执行。" +
        "安装：apt install bubblewrap / dnf install bubblewrap，或装 gcc 让 Landlock 兜底",
    };
  }

  // Landlock 还有两条前置条件不满足就得让位：**禁网**（net 规则没实现）与
  // **文件系统兼容性**（FUSE / 网络盘上规则整片落空 —— Linux 容器里踩到过）。
  if (backend === "landlock") {
    const blocker = landlockUnavailableReason(opts.workspace, opts.landlockCanaryReady);
    if (blocker) {
      const bwrap = sandboxBackend(platform) === "bwrap" && (opts.bwrapReady ?? bwrapAvailable());
      if (!bwrap) return { cmd: shell, mode, backend: "none", degradedReason: blocker };
      logSandboxDegraded(`Landlock 让位给 bubblewrap：${blocker}`);
      backend = "bwrap";
    }
  }

  if (backend === "landlock") {
    const helper = landlockHelper();
    if (!helper.ok) {
      // 走不到这儿（上面的 blocker 检查已覆盖），但真发生了就别装作有沙箱。
      return {
        cmd: shell,
        mode,
        backend: "none",
        degradedReason: `Landlock 辅助程序不可用：${helper.reason}`,
      };
    }
    return {
      cmd: landlockCommand(
        helper.path,
        landlockRulesetSpec({
          workspace: opts.workspace,
          mode,
          authorizedFolders: opts.authorizedFolders,
          allowNetwork: sandboxAllowsNetwork(),
        }),
        opts.shell,
        command,
        opts.workspace, // canary：规则在这个文件系统上真的生效吗（FUSE 上会整片落空）
      ),
      mode,
      backend,
    };
  }

  if (backend === "bwrap") {
    return {
      cmd: [
        "bwrap",
        ...bwrapArgs({
          workspace: opts.workspace,
          shell: opts.shell,
          command,
          mode,
          authorizedFolders: opts.authorizedFolders,
          allowNetwork: sandboxAllowsNetwork(),
        }),
      ],
      mode,
      backend,
    };
  }

  const profile = sandboxProfile({
    workspace: opts.workspace,
    authorizedFolders: opts.authorizedFolders,
    allowNetwork: sandboxAllowsNetwork(),
    mode,
  });
  return { cmd: ["sandbox-exec", "-p", profile, ...shell], mode, backend };
}

/**
 * Landlock 现在能不能用（本机与该工作区）：不能就给出**能看懂的原因**。
 * 三个前置条件：辅助程序编得出来、内核支持（由探测负责）、规则在这个文件系统上
 * 真的生效（canary），外加"禁网"这一条它做不到。
 */
export function landlockUnavailableReason(workspace: string, canaryReady?: boolean): string | null {
  const helper = landlockHelper();
  if (!helper.ok) return `Landlock 辅助程序不可用：${helper.reason}`;
  if (!sandboxAllowsNetwork()) {
    return "Landlock 后端不支持禁网（内核 net 规则未实现），已让位给 bubblewrap；" +
      "想只用 Landlock 就把沙箱的「允许联网」打开";
  }
  const canary = canaryReady === undefined ? probeLandlockWorkspace(workspace) : { ok: canaryReady };
  if (!canary.ok) {
    const detail = "reason" in canary && canary.reason ? `：${canary.reason}` : "";
    return `Landlock 规则在该工作区所在的文件系统上不生效（FUSE / 网络盘常见）${detail}`;
  }
  return null;
}

/**
 * 命中沙箱拦截时的补充说明：命令只回一句 "operation not permitted" 时，
 * 模型与用户都看不出是被沙箱拦的，会误以为是命令本身写错了。
 */
export function explainSandboxDenial(output: string, opts: { backend?: SandboxBackend } = {}): string | null {
  // Seatbelt 报 "operation not permitted"，bwrap 的只读挂载报 "Read-only file system"
  // （或 bwrap 自己前缀的错误）。刻意不把裸的 "Permission denied" 算进来 ——
  // 那太常见，普通文件权限问题会被误报成"沙箱拦的"。
  //
  // 例外：Landlock 拒写时内核只回 EACCES（就是 "Permission denied"），没有可辨识的措辞。
  // 在**确认走的是 Landlock**（backend 已知）时把它算进来 —— 代价是可能多问一次
  // "要不要跳过沙箱"，比"被拦了却什么都不说、模型反复试同一件事"要好。
  const landlock = opts.backend === "landlock";
  const pattern = landlock
    ? /operation not permitted|Read-only file system|Permission denied/i
    : /operation not permitted|Read-only File system|Read-only file system|sandbox-exec|bwrap:/i;
  if (!pattern.test(output)) return null;
  const scope =
    sandboxMode() === "read-only"
      ? "当前为 read-only：工作区与用户目录都不可写，只有临时目录例外"
      : "当前为 workspace-write：只允许写工作区 / 临时目录";
  return (
    `提示：这条命令可能被命令沙箱拦住了（${scope}，` +
    `网络${sandboxAllowsNetwork() ? "已放行" : "已禁止"}）。需要放宽时到 设置 → Agent 能力 调整沙箱模式。`
  );
}

/** 设置页展示用：模式、是否真的生效、原因。 */
export function sandboxStatus(): {
  mode: SandboxMode;
  supported: boolean;
  backend: SandboxBackend;
  platform: string;
  allowNetwork: boolean;
  /** Linux 上：bwrap 是否探测通过（设置页据此显示"装了没装"）。 */
  bwrapAvailable: boolean;
  /** 后端偏好（设置项 AGENT_SANDBOX_BACKEND）：auto / bwrap / landlock。 */
  backendPreference: SandboxBackendPreference;
  /** Landlock：辅助程序能不能用（真的编一次、真的探一次内核，不是"理论上可以"）。 */
  landlock: {
    policyReady: boolean;
    helperAvailable: boolean;
    abi: number | null;
    reason: string | null;
    note: string;
  };
} {
  const platform = process.platform;
  const bwrapReady = sandboxBackend(platform) === "bwrap" ? bwrapAvailable() : false;
  return {
    mode: sandboxMode(),
    supported: sandboxSupported(platform, { bwrapReady }),
    // 报"现在真会用哪个"：Linux 上有 bwrap 用 bwrap，没有就 Landlock，都没有才 none/降级。
    backend: effectiveSandboxBackend(platform, { bwrapReady }),
    platform,
    allowNetwork: sandboxAllowsNetwork(),
    bwrapAvailable: bwrapReady,
    backendPreference: sandboxBackendPreference(),
    landlock: landlockStatus(),
  };
}

/** 是否启用沙箱（供 bash 工具判断要不要在失败结果里附解释）。 */
export function sandboxActive(): boolean {
  return sandboxMode() !== "off" && sandboxSupported();
}

/** 记录一次沙箱降级（设置页看不到日志，统一日志里要能查）。 */
export function logSandboxDegraded(reason: string): void {
  logEvent({
    level: "warn",
    source: "agent",
    event: "agent.sandbox.degraded",
    message: reason,
    detail: { platform: process.platform },
  });
}
