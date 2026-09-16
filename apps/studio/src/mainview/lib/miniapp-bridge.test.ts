import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { MINIAPP_ACTIONS, MINIAPP_CHANNEL, type MiniAppCapabilitySnapshot } from "../../shared/miniapps";
import {
  MINIAPP_BASE_STYLE,
  MINIAPP_RUNTIME_SCRIPT,
  dispatchMiniAppRequest,
  injectMiniAppRuntime,
  type MiniAppHostDeps,
} from "./miniapp-bridge";

const CAPS: MiniAppCapabilitySnapshot = {
  image: { ready: true, label: "Cloud · flux" },
  imageEdit: { ready: true, label: "Cloud · flux" },
  chat: { ready: false, label: "" },
  asr: { ready: false, label: "" },
  bgRemove: { ready: true, label: "本地 · silueta" },
  local: { ready: true, label: "On-device only" },
};

/** 记录调用的假 RPC 客户端：每条用例都能断言"到底打了哪些方法"。 */
function makeDeps(overrides: Partial<MiniAppHostDeps> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const results: Record<string, unknown> = {
    generateImage: { records: [{ imagePath: "gen/a.png", width: 1024, height: 1024 }] },
    stageEditImage: { files: [{ ref: "edit/in/a.png", url: "http://127.0.0.1:19782/edit/in/a.png" }] },
    transcribeAudio: { text: "你好", engine: "whisper-cli", segments: [], hasSpeakers: false },
    miniappComplete: { text: "写好的文案" },
    miniappSaveFile: { ok: true, path: "/Users/me/Downloads/a.png" },
    miniappReadFile: { ok: true, dataUrl: "data:image/png;base64,AAA", name: "a.png", size: 3 },
    miniappLog: { ok: true },
    openFileDialog: { paths: ["/tmp/a.png"] },
    bgRemoveModels: {
      models: [
        { id: "u2netp", bytes: 4_574_861, ready: false, tier: "fast", license: "Apache-2.0", localBytes: 0, inputSize: 320 },
        { id: "silueta", bytes: 44_173_029, ready: true, tier: "balanced", license: "Apache-2.0", localBytes: 44_173_029, inputSize: 320 },
      ],
      defaultModel: "silueta",
      ready: "silueta",
    },
    bgRemoveDownloadModel: { ok: true, path: "/data/engines/bgremove/models/u2netp.onnx", size: 4_574_861 },
    bgRemoveStageSource: { ref: "edit/in/a.png", url: "http://127.0.0.1:19782/edit/in/a.png" },
    miniappNotesList: {
      notes: [{ id: 1, title: "第一条", body: "正文", tags: ["工作"], day: "2026-01-02", images: [] }],
      stats: { notes: 1, images: 0, bytes: 0 },
      agentAccess: true,
    },
    miniappNotesSave: {
      ok: true,
      note: { id: 7, title: "标题", body: "正文", tags: ["工作"], day: "2026-01-02", images: [] },
    },
    miniappNotesDelete: { ok: true },
    miniappNotesSetAgentAccess: { ok: true, enabled: true },
    miniappNotesAttach: {
      ok: true,
      image: {
        ref: "notes/abc123/a.webp",
        url: "http://127.0.0.1:19782/notes/abc123/a.webp",
        path: "/data/images/notes/abc123/a.webp",
        width: 40,
        height: 30,
        bytes: 1200,
      },
    },
    bgRemoveRun: {
      cutout: { ref: "bgremove/x-cutout.png", url: "http://127.0.0.1:19782/bgremove/x-cutout.png" },
      mask: { ref: "bgremove/x-mask.png", url: "http://127.0.0.1:19782/bgremove/x-mask.png" },
      width: 640,
      height: 480,
      model: "silueta",
      inferenceMs: 900,
      totalMs: 1200,
    },
  };
  const deps: MiniAppHostDeps = {
    appId: "bg-remove",
    call: async <T,>(method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "generateImage" && (params as { prompt?: string })?.prompt === "boom") {
        return { records: [], error: "模型炸了" } as T;
      }
      if (method === "transcribeAudio" && String((params as { wavBase64?: string })?.wavBase64).startsWith("BAD")) {
        return { text: "", engine: "error", segments: [], hasSpeakers: false, error: "转写失败" } as T;
      }
      return (results[method] ?? {}) as T;
    },
    lang: () => "zh",
    theme: () => "light",
    capabilities: async () => CAPS,
    openSettings: () => {},
    onSaved: () => {},
    record: async (op) =>
      op === "stop" ? { ok: true, wavBase64: "UklGRg==", seconds: 3 } : { ok: true },
    ...overrides,
  };
  return { deps, calls };
}

