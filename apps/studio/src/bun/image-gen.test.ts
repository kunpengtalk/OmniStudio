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
await mockModulePartial<typeof import("./db")>("./db", { db });
await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: () => "",
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
const { generateImage } = await import("./image-gen");

afterAll(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`/tmp/img-${process.pid}`, { recursive: true, force: true });
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
