import { afterAll, expect, mock, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import * as fs from "fs";

import * as schema from "./db/schema";
import type { CloudProviderInfo } from "../shared/cloud-providers";
import { mockModulePartial } from "./test-mocks";

// ---------------------------------------------------------------------------
// 独立的临时测试库（跑迁移，得到真实的 video_records / usage_records 表）
// ---------------------------------------------------------------------------
const tmpDb = `/tmp/video-gen-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite, schema });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

const IMAGES = `/tmp/video-gen-images-${process.pid}`;

await mockModulePartial<typeof import("./db")>("./db", { db });
await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: () => "",
  updateSettings: () => {},
});
await mockModulePartial<typeof import("./image-server")>("./image-server", {
  getImagesBaseDir: () => IMAGES,
});
await mockModulePartial<typeof import("../shared/server-info")>("../shared/server-info", {
  chatImageUrl: (ref: string) => `http://img.local/${ref}`,
});

/**
 * 云端厂商替身：地址**故意带 `/v1`** —— 用户常把接口文档里带版本的整段路径
 * 一起填进「API 地址」，这里就是那次 `…/v1/v2/video_generation` 404 的现场。
 */
const PROVIDER: CloudProviderInfo = {
  id: "minimax",
  name: "MiniMax",
  vendor: "MiniMax",
  baseUrl: "https://api.minimax.chat/v1",
  apiKey: "sk-test",
  models: [],
  enabled: true,
  videoApi: "minimax",
  musicApi: "",
  createdAt: 0,
  updatedAt: 0,
};

await mockModulePartial<typeof import("./cloud-providers")>("./cloud-providers", {
  resolveCloudProvider: (id) => ((id ?? "").trim() === PROVIDER.id ? { ...PROVIDER } : null),
  saveAppModelChoice: () => ({ ok: true }),
});

const { nearestMinimaxDuration, normalizeApiBase, pollVideoRecords, submitVideoGeneration } =
  await import("./video-gen");
const { readAppLogsInMemory } = await import("./app-log");

// ---------------------------------------------------------------------------
// 上游 fetch 替身：每个用例自己决定返回什么
// ---------------------------------------------------------------------------
type Reply = { status: number; body?: string; bytes?: Uint8Array<ArrayBuffer> };
let reply: (url: string) => Reply;
const seenUrls: string[] = [];
/** 最近一次 POST 的请求体（断言请求形状用）。 */
let lastBody: Record<string, unknown> | null = null;

const originalFetch = globalThis.fetch;
globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  seenUrls.push(url);
  lastBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  const r = reply(url);
  return r.bytes
    ? new Response(r.bytes, { status: r.status })
    : new Response(r.body ?? "", { status: r.status });
}) as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  sqlite.close();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(IMAGES, { recursive: true, force: true });
});

/** MiniMax 成功响应：HTTP 200 + base_resp.status_code = 0。 */
function minimaxOk(extra: Record<string, unknown>): string {
  return JSON.stringify({ base_resp: { status_code: 0, status_msg: "success" }, ...extra });
}

/** MiniMax 业务错误：HTTP 200 + base_resp.status_code ≠ 0（1004 = 鉴权失败）。 */
function minimaxBizError(code: number, message: string): string {
  return JSON.stringify({ base_resp: { status_code: code, status_msg: message } });
}

function seedProcessing(over: Partial<typeof schema.videoRecords.$inferInsert> = {}) {
  return db
    .insert(schema.videoRecords)
    .values({
      status: "processing",
      backend: "cloud",
      providerId: PROVIDER.id,
      model: "MiniMax-Hailuo-2.3",
      taskId: "task-1",
      prompt: "两只猫在居酒屋",
      createdAt: Date.now(),
      ...over,
    })
    .returning()
    .get();
}

/** 某事件下、与给定关键字（如 taskId）匹配的最近一条日志；内存日志默认最新在前。 */
function lastLog(event: string, needle: string) {
  const hit = readAppLogsInMemory({ event }).find((e) => JSON.stringify(e).includes(needle));
  return hit ? JSON.stringify(hit) : "";
}

/** 轮询单条记录并取出结果（列表里必然有这一条）。 */
async function pollOne(id: number) {
  const [row] = await pollVideoRecords([id]);
  return row!;
}

/** 把假时钟往前拨一段时间再跑一段逻辑，跑完恢复真实时间。 */
async function withClockAdvanced<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  setSystemTime(Date.now() + ms);
  try {
    return await fn();
  } finally {
    setSystemTime();
  }
}

function submitMiniMax(model = "MiniMax-Hailuo-2.3") {
  return submitVideoGeneration({
    prompt: "两只猫在居酒屋",
    duration: 5,
    resolution: "768P",
    config: { backend: "cloud", providerId: PROVIDER.id, model },
  });
}