function request(action: string, params?: unknown, id = 1) {
  return { channel: MINIAPP_CHANNEL as typeof MINIAPP_CHANNEL, kind: "request" as const, id, action: action as never, params };
}

test("host.ready 返回语言、主题与能力快照", async () => {
  const { deps } = makeDeps();
  const res = await dispatchMiniAppRequest(request("host.ready"), deps);
  expect(res.ok).toBe(true);
  expect(res.result).toEqual({ appId: "bg-remove", lang: "zh", theme: "light", capabilities: CAPS });
});

test("认不出来的动作一律拒绝，并写一条 app.log", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(
    { channel: MINIAPP_CHANNEL, kind: "request", id: 7, action: "rpc.invoke" as never, params: { method: "getSettings" } },
    deps,
  );
  expect(res.ok).toBe(false);
  expect(res.error).toContain("不支持的动作");
  // 只能走 miniappLog，绝不能把 getSettings 转发出去
  expect(calls.map((c) => c.method)).toEqual(["miniappLog"]);
});

test("image.generate 夹取尺寸并禁止改写用户的生图配置", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(
    request("image.generate", { prompt: "一只猫", width: 99999, height: -5, seed: 12 }),
    deps,
  );
  expect(res.ok).toBe(true);
  const call = calls.find((c) => c.method === "generateImage");
  expect(call?.params).toMatchObject({
    prompt: "一只猫",
    width: 4096,
    height: 64,
    seed: 12,
    count: 1,
    persistConfig: false,
  });
  expect(res.result).toMatchObject({ ref: "gen/a.png", width: 1024 });
  expect(String((res.result as { url: string }).url)).toContain("gen/a.png");
});

test("image.generate 缺提示词直接拒，不打扰主进程", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(request("image.generate", { prompt: "   " }), deps);
  expect(res.ok).toBe(false);
  expect(calls.map((c) => c.method)).toEqual(["miniappLog"]);
});

test("模型返回错误时把错误交给小应用，而不是当成成功", async () => {
  const { deps } = makeDeps();
  const res = await dispatchMiniAppRequest(request("image.generate", { prompt: "boom" }), deps);
  expect(res.ok).toBe(false);
  expect(res.error).toBe("模型炸了");
});

test("image.edit 先暂存参考图再用它生图", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(
    request("image.edit", { path: "/Users/me/a.png", prompt: "换成白底" }),
    deps,
  );
  expect(res.ok).toBe(true);
  expect(calls.map((c) => c.method)).toEqual(["stageEditImage", "generateImage"]);
  expect(calls[0]?.params).toEqual({ paths: ["/Users/me/a.png"] });
  expect(calls[1]?.params).toMatchObject({ referenceImageRef: "edit/in/a.png", persistConfig: false });
});

test("image.edit 要求参考图与提示词都在", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(request("image.edit", { path: "/a.png" }), deps);
  expect(res.ok).toBe(false);
  expect(calls.map((c) => c.method)).toEqual(["miniappLog"]);
});

