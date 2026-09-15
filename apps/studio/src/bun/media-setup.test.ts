import { afterAll, expect, mock, test } from "bun:test";

import type { MediaSetupAnswer, MediaSetupPayload } from "./media-setup";
import type { CloudProviderInfo } from "../shared/cloud-providers";
import type * as CloudProviders from "./cloud-providers";
import { mockModulePartial } from "./test-mocks";

// ---------------------------------------------------------------------------
// 生图配置走真实 settings（bunfig 的 test-preload 已把数据目录指向本进程专属临时目录）。
//
// 云服务商这一层则用内存 fake：bun 的 mock.module 会在同进程内跨文件泄漏，
// 别的测试文件把 ./db 换成自己的临时库并删掉之后，真实 cloud-providers 再读写
// 那张表会直接 SQLITE_IOERR_VNCORE —— 整个套件一起跑时才暴露，单跑本文件却正常。
//
// 新模型：页面不再保存地址 / 密钥，只记 IMG_PROVIDER_ID；地址与密钥由服务商行提供，
// 所以这里的 fake 必须实现 resolveCloudProvider / listEnabledCloudProviders。
//
// 只替换"读服务商行"的那几个函数，其余走 `mockModulePartial` 的真实实现：生图这条路
// 还会调到 `fetchRemoteModels`（`listImageApiModels` → 拉 /models 扫描候选模型，
// 见 image-gen.ts），手写清单时漏掉它，"选了厂商没选模型"那两条用例就变成
// `fetchRemoteModels is not a function`；真实实现铺开之后，这条路上新增的调用不会再漏。
// ---------------------------------------------------------------------------
const fakeProviders: CloudProviderInfo[] = [];

await mockModulePartial<typeof CloudProviders>("./cloud-providers", {
  activeProviderId: () => fakeProviders[0]?.id ?? null,
  listCloudProviders: () => ({
    providers: fakeProviders,
    activeId: fakeProviders[0]?.id ?? null,
  }),
  listEnabledCloudProviders: () => fakeProviders.filter((p) => p.enabled),
  getCloudProviderInfo: (id: string) => fakeProviders.find((p) => p.id === id) ?? null,
  resolveCloudProvider: (id: string | undefined | null) =>
    fakeProviders.find((p) => p.id === (id ?? "").trim()) ?? null,
  saveAppModelChoice: () => ({ ok: true }),
  ensureAppProvidersMigrated: () => {},
});

const MediaSetup = await import("./media-setup");
const { getSetting, updateSettings } = await import("./db/settings");

const originalFetch = globalThis.fetch;
const TOUCHED = [
  "IMG_BACKEND",
  "IMG_PROVIDER_ID",
  "IMG_API_BASE",
  "IMG_API_KEY",
  "IMG_MODEL",
] as const;
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

/** 造一个云服务商（默认已启用），返回 id（用完记得删）。 */
function addCloudProvider(input: {
  name: string;
  baseUrl: string;
  models: string[];
  apiKey?: string;
  enabled?: boolean;
}) {
  const id = `test-${input.name}-${fakeProviders.length}`;
  fakeProviders.push({
    id,
    name: input.name,
    vendor: "测试",
    baseUrl: input.baseUrl,
    apiKey: input.apiKey ?? "sk-test",
    models: input.models.map((modelId) => ({ id: modelId })),
    enabled: input.enabled ?? true,
    videoApi: "",
    createdAt: 0,
    updatedAt: 0,
  });
  return id;
}

function removeCloudProvider(id: string) {
  const index = fakeProviders.findIndex((p) => p.id === id);
  if (index >= 0) fakeProviders.splice(index, 1);
}

test("配置齐全时 prepareImageGeneration 直接放行，不弹窗", async () => {
  const provider = addCloudProvider({
    name: "本地兼容服务",
    baseUrl: "http://127.0.0.1:9/v1",
    models: ["ready-model"],
  });
  updateSettings({
    IMG_BACKEND: "api",
    IMG_PROVIDER_ID: provider,
    IMG_MODEL: "ready-model",
  });
  const { seen, stop } = fakeWebview([]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res).toEqual({ ok: true, model: "ready-model" });
    expect(seen).toHaveLength(0);
  } finally {
    stop();
    removeCloudProvider(provider);
  }
});

test("没选厂商时弹窗，用户选中厂商后落盘并继续", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_PROVIDER_ID: "", IMG_MODEL: "" });
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
      // 候选来自「已启动」的厂商，选中即把厂商 id 回传（地址 / 密钥由厂商行提供）。
      expect(payload.candidates.map((c) => [c.providerId, c.id])).toEqual([
        [a, "Qwen/Qwen-Image"],
        [b, "flux-dev"],
      ]);
      return { action: "confirm", backend: "api", providerId: b, model: "flux-dev" };
    },
  ]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res).toEqual({ ok: true, model: "flux-dev" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe("choose-model");
    expect(seen[0]!.backend).toBe("api");
    // 只落厂商 + 模型；地址 / 密钥从服务商解析出来。
    expect(getSetting("IMG_PROVIDER_ID")).toBe(b);
    expect(getSetting("IMG_MODEL")).toBe("flux-dev");
    expect(MediaSetup.cloudImageCandidates().length).toBe(2);
    // 弹窗里带着三个后端供切换，且都标了就绪状态。
    expect(seen[0]!.backends.map((x) => x.id)).toEqual(["api", "mlx", "comfyui"]);
  } finally {
    stop();
    removeCloudProvider(a);
    removeCloudProvider(b);
  }
});

