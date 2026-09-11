import { afterAll, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// 独立的临时测试库（跑迁移，得到真实的 image_records 表）
// ---------------------------------------------------------------------------
const tmpDb = `/tmp/image-gen-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

// 这些 mock 提供完整、兼容的形状（含 updateSettings），避免与其他测试文件的
// mock 冲突导致「Export named 'updateSettings' not found」。
mock.module("./db", () => ({ db }));
mock.module("./db/settings", () => ({
  getSetting: () => "",
  updateSettings: () => {},
  getAllSettings: () => ({}),
}));
mock.module("./image-server", () => ({
  getImagesBaseDir: () => `/tmp/img-${process.pid}`,
  getPromptLibraryCacheBase: () => `/tmp/pl-cache-${process.pid}`,
  promptLibraryLocalUrl: (rel: string) => `http://localhost:1/prompt-library/${rel}`,
}));
// 补全 server-info 的全部导出：replace mock 会在同进程内泄漏给其他测试文件
// （如 prompt-library.test 的 IMAGE_SERVER_PORT 导入），缺导出会直接报错。
mock.module("../shared/server-info", () => ({
  IMAGE_SERVER_PORT: 19782,
  DEFAULT_INFERENCE_PORT: "18080",
  PROMPT_LIBRARY_MEDIA_ORIGIN: "https://kunpengtalk.com",
  chatImageUrl: (ref: string) => `http://img.local/${ref}`,
}));
mock.module("./mlx-gen", () => ({
  MLX_MODELS: [],
  findMlxModel: () => null,
}));

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
      apiBase: "https://api.siliconflow.cn/v1",
      apiKey: "sk-live-key",
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