test("bg.status 递出模型清单，localBytes 必须留着（下载进度靠它轮询）", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(request("bg.status"), deps);
  expect(res.ok).toBe(true);
  expect(calls).toEqual([{ method: "bgRemoveModels", params: {} }]);
  const result = res.result as {
    models: Record<string, unknown>[];
    defaultModel: string;
    ready: string;
  };
  expect(result.defaultModel).toBe("silueta");
  expect(result.ready).toBe("silueta");
  // 小应用收不到宿主推送：进度条读的是 localBytes，缺了它下载全程停在 0.0MB
  expect(result.models[0]).toMatchObject({ id: "u2netp", ready: false, localBytes: 0 });
  expect(result.models[1]).toMatchObject({ id: "silueta", ready: true });
  // 不认识的主进程字段不进小应用
  expect(Object.keys(result.models[1]!).sort()).toEqual([
    "bytes",
    "id",
    "license",
    "localBytes",
    "ready",
    "tier",
  ]);
});

test("bg.download 要有模型名，失败时把主进程的错误原样带回来", async () => {
  const { deps, calls } = makeDeps();
  const missing = await dispatchMiniAppRequest(request("bg.download", {}), deps);
  expect(missing.ok).toBe(false);
  expect(calls.map((c) => c.method)).toEqual(["miniappLog"]);

  const ok = await dispatchMiniAppRequest(request("bg.download", { model: "u2netp" }), deps);
  expect(ok.ok).toBe(true);
  expect(calls[calls.length - 1]).toEqual({
    method: "bgRemoveDownloadModel",
    params: { model: "u2netp" },
  });
});

test("bg.download 把主进程的失败当失败，不静默成功", async () => {
  const { deps } = makeDeps({
    call: async <T,>(method: string) =>
      (method === "bgRemoveDownloadModel" ? { ok: false, error: "源全都连不上" } : { ok: true }) as T,
  });
  const res = await dispatchMiniAppRequest(request("bg.download", { model: "u2netp" }), deps);
  expect(res.ok).toBe(false);
  expect(res.error).toBe("源全都连不上");
});

test("bg.run 先暂存源图再抠图，并夹住 refine / maxSize", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(
    request("bg.run", { path: "/Users/me/a.png", model: "silueta", refine: 7, maxSize: 99999 }),
    deps,
  );
  expect(res.ok).toBe(true);
  expect(calls.map((c) => c.method)).toEqual(["bgRemoveStageSource", "bgRemoveRun"]);
  expect(calls[0]?.params).toEqual({ path: "/Users/me/a.png" });
  expect(calls[1]?.params).toMatchObject({
    ref: "edit/in/a.png",
    model: "silueta",
    refine: 1,
    maxSize: 8192,
  });
  // 源图 URL 一起回去：小应用的"原图/结果"对比图靠它显示
  expect(res.result).toMatchObject({
    source: { ref: "edit/in/a.png" },
    cutout: { ref: "bgremove/x-cutout.png" },
    mask: { ref: "bgremove/x-mask.png" },
    width: 640,
    height: 480,
    totalMs: 1200,
  });
});

test("bg.run 不传 maxSize 时不替引擎决定分辨率（原图尺寸是页面的选项）", async () => {
  const { deps, calls } = makeDeps();
  await dispatchMiniAppRequest(request("bg.run", { path: "/a.png" }), deps);
  const params = calls.find((c) => c.method === "bgRemoveRun")?.params as Record<string, unknown>;
  expect(params.maxSize).toBeUndefined();
  expect(params.refine).toBeUndefined();
});

test("bg.run 缺路径直接拒，不碰主进程的暂存", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(request("bg.run", {}), deps);
  expect(res.ok).toBe(false);
  expect(calls.map((c) => c.method)).toEqual(["miniappLog"]);
});

test("audio.record 交给宿主采集：小应用只说开始 / 停止", async () => {
  const seen: string[] = [];
  const { deps, calls } = makeDeps({
    record: async (op) => {
      seen.push(op);
      return op === "stop" ? { ok: true, wavBase64: "UklGRg==", seconds: 3 } : { ok: true };
    },
  });

  const start = await dispatchMiniAppRequest(request("audio.record", { op: "start" }), deps);
  expect(start.ok).toBe(true);

  const stop = await dispatchMiniAppRequest(request("audio.record", { op: "stop" }), deps);
  expect(stop.result).toEqual({ ok: true, wavBase64: "UklGRg==", seconds: 3 });
  expect(seen).toEqual(["start", "stop"]);
  // 采样不能在这里做：iframe 里根本没有麦克风，音频只从宿主侧回来
  expect(calls).toEqual([]);
});

