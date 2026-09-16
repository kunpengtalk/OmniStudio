import { afterAll, expect, mock, test } from "bun:test";

import {
  providersForType,
  providerModelsOfType,
  modelTypeOf,
  type CloudProviderInfo,
} from "../shared/cloud-providers";

// ---------------------------------------------------------------------------
// 云服务商：这次改动把「每页各存一份地址 + 密钥」换成「页面只选厂商 + 模型」，
// 并让厂商可以被**启动**（启用时校验密钥，可同时启动多个）。下面钉住三条：
//   1. 启动要过密钥校验：401/403 不启用，成功则把探到的模型并进清单；
//   2. 旧配置（各页自带的地址 + 密钥）搬家成厂商行并自动选中；
//   3. 每个模型带用途，功能页按用途挑厂商与模型。
// ---------------------------------------------------------------------------
const CloudProviders = await import("./cloud-providers");
const { getSetting, updateSettings } = await import("./db/settings");

const originalFetch = globalThis.fetch;
const TOUCHED = [
  "IMG_PROVIDER_ID",
  "IMG_API_BASE",
  "IMG_API_KEY",
  "IMG_MODEL",
  "TTS_PROVIDER_ID",
  "TTS_PROVIDER_BASE",
  "TTS_PROVIDER_API_KEY",
  "TTS_PROVIDER_MODEL",
  "ASR_PROVIDER_ID",
  "ASR_PROVIDER_BASE",
  "ASR_PROVIDER_API_KEY",
  "ASR_PROVIDER_MODEL",
  "OCR_PROVIDER_ID",
  "OCR_PROVIDER_BASE",
  "OCR_PROVIDER_API_KEY",
  "OCR_PROVIDER_MODEL",
  "VIDEO_BACKEND",
  "VIDEO_PROVIDER_ID",
  "VIDEO_MODEL",
  "VIDEO_SEEDANCE_BASE",
  "VIDEO_SEEDANCE_API_KEY",
  "VIDEO_SEEDANCE_MODEL",
  "VIDEO_MINIMAX_BASE",
  "VIDEO_MINIMAX_API_KEY",
  "VIDEO_MINIMAX_MODEL",
  "CLOUD_APP_PROVIDERS_MIGRATED",
  "SERVER_MODE",
  "VLLM_MODEL_NAME",
  "CHAT_MODEL",
] as const;
const originalSettings = Object.fromEntries(TOUCHED.map((k) => [k, getSetting(k)]));

/** 收集测试里建出来的厂商行，跑完删掉（真实临时库，别留给别的用例）。 */
const created: string[] = [];
function makeProvider(input: { name: string; baseUrl: string; apiKey?: string }) {
  const res = CloudProviders.createCloudProvider({ name: input.name, baseUrl: input.baseUrl });
  const id = res.id!;
  created.push(id);
  if (input.apiKey !== undefined) CloudProviders.updateCloudProvider(id, { apiKey: input.apiKey });
  return id;
}

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const id of created) CloudProviders.deleteCloudProvider(id);
  updateSettings({ ...originalSettings });
});

