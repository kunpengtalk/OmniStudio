import { afterAll, expect, mock, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { dirname, join } from "path";
import * as fs from "fs";
import * as os from "os";

// ---------------------------------------------------------------------------
// 不做模块 mock：bunfig 的 test-preload 已把 OMNI_DATA_DIR / OMNI_DB_PATH 指向
// 本进程专属的临时目录，真实的 db（含迁移）与 images 目录天然隔离。
// 在这里 mock ./db 或 ./image-server 会泄漏给同进程的其它测试文件
// （例如 prompt-library.test 断言 getPromptLibraryMediaBase 的真实取值）。
// ---------------------------------------------------------------------------
const { buildMediaReadTools, buildMediaGenTools } = await import("./media-tools");
const { db } = await import("./db");
const { imageRecords, videoRecords, voiceRecords } = await import("./db/schema");
const { getSetting, updateSettings } = await import("./db/settings");
const { getImagesBaseDir } = await import("./image-server");

const originalFetch = globalThis.fetch;
const imagesDir = getImagesBaseDir();
const workspace = fs.mkdtempSync(join(os.tmpdir(), "media-tools-ws-"));

/** 测试会改写这些设置，afterAll 时原样还原。 */
const TOUCHED_SETTINGS = [
  "IMG_BACKEND",
  "IMG_API_BASE",
  "IMG_API_KEY",
  "IMG_MODEL",
  "TTS_LOCAL_ENGINE",
  "TTS_PROVIDER_BASE",
  "VIDEO_BACKEND",
  "VIDEO_MINIMAX_BASE",
] as const;
const originalSettings = Object.fromEntries(
  TOUCHED_SETTINGS.map((key) => [key, getSetting(key)]),
);

const ctx = { workspace, allowShell: false };
const tool = (name: string) => buildMediaGenTools(ctx).find((t) => t.name === name)!;
/** 工具结果里只关心文本块（图片块暂未使用）。 */
const textOf = (res: { content: readonly { type: string; text?: string }[] }) =>
  res.content.map((c) => c.text ?? "").join("\n");

function writeLibraryFile(ref: string, content = "binary"): string {
  const abs = join(imagesDir, ref);
  fs.mkdirSync(dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// ---------------------------------------------------------------------------
// 素材样本：用户手工生成的图 / 视频 / 语音 + Agent 生成的一张图
// ---------------------------------------------------------------------------
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
writeLibraryFile("gen/cat.png");
writeLibraryFile("gen/ginkgo.png");
writeLibraryFile("videos/demo.mp4");
writeLibraryFile("audio/tts-demo.mp3");

db.insert(imageRecords)
  .values({
    status: "done",
    source: "manual",
    prompt: "一只在窗台晒太阳的橘猫",
    imagePath: "gen/cat.png",
    width: 1024,
    height: 768,
    model: "z-image-turbo",
    createdAt: Date.now() - HOUR,
  })
  .run();
db.insert(imageRecords)
  .values({
    status: "done",
    source: "agent",
    prompt: "文章配图：秋天的银杏大道",
    imagePath: "gen/ginkgo.png",
    width: 1344,
    height: 768,
    model: "flux-schnell",
  })
  .run();
db.insert(videoRecords)
  .values({
    status: "done",
    source: "manual",
    prompt: "城市夜景延时",
    videoPath: "videos/demo.mp4",
    duration: 5,
    ratio: "16:9",
    model: "MiniMax-H3",
    createdAt: Date.now() - 2 * DAY,
  })
  .run();
db.insert(voiceRecords)
  .values({
    kind: "tts",
    source: "manual",
    text: "大家好，这是公众号的第一段语音。",
    audioPath: "audio/tts-demo.mp3",
    model: "IndexTTS2.5 (audio.cpp)",
    voice: "默认",
  })
  .run();

afterAll(() => {
  globalThis.fetch = originalFetch;
  updateSettings({ ...originalSettings });
  fs.rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// media_search
// ---------------------------------------------------------------------------

test("media_search 把用户手工生成和 Agent 生成的素材连同日期一起列出来", async () => {
  const text = textOf(await buildMediaReadTools()[0]!.execute("t1", {}));

  expect(text).toContain("用户手工生成");
  expect(text).toContain("Agent 生成");
  expect(text).toContain("一只在窗台晒太阳的橘猫");
  expect(text).toContain("gen/cat.png");
  expect(text).toContain("videos/demo.mp4");
  expect(text).toContain("audio/tts-demo.mp3");
  // 日期、绝对路径与复用指引都要给到 Agent。
  expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  expect(text).toContain(join(imagesDir, "gen/cat.png"));
  expect(text).toContain("复用方式");
  // 素材库总量概览：Agent 得知道"积累了多少东西"，而不是只看这一页。
  const overview = /素材库一共 (\d+) 项（图片 (\d+) \/ 语音 (\d+) \/ 视频 (\d+)）/.exec(text);
  expect(overview).not.toBeNull();
  expect(Number(overview![2])).toBeGreaterThanOrEqual(2); // 图片
  expect(Number(overview![3])).toBeGreaterThanOrEqual(1); // 语音
  expect(Number(overview![4])).toBeGreaterThanOrEqual(1); // 视频
});

test("media_search 支持按来源 / 关键词 / 类型 / 时间过滤", async () => {
  const search = buildMediaReadTools()[0]!;

  const agentOnly = textOf(await search.execute("t", { source: "agent" }));
  expect(agentOnly).toContain("秋天的银杏大道");
  expect(agentOnly).not.toContain("橘猫");

  const byKeyword = textOf(await search.execute("t", { query: "橘猫" }));
  expect(byKeyword).toContain("gen/cat.png");
  expect(byKeyword).not.toContain("ginkgo");

  const audioOnly = textOf(await search.execute("t", { kind: "audio" }));
  expect(audioOnly).toContain("audio/tts-demo.mp3");
  expect(audioOnly).not.toContain("gen/cat.png");

  const recent = textOf(await search.execute("t", { days: 1 }));
  expect(recent).toContain("gen/cat.png");
  expect(recent).not.toContain("videos/demo.mp4"); // 两条视频在 2 天前

  expect(textOf(await search.execute("t", { query: "不存在的素材关键词" }))).toContain("没有匹配");
});

// ---------------------------------------------------------------------------
// generate_image
// ---------------------------------------------------------------------------

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg=="; // 1x1 占位 PNG

test("generate_image 用已配置的后端出图、标记 agent 来源，并把结果复制进工作区", async () => {
  updateSettings({
    IMG_BACKEND: "api",
    IMG_API_BASE: "http://127.0.0.1:9/v1",
    IMG_API_KEY: "",
    IMG_MODEL: "test-model",
  });
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as never;

  const res = await tool("generate_image").execute("t1", {
    prompt: "公众号头图：秋天的银杏大道，暖色调",
    aspect_ratio: "16:9",
    save_to: "gen-assets",
  });
  const text = textOf(res);

  expect(text).toContain("已生成 1 张图片");
  expect(text).toContain("1344x768"); // 16:9 映射
  expect(text).toContain("gen-assets/image-1.png");

  const row = db.select().from(imageRecords).orderBy(desc(imageRecords.id)).get()!;
  expect(row.source).toBe("agent");
  expect(row.prompt).toContain("银杏");
  expect(row.model).toBe("test-model");
  expect(fs.existsSync(join(workspace, "gen-assets/image-1.png"))).toBe(true);

  // 参考图必须落在 images 目录内：越界引用直接报错，不读取任意文件。
  const bad = textOf(
    await tool("generate_image").execute("t2", { prompt: "x", reference: "../../etc/passwd" }),
  );
  expect(bad).toContain("找不到参考图");

  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// media_export
// ---------------------------------------------------------------------------

test("media_export 复制素材进工作区：自定义文件名、自动防重名、拒绝越界", async () => {
  const exportTool = tool("media_export");
  const ref = "gen/cat.png";

  const named = textOf(await exportTool.execute("t1", { refs: [ref], save_to: "assets", name: "cover.png" }));
  expect(named).toContain("assets/cover.png");
  expect(fs.existsSync(join(workspace, "assets/cover.png"))).toBe(true);

  const first = textOf(await exportTool.execute("t2", { refs: [ref], save_to: "assets" }));
  expect(first).toContain("assets/image-1.png");

  const second = textOf(await exportTool.execute("t3", { refs: [ref], save_to: "assets" }));
  expect(second).toContain("assets/image-2.png"); // 不覆盖上一次的 image-1.png

  // 支持 `image#<id>` 句柄（用用户手工生成的那张验证）
  const ginkgo = db
    .select()
    .from(imageRecords)
    .where(eq(imageRecords.prompt, "文章配图：秋天的银杏大道"))
    .get()!;
  const byId = textOf(await exportTool.execute("t4", { refs: [`image#${ginkgo.id}`], save_to: "assets" }));
  expect(byId).toContain("gen/ginkgo.png");
  expect(fs.existsSync(join(workspace, "assets/image-3.png"))).toBe(true);

  // ref 穿越出 images 目录 → 视为找不到；目标目录穿越出工作区 → 直接报错。
  expect(textOf(await exportTool.execute("t5", { refs: ["../../etc/passwd"], save_to: "assets" }))).toContain(
    "找不到这些素材",
  );
  expect(textOf(await exportTool.execute("t6", { refs: [ref], save_to: "../outside" }))).toContain(
    "media_export failed",
  );
  expect(fs.existsSync(join(workspace, "..", "outside"))).toBe(false);
});

// ---------------------------------------------------------------------------
// generate_speech / generate_video（无可用后端时的失败路径，不联网）
// ---------------------------------------------------------------------------

test("generate_speech 没有可用引擎时给出明确错误，超长文本直接拒绝", async () => {
  updateSettings({ TTS_LOCAL_ENGINE: "", TTS_PROVIDER_BASE: "" });
  const speech = tool("generate_speech");

  expect(textOf(await speech.execute("t1", { text: "测试", engine: "local" }))).toContain("本地引擎未启动");
  expect(textOf(await speech.execute("t2", { text: "测试", engine: "provider" }))).toContain(
    "未配置三方 TTS Provider",
  );
  expect(textOf(await speech.execute("t3", { text: "啊".repeat(5001) }))).toContain("文本太长");
});

test("generate_video 提交失败时，失败记录同样带 agent 来源标记", async () => {
  updateSettings({ VIDEO_BACKEND: "minimax", VIDEO_MINIMAX_BASE: "" });

  const text = textOf(await tool("generate_video").execute("t1", { prompt: "城市夜景延时" }));
  expect(text).toContain("视频提交失败");

  const row = db.select().from(videoRecords).orderBy(desc(videoRecords.id)).get()!;
  expect(row.source).toBe("agent");
  expect(row.status).toBe("failed");
});

// ---------------------------------------------------------------------------
// 弹窗介入：缺配置时 generate_image 会停下来等用户，确认后接着把图生成完
// ---------------------------------------------------------------------------

test("generate_image 缺配置时弹窗，用户确认后继续生图（不改上下文、不重开一轮）", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "", IMG_API_KEY: "", IMG_MODEL: "" });
  const MediaSetup = await import("./media-setup");

  const seen: string[] = [];
  const stop = MediaSetup.onMediaSetup((payload) => {
    seen.push(payload.reason);
    // 模拟界面：用户填了地址并选定模型后点「确认并继续生图」。
    MediaSetup.resolveMediaSetup(payload.id, {
      action: "confirm",
      backend: "api",
      apiBase: "http://127.0.0.1:9/v1",
      model: "dialog-model",
    });
  });

  globalThis.fetch = mock(
    async (url: URL | string) =>
      String(url).includes("/images/generations")
        ? new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : new Response("Not Found", { status: 404 }),
  ) as never;

  try {
    const res = await tool("generate_image").execute("t1", {
      prompt: "弹窗确认之后继续生图",
      save_to: "dialog-assets",
    });
    const text = textOf(res);

    expect(seen).toEqual(["missing-config"]);
    expect(text).toContain("已生成 1 张图片");
    expect(text).toContain("dialog-model");

    const row = db.select().from(imageRecords).orderBy(desc(imageRecords.id)).get()!;
    expect(row.model).toBe("dialog-model");
    expect(row.source).toBe("agent");
    expect(fs.existsSync(join(workspace, "dialog-assets/image-1.png"))).toBe(true);
  } finally {
    stop();
    globalThis.fetch = originalFetch;
  }
});

test("用户在弹窗里取消：generate_image 不生成，并明确告诉模型别再重试", async () => {
  updateSettings({ IMG_BACKEND: "api", IMG_API_BASE: "", IMG_API_KEY: "", IMG_MODEL: "" });
  const MediaSetup = await import("./media-setup");
  const before = db.select().from(imageRecords).orderBy(desc(imageRecords.id)).get()!.id;

  const stop = MediaSetup.onMediaSetup((payload) => {
    MediaSetup.resolveMediaSetup(payload.id, { action: "cancel" });
  });

  try {
    const text = textOf(await tool("generate_image").execute("t1", { prompt: "不该生成" }));
    expect(text).toContain("取消了");
    expect(text).toContain("不要重试");
    // 没有新记录落库。
    expect(db.select().from(imageRecords).orderBy(desc(imageRecords.id)).get()!.id).toBe(before);
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// 对外接口：网关 MCP / REST（同一份检索实现）
// ---------------------------------------------------------------------------

test("对外接口（MCP / REST）与应用内检索共用同一套结果", async () => {
  const { handleMediaMcpCall, isMediaMcpTool, searchMediaAssets } = await import("./media-api");

  expect(isMediaMcpTool("media_search")).toBe(true);
  expect(isMediaMcpTool("kb_search")).toBe(false);
  expect(isMediaMcpTool("memory_search")).toBe(false);

  // MCP：工具名对了就给可读文本，未知工具报错。
  const viaMcp = await handleMediaMcpCall("media_search", { kind: "image", source: "manual" });
  expect(viaMcp.isError).toBeUndefined();
  expect(viaMcp.text).toContain("橘猫");
  expect(await handleMediaMcpCall("media_export", {})).toMatchObject({ isError: true });

  // REST：结构化结果带上绝对路径与可播放 URL，方便外部程序直接复用。
  const { count, assets, text } = searchMediaAssets({ limit: 10 });
  expect(count).toBe(assets.length);
  expect(count).toBeGreaterThanOrEqual(3);
  expect(text).toContain("素材库一共");

  const image = assets.find((a) => a.ref === "gen/cat.png")!;
  expect(image.kind).toBe("image");
  expect(image.source).toBe("manual");
  expect(image.path).toBe(join(imagesDir, "gen/cat.png"));
  expect(image.url).toContain("gen/cat.png");
  expect(image.status).toBe("done");
  expect(assets.some((a) => a.kind === "audio" && a.ref === "audio/tts-demo.mp3")).toBe(true);
  expect(assets.some((a) => a.kind === "video" && a.ref === "videos/demo.mp4")).toBe(true);
});
