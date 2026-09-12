import { afterAll, expect, mock, test } from "bun:test";

import type { MediaSetupAnswer, MediaSetupPayload } from "./media-setup";
import type { CloudProviderInfo } from "../shared/cloud-providers";

// ---------------------------------------------------------------------------
// 生图配置走真实 settings（bunfig 的 test-preload 已把数据目录指向本进程专属临时目录）。
//
// 云服务商这一层则用内存 fake：bun 的 mock.module 会在同进程内跨文件泄漏，
// 别的测试文件把 ./db 换成自己的临时库并删掉之后，真实 cloud-providers 再读写
// 那张表会直接 SQLITE_IOERR_VNODE —— 整个套件一起跑时才暴露，单跑本文件却正常。
// ---------------------------------------------------------------------------
const fakeProviders: CloudProviderInfo[] = [];

mock.module("./cloud-providers", () => ({
  activeProviderId: () => fakeProviders[0]?.id ?? null,
  listCloudProviders: () => ({
    providers: fakeProviders,
    activeId: fakeProviders[0]?.id ?? null,
  }),
  getCloudProviderInfo: (id: string) => fakeProviders.find((p) => p.id === id) ?? null,
}));

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

// ---------------------------------------------------------------------------
// 「云端模型」（云服务商）里已经配好的生图模型：生图这条路以前完全看不见它们，
// 于是只会弹窗让用户把地址与 Key 再手填一遍。下面这几条钉住「配过就别再问」。
// ---------------------------------------------------------------------------

/** 造一个配好 Key 与模型清单的云服务商，返回 id（用完记得删）。 */
function addCloudProvider(input: { name: string; baseUrl: string; models: string[]; apiKey?: string }) {
  const id = `test-${input.name}-${fakeProviders.length}`;
  fakeProviders.push({
    id,
    name: input.name,
    vendor: "测试",
    baseUrl: input.baseUrl,
    apiKey: input.apiKey ?? "sk-test",
    models: input.models.map((modelId) => ({ id: modelId })),
    createdAt: 0,
    updatedAt: 0,
  });
  return id;
}

function removeCloudProvider(id: string) {
  const index = fakeProviders.findIndex((p) => p.id === id);
  if (index >= 0) fakeProviders.splice(index, 1);
}

test("cloudImageCandidates 只认配好地址 + Key 的服务商里的生图模型", async () => {
  const ready = addCloudProvider({
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen-Image", "deepseek-v4-flash"],
  });
  const noKey = addCloudProvider({
    name: "还没填 Key",
    baseUrl: "https://example.com/v1",
    models: ["flux-dev"],
    apiKey: "",
  });
  try {
    const ids = MediaSetup.cloudImageCandidates().map((c) => c.id);
    expect(ids).toContain("Qwen/Qwen-Image");
    expect(ids).not.toContain("deepseek-v4-flash"); // 对话模型不是生图候选
    expect(ids).not.toContain("flux-dev"); // 没填 Key 的服务商不算「配过」
  } finally {
    removeCloudProvider(ready);
    removeCloudProvider(noKey);
  }
});

test("「云端模型」里只有一个生图模型：直接采用，不弹窗", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "", IMG_API_KEY: "", IMG_MODEL: "" });
  const provider = addCloudProvider({
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen-Image"],
  });
  const { seen, stop } = fakeWebview([]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res).toEqual({ ok: true, model: "Qwen/Qwen-Image" });
    expect(seen).toHaveLength(0); // 用户已经配过，不该再问一遍
    expect(getSetting("IMG_API_BASE")).toBe("https://api.siliconflow.cn/v1");
    expect(getSetting("IMG_API_KEY")).toBe("sk-test");
    expect(getSetting("IMG_MODEL")).toBe("Qwen/Qwen-Image");
  } finally {
    stop();
    removeCloudProvider(provider);
  }
});

test("「云端模型」里有多个生图模型：列出来让用户挑，挑谁用谁的地址", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "", IMG_API_KEY: "", IMG_MODEL: "" });
  const a = addCloudProvider({
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen-Image"],
  });
  const b = addCloudProvider({
    name: "自建服务",
    baseUrl: "http://127.0.0.1:9/v1",
    models: ["flux-dev"],
    apiKey: "sk-local",
  });
  const { seen, stop } = fakeWebview([
    (payload) => {
      expect(payload.reason).toBe("choose-model");
      expect(payload.candidates.map((c) => c.id)).toEqual(["Qwen/Qwen-Image", "flux-dev"]);
      // 界面选中「自建服务」那一行时就是这样回传的（地址 / Key 来自服务商）。
      return {
        action: "confirm",
        backend: "api",
        model: "flux-dev",
        apiBase: "http://127.0.0.1:9/v1",
        apiKey: "sk-local",
      };
    },
  ]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res).toEqual({ ok: true, model: "flux-dev" });
    expect(seen).toHaveLength(1);
    expect(getSetting("IMG_API_BASE")).toBe("http://127.0.0.1:9/v1");
    expect(getSetting("IMG_API_KEY")).toBe("sk-local");
  } finally {
    stop();
    removeCloudProvider(a);
    removeCloudProvider(b);
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
