import { describe, expect, test } from "bun:test";

import { resolveCommandShell } from "./shell";

/**
 * issue #15：Windows 上没有 /bin/zsh，而 bash 工具 / 终端 / hooks 各自把它当兜底，
 * 于是 `uv_spawn '/bin/zsh' ENOENT`。这里的用例把「什么平台解析成什么」钉住。
 */
const existsOnly = (...paths: string[]) => (path: string) => paths.includes(path);
const noSuch = () => null;

describe("resolveCommandShell", () => {
  test("macOS：优先 $SHELL，其次 /bin/zsh", () => {
    const explicit = resolveCommandShell({ SHELL: "/opt/homebrew/bin/fish" }, "darwin", existsOnly("/opt/homebrew/bin/fish"));
    expect(explicit.file).toBe("/opt/homebrew/bin/fish");
    expect(explicit.commandArgs("echo hi")).toEqual(["/opt/homebrew/bin/fish", "-c", "echo hi"]);

    const fallback = resolveCommandShell({}, "darwin", existsOnly("/bin/zsh", "/bin/bash", "/bin/sh"));
    expect(fallback.file).toBe("/bin/zsh");
    expect(fallback.interactiveArgs).toEqual(["-l"]);
  });

  test("$SHELL 指向不存在的文件时往下退（卸过 brew / 换过系统的残值）", () => {
    const shell = resolveCommandShell({ SHELL: "/opt/homebrew/bin/gone" }, "darwin", existsOnly("/bin/zsh"));
    expect(shell.file).toBe("/bin/zsh");
  });

  test("Linux：$SHELL → /bin/bash", () => {
    expect(resolveCommandShell({}, "linux", existsOnly("/bin/bash", "/bin/sh")).file).toBe("/bin/bash");
  });

  test("Windows + 有 Git Bash：优先用它，参数仍是 -c（模型给的命令基本是 Unix 风格）", () => {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const shell = resolveCommandShell(
      { ProgramFiles: "C:\\Program Files" },
      "win32",
      existsOnly(gitBash),
      noSuch,
    );
    expect(shell.file).toBe(gitBash);
    expect(shell.commandArgs("ls -la")).toEqual([gitBash, "-c", "ls -la"]);
    expect(shell.interactiveArgs).toEqual(["-l"]);
  });

  test("Windows + 只有 PowerShell：用 -NoProfile -Command，而不是 -c", () => {
    const shell = resolveCommandShell({}, "win32", existsOnly(), (name) => (name === "pwsh.exe" ? "C:\\pwsh\\pwsh.exe" : null));
    expect(shell.file).toBe("C:\\pwsh\\pwsh.exe");
    expect(shell.commandArgs("Get-Date")).toEqual(["C:\\pwsh\\pwsh.exe", "-NoProfile", "-Command", "Get-Date"]);
    expect(shell.interactiveArgs).toEqual(["-NoLogo"]);
    expect(shell.label).toBe("pwsh.exe");
  });

  test("Windows + 只有 %COMSPEC%：退到 cmd.exe 的 /d /s /c", () => {
    const shell = resolveCommandShell(
      { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
      existsOnly("C:\\Windows\\System32\\cmd.exe"),
      noSuch,
    );
    expect(shell.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(shell.commandArgs("dir")).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "dir"]);
    expect(shell.interactiveArgs).toEqual([]);
  });

  test("Windows 什么都没有：仍是 cmd.exe —— 绝不再回落到 Unix 路径（issue #15 的回归）", () => {
    const shell = resolveCommandShell({}, "win32", existsOnly(), noSuch);
    expect(shell.file).toBe("cmd.exe");
    expect(shell.file).not.toContain("/bin/");
    expect(shell.commandArgs("echo hi")).not.toContain("-c");   // cmd.exe 不用 -c
  });

  test("Windows 上 $SHELL 有效时优先听用户的（Git Bash 里会设成 /usr/bin/bash）", () => {
    const shell = resolveCommandShell(
      { SHELL: "C:\\tools\\msys64\\usr\\bin\\bash.exe" },
      "win32",
      existsOnly("C:\\tools\\msys64\\usr\\bin\\bash.exe"),
      noSuch,
    );
    expect(shell.file).toBe("C:\\tools\\msys64\\usr\\bin\\bash.exe");
    expect(shell.commandArgs("echo hi")).toEqual(["C:\\tools\\msys64\\usr\\bin\\bash.exe", "-c", "echo hi"]);
  });
});