test("audio.record 不传 op 时默认开始，认不出的操作直接拒", async () => {
  const seen: string[] = [];
  const { deps, calls } = makeDeps({
    record: async (op) => {
      seen.push(op);
      return { ok: true };
    },
  });
  await dispatchMiniAppRequest(request("audio.record"), deps);
  expect(seen).toEqual(["start"]);

  const bad = await dispatchMiniAppRequest(request("audio.record", { op: "exec" }), deps);
  expect(bad.ok).toBe(false);
  expect(seen).toEqual(["start"]);
  expect(calls.map((c) => c.method)).toEqual(["miniappLog"]);
});

test("audio.transcribe 关掉记录留存，只回小应用需要的字段", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(
    request("audio.transcribe", { wavBase64: "UklGRg==", diarize: true }),
    deps,
  );
  expect(res.ok).toBe(true);
  expect(calls[0]?.params).toMatchObject({ wavBase64: "UklGRg==", diarize: true, save: false });
  expect(res.result).toEqual({ text: "你好", engine: "whisper-cli", segments: [], hasSpeakers: false });
});

test("text.complete 清洗消息列表并带上 maxTokens", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(
    request("text.complete", {
      system: "你是助手",
      messages: [
        { role: "user", content: "主题" },
        { role: "tool", content: "忽略掉的角色" },
        { role: "assistant", content: "" },
      ],
      maxTokens: 12,
    }),
    deps,
  );
  expect(res.ok).toBe(true);
  const call = calls.find((c) => c.method === "miniappComplete");
  expect(call?.params).toMatchObject({ system: "你是助手", maxTokens: 64 });
  expect((call!.params as { messages: unknown[] }).messages).toEqual([
    { role: "user", content: "主题" },
    { role: "user", content: "忽略掉的角色" },
  ]);
});

test("files.save 必须同时有文件名与内容，成功后通知宿主", async () => {
  const saved: { name: string; path: string }[] = [];
  const { deps, calls } = makeDeps({ onSaved: (info) => saved.push(info) });

  const bad = await dispatchMiniAppRequest(request("files.save", { name: "a.png" }), deps);
  expect(bad.ok).toBe(false);

  const good = await dispatchMiniAppRequest(
    request("files.save", { name: "a.png", dataUrl: "data:image/png;base64,AAA" }),
    deps,
  );
  expect(good.ok).toBe(true);
  expect(calls[calls.length - 1]?.method).toBe("miniappSaveFile");
  expect(saved).toEqual([{ name: "a.png", path: "/Users/me/Downloads/a.png" }]);
});

test("files.pick 把扩展名列表与多选透给系统对话框", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(
    request("files.pick", { types: "wav,mp3", multiple: true }),
    deps,
  );
  expect(res.ok).toBe(true);
  expect(calls[0]?.params).toMatchObject({
    allowedFileTypes: "wav,mp3",
    canChooseFiles: true,
    allowsMultipleSelection: true,
  });
  expect(res.result).toEqual({ paths: ["/tmp/a.png"] });
});

test("host.openSettings 交给宿主路由，不经过 RPC", async () => {
  const opened: (string | undefined)[] = [];
  const { deps, calls } = makeDeps({ openSettings: (tab) => opened.push(tab) });
  const res = await dispatchMiniAppRequest(request("host.openSettings", { tab: "network" }), deps);
  expect(res.ok).toBe(true);
  expect(opened).toEqual(["network"]);
  expect(calls).toEqual([]);
});

test("host.log 带上 appId 转发给主进程", async () => {
  const { deps, calls } = makeDeps();
  await dispatchMiniAppRequest(request("host.log", { event: "picked", message: "ok" }), deps);
  expect(calls[0]).toEqual({
    method: "miniappLog",
    params: { appId: "bg-remove", event: "picked", message: "ok", detail: undefined },
  });
});

