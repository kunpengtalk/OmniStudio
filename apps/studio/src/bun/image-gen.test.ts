import { afterAll, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import * as fs from "fs";

import * as schema from "./db/schema";
import { mockModulePartial } from "./test-mocks";

// ---------------------------------------------------------------------------
// 独立的临时测试库（跑迁移，得到真实的 image_records 表）
// ---------------------------------------------------------------------------
const tmpDb = `/tmp/image-gen-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite, schema });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

// 设置层用「真实导出 + 局部覆盖」：不用再手工补齐形状，真实模块新增导出时自动跟上
// （缺导出会在 import 阶段直接报 "Export named ... not found"）。
const settings: Record<string, string> = {};
await mockModulePartial<typeof import("./db")>("./db", { db });
await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: (key: string) => settings[key] ?? "",
  updateSettings: () => {},
  getAllSettings: () => ({}),
});
await mockModulePartial<typeof import("./image-server")>("./image-server", {
  getImagesBaseDir: () => `/tmp/img-${process.pid}`,
  getPromptLibraryCacheBase: () => `/tmp/pl-cache-${process.pid}`,
  promptLibraryLocalUrl: (rel) => `http://localhost:1/prompt-library/${rel}`,
});
// server-info 用「真实导出 + 局部覆盖」：以前这里要手工把全部导出列一遍，否则
// import 这个模块的其它文件（prompt-library.test 的 PROMPT_LIBRARY_MEDIA_ORIGIN 等）
// 会直接报 "Export named ... not found"。
await mockModulePartial<typeof import("../shared/server-info")>("../shared/server-info", {
  chatImageUrl: (ref: string) => `http://img.local/${ref}`,
});
await mockModulePartial<typeof import("./mlx-gen")>("./mlx-gen", {
  MLX_MODELS: [],
  findMlxModel: () => null,
});
// 云端地址 / 密钥来自服务商行（页面只带 providerId）：mock 掉服务商查询，
// 让"页面实时配置"这条回归测试仍然能验证实时值优先。
await mockModulePartial<typeof import("./cloud-providers")>("./cloud-providers", {
  resolveCloudProvider: (id) =>
    (id ?? "").trim() === "live-provider"
      ? {
          id: "live-provider",
          name: "Live",
          vendor: "测试",
          baseUrl: "https://api.siliconflow.cn/v1",
          apiKey: "sk-live-key",
          models: [],
          enabled: true,
          videoApi: "",
          musicApi: "",
          createdAt: 0,
          updatedAt: 0,
        }
      : null,
  saveAppModelChoice: () => ({ ok: true }),
  ensureAppProvidersMigrated: () => {},
});

// ---------------------------------------------------------------------------
// mock 远程 OpenAI 兼容 API 的 fetch：成功返回一张 b64 图片
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
const PNG = "iVBORw0KGgoAAAANSUhEUg=="; // 1x1 占位 PNG（base64）
globalThis.fetch = mock(async (url: URL | string) => {
  const u = String(url);
  if (u.includes("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "Kwai-Kolors/Kolors" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (u.includes("/images/generations")) {
    return new Response(
      JSON.stringify({ data: [{ b64_json: PNG }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response("Not Found", { status: 404 });
}) as never;

// 所有 mock 注册后再动态加载被测模块。
const { generateImage, listImageGenModelIds, upstreamErrorText, modelNotFoundHint } =
  await import("./image-gen");

test("上游报错取 message，而不是把整段 JSON 丢给用户", async () => {
  // 国内聚合网关的信封是 { code, message }（不是 OpenAI 的 { error: { message } }）：
  // 只认后者的结果是小应用里直接显示 {"code":20012,"message":"Model does not exist…"}
  expect(upstreamErrorText('{"code":20012,"message":"Model does not exist.","data":null}')).toBe(
    "Model does not exist.",
  );
  expect(upstreamErrorText('{"error":{"message":"bad key"}}')).toBe("bad key");
  expect(upstreamErrorText('{"error":"plain string"}')).toBe("plain string");
  // 非 JSON 原样保留（有些网关直接回一段 HTML / 纯文本）
  expect(upstreamErrorText("<html>502</html>")).toBe("<html>502</html>");
  expect(upstreamErrorText("")).toBe("");
});

test("「模型不存在」补一句能照着做的提示（并带上厂商名）", async () => {
  const message = '{"code":20012,"message":"Model does not exist. Please check it carefully."}';
  const text = upstreamErrorText(message);
  const hinted = modelNotFoundHint(text, "z-image-turbo", "硅基流动");
  expect(hinted).toContain("硅基流动");
  expect(hinted).toContain("z-image-turbo");
  expect(hinted).toContain("图像生成");
  // 原始报错留着：排查时要能看到上游到底说了什么
  expect(hinted).toContain("Model does not exist");

  // 别的错误一个字都不改（别把网络超时、鉴权失败也套上"换模型"的结论）
  expect(modelNotFoundHint("connection reset", "flux", "硅基流动")).toBe("connection reset");
  expect(modelNotFoundHint("Incorrect API key", "flux")).toBe("Incorrect API key");
  // 没给厂商名时也要成句
  expect(modelNotFoundHint("Model does not exist", "x")).toContain("当前厂商");
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`/tmp/img-${process.pid}`, { recursive: true, force: true });
});

test("列模型用的密钥来自选中的厂商行，页面不参与", async () => {
  // 页面唯一能选的是"哪个厂商"（IMG_PROVIDER_ID）；密钥从这里解析。
  // 曾经的写法是 RPC 接页面传的 apiKey，而页面传的是空串 —— 空串不被 `??` 拦下，
  // 于是一次"列模型"请求无声地丢掉了 Authorization，需要鉴权的上游只回 401。
  const calls: { url: string; auth: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ data: [{ id: "Kwai-Kolors/Kolors" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as never;
  settings.IMG_PROVIDER_ID = "live-provider";

  const models = await listImageGenModelIds("api");

  expect(models).toContain("Kwai-Kolors/Kolors");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.siliconflow.cn/v1/models");
  expect(calls[0]!.auth).toBe("Bearer sk-live-key");

  globalThis.fetch = realFetch;
  delete settings.IMG_PROVIDER_ID;
});

// 回归测试：即使数据库里是旧/空的配置，只要前端带上实时 config，生成也应成功。
test("generateImage 使用页面实时配置，杜绝连到旧配置", async () => {
  const res = await generateImage({
    prompt: "a red apple",
    width: 1024,
    height: 1024,
    config: {
      backend: "api",
      providerId: "live-provider",
      model: "Kwai-Kolors/Kolors",
      comfyBase: "",
    },
  });

  expect(res.error).toBeUndefined();
  expect(res.records.length).toBe(1);
  expect(res.records[0]!.status).toBe("done");
  expect(res.records[0]!.backend).toBe("api");
  // 生成的模型应来自页面实时配置。
  expect(res.records[0]!.model).toBe("Kwai-Kolors/Kolors");
  expect(res.records[0]!.imageUrl).toContain("http://img.local/");
});
