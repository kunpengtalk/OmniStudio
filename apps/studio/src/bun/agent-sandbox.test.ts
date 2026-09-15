import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";

import {
  bwrapArgs,
  explainSandboxDenial,
  landlockRuleset,
  landlockRulesetSpec,
  landlockStatus,
  type LandlockAccess,
  sandboxBackend,
  isSandboxMode,
  sandboxActive,
  sandboxAllowsNetwork,
  sandboxCredentialPaths,
  sandboxMode,
  sandboxProfile,
  sandboxStatus,
  sandboxSupported,
  sandboxTempRoots,
  sandboxWritableRoots,
  effectiveSandboxBackend,
  wrapShellCommand,
  landlockUnavailableReason,
} from "./agent-sandbox";
import { landlockHelperAvailable } from "./landlock-helper";
import { buildAgentTools } from "./agent-tools";
import { getDataDir } from "./paths";
import { updateSettings } from "./db/settings";

/**
 * 命令沙箱（对齐 Codex 的 workspace-write）。
 *
 * 这是**内核层面**的边界：权限闸门管得住工具，却管不住 `bash` 里的一行命令。
 * 真实拦不拦得住只有跑一次才知道，所以下面除了策略生成，还有在 macOS 上
 * 真跑 sandbox-exec 的端到端用例（其它平台自动跳过）。
 */
const onMac = process.platform === "darwin";

let workspace: string;

const readFileSyncText = (target: string): string => readFileSync(target, "utf8");

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "omni-sandbox-ws-"));
  updateSettings({ AGENT_SANDBOX_MODE: "off", AGENT_SANDBOX_NETWORK: "1", AGENT_AUTHORIZED_FOLDERS: "[]" });
});

afterEach(() => {
  updateSettings({ AGENT_SANDBOX_MODE: "off", AGENT_SANDBOX_NETWORK: "1", AGENT_AUTHORIZED_FOLDERS: "[]" });
  rmSync(workspace, { recursive: true, force: true });
});

