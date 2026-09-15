/**
 * Landlock 端到端：**真拦住**工作区外的写入。
 *
 * 为什么单独一个脚本而不是单测：这件事只有在 Linux（内核 ≥5.13）上、且本机能编译
 * 那个 C 辅助程序时才成立 —— 在 macOS 上写再多断言也只是"看起来对"。所以：
 * - 平台/内核/编译器任一不具备 → 如实跳过（打印原因），CI 用 `--require` 把跳过变成失败；
 * - 具备 → 编辅助程序，走 `wrapShellCommand()` 这条**真实代码路径**，看内核到底拦不拦。
 *
 * 跑法（CI 的 linux 作业与本地 Linux 容器都用这一条）：
 *   bun run scripts/landlock-e2e.ts
 *   bun run scripts/landlock-e2e.ts --require
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";

const requireLandlock = process.argv.includes("--require");

// 数据目录先摆好：下面动态 import 的模块会用它建设置库（不能碰真实数据目录）。
const dataDir = mkdtempSync(path.join(tmpdir(), "omni-landlock-e2e-data-"));
process.env.OMNI_DATA_DIR = dataDir;

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
};

const skip: (reason: string) => never = (reason) => {
  console.log(`\n跳过：${reason}`);
  if (requireLandlock) {
    console.error("（--require：跳过按失败处理）");
    process.exit(1);
  }
  process.exit(0);
};

if (process.platform !== "linux") {
  skip(`Landlock 只在 Linux 上存在（当前 ${process.platform}）`);
}

const { updateSettings } = await import("../src/bun/db/settings");
const Sandbox = await import("../src/bun/agent-sandbox");
const helper = await import("../src/bun/landlock-helper");

const built = helper.buildLandlockHelper();
if (!built.ok) skip(`Landlock 辅助程序不可用：${built.reason}`);
console.log(`辅助程序：${built.path}（内核 ABI ${built.abi}）`);

/** 跑一条被沙箱包起来的命令（走真实路径 wrapShellCommand）。 */
const runWrapped = (command: string, workspace: string) => {
  const wrapped = Sandbox.wrapShellCommand(command, {
    workspace,
    shell: "/bin/sh",
    platform: "linux",
  });
  if (wrapped.degradedReason) return { degraded: wrapped.degradedReason, code: -1, output: "" };
  const proc = Bun.spawnSync({ cmd: wrapped.cmd, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const output = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
  return { degraded: null, code: proc.exitCode ?? -1, output, backend: wrapped.cmd[0] };
};

// 工作区放在用户目录下（不是 TMPDIR）—— 临时目录在所有档位里都可写，
// 放那儿的话"工作区被禁写"根本测不出来。
const workspace = mkdtempSync(path.join(homedir(), ".omni-landlock-e2e-"));
const outside = path.join(homedir(), `.omni-landlock-outside-${process.pid}.txt`);
const inside = path.join(workspace, "inside.txt");
const tempTarget = path.join(tmpdir(), `omni-landlock-temp-${process.pid}.txt`);

/**
 * FUSE **数据**文件系统的 fstype。
 *
 * 必须显式排除 `fusectl`：它是 FUSE 的**控制接口**（挂在 `/sys/fs/fuse/connections`），
 * 不是能在上面放工作区的数据文件系统，而它的 fstype 恰好以 `fuse` 开头 ——
 * 照字面用 `/^fuse/` 匹配（原来的写法）会在 CI runner 上把它当成"不兼容样本"，
 * 接着断言"canary 在这里必须失败"，而实际上读取 `/sys` 本来就被规则允许（根目录给了
 * read_dir / read_file），canary 必然通过 —— 于是一个假样本制造出两条永远红的用例。
 * `fuseblk`（NTFS-3G 之类）是真数据文件系统，要留住。
 */
const FUSE_DATA_FSTYPE = /^(fuse(?!ctl)|fuse\.[a-z0-9_.-]+|fakeowner)$/i;

/**
 * 本机有没有 FUSE 类挂载（canary 的已知不兼容样本）。
 * 从 /proc/self/mountinfo 里找：Docker Desktop 的共享目录是 `fakeowner`，
 * 其它 FUSE 实现是 `fuse` / `fuse.<name>` / `fuseblk`。
 */
function findIncompatibleMount(): string | null {
  try {
    const lines = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
    for (const line of lines) {
      const parts = line.split(" - ");
      const left = parts[0];
      const right = parts[1];
      if (!left || !right) continue;
      const fstype = right.split(" ")[0] ?? "";
      if (!FUSE_DATA_FSTYPE.test(fstype)) continue;
      // mountinfo 的第 5 个字段是挂载点（已按 \040 转义空格）。
      const mountPoint = left.split(" ")[4]?.replace(/\\040/g, " ");
      if (mountPoint && existsSync(mountPoint)) return mountPoint;
    }
  } catch {
    /* 读不到就当作"没有样本"，跳过这一条 */
  }
  return null;
}

const cleanup = () => {
  for (const target of [workspace, outside, tempTarget]) {
    rmSync(target, { recursive: true, force: true });
  }
  rmSync(dataDir, { recursive: true, force: true });
};

try {
  mkdirSync(workspace, { recursive: true });
  updateSettings({
    AGENT_SANDBOX_MODE: "workspace-write",
    AGENT_SANDBOX_BACKEND: "landlock",
    AGENT_SANDBOX_NETWORK: "1",
    AGENT_AUTHORIZED_FOLDERS: "[]",
  });

  const status = Sandbox.sandboxStatus();
  check(
    "后端选择：偏好 landlock 时真的走 Landlock（不是悄悄用别的）",
    status.backend === "landlock" && status.landlock.helperAvailable === true,
    `backend=${status.backend} abi=${status.landlock.abi}`,
  );

  // 1) 工作区内可写
  const okWrite = runWrapped(`echo inside > ${inside}`, workspace);
  check(
    "工作区内可写",
    okWrite.code === 0 && existsSync(inside),
    `exit=${okWrite.code} output=${okWrite.output.trim().slice(0, 120)}`,
  );

  // 2) 工作区外不可写 —— 这是整件事的核心
  const deniedWrite = runWrapped(`echo escape > ${outside}`, workspace);
  check(
    "工作区外不可写（内核拒绝）",
    deniedWrite.code !== 0 && !existsSync(outside),
    `exit=${deniedWrite.code} output=${deniedWrite.output.trim().slice(0, 120)}`,
  );

  // 3) 拦截能被上层认出来（否则模型只会一遍遍重试同一件事）
  check(
    "拦截能被识别成沙箱行为（bash 工具据此提示 / 触发升级询问）",
    Sandbox.explainSandboxDenial(deniedWrite.output, { backend: "landlock" }) !== null,
  );

  // 4) 临时目录仍可写（与 Seatbelt / bwrap 口径一致：测试运行器要写 TMPDIR）
  const tempWrite = runWrapped(`echo t > ${tempTarget}`, workspace);
  check("临时目录仍可写", tempWrite.code === 0 && existsSync(tempTarget), `exit=${tempWrite.code}`);

  // 5) /dev/null 可写：Landlock 的 write_file 管到设备文件，不放行的话
  //    `cmd 2>/dev/null` 这种满地都是的写法会全线失败（第一次跑 e2e 就踩到了）。
  const devNull = runWrapped("echo hi 2>/dev/null && echo hi > /dev/null", workspace);
  check(
    "/dev/null 可写（`2>/dev/null` 不会被拦）",
    devNull.code === 0,
    `exit=${devNull.code} output=${devNull.output.trim().slice(0, 120)}`,
  );

  // 6) 读照旧放行 —— Landlock 规则只能"允许"，这一点必须如实记录，别号称也拦了读。
  //    读的是容器/宿主自己的根文件系统上的文件（与工作区同一条挂载链），
  //    跨挂载的情况见下面 canary 那一条。
  const outsideReadable = path.join(tmpdir(), `omni-landlock-readable-${process.pid}.txt`);
  Bun.write(outsideReadable, "readable\n");
  const readOutside = runWrapped(
    `cat ${outsideReadable} > ${path.join(workspace, "read-copy.txt")}`,
    workspace,
  );
  check(
    "读照旧放行（Landlock 只能声明允许，挡不住读；凭据目录要靠 bwrap）",
    readOutside.code === 0 &&
      existsSync(path.join(workspace, "read-copy.txt")) &&
      readFileSync(path.join(workspace, "read-copy.txt"), "utf8").includes("readable"),
    `exit=${readOutside.code} output=${readOutside.output.trim().slice(0, 120)}`,
  );
  rmSync(outsideReadable, { force: true });

  // 7) read-only 档：工作区也不可写
  updateSettings({ AGENT_SANDBOX_MODE: "read-only" });
  const roWrite = runWrapped(`echo changed > ${inside}`, workspace);
  check(
    "read-only 档：工作区也写不了",
    roWrite.code !== 0,
    `exit=${roWrite.code} output=${roWrite.output.trim().slice(0, 120)}`,
  );

  // 8) 对照组：关掉沙箱后同一命令能写出去 —— 证明拒绝来自沙箱而不是目录权限
  updateSettings({ AGENT_SANDBOX_MODE: "off" });
  const unsandboxed = runWrapped(`echo escape > ${outside}`, workspace);
  check(
    "关掉沙箱后能写出去（确认拦截来自沙箱）",
    unsandboxed.code === 0 && existsSync(outside),
    `exit=${unsandboxed.code}`,
  );

  // 9) canary：规则在"这个文件系统"上真的生效吗？
  //    FUSE 类挂载（Docker Desktop 的共享目录、部分网络盘）上 Landlock 的 inode 匹配
  //    会整片落空 —— 不检测的话用户看到的是"每条命令都 Permission denied"。
  const incompatible = findIncompatibleMount();
  if (incompatible) {
    const probe = helper.probeLandlockWorkspace(incompatible, { refresh: true });
    check(
      `canary 能识别不兼容的文件系统（本机样本：${incompatible}）`,
      probe.ok === false,
      probe.reason ? probe.reason.slice(0, 140) : "canary 竟然通过了",
    );
  } else {
    console.log(`· 本机没有 FUSE 类挂载样本，跳过 canary 不兼容性检查`);
  }

  // 9b) canary 的**确定性**版本：上面那条依赖宿主机恰好有 FUSE 挂载（CI runner 上没有），
  //     于是"canary 说不兼容时会拒绝硬上"这条路在 CI 里从来没被走过。
  //     指向一个不存在的目录必然让 exec 前的 canary 打开失败 —— 与 FUSE 那条走的是
  //     同一个分支，差别只是原因（ENOENT 而不是规则落空），不依赖任何环境。
  {
    const gone = path.join(workspace, "does-not-exist");
    const probe = helper.probeLandlockWorkspace(gone, { refresh: true });
    check(
      "canary 打不开目标时如实拒绝（不兼容文件系统那条分支的确定性版本）",
      probe.ok === false && (probe.reason ?? "").includes("canary"),
      probe.ok ? "竟然通过了 —— 打不开的路径不该被当成可用工作区" : (probe.reason ?? "").slice(0, 140),
    );
  }

  // 10) 禁网：Landlock 的 net 规则没实现 → 必须让位/如实降级，不能装作拦住了。
  //     注意把档位摆回 workspace-write：上一块为了做对照把它关掉了（每块自洽）。
  updateSettings({ AGENT_SANDBOX_MODE: "workspace-write", AGENT_SANDBOX_NETWORK: "0" });
  const offline = Sandbox.wrapShellCommand("echo hi", {
    workspace,
    shell: "/bin/sh",
    platform: "linux",
  });
  const offlineReason = offline.degradedReason ?? "";
  check(
    "关掉联网开关时不让 Landlock 硬上（明说禁网没实现，而不是假装拦住了）",
    offline.cmd[0] !== built.path && offlineReason.includes("禁网"),
    offline.cmd[0] === built.path
      ? "仍然用了 Landlock —— 等于假装禁网生效了"
      : `包成了 ${offline.cmd[0]}｜原因：${offlineReason.slice(0, 100)}`,
  );
  updateSettings({ AGENT_SANDBOX_NETWORK: "1" });

  // 11) 工作区落在不兼容的文件系统上（共享目录 / FUSE）：不能让 Landlock 硬上 ——
  //     那种环境里规则整片落空，用户会看到"每条命令都 Permission denied"。
  if (incompatible) {
    updateSettings({ AGENT_SANDBOX_MODE: "workspace-write", AGENT_SANDBOX_NETWORK: "1" });
    const onFuse = Sandbox.wrapShellCommand("echo hi", {
      workspace: incompatible,
      shell: "/bin/sh",
      platform: "linux",
    });
    const reason = onFuse.degradedReason ?? "";
    check(
      `工作区在不兼容文件系统上时不硬上（样本：${incompatible}）`,
      onFuse.backend !== "landlock" && (onFuse.backend === "bwrap" || reason.includes("文件系统")),
      `backend=${onFuse.backend} 原因：${reason.slice(0, 120)}`,
    );
  }

  // 12) 辅助程序对坏规格的处理：宁可什么都不跑，也不能"看不懂规则就放行"
  const badSpec = Bun.spawnSync({
    cmd: [built.path, "--spec", '{"handled":[],"rules":[]}', "--", "/bin/sh", "-c", `echo x > ${outside}`],
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  rmSync(outside, { force: true });
  writeFileSync(outside, "");
  const badSpecDenied = (badSpec.exitCode ?? -1) !== 0 && Bun.file(outside).size === 0;
  check(
    "坏规格被拒（退出码非 0，命令的副作用没发生）",
    badSpecDenied,
    `exit=${badSpec.exitCode} stderr=${badSpec.stderr?.toString().trim().slice(0, 120)}`,
  );
} finally {
  updateSettings({ AGENT_SANDBOX_MODE: "off", AGENT_SANDBOX_BACKEND: "auto" });
  cleanup();
}

const failed = checks.filter((item) => !item.ok);
console.log(
  `\nLandlock 端到端：${checks.length - failed.length}/${checks.length} 通过` +
    (failed.length ? `，失败：${failed.map((item) => item.name).join(" / ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