test("用户在弹窗里点取消：不生成，并让模型别再自行重试", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_PROVIDER_ID: "", IMG_MODEL: "" });
  const { stop } = fakeWebview([{ action: "cancel" }]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("取消了");
    expect(getSetting("IMG_PROVIDER_ID")).toBe(""); // 取消不落盘
  } finally {
    stop();
  }
});

test("没有界面在监听时（CLI / 无人值守）直接按取消返回，不挂起", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_PROVIDER_ID: "", IMG_MODEL: "" });
  const res = await MediaSetup.prepareImageGeneration();
  expect(res.ok).toBe(false);
});

test("选了厂商没选模型：扫描到多个候选时再弹一次确认用哪个模型", async () => {
  const provider = addCloudProvider({
    name: "本地兼容服务",
    baseUrl: "http://127.0.0.1:9/v1",
    models: [],
  });
  updateSettings({ IMG_BACKEND: "api", IMG_PROVIDER_ID: provider, IMG_MODEL: "" });
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
    { action: "confirm" }, // 第一次弹窗：确认厂商已选好（模型待扫）
    (payload) => {
      // 扫到的候选摆出来让用户挑。
      expect(payload.reason).toBe("choose-model");
      expect(payload.candidates.map((c) => c.id)).toEqual(["flux-dev", "sdxl-turbo"]);
      return { action: "confirm", model: "sdxl-turbo" };
    },
  ]);
  try {
    const res = await MediaSetup.prepareImageGeneration();
    expect(res).toEqual({ ok: true, model: "sdxl-turbo" });
    expect(seen).toHaveLength(2);
    expect(getSetting("IMG_MODEL")).toBe("sdxl-turbo");
  } finally {
    stop();
    globalThis.fetch = originalFetch;
    removeCloudProvider(provider);
  }
});

test("扫描到唯一候选时自动选定，不再打扰用户", async () => {
  const provider = addCloudProvider({
    name: "本地兼容服务",
    baseUrl: "http://127.0.0.1:9/v1",
    models: [],
  });
  updateSettings({ IMG_BACKEND: "api", IMG_PROVIDER_ID: provider, IMG_MODEL: "" });
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
    expect(seen).toHaveLength(1); // 只有"确认厂商"这一次弹窗，扫到唯一候选就自动选定
    expect(getSetting("IMG_MODEL")).toBe("only-one");
  } finally {
    stop();
    globalThis.fetch = originalFetch;
    removeCloudProvider(provider);
  }
});

test("工具调用里显式指定了模型：只补厂商配置，不再问用哪个模型", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_PROVIDER_ID: "", IMG_MODEL: "" });
  const provider = addCloudProvider({
    name: "唯一厂商",
    baseUrl: "http://127.0.0.1:9/v1",
    models: [],
  });
  const { seen, stop } = fakeWebview([
    { action: "confirm", backend: "api", providerId: provider },
  ]);
  try {
    const res = await MediaSetup.prepareImageGeneration({ explicitModel: "caller-model" });
    expect(res).toEqual({ ok: true, model: "caller-model" });
    expect(seen).toHaveLength(1); // 只有"补配置"这一次弹窗
  } finally {
    stop();
    removeCloudProvider(provider);
  }
});

// ---------------------------------------------------------------------------
// 「云端模型」（云服务商）里已经配好的生图模型：生图这条路以前完全看不见它们，
// 于是只会弹窗让用户把地址与 Key 再手填一遍。下面这几条钉住「配过就别再问」。
// ---------------------------------------------------------------------------

test("cloudImageCandidates 只认已启动服务商里的生图模型", async () => {
  const ready = addCloudProvider({
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen-Image", "deepseek-v4-flash"],
  });
  const disabled = addCloudProvider({
    name: "没启动",
    baseUrl: "https://example.com/v1",
    models: ["flux-dev"],
    enabled: false,
  });
  try {
    const candidates = MediaSetup.cloudImageCandidates();
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain("Qwen/Qwen-Image");
    expect(ids).not.toContain("deepseek-v4-flash"); // 对话模型不是生图候选
    expect(ids).not.toContain("flux-dev"); // 没启动的厂商不算「配过」
    // 候选带厂商 id：选中即把这个厂商设为生图后端。
    expect(candidates.find((c) => c.id === "Qwen/Qwen-Image")?.providerId).toBe(ready);
  } finally {
    removeCloudProvider(ready);
    removeCloudProvider(disabled);
  }
});

test("「云端模型」里只有一个生图模型：直接采用，不弹窗", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_PROVIDER_ID: "", IMG_MODEL: "" });
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
    expect(getSetting("IMG_PROVIDER_ID")).toBe(provider);
    expect(getSetting("IMG_MODEL")).toBe("Qwen/Qwen-Image");
  } finally {
    stop();
    removeCloudProvider(provider);
  }
});

test("等待中的弹窗可被中断收尾（停止按钮 / 会话重置）", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_PROVIDER_ID: "", IMG_MODEL: "" });
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