// ---------------------------------------------------------------------------
// 地址归一化 / 档位
// ---------------------------------------------------------------------------

test("normalizeApiBase：剥掉误填的 /v1、/v2、/api/v3", () => {
  expect(normalizeApiBase("https://api.minimax.chat/v1", "")).toBe("https://api.minimax.chat");
  expect(normalizeApiBase("https://api.minimax.chat/v2/", "")).toBe("https://api.minimax.chat");
  expect(normalizeApiBase("https://api.minimax.chat/", "")).toBe("https://api.minimax.chat");
  expect(normalizeApiBase("https://api.minimax.chat", "")).toBe("https://api.minimax.chat");
  // 自部署兼容服务：路径里的版本段只在末尾，前面的路径要留着
  expect(normalizeApiBase("http://host/minimax/v2", "")).toBe("http://host/minimax");
  // Seedance：协议前缀是 /api/v3，三种写法都归一到同一个地址
  expect(normalizeApiBase("https://ark.cn-beijing.volces.com", "/api/v3")).toBe(
    "https://ark.cn-beijing.volces.com/api/v3",
  );
  expect(normalizeApiBase("https://ark.cn-beijing.volces.com/api/v3", "/api/v3")).toBe(
    "https://ark.cn-beijing.volces.com/api/v3",
  );
  expect(normalizeApiBase("  ", "")).toBe("");
});

test("时长收敛到 MiniMax 认可的档位（Hailuo 只吃 6 / 10 秒）", () => {
  expect(nearestMinimaxDuration(5)).toBe(6);
  expect(nearestMinimaxDuration(7)).toBe(6);
  expect(nearestMinimaxDuration(8)).toBe(10);
  expect(nearestMinimaxDuration(15)).toBe(10);
  expect(nearestMinimaxDuration(undefined)).toBe(6);
});

// ---------------------------------------------------------------------------
// 提交（官方 v1 契约）
// ---------------------------------------------------------------------------

test("提交走官方 v1：/v1/video_generation + prompt 字符串；地址带 /v1 也不会重复", async () => {
  seenUrls.length = 0;
  reply = () => ({ status: 200, body: minimaxOk({ task_id: "task-submit" }) });

  const res = await submitMiniMax();
  expect(res.error).toBeUndefined();
  expect(res.record?.status).toBe("processing");
  expect(res.record?.taskId).toBe("task-submit");
  expect(res.record?.duration).toBe(6); // 库里记的时长要和发出去的一致（5 → 6）
  expect(seenUrls).toEqual(["https://api.minimax.chat/v1/video_generation"]);
  expect(lastBody?.model).toBe("MiniMax-Hailuo-2.3");
  expect(lastBody?.prompt).toBe("两只猫在居酒屋");
  expect(lastBody?.duration).toBe(6); // 5 秒 → 收敛到 6
  expect(lastBody?.resolution).toBe("768P");
  expect(lastBody?.content).toBeUndefined(); // content[] 是 v2 私约 / Seedance 的形状
});

test("提交返回 HTTP 200 但 base_resp 报鉴权失败：把上游原话与提示一起抛出来", async () => {
  reply = () => ({
    status: 200,
    body: minimaxBizError(1004, "login fail: Please carry the API secret key in the header"),
  });
  const res = await submitMiniMax();
  expect(res.error).toContain("1004");
  expect(res.error).toContain("login fail");
  expect(res.error).toContain("API Key");
});

test("提交撞上 200 + HTML（中转站首页）：直说是网页而不是接口", async () => {
  reply = () => ({
    status: 200,
    body: "<!doctype html><html><head><title>网关</title></head></html>",
  });
  const res = await submitMiniMax();
  expect(res.error).toContain("网页");
  expect(res.error).toContain("模型云服务");
});

test("提交：v1 路由不存在时退回 v2 私约，成功拿回 task_id", async () => {
  seenUrls.length = 0;
  reply = (url) =>
    url.includes("/v1/video_generation")
      ? { status: 404, body: "404 page not found" }
      : { status: 200, body: minimaxOk({ task_id: "task-v2" }) };

  const res = await submitMiniMax();
  expect(res.error).toBeUndefined();
  expect(res.record?.taskId).toBe("task-v2");
  expect(seenUrls).toEqual([
    "https://api.minimax.chat/v1/video_generation",
    "https://api.minimax.chat/v2/video_generation",
  ]);
});

test("提交：两套路径都不存在时，报错要说清这地址不是 MiniMax 视频服务", async () => {
  reply = () => ({ status: 404, body: "404 page not found" });
  const res = await submitMiniMax();
  expect(res.error).toContain("MiniMax 视频接口");
  expect(res.error).toContain("/v1/video_generation");
  expect(res.error).toContain("/v2/video_generation");
});

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

