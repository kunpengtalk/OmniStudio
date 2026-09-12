import { describe, expect, test } from "bun:test";

import { collapseCarriageReturns, killProcessTree, spawnServerProcess } from "./proc";

/** 进程组是否还存在（不存在 → ESRCH，返回 false）。 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("collapseCarriageReturns", () => {
  test("保留 \\r 进度条的最后一段", () => {
    expect(collapseCarriageReturns("10%\r50%\r100%\n")).toBe("100%\n");
    expect(collapseCarriageReturns("no cr")).toBe("no cr");
    expect(collapseCarriageReturns("a\r\nb")).toBe("a\nb");
  });
});

describe("killProcessTree", () => {
  test("杀掉整个进程组（孙进程不再是孤儿）", async () => {
    // 模拟真实形态：启动器 -> 推理进程。只杀直接子进程会留下 sleep 孤儿。
    const proc = spawnServerProcess(["/bin/sh", "-c", "sleep 30 & sleep 30"]);
    await Bun.sleep(200);
    const pid = proc.pid;
    expect(pid).toBeGreaterThan(0);
    expect(groupAlive(pid)).toBe(true);

    killProcessTree(proc, "SIGKILL");
    await Bun.sleep(300);
    expect(groupAlive(pid)).toBe(false);
  });

  test("传入 null 或已退出的进程不抛错", async () => {
    expect(() => killProcessTree(null)).not.toThrow();
    const proc = spawnServerProcess(["/bin/sh", "-c", "exit 0"]);
    await proc.exited;
    expect(() => killProcessTree(proc, "SIGTERM")).not.toThrow();
  });
});

describe("spawnServerProcess", () => {
  test("stdout/stderr 可读，退出码可获取", async () => {
    const proc = spawnServerProcess(["/bin/sh", "-c", "echo hello; echo err >&2; exit 3"]);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(out.trim()).toBe("hello");
    expect(err.trim()).toBe("err");
    expect(code).toBe(3);
  });
});
