import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  closeAllTerminals,
  closeTerminal,
  getTerminal,
  listTerminals,
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  startTerminal,
  writeTerminal,
} from "./terminal-sessions";

/**
 * 侧边面板的终端：真的起一个 shell（PTY），验证
 * 输出能推出来、输入能写进去、尺寸能改、关掉之后会话消失。
 */

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omni-term-"));
  dirs.push(dir);
  return dir;
}

/** 等一段输出（shell 的启动提示符时机不定，按"出现关键词"等更稳）。 */
function waitForOutput(id: string, needle: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    let collected = "";
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for ${needle}; got: ${collected.slice(0, 200)}`));
    }, timeoutMs);
    const unsubscribe = onTerminalData((payload) => {
      if (payload.id !== id) return;
      collected += payload.data;
      if (collected.includes(needle)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(collected);
      }
    });
  });
}

afterEach(() => {
  closeAllTerminals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("起会话 → 写命令 → 输出推回前端", async () => {
  const cwd = tempDir();
  const info = startTerminal({ cwd, cols: 100, rows: 30, shell: "/bin/sh" });
  expect(info.cwd).toBe(cwd);
  expect(info.running).toBe(true);

  const typed = writeTerminal(info.id, "echo TERM-OK-$((1+1))\n");
  expect(typed).toBe(true);

  const output = await waitForOutput(info.id, "TERM-OK-2");
  expect(output).toContain("TERM-OK-2");
});

test("会话与尺寸都可以改，关掉之后查不到", () => {
  const info = startTerminal({ cwd: tempDir(), shell: "/bin/sh" });
  expect(resizeTerminal(info.id, 132, 40)).toBe(true);
  const session = getTerminal(info.id);
  expect(session?.cols).toBe(132);
  expect(session?.rows).toBe(40);
  expect(listTerminals().some((item) => item.id === info.id)).toBe(true);

  closeTerminal(info.id);
  expect(getTerminal(info.id)).toBeNull();
  // 关掉之后再写就没有去处了（不会抛异常）
  expect(writeTerminal(info.id, "echo x\n")).toBe(false);
});

test("shell 退出会通知界面", async () => {
  const info = startTerminal({ cwd: tempDir(), shell: "/bin/sh" });
  const exit = new Promise<{ exitCode: number }>((resolve) => {
    const unsubscribe = onTerminalExit((payload) => {
      if (payload.id !== info.id) return;
      unsubscribe();
      resolve({ exitCode: payload.exitCode });
    });
  });
  writeTerminal(info.id, "exit 0\n");
  const payload = await exit;
  expect(payload.exitCode).toBe(0);
});

test("工作区不存在时退回家目录（终端不能起不来）", () => {
  const info = startTerminal({ cwd: "/definitely/not/here", shell: "/bin/sh" });
  expect(info.cwd).not.toBe("/definitely/not/here");
  expect(info.cwd.length).toBeGreaterThan(1);
  closeTerminal(info.id);
});