test("轮询成功：只有 file_id 时再查 /files/retrieve 拿下载地址并落盘", async () => {
  const seeded = seedProcessing({ taskId: "task-ok" });
  seenUrls.length = 0;
  reply = (url) => {
    if (url.includes("/query/video_generation")) {
      return { status: 200, body: minimaxOk({ status: "Success", file_id: "file-1" }) };
    }
    if (url.includes("/files/retrieve")) {
      return {
        status: 200,
        body: minimaxOk({ file: { download_url: "https://cdn.example/abc.mp4" } }),
      };
    }
    return { status: 200, bytes: new Uint8Array([1, 2, 3, 4]) };
  };

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("done");
  expect(row.videoPath).toMatch(/^videos\/.+\.mp4$/);
  expect(row.videoUrl).toBe(`http://img.local/${row.videoPath}`);
  expect(seenUrls[0]).toBe("https://api.minimax.chat/v1/query/video_generation?task_id=task-ok");
  expect(seenUrls[1]).toBe("https://api.minimax.chat/v1/files/retrieve?file_id=file-1");
});

test("轮询遇 200 + base_resp 1004：宽限期内亮出原因，过期才标失败", async () => {
  const seeded = seedProcessing({ taskId: "task-1004" });
  reply = () => ({ status: 200, body: minimaxBizError(1004, "login fail: ...") });

  const first = await pollOne(seeded.id);
  expect(first.status).toBe("processing");
  expect(first.pollError).toContain("1004");
  expect(first.pollError).toContain("API Key");
  expect(lastLog("video.poll.http", "task-1004")).toContain('"level":"error"');

  const late = await withClockAdvanced(4 * 60_000, () => pollOne(seeded.id));
  expect(late.status).toBe("failed");
  expect(late.error).toContain("1004");
  expect(lastLog("video.poll.failed", "task-1004")).toContain("task-1004");
});

test("轮询遇 5xx：保留 processing，把原因透到界面并记 warn 日志", async () => {
  const seeded = seedProcessing({ taskId: "task-503" });
  reply = () => ({ status: 503, body: "service unavailable" });

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("processing");
  expect(row.pollError).toContain("503");
  expect(lastLog("video.poll.http", "task-503")).toContain('"level":"warn"');
});

test("轮询：两套查询路径都不存在时指向「地址不对」，并给宽限期", async () => {
  const seeded = seedProcessing({ taskId: "task-404" });
  reply = () => ({ status: 404, body: "404 page not found" });

  const first = await pollOne(seeded.id);
  expect(first.status).toBe("processing");
  expect(first.pollError).toContain("任务查询接口");
  expect(first.pollError).toContain("https://api.minimax.chat");

  const late = await withClockAdvanced(4 * 60_000, () => pollOne(seeded.id));
  expect(late.status).toBe("failed");
});

test("轮询：上游说任务没了（JSON 404）是终态，立刻失败而不是等超时", async () => {
  const seeded = seedProcessing({ taskId: "task-notfound" });
  reply = () => ({
    status: 404,
    body: JSON.stringify({ base_resp: { status_code: 1013, status_msg: "task not found" } }),
  });

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("failed");
  expect(row.error).toContain("任务不存在");
});

test("轮询：v1 查不到时落到 v2 路径并记住；已完成的记录不再轮询", async () => {
  const seeded = seedProcessing({ taskId: "task-v2-poll" });
  seenUrls.length = 0;
  reply = (url) =>
    url.includes("/v1/query/video_generation")
      ? { status: 404, body: "404 page not found" }
      : {
          status: 200,
          body: JSON.stringify({
            status: "Success",
            content: { url: "https://cdn.example/v2.mp4" },
          }),
        };

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("done");
  expect(seenUrls).toEqual([
    "https://api.minimax.chat/v1/query/video_generation?task_id=task-v2-poll",
    "https://api.minimax.chat/v2/query/video_generation/task-v2-poll",
    "https://cdn.example/v2.mp4",
  ]);

  seenUrls.length = 0;
  const again = await pollOne(seeded.id);
  expect(again.status).toBe("done");
  expect(seenUrls.length).toBe(0); // 已是终态：不再打上游
});

test("记录里的厂商已被删除：直接失败，不拖到 30 分钟超时", async () => {
  const seeded = seedProcessing({ providerId: "gone-provider", taskId: "task-gone-provider" });
  reply = () => ({ status: 200, body: minimaxOk({}) });

  const row = await pollOne(seeded.id);
  expect(row.status).toBe("failed");
  expect(row.error).toContain("无法继续查询上游状态");
});