describe("策略与包装", () => {
  test("关闭时原样执行，不引入任何包装", () => {
    const wrapped = wrapShellCommand("echo hi", { workspace, shell: "/bin/zsh" });
    expect(wrapped.mode).toBe("off");
    expect(wrapped.cmd).toEqual(["/bin/zsh", "-c", "echo hi"]);
    expect(wrapped.degradedReason).toBeUndefined();
  });

  test("开启后在支持的平台包上 sandbox-exec；不支持的平台降级并说明原因", () => {
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write" });
    const mac = wrapShellCommand("echo hi", { workspace, shell: "/bin/zsh", platform: "darwin" });
    expect(mac.cmd[0]).toBe("sandbox-exec");
    expect(mac.cmd).toContain("/bin/zsh");
    expect(mac.degradedReason).toBeUndefined();

    /**
     * Linux 有两个后端（bwrap / Landlock），"能不能用"取决于**宿主**装没装 bwrap、
     * 有没有 C 编译器、内核够不够新 —— 直接断言结果会变成"在 macOS 上碰巧成立"：
     * 这台机器没有 bwrap，于是看着像"Linux 永远降级"，而在 Linux 上（有 gcc + 新内核）
     * 同一个用例会拿到包好的 landlock argv 而失败。所以这里把两个后端的可用性**显式注入**，
     * 断言的是分支逻辑本身。真机上 bwrap 可用时的 argv 见下面「Linux（bwrap）」那一组。
     */
    const linux = wrapShellCommand("echo hi", {
      workspace,
      shell: "/bin/bash",
      platform: "linux",
      bwrapReady: false,
      landlockReady: false,
    });
    expect(linux.cmd).toEqual(["/bin/bash", "-c", "echo hi"]);
    expect(linux.degradedReason).toContain("bwrap");
    expect(sandboxSupported("darwin")).toBe(true);
    expect(sandboxSupported("win32")).toBe(false);
    expect(sandboxSupported("linux", { bwrapReady: false, landlockReady: false })).toBe(false);
    expect(sandboxSupported("linux", { bwrapReady: true, landlockReady: false })).toBe(true);
    expect(sandboxSupported("linux", { bwrapReady: false, landlockReady: true })).toBe(true);
  });

  test("策略里包含工作区（含 realpath）、临时目录与已授权目录，并拒绝凭据路径", () => {
    const profile = sandboxProfile({ workspace, authorizedFolders: ["/opt/shared"] });
    expect(profile).toContain(`(subpath "${path.resolve(workspace)}")`);
    expect(profile).toContain('(subpath "/tmp")');
    expect(profile).toContain('(subpath "/opt/shared")');
    // ~/.ssh 这类路径读也拒 —— 提示词注入最想拿到的就是它。
    for (const target of sandboxCredentialPaths().slice(0, 3)) {
      expect(profile).toContain(`(subpath "${target}")`);
    }
    expect(profile).toContain("deny file-write*");

    // 关掉联网 → 换成 deny default 的严格形态。
    const strict = sandboxProfile({ workspace, allowNetwork: false });
    expect(strict).toContain("(deny default)");
    expect(strict).not.toContain("(allow default)");
  });

  test("可写目录去重且带 realpath（/tmp 与 /private/tmp 是两条路径）", () => {
    const roots = sandboxWritableRoots(workspace, [workspace]);
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots).toContain(path.resolve(workspace));
  });

  test("read-only：只放行临时目录写，且不认已授权目录；网络按开关", () => {
    const profile = sandboxProfile({ workspace, authorizedFolders: ["/opt/shared"], mode: "read-only" });
    expect(profile).toContain("(deny default)");
    // 只读：工作区不在可写列表里（这是与 workspace-write 的核心差别）。
    expect(profile).not.toContain(`(allow file-write* (subpath "${path.resolve(workspace)}")`);
    // 只读模式连已授权目录都不放行 —— 它们照样是"用户目录"。
    expect(profile).not.toContain('(subpath "/opt/shared")');
    for (const root of sandboxTempRoots().slice(0, 2)) {
      expect(profile).toContain(`(subpath "${path.resolve(root)}")`);
    }
    expect(profile).toContain("(allow network*)");
    expect(profile).toContain("(deny file-read*");
    // 关掉联网后不再放行 network。
    const offline = sandboxProfile({ workspace, mode: "read-only", allowNetwork: false });
    expect(offline).not.toContain("(allow network*)");
  });

  test("档位解析：三种值，非法值回落到 off", () => {
    expect(isSandboxMode("read-only")).toBe(true);
    expect(isSandboxMode("workspace-write")).toBe(true);
    expect(isSandboxMode("danger-full-access")).toBe(false);
    updateSettings({ AGENT_SANDBOX_MODE: "read-only" });
    expect(sandboxMode()).toBe("read-only");
    updateSettings({ AGENT_SANDBOX_MODE: "nonsense" });
    expect(sandboxMode()).toBe("off");
  });

  test("阻断说明只在真的像沙箱拦截时出现，并说清是哪一档", () => {
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write" });
    expect(explainSandboxDenial("zsh:1: operation not permitted: /Users/x/a.txt")).toContain("工作区 / 临时目录");
    updateSettings({ AGENT_SANDBOX_MODE: "read-only" });
    expect(explainSandboxDenial("zsh:1: operation not permitted: /Users/x/a.txt")).toContain("read-only");
    expect(explainSandboxDenial("ls: no such file or directory")).toBeNull();
    updateSettings({ AGENT_SANDBOX_MODE: "off" });
    expect(sandboxActive()).toBe(false);
  });

  test("状态摘要如实反映平台与联网设置", () => {
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write", AGENT_SANDBOX_NETWORK: "0" });
    const status = sandboxStatus();
    expect(status.mode).toBe("workspace-write");
    /**
     * `supported` 是**本机**的实际结论，不能写成"macOS 为真、其余为假"：
     * Linux 上有 bwrap 或有能用的 Landlock（内核 5.13+ 且有 C 编译器）都是真 ——
     * 在 Linux runner 上断言 false 必然失败，而那是"这台开发机碰巧没有 bwrap"。
     * 这里按机制对齐：有没有后端看平台，能不能用看本机探测。
     */
    const hasBackend = sandboxBackend() !== "none";
    expect(status.supported).toBe(hasBackend ? sandboxSupported() : false);
    expect(status.allowNetwork).toBe(false);
    expect(sandboxAllowsNetwork()).toBe(false);
  });
});

/**
 * Linux（bubblewrap）：策略生成与平台降级。
 *
 * 端到端要在 Linux runner 上才跑得动，但**策略生成本身是纯函数** ——
 * 在 macOS 上就能把"命令行拼成什么样"钉死：拼错了（比如忘了把工作区挂成可写、
 * 或者没挖空凭据目录）在 Linux 上就是"沙箱形同虚设"或"命令全跑不动"，
 * 那种 bug 不该等到有 Linux 机器才发现。
 */
