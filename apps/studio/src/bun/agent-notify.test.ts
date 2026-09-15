import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  externalNotifyConfigured,
  notifyCommand,
  notifyExternal,
} from "./agent-notify";
import { notify, resetNotifications } from "./notifications";
import { updateSettings } from "./db/settings";

/**
 * 外部通知回调（对齐 Codex 的 `notify`）。
 *
 * 两个必须钉住的点：
 * 1. 载荷是**数据**：标题里带引号 / 分号 / 反引号也不能被当成命令执行（注入）；
 * 2. 外部命令失败或很慢，都不能影响 Agent —— 它只是"发一条出去就算了"。
 */
let dir: string;

const readPayload = async (file: string, timeoutMs = 3000): Promise<Record<string, unknown> | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8").trim();
      if (text) {
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          // 还在写：等一下再来
        }
      }
    }
    await Bun.sleep(30);
  }
  return null;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "omni-notify-"));
  resetNotifications();
  updateSettings({ AGENT_NOTIFY_COMMAND: "" });
});

afterEach(() => {
  updateSettings({ AGENT_NOTIFY_COMMAND: "" });
  rmSync(dir, { recursive: true, force: true });
});

describe("外部通知回调", () => {
  test("未配置时不执行任何东西", () => {
    expect(externalNotifyConfigured()).toBe(false);
    expect(notifyCommand()).toBe("");
    expect(notifyExternal({ kind: "info", title: "没人听" })).toBe(false);
  });

  test("事件载荷作为最后一个参数传给用户的命令（含应用内通知的类型映射）", async () => {
    const file = path.join(dir, "payload.json");
    updateSettings({ AGENT_NOTIFY_COMMAND: `sh -c 'printf %s "$1" > ${file}' omni-notify` });
    expect(externalNotifyConfigured()).toBe(true);

    notify({ kind: "run_finished", title: "会话跑完了", body: "改了 3 个文件", conversationId: 42 });

    const payload = await readPayload(file);
    expect(payload).not.toBeNull();
    expect(payload!.type).toBe("agent-turn-complete");
    expect(payload!.kind).toBe("run_finished");
    expect(payload!.title).toBe("会话跑完了");
    expect(payload!.body).toBe("改了 3 个文件");
    expect(payload!.conversationId).toBe(42);
    expect(typeof payload!.at).toBe("number");
  });

  test("种类映射：授权请求 / 自动化 / 出错各有各的类型", async () => {
    const file = path.join(dir, "kinds.json");
    updateSettings({ AGENT_NOTIFY_COMMAND: `sh -c 'printf %s "$1" > ${file}' omni-notify` });

    notify({ kind: "permission", title: "需要授权" });
    let payload = await readPayload(file);
    expect(payload!.type).toBe("agent-permission-request");
    rmSync(file, { force: true });

    notify({ kind: "automation", title: "日报跑完" });
    payload = await readPayload(file);
    expect(payload!.type).toBe("automation-finished");
    rmSync(file, { force: true });

    notify({ kind: "error", title: "自动化失败" });
    payload = await readPayload(file);
    expect(payload!.type).toBe("agent-error");
  });

  test("载荷是数据不是代码：标题里的引号 / 分号 / 反引号不会被执行", async () => {
    const file = path.join(dir, "injection.json");
    const marker = path.join(dir, "pwned");
    updateSettings({ AGENT_NOTIFY_COMMAND: `sh -c 'printf %s "$1" > ${file}' omni-notify` });
    notify({
      kind: "info",
      title: `"; touch ${marker}; echo "`,
      body: "`touch " + marker + "`",
    });
    const payload = await readPayload(file);
    expect(payload).not.toBeNull();
    expect(payload!.title).toContain("touch");
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);
  });

  test("命令写错也只是发不出去，不影响调用方", () => {
    updateSettings({ AGENT_NOTIFY_COMMAND: "/nonexistent/omni-notify-binary" });
    // notify() 内部调用外部命令：不能抛错、不能挂住。
    expect(() => notify({ kind: "info", title: "照常入通知中心" })).not.toThrow();
    expect(notifyExternal({ kind: "info", title: "同样返回 false 或 true" })).toBeBoolean();
  });
});