test("启动厂商：密钥校验通过才启用，并把探到的模型并进清单", async () => {
  const id = makeProvider({ name: "启动测试", baseUrl: "https://live.example/v1", apiKey: "sk-live" });
  globalThis.fetch = mock(async (url: URL | string) => {
    expect(String(url)).toContain("live.example/v1/models");
    return new Response(JSON.stringify({ data: [{ id: "flux-dev" }, { id: "qwen-max" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as never;

  const res = await CloudProviders.setCloudProviderEnabled(id, true);
  expect(res.ok).toBe(true);
  const info = CloudProviders.getCloudProviderInfo(id)!;
  expect(info.enabled).toBe(true);
  expect(info.models.map((m) => m.id).sort()).toEqual(["flux-dev", "qwen-max"]);
  // 探到的模型没有写死分类：读取时按名字识别（flux-dev → 生图）。
  expect(info.models.find((m) => m.id === "flux-dev")?.type).toBeUndefined();
});

test("启动厂商：密钥无效（401）不启用，并把原因交回界面", async () => {
  const id = makeProvider({ name: "密钥错误", baseUrl: "https://bad.example/v1", apiKey: "sk-bad" });
  globalThis.fetch = mock(
    async () => new Response("unauthorized", { status: 401 }),
  ) as never;

  const res = await CloudProviders.setCloudProviderEnabled(id, true);
  expect(res.ok).toBe(false);
  expect(res.error).toContain("密钥无效");
  expect(CloudProviders.getCloudProviderInfo(id)!.enabled).toBe(false);
});

test("启动厂商：地址自带版本段时不会探到不存在的 /v1/models", async () => {
  // 启用是功能页选到该厂商的前提，探错地址 = 这家永远用不了。Gemini 的 OpenAI
  // 兼容地址是 /v1beta/openai，只按「补 /v1/models」拼会得到一个 404 的路径。
  const gemini = makeProvider({
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "sk-gem",
  });
  const seen: string[] = [];
  globalThis.fetch = mock(async (url: URL | string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: "gemini-2.5-pro" }] }), { status: 200 });
  }) as never;

  const res = await CloudProviders.setCloudProviderEnabled(gemini, true);
  expect(res.ok).toBe(true);
  expect(seen).toEqual(["https://generativelanguage.googleapis.com/v1beta/openai/models"]);

  // 不带版本段的地址（MiniMax 那种只填域名的）仍要能探到：先试 /models，404 再补 /v1。
  const bare = makeProvider({ name: "裸域名", baseUrl: "https://api.bare.example", apiKey: "sk-bare" });
  const tried: string[] = [];
  globalThis.fetch = mock(async (url: URL | string) => {
    tried.push(String(url));
    if (tried.length === 1) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ data: [{ id: "abab6.5s" }] }), { status: 200 });
  }) as never;

  const res2 = await CloudProviders.setCloudProviderEnabled(bare, true);
  expect(res2.ok).toBe(true);
  expect(tried).toEqual(["https://api.bare.example/models", "https://api.bare.example/v1/models"]);
});