test("失败日志只留参数摘要：base64 不进 app.log", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(
    request("audio.transcribe", { wavBase64: "BAD" + "A".repeat(500) }),
    deps,
  );
  expect(res.ok).toBe(false);
  expect(res.error).toBe("转写失败");
  const logCall = calls.find((c) => c.method === "miniappLog");
  const detail =
    (logCall!.params as { detail?: { params?: Record<string, string> } }).detail?.params ?? {};
  expect(detail.wavBase64).toContain("(503)");
  expect(detail.wavBase64!.length).toBeLessThan(260);
});

test("注入的运行时可被小应用直接使用，且不会提前闭合 script 标签", () => {
  const html = injectMiniAppRuntime("<!doctype html><html><head><title>t</title></head><body></body></html>", {
    appId: "bg-remove",
    lang: "zh",
    theme: "dark",
    capabilities: CAPS,
  });
  expect(html).toContain("window.__OMNI_BOOT__=");
  expect(html).toContain('"appId":"bg-remove"');
  expect(html).toContain('"theme":"dark"');
  expect(html).toContain(MINIAPP_BASE_STYLE.slice(0, 40));
  expect(html.indexOf("__OMNI_BOOT__")).toBeLessThan(html.indexOf("window.omni = api"));
  // 注入内容自己不能含 `</script>`，否则整个小应用会从中间断开
  expect(MINIAPP_RUNTIME_SCRIPT).not.toContain("</script>");
  expect(MINIAPP_BASE_STYLE).not.toContain("</style>");
  // 没有 <head> 的页面也要能用（内容前置，照样在业务脚本之前定义 omni）
  const headless = injectMiniAppRuntime("<body>hi</body>", {
    appId: "x",
    lang: "en",
    theme: "light",
    capabilities: CAPS,
  });
  expect(headless.endsWith("<body>hi</body>")).toBe(true);
  expect(headless.indexOf("window.omni = api")).toBeLessThan(headless.indexOf("<body>"));
});

/**
 * 端到端跑一遍运行时（不装浏览器）：用一个假的 window / parent / document 把注入的那段
 * 脚本真跑起来，验证请求配对、ready 事件、失败传播这三条协议主干。
 * 这段脚本是所有小应用的入口，它坏了就是五页全白，值得单独盯住。
 */
async function bootRuntime() {
  const listeners: ((event: { data: unknown }) => void)[] = [];
  const posted: Record<string, unknown>[] = [];
  const attributes: Record<string, string> = {};
  const win = {
    __OMNI_BOOT__: { channel: MINIAPP_CHANNEL, appId: "bg-remove", lang: "zh", theme: "dark", capabilities: CAPS },
    addEventListener: (type: string, fn: (event: { data: unknown }) => void) => {
      if (type === "message") listeners.push(fn);
    },
    omni: undefined as unknown,
  };
  const parent = { postMessage: (msg: Record<string, unknown>) => posted.push(msg) };
  const document = {
    documentElement: {
      setAttribute: (key: string, value: string) => {
        attributes[key] = value;
      },
    },
  };
  new Function("window", "parent", "document", MINIAPP_RUNTIME_SCRIPT)(win, parent, document);
  return {
    omni: win.omni as {
      lang: string;
      ready: Promise<{ lang: string }>;
      files: { pick: (p?: unknown) => Promise<unknown> };
      image: { generate: (p?: unknown) => Promise<unknown> };
      onCapabilities: ((caps: unknown) => void) | null;
    },
    posted,
    attributes,
    /** 宿主回包（相当于 runner 里 post(response)）。 */
    reply: (id: unknown, body: Record<string, unknown>) =>
      listeners[0]!({ data: { channel: MINIAPP_CHANNEL, kind: "response", id, ...body } }),
    event: (event: string, payload: Record<string, unknown>) =>
      listeners[0]!({ data: { channel: MINIAPP_CHANNEL, kind: "event", event, payload } }),
  };
}