describe("Linux（bwrap）", () => {
  test("后端按平台选：macOS 走 Seatbelt、Linux 走 bwrap、其它没有", () => {
    expect(sandboxBackend("darwin")).toBe("seatbelt");
    expect(sandboxBackend("linux")).toBe("bwrap");
    expect(sandboxBackend("win32")).toBe("none");
    expect(sandboxSupported("darwin")).toBe(true);
    expect(sandboxSupported("win32")).toBe(false);
    // Linux 取决于 bwrap / Landlock 是否真的能用（容器里常常装了 bwrap 却起不来）。
    // 两个后端的可用性都要显式给：只写 bwrapReady 时 landlockReady 会回落到本机探测，
    // 于是一个装了 gcc 的 Linux runner 会得到 true —— 断言又变成"只在 macOS 成立"。
    expect(sandboxSupported("linux", { bwrapReady: true, landlockReady: false })).toBe(true);
    expect(sandboxSupported("linux", { bwrapReady: false, landlockReady: true })).toBe(true);
    expect(sandboxSupported("linux", { bwrapReady: false, landlockReady: false })).toBe(false);
  });

  test("argv：整体只读挂根，再把工作区/临时目录挂成可写", () => {
    const args = bwrapArgs({
      workspace,
      shell: "/bin/bash",
      command: "echo hi",
      mode: "workspace-write",
      allowNetwork: true,
    });
    // 先只读挂整个根 —— 这是"写到别处会被拒"的来源。
    expect(args.slice(0, 4)).toEqual(["--ro-bind", "/", "/", "--dev"]);
    expect(args).toContain("--bind");
    const binds = args.filter((arg, index) => args[index - 1] === "--bind");
    expect(binds).toContain(path.resolve(workspace));
    expect(binds).toContain(path.resolve(tmpdir()));
    // 进程隔离与"父进程退出时一起收摊"。
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--die-with-parent");
    // 命令在最后：shell -c <命令>
    expect(args.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });

  test("argv：read-only 不挂工作区；联网开关 → --unshare-net", () => {
    const readOnly = bwrapArgs({
      workspace,
      shell: "/bin/bash",
      command: "ls",
      mode: "read-only",
      allowNetwork: true,
    });
    const readOnlyBinds = readOnly.filter((arg, index) => readOnly[index - 1] === "--bind");
    expect(readOnlyBinds).not.toContain(path.resolve(workspace));
    expect(readOnlyBinds).toContain(path.resolve(tmpdir()));
    expect(readOnly).not.toContain("--unshare-net");

    const offline = bwrapArgs({ workspace, shell: "/bin/bash", command: "ls", allowNetwork: false });
    expect(offline).toContain("--unshare-net");
  });

  test("argv：凭据目录用空 tmpfs 盖住（bwrap 没有按路径拒读的写法）", () => {
    // 用一个真实存在的目录冒充凭据目录（$HOME 一定在）。
    const previousHome = process.env.HOME;
    const fakeHome = mkdtempSync(path.join(homedir(), ".omni-bwrap-creds-"));
    mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
    process.env.HOME = fakeHome;
    try {
      const args = bwrapArgs({ workspace, shell: "/bin/bash", command: "ls", mode: "read-only" });
      const tmpfs = args.filter((arg, index) => args[index - 1] === "--tmpfs");
      expect(tmpfs).toContain(path.join(fakeHome, ".ssh"));
    } finally {
      process.env.HOME = previousHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("wrapShellCommand：Linux + bwrap 可用 → 包 bwrap；不可用 → 降级并给出安装命令", () => {
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write" });
    const ready = wrapShellCommand("echo hi", {
      workspace,
      shell: "/bin/bash",
      platform: "linux",
      bwrapReady: true,
    });
    expect(ready.cmd[0]).toBe("bwrap");
    expect(ready.cmd).toContain("/bin/bash");
    expect(ready.degradedReason).toBeUndefined();

    const missing = wrapShellCommand("echo hi", {
      workspace,
      shell: "/bin/bash",
      platform: "linux",
      bwrapReady: false,
      // 两个后端都要显式关掉才是"不可用"：只关 bwrap 时 landlockReady 会回落到本机探测，
      // 于是在有 gcc 的 Linux runner 上会真的包上 Landlock —— 断言又成了"只在 macOS 成立"。
      landlockReady: false,
    });
    expect(missing.cmd).toEqual(["/bin/bash", "-c", "echo hi"]);
    expect(missing.degradedReason).toContain("bubblewrap");
    expect(missing.degradedReason).toContain("apt install bubblewrap");

    // Windows 之类：明确"没有实现"，而不是含糊地说"不支持"。
    const unsupported = wrapShellCommand("echo hi", {
      workspace,
      shell: "/bin/bash",
      platform: "win32",
    });
    expect(unsupported.degradedReason).toContain("还没有沙箱实现");
  });

  test("拦截解释认得 bwrap 的报错（只读挂载 / bwrap 前缀）", () => {
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write" });
    expect(explainSandboxDenial("bash: /home/u/x.txt: Read-only file system")).toContain("沙箱");
    expect(explainSandboxDenial("bwrap: Can't create file at /tmp/x: Permission denied")).toContain("沙箱");
    // 裸的 Permission denied 不算（普通文件权限问题不该被说成"沙箱拦的"）。
    expect(explainSandboxDenial("cat: /etc/shadow: Permission denied")).toBeNull();
  });
});

/**
 * Landlock（Linux 5.13+）的规则生成。
 *
 * 真实拦不拦得住要 Linux 内核说了算（`landlock_*` 系统调用，纯 JS 发不了，
 * 得靠原生辅助程序）—— 那部分端到端留给 Linux runner。这里钉住的是**策略**：
 * 每个档位算出哪些路径可写、哪些位被"处理"、以及它表达不了什么。
 * 策略只有一份实现：将来辅助程序读同一份 JSON，口径不会两边漂移。
 */
describe("Linux（Landlock 规则生成）", () => {
  const modeOf = (ruleset: ReturnType<typeof landlockRuleset>) => ruleset.mode;
  const writeRule = (ruleset: ReturnType<typeof landlockRuleset>, target: string) =>
    ruleset.rules.find((rule) => rule.path === path.resolve(target));
  const WRITE_BITS: LandlockAccess[] = [
    "write_file",
    "remove_file",
    "remove_dir",
    "make_reg",
    "make_dir",
    "truncate",
  ];

  test("workspace-write：根目录只给读，可写目录单独给一组（Landlock 是叠加的允许集）", () => {
    const ruleset = landlockRuleset({ workspace, mode: "workspace-write" });
    expect(modeOf(ruleset)).toBe("workspace-write");

    const root = ruleset.rules[0]!;
    expect(root.path).toBe("/");
    expect(root.access).toContain("read_file");
    expect(root.access).toContain("execute");
    // 根目录上不能有任何写位 —— 有的话整个盘都可写，等于没沙箱。
    for (const bit of WRITE_BITS) expect(root.access).not.toContain(bit);

    const ws = writeRule(ruleset, workspace);
    expect(ws).toBeDefined();
    for (const bit of WRITE_BITS) expect(ws!.access).toContain(bit);
  });

  test("read-only：工作区不给写；临时目录仍可写（与 Seatbelt / bwrap 口径一致）", () => {
    const ruleset = landlockRuleset({ workspace, mode: "read-only" });
    expect(writeRule(ruleset, workspace)).toBeUndefined();
    // 工作区内的文件仍然可读（只读档不是"什么都看不到"）。
    expect(ruleset.rules[0]!.access).toContain("read_file");
    const tempWritable = sandboxTempRoots()
      .map((dir) => writeRule(ruleset, dir))
      .filter((rule) => rule !== undefined);
    expect(tempWritable.length).toBeGreaterThan(0);
  });

  test("已授权目录只在 workspace-write 档可写；重复路径只出现一次", () => {
    const extra = mkdtempSync(path.join(tmpdir(), "omni-ll-extra-"));
    try {
      const write = landlockRuleset({
        workspace,
        mode: "workspace-write",
        authorizedFolders: [extra, workspace],
      });
      expect(writeRule(write, extra)).toBeDefined();
      // 工作区同时出现在 workspace 与 authorizedFolders 里：规则只能有一条。
      const wsRules = write.rules.filter((rule) => rule.path === path.resolve(workspace));
      expect(wsRules.length).toBe(1);

      const readOnly = landlockRuleset({
        workspace,
        mode: "read-only",
        authorizedFolders: [extra],
      });
      expect(writeRule(readOnly, extra)).toBeUndefined();
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  test("handled 覆盖所有写位：Landlock 只处理你声明的权限，漏一位就是少拦一种", () => {
    for (const mode of ["workspace-write", "read-only"] as const) {
      const ruleset = landlockRuleset({ workspace, mode });
      for (const bit of WRITE_BITS) expect(ruleset.handled).toContain(bit);
      // 规则里给出的权限必须都被"处理"到，否则那条规则等于没生效。
      for (const rule of ruleset.rules) {
        for (const bit of rule.access) expect(ruleset.handled).toContain(bit);
      }
    }
  });

  test("设备例外：/dev/null 等必须可写（否则 `2>/dev/null` 会被拦），且不多给权限", () => {
    /**
     * 用 `existingOnly: () => true` 让设备规则**在所有平台都生成**。
     * 直接调 `landlockRuleset()` 时它看的是本机的路径存在性：macOS 上没有
     * `/dev/pts`、`/dev/shm`，于是规则不生成、下面的断言整段被跳过 —— 断言写错了也
     * 不会有人知道（这个用例原来就在 macOS 上"通过"、在 Linux 上直接挂）。
     * 规则生成是纯函数，"路径在不在"本来就该是注入进来的。
     */
    const ruleset = landlockRuleset({
      workspace,
      mode: "workspace-write",
      existingOnly: () => true,
    });
    const devNull = ruleset.rules.find((rule) => rule.path === "/dev/null");
    // 这条不是"可有可无"：Landlock 的 write_file 管到 /dev/null，不放行连重定向都失败
    // （Linux 端到端第一次跑就把这条踩出来了）。
    expect(devNull).toBeDefined();
    expect(devNull!.access).toContain("write_file");
    expect(devNull!.access).toContain("read_file");
    // 设备文件不需要造/删：多给的每一位都是过宽。
    expect(devNull!.access).not.toContain("remove_file");
    expect(devNull!.access).not.toContain("make_char");

    /**
     * pty 与共享内存是目录，给完整的可写集（pty slave / 共享内存文件都要能建）。
     *
     * 这里**不断言 make_char**，虽然 pty 分配在概念上要它：
     * `make_char` 不在 `handled` 里，而 Landlock 只管辖声明过的权限 —— 没声明就是全机放行，
     * 所以 `mknod` 本来就不受拦。反过来，把 make_char 写进规则才是错的：Landlock 要求
     * `rule.allowed_access ⊆ handled`，写了直接 EINVAL（辅助程序会拒掉整份规格）。
     * 真正要钉的是"规则里的每一位都在 handled 里"—— 同一口径也见上面那条用例。
     */
    const pts = ruleset.rules.find((rule) => rule.path === "/dev/pts");
    const shm = ruleset.rules.find((rule) => rule.path === "/dev/shm");
    for (const rule of [pts, shm]) {
      expect(rule).toBeDefined();
      expect(rule!.access).toContain("make_reg");
      expect(rule!.access).toContain("write_file");
      for (const bit of rule!.access) expect(ruleset.handled).toContain(bit);
    }
    // 设备节点本身（mknod）不在 Landlock 的管辖范围里：没声明就没人拦它。
    expect(ruleset.handled).not.toContain("make_char");
    // 设备规则只在路径真的存在时出现（Landlock 对不存在路径加规则会 ENOENT）。
    const missing = landlockRuleset({
      workspace,
      mode: "workspace-write",
      existingOnly: () => false,
    });
    expect(missing.rules.some((rule) => rule.path === "/dev/null")).toBe(false);
  });

  test("不存在的路径不生成规则（Landlock 对不存在路径加规则会 ENOENT）", () => {
    const ruleset = landlockRuleset({
      workspace,
      mode: "workspace-write",
      existingOnly: (target) => target === path.resolve(workspace),
    });
    expect(ruleset.rules.some((rule) => rule.path === path.resolve(workspace))).toBe(true);
    expect(ruleset.rules.some((rule) => rule.path === path.resolve(tmpdir()))).toBe(false);
  });

  test("联网开关 → network 字段与如实的能力提示（老内核没有 net 规则）", () => {
    expect(landlockRuleset({ workspace, allowNetwork: true }).network).toBe("allowed");
    const offline = landlockRuleset({ workspace, allowNetwork: false });
    expect(offline.network).toBe("denied");
    expect(offline.unsupported.join(" ")).toContain("net");
  });

  test("如实说明表达不了的部分：Landlock 是只允许模型，挖不掉凭据目录", () => {
    const ruleset = landlockRuleset({ workspace, mode: "workspace-write" });
    expect(ruleset.unsupported.join(" ")).toContain("只允许");
    // 凭据目录不会以"拒绝"的形式出现在规则里 —— 那是 bwrap/Seatbelt 的机制，
    // 写进规则只会是"允许"，宁可明说做不到。
    const creds = sandboxCredentialPaths();
    for (const credential of creds) {
      expect(ruleset.rules.some((rule) => rule.path === credential)).toBe(false);
    }
  });

  test("凭据清单里的本应用数据目录是**真实路径**（写死名字等于什么都没拦）", () => {
    // 真实路径是 `<appData>/omni-studio.kunpengtalk.com/<频道>`（见 paths.ts）。
    // 曾经这里写死成 `Library/Application Support/omni-studio`，于是条目的意图
    // （"设置表里存着全部云端 API Key，读也拒"）完全落空 —— 名字对不上就永远匹配不到。
    const creds = sandboxCredentialPaths();
    const dataDir = getDataDir();
    expect(creds).toContain(dataDir);
    // 标识目录也拒：dev / canary / 正式频道各有一份数据，通向任意一份都等于拿到密钥。
    // 只在它确实长得像我们的标识目录时才加 —— 测试环境的数据目录是临时目录，
    // 不加这层判断会把整个 /tmp 拦掉。
    const identifierDir = path.dirname(dataDir);
    if (path.basename(identifierDir).startsWith("omni-studio")) {
      expect(creds).toContain(identifierDir);
    }
    // 不能再有那个匹配不到任何东西的占位条目。
    expect(creds.some((p) => p.endsWith(path.join("Application Support", "omni-studio")))).toBe(false);
  });

  test("规格 JSON：同一档位序列化完全一致，路径排序，版本可演进", () => {
    const opts = { workspace, mode: "workspace-write" as const };
    const first = landlockRulesetSpec(opts);
    const second = landlockRulesetSpec(opts);
    expect(first).toBe(second);

    const parsed = JSON.parse(first) as { version: number; rules: { path: string }[] };
    expect(parsed.version).toBe(1);
    const paths = parsed.rules.map((rule) => rule.path);
    expect([...paths].sort()).toEqual(paths);
  });

  test("状态如实反映本机情况：非 Linux 明说不可用，Linux 才去编译与探测", () => {
    const status = landlockStatus();
    expect(status.policyReady).toBe(true);
    if (process.platform === "linux") {
      // Linux：helperAvailable 是**真探测**（编译 + 内核 ABI）；不可用时必须给得出理由。
      expect(status.helperAvailable === true ? status.abi! >= 1 : status.reason).toBeTruthy();
    } else {
      expect(status.helperAvailable).toBe(false);
      expect(status.abi).toBeNull();
      expect(status.reason).toContain("Linux");
    }
    expect(sandboxStatus().landlock).toEqual(status);
  });

  test("Landlock 的前置条件：禁网与文件系统不兼容都要如实拦下，别硬上", () => {
    if (process.platform !== "linux") {
      // 非 Linux：第一条就说清楚"只在 Linux 上可用"，不折腾编译。
      expect(landlockUnavailableReason(workspace, true) ?? "").toContain("Linux");
      return;
    }
    if (!landlockHelperAvailable()) {
      // 没编译器（或内核不支持）：理由里要说清是辅助程序不可用，而不是含糊的"不支持"。
      expect(landlockUnavailableReason(workspace, true) ?? "").toContain("辅助程序");
      return;
    }
    // 禁网：内核 net 规则没实现 → 明确拒绝（否则等于假装禁网生效了）。
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write", AGENT_SANDBOX_NETWORK: "0" });
    expect(landlockUnavailableReason(workspace, true) ?? "").toContain("禁网");
    updateSettings({ AGENT_SANDBOX_NETWORK: "1" });
    // canary 没过（FUSE / 网络盘上规则整片落空）：理由是文件系统，不是"内核不支持"。
    expect(landlockUnavailableReason(workspace, false) ?? "").toContain("文件系统");
    // 都满足 → 没有理由拦它。
    expect(landlockUnavailableReason(workspace, true)).toBeNull();
  });

  test("后端偏好：默认 auto（bwrap 优先、Landlock 兜底），可显式指定", () => {
    expect(effectiveSandboxBackend("darwin")).toBe("seatbelt");
    expect(effectiveSandboxBackend("win32")).toBe("none");
    // auto：bwrap 能用就用 bwrap；不能用才落到 Landlock。
    expect(effectiveSandboxBackend("linux", { bwrapReady: true, landlockReady: true })).toBe("bwrap");
    expect(effectiveSandboxBackend("linux", { bwrapReady: false, landlockReady: true })).toBe("landlock");
    // 都没有：仍报首选后端（bwrap），由 supported=false + 降级说明交代，不静默换后端。
    expect(effectiveSandboxBackend("linux", { bwrapReady: false, landlockReady: false })).toBe("bwrap");
    // 显式偏好：想用 Landlock 就用，但它不可用时也不会假装。
    expect(effectiveSandboxBackend("linux", { bwrapReady: true, landlockReady: true, prefer: "landlock" })).toBe(
      "landlock",
    );
    expect(effectiveSandboxBackend("linux", { bwrapReady: true, landlockReady: false, prefer: "landlock" })).toBe(
      "bwrap",
    );
    expect(effectiveSandboxBackend("linux", { bwrapReady: true, prefer: "bwrap" })).toBe("bwrap");
  });
});

describe("端到端（真实 Seatbelt）", () => {
  test("工作区内可写，工作区外不可写", async () => {
    if (!onMac) return;
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write" });
    const tools = buildAgentTools({ workspace, allowShell: true });
    const bash = tools.find((tool) => tool.name === "bash")!;

    const inside = await bash.execute("s1", { command: "echo inside-ok > note.txt && cat note.txt" });
    expect(JSON.stringify(inside)).toContain("inside-ok");

    // 注意：临时目录（/var/folders）本身是允许写的，要拿真正的工作区外路径来试。
    const escapeTarget = path.join(process.env.HOME ?? "/tmp", `omni-escape-${Date.now()}.txt`);
    const outside = await bash.execute("s2", { command: `echo nope > ${escapeTarget}` });
    expect(JSON.stringify(outside)).toContain("沙箱");
    expect(existsSync(escapeTarget)).toBe(false);
  });

  test("凭据目录读也被拒（工具层黑名单覆盖不到 bash）", async () => {
    if (!onMac) return;
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write" });
    // 用假的 HOME 造一份"凭据"：沙箱策略按 HOME 推导凭据路径，读也拒。
    const fakeHome = mkdtempSync(path.join(tmpdir(), "omni-fake-home-"));
    mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".ssh", "id_rsa"), "SECRET-MARKER\n");
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const tools = buildAgentTools({ workspace, allowShell: true });
      const bash = tools.find((tool) => tool.name === "bash")!;
      const blocked = await bash.execute("s3", { command: `cat ${fakeHome}/.ssh/id_rsa` });
      expect(JSON.stringify(blocked)).toContain("沙箱");
      expect(JSON.stringify(blocked)).not.toContain("SECRET-MARKER");
    } finally {
      process.env.HOME = previousHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("read-only：工作区也写不了、临时目录可以写、读照常", async () => {
    if (!onMac) return;
    /**
     * 这里的工作区**必须放在用户目录下**，不能放 TMPDIR：临时目录正是 read-only
     * 唯一放行写入的地方（测试运行器 / 编译器都要写 TMPDIR），建在那里测不出区别
     * —— 这个坑第一次写的时候就踩到了。
     */
    const roWorkspace = mkdtempSync(path.join(homedir(), ".omni-readonly-ws-"));
    updateSettings({ AGENT_SANDBOX_MODE: "read-only", AGENT_AUTHORIZED_FOLDERS: "[]" });
    try {
      const tools = buildAgentTools({ workspace: roWorkspace, allowShell: true });
      const bash = tools.find((tool) => tool.name === "bash")!;

      // 读照常
      writeFileSync(path.join(roWorkspace, "read-me.txt"), "原样内容\n");
      const read = await bash.execute("ro1", { command: "cat read-me.txt" });
      expect(JSON.stringify(read)).toContain("原样内容");

      // 工作区写入被内核拦下（workspace-write 下这正是允许的 —— 两档的差别就在这）
      const write = await bash.execute("ro2", { command: "echo changed > read-me.txt" });
      expect(JSON.stringify(write)).toContain("沙箱");
      expect(readFileSyncText(path.join(roWorkspace, "read-me.txt"))).toBe("原样内容\n");

      // 用户目录下的其它位置同样写不了
      const outside = path.join(homedir(), `omni-readonly-escape-${Date.now()}.txt`);
      const escape = await bash.execute("ro3", { command: `echo nope > ${outside}` });
      expect(JSON.stringify(escape)).toContain("沙箱");
      expect(existsSync(outside)).toBe(false);

      // 临时目录例外：工具链要写 TMPDIR
      const tmpTarget = path.join(tmpdir(), `omni-readonly-${Date.now()}.txt`);
      const tmpWrite = await bash.execute("ro4", { command: `echo scratch > ${tmpTarget} && cat ${tmpTarget}` });
      expect(JSON.stringify(tmpWrite)).toContain("scratch");
      rmSync(tmpTarget, { force: true });

      // 已授权目录在只读模式下也不放行（策略里根本没有它们）
      const authorized = path.join(homedir(), `.omni-readonly-auth-${Date.now()}`);
      mkdirSync(authorized, { recursive: true });
      try {
        updateSettings({ AGENT_AUTHORIZED_FOLDERS: JSON.stringify([authorized]) });
        const denied = await bash.execute("ro5", { command: `echo nope > ${path.join(authorized, "x.txt")}` });
        expect(JSON.stringify(denied)).toContain("沙箱");
        expect(existsSync(path.join(authorized, "x.txt"))).toBe(false);
      } finally {
        updateSettings({ AGENT_AUTHORIZED_FOLDERS: "[]" });
        rmSync(authorized, { recursive: true, force: true });
      }
    } finally {
      rmSync(roWorkspace, { recursive: true, force: true });
    }
  });

  test("沙箱升级：被拦后按次申请，允许则跳过沙箱重跑一次", async () => {
    if (!onMac) return;
    // 工作区放在用户目录下：TMPDIR 在 read-only 下本来就可写，测不出"被拦"。
    const roWorkspace = mkdtempSync(path.join(homedir(), ".omni-escalate-ws-"));
    updateSettings({ AGENT_SANDBOX_MODE: "read-only", AGENT_AUTHORIZED_FOLDERS: "[]" });
    try {
      const asked: { command: string; output: string }[] = [];
      const tools = buildAgentTools({
        workspace: roWorkspace,
        allowShell: true,
        escalateSandbox: async (input) => {
          asked.push(input);
          return null; // 用户点了「跳过沙箱重试」
        },
      });
      const bash = tools.find((tool) => tool.name === "bash")!;
      const result = await bash.execute("esc-allow", { command: "echo escalated > out.txt && cat out.txt" });

      expect(asked).toHaveLength(1);
      expect(asked[0]!.command).toContain("out.txt");
      expect(asked[0]!.output).toMatch(/not permitted/i);
      const text = JSON.stringify(result);
      expect(text).toContain("跳过沙箱重试");
      expect(text).toContain("escalated");
      // 重试是"没沙箱"的那次真的落了盘
      expect(readFileSyncText(path.join(roWorkspace, "out.txt")).trim()).toBe("escalated");
    } finally {
      rmSync(roWorkspace, { recursive: true, force: true });
    }
  });

  test("沙箱升级：拒绝时不重跑，把拒绝原因一并交给模型", async () => {
    if (!onMac) return;
    const roWorkspace = mkdtempSync(path.join(homedir(), ".omni-escalate-deny-"));
    updateSettings({ AGENT_SANDBOX_MODE: "read-only", AGENT_AUTHORIZED_FOLDERS: "[]" });
    try {
      const tools = buildAgentTools({
        workspace: roWorkspace,
        allowShell: true,
        escalateSandbox: async () => "已按当前权限策略拒绝：跳过命令沙箱（sandbox_escalation）",
      });
      const bash = tools.find((tool) => tool.name === "bash")!;
      const result = await bash.execute("esc-deny", { command: "echo nope > out.txt" });
      const text = JSON.stringify(result);
      expect(text).toContain("沙箱");
      expect(text).toContain("跳过沙箱重试被拒绝");
      expect(existsSync(path.join(roWorkspace, "out.txt"))).toBe(false);
    } finally {
      rmSync(roWorkspace, { recursive: true, force: true });
    }
  });

  test("普通命令失败（不是沙箱拦的）不会触发升级询问", async () => {
    if (!onMac) return;
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write" });
    let asked = 0;
    const tools = buildAgentTools({
      workspace,
      allowShell: true,
      escalateSandbox: async () => {
        asked += 1;
        return null;
      },
    });
    const bash = tools.find((tool) => tool.name === "bash")!;
    const result = await bash.execute("esc-plain", { command: "exit 3" });
    expect(asked).toBe(0);
    expect(JSON.stringify(result)).toContain("[exit 3]");
  });

  test("无人值守（没注入升级回调）时如实报告被拦，不重跑", async () => {
    if (!onMac) return;
    const roWorkspace = mkdtempSync(path.join(homedir(), ".omni-escalate-headless-"));
    updateSettings({ AGENT_SANDBOX_MODE: "read-only", AGENT_AUTHORIZED_FOLDERS: "[]" });
    try {
      const tools = buildAgentTools({ workspace: roWorkspace, allowShell: true });
      const bash = tools.find((tool) => tool.name === "bash")!;
      const result = await bash.execute("esc-headless", { command: "echo nope > out.txt" });
      expect(JSON.stringify(result)).toContain("沙箱");
      expect(existsSync(path.join(roWorkspace, "out.txt"))).toBe(false);
    } finally {
      rmSync(roWorkspace, { recursive: true, force: true });
    }
  });

  test("关掉沙箱后同一命令能写出去（确认拦截确实来自沙箱）", async () => {
    if (!onMac) return;
    updateSettings({ AGENT_SANDBOX_MODE: "off" });
    const tools = buildAgentTools({ workspace, allowShell: true });
    const bash = tools.find((tool) => tool.name === "bash")!;
    const target = path.join(tmpdir(), `omni-unsandboxed-${Date.now()}.txt`);
    const result = await bash.execute("s5", { command: `echo ok > ${target}` });
    expect(JSON.stringify(result)).toContain("[exit 0]");
    rmSync(target, { force: true });
  });
});