test("裸域名 + 站点根路径是前端首页：自动退回 /v1/models 拿到清单（New API 这类聚合站）", async () => {
  // 上游是 New API / one-api 时，用户常常只填到域名一级（官方文档给的就是这个）。
  // 站点根路径返回的是 SPA 首页：200 + text/html —— 只补 /models 的实现会在这里
  // 抛 SyntaxError: Failed to parse JSON，设置页于是显示「获取失败」。
  const id = makeProvider({ name: "聚合站", baseUrl: "https://agg.example", apiKey: "sk-agg" });
  const seen: string[] = [];
  globalThis.fetch = mock(async (url: URL | string) => {
    seen.push(String(url));
    if (String(url).endsWith("/v1/models")) {
      return new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-image-1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("<!doctype html><html><body>前端首页</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }) as never;

  const res = await CloudProviders.setCloudProviderEnabled(id, true);
  expect(res.ok).toBe(true);
  expect(seen).toEqual(["https://agg.example/models", "https://agg.example/v1/models"]);
  expect(CloudProviders.getCloudProviderInfo(id)!.models.map((m) => m.id)).toEqual(["gpt-image-1"]);
});

test("候选地址都不是模型清单：说清「返回的是网页、地址要填到 /v1」，而不是 SyntaxError", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  ) as never;

  const r = await CloudProviders.fetchRemoteModels({ baseUrl: "https://site.example", apiKey: "sk-x" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("网页");
  expect(r.error).toContain("/v1");
  expect(r.error).not.toContain("SyntaxError");
});

test("上游用 JSON 报文报错（New API 管理接口形状）：把上游原话交回界面", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ message: "Unauthorized, invalid access token", success: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as never;

  const r = await CloudProviders.fetchRemoteModels({ baseUrl: "https://agg.example/v1", apiKey: "sk-x" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("Unauthorized, invalid access token");
});

test("清单形状：{data} / {models} / 根数组都认", async () => {
  for (const body of [{ data: [{ id: "a" }] }, { models: [{ id: "b" }] }, [{ id: "c" }]]) {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(body), { status: 200 })) as never;
    const r = await CloudProviders.fetchRemoteModels({ baseUrl: "https://shape.example/v1", apiKey: "sk" });
    expect(r.ok).toBe(true);
    expect(r.models).toHaveLength(1);
  }
});

test("停用激活中的厂商：回到本地模式（对话不会继续打到已停用的地址）", async () => {
  const id = makeProvider({ name: "停用测试", baseUrl: "https://off.example/v1", apiKey: "sk-x" });
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  ) as never;
  await CloudProviders.setCloudProviderEnabled(id, true);
  CloudProviders.activateCloudProvider(id);
  expect(getSetting("SERVER_MODE")).toBe("remote");

  const res = await CloudProviders.setCloudProviderEnabled(id, false);
  expect(res.ok).toBe(true);
  expect(CloudProviders.getCloudProviderInfo(id)!.enabled).toBe(false);
  expect(getSetting("SERVER_MODE")).toBe("local");
  expect(getSetting("CLOUD_PROVIDER")).toBe("");
});

test("激活厂商：默认对话模型跳过生图 / 语音 / 嵌入（清单第一条常常不是对话模型）", async () => {
  const id = makeProvider({ name: "激活默认模型", baseUrl: "https://act.example/v1", apiKey: "sk-act" });
  // 老用户先配生图再配语音，清单里就长这样；直接取第一条会把生图模型当对话模型发出去。
  CloudProviders.updateCloudProvider(id, {
    models: [{ id: "Qwen/Qwen-Image-2512" }, { id: "whisper-large-v3" }, { id: "qwen-max" }],
  });
  updateSettings({ VLLM_MODEL_NAME: "", CHAT_MODEL: "" });

  CloudProviders.activateCloudProvider(id);
  expect(getSetting("SERVER_MODE")).toBe("remote");
  expect(getSetting("VLLM_MODEL_NAME")).toBe("qwen-max");
  expect(getSetting("CHAT_MODEL")).toBe("qwen-max");
});

test("激活厂商：一个对话模型都没有时不拿非对话模型顶替（宁可不填）", async () => {
  const id = makeProvider({ name: "激活无对话模型", baseUrl: "https://act2.example/v1", apiKey: "sk-act" });
  CloudProviders.updateCloudProvider(id, {
    models: [{ id: "Qwen/Qwen-Image-2512" }, { id: "whisper-large-v3" }],
  });
  updateSettings({ VLLM_MODEL_NAME: "qwen-max", CHAT_MODEL: "qwen-max" });

  CloudProviders.activateCloudProvider(id);
  expect(getSetting("VLLM_MODEL_NAME")).toBe("");
});

test("旧配置搬家：各页自带的地址 + 密钥变成厂商行并自动选中", async () => {
  // 模拟老用户：生图页填过地址与 Key，语音页也填过，视频还停在 Seedance 后端。
  updateSettings({
    CLOUD_APP_PROVIDERS_MIGRATED: "",
    IMG_PROVIDER_ID: "",
    IMG_API_BASE: "http://127.0.0.1:18123/v1",
    IMG_API_KEY: "sk-image",
    IMG_MODEL: "flux-dev",
    TTS_PROVIDER_ID: "",
    TTS_PROVIDER_BASE: "https://api.siliconflow.cn/v1",
    TTS_PROVIDER_API_KEY: "sk-tts",
    TTS_PROVIDER_MODEL: "FunAudioLLM/CosyVoice2-0.5B",
    ASR_PROVIDER_ID: "",
    ASR_PROVIDER_BASE: "",
    ASR_PROVIDER_API_KEY: "",
    ASR_PROVIDER_MODEL: "",
    OCR_PROVIDER_ID: "",
    OCR_PROVIDER_BASE: "",
    OCR_PROVIDER_API_KEY: "",
    OCR_PROVIDER_MODEL: "",
    VIDEO_BACKEND: "seedance",
    VIDEO_PROVIDER_ID: "",
    VIDEO_MODEL: "",
    VIDEO_SEEDANCE_BASE: "https://ark.example/api/v3",
    VIDEO_SEEDANCE_API_KEY: "ark-key",
    VIDEO_SEEDANCE_MODEL: "doubao-seedance-1-0-pro-t2v-250528",
  });
  // 之前测试留下的启用状态先清干净：迁移只给「搬过来的」厂商置启用。
  CloudProviders.ensureAppProvidersMigrated();

  const imageProviderId = getSetting("IMG_PROVIDER_ID");
  expect(imageProviderId).not.toBe("");
  const imageProvider = CloudProviders.getCloudProviderInfo(imageProviderId)!;
  expect(imageProvider.baseUrl).toBe("http://127.0.0.1:18123/v1");
  expect(imageProvider.apiKey).toBe("sk-image");
  expect(imageProvider.enabled).toBe(true);
  // 生图模型按功能页的用途写入分类：选择器才认得它。
  expect(modelTypeOf(imageProvider.models.find((m) => m.id === "flux-dev")!)).toBe("image");

  const ttsProvider = CloudProviders.getCloudProviderInfo(getSetting("TTS_PROVIDER_ID"))!;
  expect(ttsProvider.baseUrl).toBe("https://api.siliconflow.cn/v1");
  expect(modelTypeOf(ttsProvider.models.find((m) => m.id === "FunAudioLLM/CosyVoice2-0.5B")!)).toBe(
    "tts",
  );

  const videoProvider = CloudProviders.getCloudProviderInfo(getSetting("VIDEO_PROVIDER_ID"))!;
  expect(videoProvider.videoApi).toBe("seedance");
  expect(getSetting("VIDEO_BACKEND")).toBe("cloud");
  expect(getSetting("VIDEO_MODEL")).toBe("doubao-seedance-1-0-pro-t2v-250528");
  expect(modelTypeOf(videoProvider.models.find((m) => m.id.includes("seedance"))!)).toBe("video");

  for (const id of [imageProviderId, ttsProvider.id, videoProvider.id]) created.push(id);
});

test("没填过 Key 的默认地址不搬家（TTS / 视频自带默认地址，别凭空多出厂商）", async () => {
  const before = CloudProviders.listCloudProviders().providers.length;
  updateSettings({
    CLOUD_APP_PROVIDERS_MIGRATED: "",
    TTS_PROVIDER_ID: "",
    TTS_PROVIDER_BASE: "https://omnilabs.vibeadmin.cn/v1", // 默认值，用户没填 Key
    TTS_PROVIDER_API_KEY: "",
    ASR_PROVIDER_ID: "",
    ASR_PROVIDER_BASE: "https://omnilabs.vibeadmin.cn/v1",
    ASR_PROVIDER_API_KEY: "",
    VIDEO_BACKEND: "cloud",
    VIDEO_PROVIDER_ID: "",
  });
  CloudProviders.ensureAppProvidersMigrated();
  expect(getSetting("TTS_PROVIDER_ID")).toBe("");
  expect(getSetting("ASR_PROVIDER_ID")).toBe("");
  expect(CloudProviders.listCloudProviders().providers.length).toBe(before);
});

test("功能页保存「厂商 + 模型」：模型带用途落进厂商清单", async () => {
  const id = makeProvider({ name: "保存选择", baseUrl: "https://save.example/v1", apiKey: "sk-x" });
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  ) as never;

  // 没启动的厂商不让页面选：先去设置里启动（启动时校验密钥）。
  const denied = CloudProviders.saveAppModelChoice({
    settingKey: "IMG_PROVIDER_ID",
    modelKey: "IMG_MODEL",
    providerId: id,
    model: "flux-dev",
    type: "image",
  });
  expect(denied.ok).toBe(false);
  expect(denied.error).toContain("还没启用");
  expect(getSetting("IMG_PROVIDER_ID")).not.toBe(id);

  await CloudProviders.setCloudProviderEnabled(id, true);
  const saved = CloudProviders.saveAppModelChoice({
    settingKey: "IMG_PROVIDER_ID",
    modelKey: "IMG_MODEL",
    providerId: id,
    model: "flux-dev",
    type: "image",
  });
  expect(saved.ok).toBe(true);
  expect(getSetting("IMG_PROVIDER_ID")).toBe(id);
  expect(getSetting("IMG_MODEL")).toBe("flux-dev");
  // 功能页选中的模型落一个显式用途：其它页面就不会把它列错位置。
  const provider = CloudProviders.getCloudProviderInfo(id)!;
  expect(modelTypeOf(provider.models.find((m) => m.id === "flux-dev")!)).toBe("image");
});

test("预设新增的模型会补进存量厂商行（阶跃语音线：老用户升级后直接可用）", () => {
  // 存量库里那一行是当初拷贝下来的快照（只有两个对话模型）。厂商后来上了语音线，
  // 预设跟着版本走 —— 不补的话，语音页 / 通话页对老用户就是一片空白，
  // 只能自己去设置页点「获取模型列表」在几百条远程模型里挑。
  const res = CloudProviders.createCloudProvider({ presetId: "stepfun" });
  expect(res.ok).toBe(true);
  const id = res.id!;
  created.push(id);
  // 模拟老行：语音线的模型一条都没有。
  CloudProviders.updateCloudProvider(id, { models: [{ id: "step-1-8k" }, { id: "step-1-flash" }] });

  const info = CloudProviders.listCloudProviders().providers.find((p) => p.id === id)!;
  const ids = info.models.map((m) => m.id);
  expect(ids).toContain("stepaudio-3-tts");
  expect(ids).toContain("stepaudio-3-asr-max");
  expect(ids).toContain("stepaudio-3-realtime-preview");
  // 用途跟着预设走：TTS 页只列 tts、ASR 页只列 asr，实时语音两条都不进（它在通话页选）。
  expect(modelTypeOf(info.models.find((m) => m.id === "stepaudio-3-tts")!)).toBe("tts");
  expect(modelTypeOf(info.models.find((m) => m.id === "stepaudio-3-asr-max")!)).toBe("asr");
  expect(providerModelsOfType(info, "tts").map((m) => m.id)).toEqual(["stepaudio-3-tts", "stepaudio-2.5-tts"]);
  expect(providerModelsOfType(info, "asr").map((m) => m.id)).toEqual([
    "stepaudio-3-asr-max",
    "stepaudio-2.5-asr",
  ]);
  // 用户原有的条目原样保留（没被"按预设重建"冲掉）。
  expect(ids.slice(0, 2)).toEqual(["step-1-8k", "step-1-flash"]);
  // 幂等：再打开几次页面也不会重复补条目。
  const again = CloudProviders.listCloudProviders().providers.find((p) => p.id === id)!;
  expect(again.models.map((m) => m.id)).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
});

test("按用途挑厂商与模型：未启用的厂商不进选择器", () => {
  const providers: CloudProviderInfo[] = [
    {
      id: "on",
      name: "已启动",
      vendor: "",
      baseUrl: "https://a.example/v1",
      apiKey: "sk",
      models: [{ id: "flux-dev" }, { id: "qwen-max", type: "chat" }],
      enabled: true,
      videoApi: "",
      musicApi: "",
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "off",
      name: "没启动",
      vendor: "",
      baseUrl: "https://b.example/v1",
      apiKey: "sk",
      models: [{ id: "sdxl" }],
      enabled: false,
      videoApi: "",
      musicApi: "",
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  expect(providersForType(providers, "image").map((p) => p.id)).toEqual(["on"]);
  expect(providerModelsOfType(providers[0]!, "image").map((m) => m.id)).toEqual(["flux-dev"]);
  expect(providerModelsOfType(providers[0]!, "chat").map((m) => m.id)).toEqual(["qwen-max"]);
});

test("生视频只列有视频接口协议的厂商", () => {
  const providers: CloudProviderInfo[] = [
    {
      id: "mm",
      name: "MiniMax",
      vendor: "",
      baseUrl: "https://api.minimaxi.com",
      apiKey: "sk",
      models: [{ id: "MiniMax-H3", type: "video" }],
      enabled: true,
      videoApi: "minimax",
      musicApi: "",
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "chat-only",
      name: "只有对话",
      vendor: "",
      baseUrl: "https://c.example/v1",
      apiKey: "sk",
      // 名字看着像视频模型，但厂商没配生视频接口 → 视频页不该列它。
      models: [{ id: "some-video-model", type: "video" }],
      enabled: true,
      videoApi: "",
      musicApi: "",
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  expect(providersForType(providers, "video", { requireVideoApi: true }).map((p) => p.id)).toEqual([
    "mm",
  ]);
});

test("保存厂商：地址栏粘成 API Key 时当场拒绝，而不是回一句 fetch() URL is invalid", () => {
  const bad = CloudProviders.createCloudProvider({ name: "填错地址的", baseUrl: "sk-opc-abcdef" });
  expect(bad.ok).toBe(false);
  expect(bad.error).toContain("http://");

  // 空地址仍然允许（可以先建厂商、后补地址）
  const blank = CloudProviders.createCloudProvider({ name: "还没填地址的" });
  expect(blank.ok).toBe(true);

  const good = CloudProviders.createCloudProvider({
    name: "地址正常的",
    baseUrl: "https://open.cherryin.net",
  });
  expect(good.ok).toBe(true);

  const update = CloudProviders.updateCloudProvider(good.id!, { baseUrl: "sk-opc-abcdef" });
  expect(update.ok).toBe(false);
  expect(update.error).toContain("API Key");
});

// ---------------------------------------------------------------------------
// 存量厂商补预设新增的接口协议（`syncPresetModels`）
//
// 现场：v0.0.9 加生音乐时 `musicApi` 是新加到预设上的字段，而老用户库里那一行是
// 当初拷贝的快照 —— 模型补上了（syncPresetModels 早就在做模型），协议没补，于是
// 「设置里启用着 StepFun、音乐模型也在清单里，音乐页却一个厂商都选不到」。
// 两半拼不上，而且不报错、不打日志，只能靠人肉发现选择器是空的。
// ---------------------------------------------------------------------------

/** 拿 stepfun 预设行（前面用例可能已经建过），并把它交回 afterAll 清理。 */
function stepfunRowId(): string {
  const existing = CloudProviders.listCloudProviders().providers.some((p) => p.id === "stepfun");
  if (!existing) {
    const r = CloudProviders.createCloudProvider({ presetId: "stepfun" });
    expect(r.ok).toBe(true);
  }
  if (!created.includes("stepfun")) created.push("stepfun");
  return "stepfun";
}

test("存量行补上预设的 musicApi，并因此出现在音乐页的候选厂商里", async () => {
  const id = stepfunRowId();
  // 模拟升级前的存量行：协议列刚由迁移加上，默认是空串。
  expect(CloudProviders.updateCloudProvider(id, { musicApi: "" }).ok).toBe(true);
  // 新建的厂商默认未启用，而选择器只列已启用的 —— 先把密钥校验 mock 掉启用它，
  // 否则这个用例会因为"未启用"而红，掩盖掉真正要验的协议补全。
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  ) as never;
  expect(CloudProviders.updateCloudProvider(id, { apiKey: "sk-stepfun-test" }).ok).toBe(true);
  const enabled = await CloudProviders.setCloudProviderEnabled(id, true);
  expect(enabled.ok).toBe(true);

  // 读列表就会触发补全（音乐页选厂商走的就是这条路径），所以补全前的状态
  // 通过公开 API 观察不到 —— 这正是它「透明生效」的原因。
  const { providers } = CloudProviders.listCloudProviders();
  expect(providers.find((p) => p.id === id)?.musicApi).toBe("stepfun");

  // 补完必须真的进得了音乐页的选择器：这才是用户看得见的结果，
  // 只断言字段值的话，选择器的过滤条件变了这个用例也不会红。
  const candidates = providersForType(providers, "music", { requireMusicApi: true });
  expect(candidates.some((p) => p.id === id)).toBe(true);
});

test("用户自己选过的协议不被预设覆盖（只补空值）", () => {
  const id = stepfunRowId();
  // 用户的显式选择优先：这里把它指向 minimax 协议的转售方，预设说 stepfun 也不该改。
  expect(CloudProviders.updateCloudProvider(id, { musicApi: "minimax" }).ok).toBe(true);
  const { providers } = CloudProviders.listCloudProviders();
  expect(providers.find((p) => p.id === id)?.musicApi).toBe("minimax");
});

test("自定义厂商（没有预设）不被补协议：没声明过协议就不该凭空多一个", () => {
  const id = makeProvider({ name: "补协议测试（自定义）", baseUrl: "https://custom-music.example/v1" });
  const { providers } = CloudProviders.listCloudProviders();
  const row = providers.find((p) => p.id === id);
  expect(row?.musicApi).toBe("");
  expect(row?.videoApi).toBe("");
});