test("运行时：请求可配对、ready 带语言与主题、失败会 reject", async () => {
  const rt = await bootRuntime();
  // 启动配置里的主题先落到 <html data-theme>
  expect(rt.attributes["data-theme"]).toBe("dark");

  const lastPosted = () => rt.posted[rt.posted.length - 1]!;
  const picked = rt.omni.files.pick({ types: "png" });
  expect(lastPosted()).toMatchObject({ kind: "request", action: "files.pick", params: { types: "png" } });
  rt.reply(lastPosted().id, { ok: true, result: { paths: ["/a.png"] } });
  expect(await picked).toEqual({ paths: ["/a.png"] });

  rt.event("ready", { appId: "bg-remove", lang: "en", theme: "light", capabilities: CAPS });
  await rt.omni.ready;
  expect(rt.omni.lang).toBe("en");
  expect(rt.attributes["data-theme"]).toBe("light");

  const failed = rt.omni.image.generate({ prompt: "x" });
  rt.reply(lastPosted().id, { ok: false, error: "模型炸了" });
  await expect(failed).rejects.toThrow("模型炸了");

  const untouched = rt.omni.files.pick();
  rt.reply(lastPosted().id, { ok: true, result: {} });
  expect(await untouched).toEqual({});
});

test("运行时：能力事件会回调页面自己的 onCapabilities", async () => {
  const rt = await bootRuntime();
  const seen: unknown[] = [];
  rt.omni.onCapabilities = (caps) => seen.push(caps);
  rt.event("capabilities", { appId: "bg-remove", lang: "zh", theme: "light", capabilities: CAPS });
  expect(seen).toEqual([CAPS]);
});

