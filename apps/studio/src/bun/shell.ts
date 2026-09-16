/**
 * 平台化的 shell 解析 —— 全应用只此一处决定「用哪个 shell 跑命令」。
 *
 * 起因（issue #15）：agent 的 bash 工具、集成终端、hooks、通知曾各自写
 * `process.env.SHELL || "/bin/zsh"` 这类兜底。macOS / Linux 上没问题，但 Windows 上
 * SHELL 通常为空、也没有 /bin/zsh，于是 spawn 直接 `uv_spawn '/bin/zsh' ENOENT`：
 * agent 一条命令都跑不了，集成终端起不来，而报错还把人引向「去装 MSYS2 / Git Bash」。
 *
 * 解析顺序（每一档都要求那个文件真的存在，拿不到就往下退）：
 *   POSIX：$SHELL → /bin/zsh（macOS）/ /bin/bash → /bin/sh
 *   Windows：$SHELL（Git Bash 里会设）→ Git Bash 的 bash.exe（装了优先用它，因为模型
 *            给的命令基本都是 Unix 风格）→ pwsh.exe → powershell.exe → %COMSPEC%
 *            （cmd.exe，Windows 上必然存在 —— 最后一档不会再 ENOENT）
 */
import { existsSync } from "node:fs";

export type CommandShell = {
  /** 可执行文件：绝对路径，或 PATH 上的名字（cmd.exe 兜底时）。 */
  file: string;
  /** 把一条命令包成**完整 argv**（含可执行文件本身）：POSIX 是 `[shell, "-c", cmd]`，
   *  cmd 是 `[cmd.exe, "/d", "/s", "/c", cmd]`，PowerShell 是 `[pwsh, "-NoProfile", "-Command", cmd]`。 */
  commandArgs: (command: string) => string[];
  /** 交互式启动参数（集成终端）：zsh / bash 走登录 shell，PowerShell 静音横幅，cmd 不加。 */
  interactiveArgs: string[];
  /** 是不是 POSIX 形状的 shell —— `"$1"` 这类位置参数约定只在它上面成立。 */
  posix: boolean;
  /** 给提示词 / 界面看的人类可读名字。 */
  label: string;
};

type Env = Record<string, string | undefined>;

const basenameOf = (file: string): string => file.split(/[\\/]/).pop() || file;

/** 按可执行文件名字挑参数风格 —— 名字是唯一可靠的判据（路径可能是任意安装位置）。 */
function shellFor(file: string): CommandShell {
  const label = basenameOf(file);
  // Windows 上是 bash.exe / cmd.exe / pwsh.exe：判据要剥掉 .exe 再看
  const name = label.toLowerCase().replace(/\.exe$/, "");
  if (name === "cmd") {
    return {
      file,
      commandArgs: (command) => [file, "/d", "/s", "/c", command],
      interactiveArgs: [],
      posix: false,
      label,
    };
  }
  if (name.startsWith("pwsh") || name.startsWith("powershell")) {
    return {
      file,
      commandArgs: (command) => [file, "-NoProfile", "-Command", command],
      interactiveArgs: ["-NoLogo"],
      posix: false,
      label,
    };
  }
  return {
    file,
    commandArgs: (command) => [file, "-c", command],
    interactiveArgs: name === "zsh" || name === "bash" ? ["-l"] : [],
    posix: true,
    label,
  };
}

/** Windows 上常见的 Git Bash 安装位置（`/bin/bash` 的实际提供者）。 */
function gitBashCandidates(env: Env): string[] {
  const from = (base: string | undefined, ...rest: string[]) =>
    base ? [base.replace(/[\\/]+$/, ""), ...rest].join("\\") : null;
  return [
    from(env.ProgramFiles, "Git", "bin", "bash.exe"),
    from(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    from(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].filter((candidate): candidate is string => candidate !== null);
}

export function resolveCommandShell(
  env: Env = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
  which: (name: string) => string | null = (name) => Bun.which(name),
): CommandShell {
  // 用户显式设了 SHELL 就听他的 —— 但要求它真的存在，否则往下退（SHELL 指向已卸载的
  // shell 是常见状态：换过系统、卸过 Homebrew 都会留下这种残值）。
  const explicit = env.SHELL?.trim();
  if (explicit && exists(explicit)) return shellFor(explicit);

  if (platform === "win32") {
    for (const candidate of gitBashCandidates(env)) {
      if (exists(candidate)) return shellFor(candidate);
    }
    for (const name of ["pwsh.exe", "powershell.exe"]) {
      const found = which(name);
      if (found) return shellFor(found);
    }
    const comspec = env.COMSPEC?.trim();
    if (comspec && exists(comspec)) return shellFor(comspec);
    // 最后一档：cmd.exe 在 Windows 上必然可执行，绝不再退回 Unix 路径。
    return shellFor("cmd.exe");
  }

  const fallbacks = platform === "darwin" ? ["/bin/zsh", "/bin/bash", "/bin/sh"] : ["/bin/bash", "/bin/sh"];
  for (const candidate of fallbacks) {
    if (exists(candidate)) return shellFor(candidate);
  }
  return shellFor("sh");
}
