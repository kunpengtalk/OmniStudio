import { afterAll, expect, mock, test } from "bun:test";

import type { MediaSetupAnswer, MediaSetupPayload } from "./media-setup";

// ---------------------------------------------------------------------------
// 不做模块 mock：bunfig 的 test-preload 已把数据目录指向本进程专属临时目录。
// ---------------------------------------------------------------------------
const MediaSetup = await import("./media-setup");
const { getSetting, updateSettings } = await import("./db/settings");

const originalFetch = globalThis.fetch;
const TOUCHED = ["IMG_BACKEND", "IMG_API_BASE", "IMG_API_KEY", "IMG_MODEL"] as const;
const originalSettings = Object.fromEntries(TOUCHED.map((k) => [k, getSetting(k)]));

afterAll(() => {
  globalThis.fetch = originalFetch;
  updateSettings({ ...originalSettings });
});

/**
 * 模拟界面：收到弹窗 payload 后按脚本回答，并记录收到过哪些请求。
 * 返回 stop() 注销监听。
 */
function fakeWebview(answers: (MediaSetupAnswer | ((p: MediaSetupPayload) => MediaSetupAnswer))[]) {
  const seen: MediaSetupPayload[] = [];
  const stop = MediaSetup.onMediaSetup((payload) => {
    seen.push(payload);
    const next = answers.shift();
    if (!next) return;
    const answer = typeof next === "function" ? next(payload) : next;
    MediaSetup.resolveMediaSetup(payload.id, answer);
  });
  return { seen, stop };
}

test("配置齐全时 prepareImageGeneration 直接放行，不弹窗", async () => {
  updateSettings({
    IMG_BACKEND: "api",
    IMG_API_BASE: "http://127.0.0.1:9/v1",
    IMG_API_KEY: "",
    IMG_MODEL: "ready-model",
  });
  const { seen, stop } = fakeWebview([]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res).toEqual({ ok: true, model: "ready-model" });
    expect(seen).toHaveLength(0);
  } finally {
    stop();
  }
});

test("缺配置时弹窗，用户确认后落盘配置并继续", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "", IMG_MODEL: "" });
  const { seen, stop } = fakeWebview([
    { action: "confirm", backend: "api", apiBase: "http://127.0.0.1:9/v1", model: "chosen-model" },
  ]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res).toEqual({ ok: true, model: "chosen-model" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe("missing-config");
    expect(seen[0]!.backend).toBe("api");
    // 用户的填写落到生图配置里（不只是这一次生效）。
    expect(getSetting("IMG_API_BASE")).toBe("http://127.0.0.1:9/v1");
    expect(getSetting("IMG_MODEL")).toBe("chosen-model");
    // 弹窗里带着三个后端供切换，且都标了就绪状态。
    expect(seen[0]!.backends.map((b) => b.id)).toEqual(["api", "mlx", "comfyui"]);
  } finally {
    stop();
  }
});

test("用户在弹窗里点取消：不生成，并让模型别再自行重试", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "", IMG_MODEL: "" });
  const { stop } = fakeWebview([{ action: "cancel" }]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("取消了");
    expect(getSetting("IMG_API_BASE")).toBe(""); // 取消不落盘
  } finally {
    stop();
  }
});

test("没有界面在监听时（CLI / 无人值守）直接按取消返回，不挂起", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "", IMG_MODEL: "" });
  const res = await MediaSetup.prepareImageGeneration();
  expect(res.ok).toBe(false);
});

test("只填了地址没选模型：扫描到多个候选时再弹一次确认用哪个模型", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "http://127.0.0.1:9/v1", IMG_MODEL: "" });
  globalThis.fetch = mock(async (url: URL | string) => {
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "flux-dev" }, { id: "sdxl-turbo" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }) as never;

  const { seen, stop } = fakeWebview([
    { action: "confirm", backend: "api", apiBase: "http://127.0.0.1:9/v1" }, // 只配地址
    (payload) => {
      // 第二次弹窗必须带上扫描到的候选，用户挑第二个。
      expect(payload.reason).toBe("choose-model");
      expect(payload.candidates.map((c) => c.id)).toEqual(["flux-dev", "sdxl-turbo"]);
      return { action: "confirm", model: "sdxl-turbo" };
    },
  ]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res).toEqual({ ok: true, model: "sdxl-turbo" });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.reason).toBe("choose-model"); // 地址齐了但没模型 → 第一枪就是选模型
    expect(getSetting("IMG_MODEL")).toBe("sdxl-turbo");
  } finally {
    stop();
    globalThis.fetch = originalFetch;
  }
});

test("扫描到唯一候选时自动选定，不再打扰用户", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "http://127.0.0.1:9/v1", IMG_MODEL: "" });
  globalThis.fetch = mock(async (url: URL | string) => {
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "only-one" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }) as never;

  const { seen, stop } = fakeWebview([{ action: "confirm" }]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res).toEqual({ ok: true, model: "only-one" });
    expect(seen).toHaveLength(1);
    expect(getSetting("IMG_MODEL")).toBe("only-one");
  } finally {
    stop();
    globalThis.fetch = originalFetch;
  }
});

test("工具调用里显式指定了模型：只补后端配置，不再问用哪个模型", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "", IMG_MODEL: "" });
  const { seen, stop } = fakeWebview([
    { action: "confirm", backend: "api", apiBase: "http://127.0.0.1:9/v1" },
  ]);
  try {
    const res = await MediaSetup.prepareImageGeneration({ explicitModel: "caller-model" });
    expect(res).toEqual({ ok: true, model: "caller-model" });
    expect(seen).toHaveLength(1); // 只有"补配置"这一次弹窗
  } finally {
    stop();
  }
});

test("等待中的弹窗可被中断收尾（停止按钮 / 会话重置）", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "", IMG_MODEL: "" });
  const { stop } = fakeWebview([]); // 收到弹窗但一直不回答
  try {
    const pending = MediaSetup.prepareImageGeneration();
    await Bun.sleep(10);
    MediaSetup.cancelMediaSetup();
    const res = await pending;
    expect(res.ok).toBe(false);
  } finally {
    stop();
  }
});