test("运行时里出现的动作名都在清单内", () => {
  const allowed = new Set(Object.keys(MINIAPP_ACTIONS));
  const called = MINIAPP_RUNTIME_SCRIPT.match(/call\('([a-z]+\.[a-zA-Z]+)'/g) ?? [];
  expect(called.length).toBeGreaterThan(0);
  for (const raw of called) {
    expect(allowed.has(raw.slice("call('".length, -1))).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// 笔记：正文与附件都落在主进程，这一层只管"把不可信输入夹小 + 认得出动作"
// ---------------------------------------------------------------------------

test("notes.list 把笔记与统计递给小应用，字段缺失时有兜底", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(request("notes.list"), deps);
  expect(res.ok).toBe(true);
  expect(calls).toEqual([{ method: "miniappNotesList", params: undefined }]);
  expect((res.result as { notes: unknown[] }).notes.length).toBe(1);
  expect((res.result as { agentAccess: boolean }).agentAccess).toBe(true);

  const bare = await dispatchMiniAppRequest(
    request("notes.list"),
    makeDeps({ call: async <T,>() => ({}) as T }).deps,
  );
  // 读不到 agentAccess 时按"开"处理：默认值就是开，界面据此显示开关状态
  expect(bare.result).toEqual({
    notes: [],
    stats: { notes: 0, images: 0, bytes: 0 },
    agentAccess: true,
  });
});

test("notes.save 夹长度、按规则筛附件，日期不合法就退回今天", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(
    request("notes.save", {
      id: 7,
      title: "x".repeat(400),
      body: "正文",
      day: "2026-2-9",
      tags: [" 工作 ", "工作", "", "生活"],
      // 只有第一条是自己生成的形状；后面两条分别想穿目录、想挂个可执行文件
      images: ["notes/abc123/a.webp", "notes/abc123/../../omni-studio.db", "notes/abc123/x.sh"],
      pinned: true,
    }),
    deps,
  );
  expect(res.ok).toBe(true);
  const saved = calls.find((c) => c.method === "miniappNotesSave");
  const params = saved?.params as Record<string, unknown>;
  expect((params.title as string).length).toBe(200);
  expect(params.body).toBe("正文");
  expect(params.id).toBe(7);
  expect(params.pinned).toBe(true);
  expect(params.tags).toEqual(["工作", "工作", "生活"]);
  expect(params.images).toEqual(["notes/abc123/a.webp"]);
  // 形状不对的日期不进主进程：由桥接层统一兜成"今天"
  expect(params.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(params.day).not.toBe("2026-2-9");
});

test("notes.save 空笔记在本地就被拒，不打扰主进程", async () => {
  const { deps, calls } = makeDeps();
  const res = await dispatchMiniAppRequest(request("notes.save", { title: "  ", body: "\n" }), deps);
  expect(res.ok).toBe(false);
  expect(calls.map((c) => c.method)).toEqual(["miniappLog"]);
});

test("notes.save 把主进程的拒绝当失败，不静默成功", async () => {
  const { deps } = makeDeps({
    call: async <T,>(method: string) =>
      (method === "miniappNotesSave" ? { ok: false, error: "这条笔记已经不存在了" } : {}) as T,
  });
  const res = await dispatchMiniAppRequest(request("notes.save", { title: "标题" }), deps);
  expect(res.ok).toBe(false);
  expect(res.error).toBe("这条笔记已经不存在了");
});

test("notes.remove 必须有 id", async () => {
  const { deps, calls } = makeDeps();
  const missing = await dispatchMiniAppRequest(request("notes.remove", {}), deps);
  expect(missing.ok).toBe(false);
  expect(calls.map((c) => c.method)).toEqual(["miniappLog"]);

  const ok = await dispatchMiniAppRequest(request("notes.remove", { id: 3 }), deps);
  expect(ok.ok).toBe(true);
  expect(calls[calls.length - 1]).toEqual({ method: "miniappNotesDelete", params: { id: 3 } });
});

test("notes.attach 转发图片数据与文件名，缺数据直接拒", async () => {
  const { deps, calls } = makeDeps();
  const empty = await dispatchMiniAppRequest(request("notes.attach", {}), deps);
  expect(empty.ok).toBe(false);
  expect(calls.map((c) => c.method)).toEqual(["miniappLog"]);

  const res = await dispatchMiniAppRequest(
    request("notes.attach", { dataUrl: "data:image/png;base64,AAA", name: "a.png" }),
    deps,
  );
  expect(res.ok).toBe(true);
  expect(calls[calls.length - 1]).toEqual({
    method: "miniappNotesAttach",
    params: { dataUrl: "data:image/png;base64,AAA", name: "a.png" },
  });
  expect((res.result as { image: { ref: string } }).image.ref).toBe("notes/abc123/a.webp");
});

test("桥接层调用的每个主进程方法都在 RPC 契约里（方法名是字符串，类型检查看不见）", () => {
  // `deps.call("miniappNotesSave")` 里的方法名不受 TS 约束：写错了只有真机点到才会发现。
  // 这里把桥接层引用的方法逐个对到 `bun/rpc/index.ts` 的请求契约上，漏一个就红。
  const rpcSource = readFileSync(join(import.meta.dir, "..", "..", "bun", "rpc", "index.ts"), "utf8");
  const bridgeSource = readFileSync(join(import.meta.dir, "miniapp-bridge.ts"), "utf8");
  const methods = [
    ...new Set(
      [...bridgeSource.matchAll(/deps\.call(?:<[^>]*>)?\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]!),
    ),
  ];
  expect(methods.length).toBeGreaterThan(0);
  for (const method of methods) {
    // 请求契约里的声明缩进是 6 空格（handlers 里的实现是 2 空格），认请求那一处
    expect({ method, declared: rpcSource.includes(`      ${method}: {`) }).toEqual({
      method,
      declared: true,
    });
  }
});

test("notes.setAgentAccess 只把布尔值递给主进程", async () => {
  const { deps, calls } = makeDeps();
  const on = await dispatchMiniAppRequest(request("notes.setAgentAccess", { enabled: "yes" }), deps);
  expect(on.ok).toBe(true);
  // 非布尔值一律按 false 处理（参数来自 iframe，不能直接透给主进程）
  expect(calls[calls.length - 1]).toEqual({
    method: "miniappNotesSetAgentAccess",
    params: { enabled: false },
  });
  expect((on.result as { enabled: boolean }).enabled).toBe(true);

  const off = await dispatchMiniAppRequest(request("notes.setAgentAccess", { enabled: true }), deps);
  expect(calls[calls.length - 1]).toEqual({
    method: "miniappNotesSetAgentAccess",
    params: { enabled: true },
  });
  expect(off.ok).toBe(true);
});
