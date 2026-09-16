import { afterAll, expect, mock, test } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

// 挡住 electrobun 运行时（paths.ts 依赖），用临时 HOME 伪造 vibedesign 目录，
// 启动真实的 image-server（startImageServer）对 /prompt-library 路由做 HTTP 冒烟测试。
const fakeHome = mkdtempSync(join(tmpdir(), "omni-pl-route-"));
// 换一个测试专用端口：本地开着应用时 19782 被占，整段路由测试会跳过——而媒体 403 恰恰
// 就是在这种"本地从没跑到"的路由上漏出去的（见 imageServerPort 的说明）。
process.env.OMNI_IMAGE_SERVER_PORT = "19799";
const mediaPublic = join(fakeHome, "ai", "vibedesign", "frontend", "public", "prompt-library");
mkdirSync(join(mediaPublic, "app-icons"), { recursive: true });
mkdirSync(join(mediaPublic, "video", "sky"), { recursive: true });
writeFileSync(join(mediaPublic, "app-icons", "bichon-shop.webp"), "FAKE-WEBP");
writeFileSync(join(mediaPublic, "video", "sky", "x-001.jpg"), "FAKE-JPG");
const originalHome = process.env.HOME;
process.env.HOME = fakeHome;

mock.module("electrobun/bun", () => ({
  Utils: {
    paths: {
      userData: join(fakeHome, "Library", "OmniStudio"),
    },
  },
}));

const {
  startImageServer,
  getImagesBaseDir,
  getMediaServerStatus,
  mediaServerId,
  getPromptLibraryMediaBase,
  getPromptLibraryCacheBase,
  setArtifactResolver,
} = await import("./image-server");
const { artifactPreviewUrl, imageServerPort, workspaceFilePreviewUrl } = await import(
  "../shared/server-info"
);
const { readAppLogsInMemory } = await import("./app-log");

// 产出物预览：解析钩子由主进程注册（这里用一张假表），工作区根目录走登记接口。
const previewDir = mkdtempSync(join(tmpdir(), "omni-artifact-preview-"));
mkdirSync(join(previewDir, "assets"), { recursive: true });
writeFileSync(
  join(previewDir, "index.html"),
  '<!doctype html><link rel="stylesheet" href="assets/style.css"><h1>OK</h1>',
);
writeFileSync(join(previewDir, "assets", "style.css"), "h1 { color: red }");
const artifactPaths = new Map<number, string>([
  [7, join(previewDir, "index.html")],
  [8, join(previewDir, "..", "outside.txt")],
]);
setArtifactResolver((id) => artifactPaths.get(id) ?? null);

// 媒体直链路由的素材：聊天图片 / 生成图 / OCR 页图 / TTS 音频都是 images 根目录下的
// 相对路径（URL 由 chatImageUrl 拼成 `http://127.0.0.1:19782/<ref>`）。
const imagesDir = getImagesBaseDir();
mkdirSync(join(imagesDir, "audio"), { recursive: true });
mkdirSync(join(imagesDir, "gen"), { recursive: true });
writeFileSync(join(imagesDir, "audio", "tts-route-test.mp3"), "FAKE-MP3");
writeFileSync(join(imagesDir, "gen", "route-test.png"), "FAKE-PNG");

// startImageServer 不再抛异常（端口被占时探身份 / 报状态 / 等对方退出后接管），
// 因此就绪与否看状态，而不是靠 catch。
startImageServer();
const serverReady = getMediaServerStatus().state === "serving";

const base = `http://localhost:${imageServerPort()}`;
const get = async (p: string) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: await r.text() };
};

// 广场媒体现在由主进程按需取上游（见 prompt-library.ts 的 mediaUrl / fetchPromptMediaUpstream）：
// 这里把"非本地"的请求拦下来，测试便不依赖外网，同时能断言"确实走的是主进程这条链路"。
const upstreamCalls: string[] = [];
let upstreamReply: () => Response = () =>
  new Response(FAKE_JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } });
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(base) || url.includes("127.0.0.1") || url.includes("localhost")) {
    return realFetch(input as RequestInfo, init);
  }
  upstreamCalls.push(url);
  return Promise.resolve(upstreamReply());
}) as typeof fetch;
// 一张最小的合法 JPEG（魔数校验要求 ffd8ff 开头，且至少 12 字节）。
const FAKE_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

afterAll(() => {
  globalThis.fetch = realFetch;
  // HOME 是进程级的，同一个测试进程里后面的文件还要用（homedir() 读的就是它）。
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(mediaPublic, { recursive: true, force: true });
  rmSync(getPromptLibraryCacheBase(), { recursive: true, force: true });
  rmSync(previewDir, { recursive: true, force: true });
  rmSync(join(imagesDir, "audio"), { recursive: true, force: true });
  rmSync(join(imagesDir, "gen"), { recursive: true, force: true });
});

test("mediaBase 指向 vibedesign 素材根目录（含 prompt-library 层）", () => {
  expect(getPromptLibraryMediaBase()).toBe(mediaPublic);
});

test("实例身份：占用端口的是谁、服务的是哪份数据目录", async () => {
  // 端口被占时后启动的实例靠它判断"能不能共用"（同一份数据目录）还是"必须报警"。
  const res = await fetch(`${base}/__omni/media-id`);
  const parsed = res.status === 200 ? ((await res.json()) as { id: string; pid: number }) : null;
  if (serverReady) {
    expect(parsed).toEqual({ id: mediaServerId(), pid: process.pid });
  } else {
    // 端口上占着的不是本进程的媒体服务：绝不能认成"同一份数据目录"。
    // （旧版本构建没有这条路由，拿不到身份，同样按"不是自己人"处理。）
    expect(parsed?.id ?? null).not.toBe(mediaServerId());
    expect(getMediaServerStatus().state).not.toBe("serving");
  }
});

if (serverReady) {
  test("/prompt-library 图片路由正常返回", async () => {
    const webp = await get("/prompt-library/app-icons/bichon-shop.webp");
    expect(webp.status).toBe(200);
    expect(webp.body).toBe("FAKE-WEBP");

    const jpg = await get("/prompt-library/video/sky/x-001.jpg");
    expect(jpg.status).toBe(200);
    expect(jpg.body).toBe("FAKE-JPG");
  });

  test("缺失文件与被禁路径返回非 200", async () => {
    expect((await get("/prompt-library/nonexistent.png")).status).toBe(404);
    expect((await get("/prompt-library/../etc/passwd")).status).not.toBe(200);
  });

  test("本地下载缓存目录也能被 /prompt-library 路由命中", async () => {
    const cacheDir = getPromptLibraryCacheBase();
    mkdirSync(join(cacheDir, "awesome"), { recursive: true });
    writeFileSync(join(cacheDir, "awesome", "case1.jpg"), "CACHE-JPG");
    // vibedesign 目录里没有，但缓存里有 -> 由缓存兜底（不再问上游）
    upstreamCalls.length = 0;
    expect((await get("/prompt-library/awesome/case1.jpg")).body).toBe("CACHE-JPG");
    expect(upstreamCalls).toEqual([]);
  });

  test("本地没有的广场图由主进程按需取上游（界面不再直连第三方 CDN）", async () => {
    upstreamCalls.length = 0;
    const res = await get("/prompt-library/awesome/case999.jpg");
    expect(res.status).toBe(200);
    // 走的是 promptMediaCloudUrl 推出来的云端直链，且**只有主进程**发起了这次请求
    expect(upstreamCalls).toEqual([
      "https://cdn.jsdelivr.net/gh/freestylefly/awesome-gpt-image-2@main/data/images/case999.jpg",
    ]);
  });

  test("上游回的是一张图才放行（HTML 回退页 / 无法推导的路径都是 404）", async () => {
    upstreamReply = () =>
      new Response("<html>not an image</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    expect((await get("/prompt-library/awesome/case-something.jpg")).status).toBe(404);
    upstreamReply = () =>
      new Response(FAKE_JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } });

    // 推导不出云端地址、也不是特例页面的相对路径：连上游都不用问
    upstreamCalls.length = 0;
    expect((await get("/prompt-library/nonexistent.png")).status).toBe(404);
    expect(upstreamCalls).toEqual([]);
  });

  test("媒体直链（TTS 音频 / 生成图）能按相对路径取到", async () => {
    // 这条路由的 pathname 带前导 "/"；早前直接把它交给 safeJoin，被当成绝对路径越界，
    // 于是所有媒体请求一律 403——表现就是「刚生成的音频点预览说文件不存在」。
    const mp3 = await fetch(`${base}/audio/tts-route-test.mp3`);
    expect(mp3.status).toBe(200);
    expect(mp3.headers.get("content-type")).toBe("audio/mpeg");
    expect(await mp3.text()).toBe("FAKE-MP3");

    const png = await fetch(`${base}/gen/route-test.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");

    // 播放器拖动进度条依赖 Range -> 206
    const ranged = await fetch(`${base}/audio/tts-route-test.mp3`, {
      headers: { Range: "bytes=0-3" },
    });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("FAKE");
  });

  test("媒体直链：缺失文件 / 目录 / 越界路径都拿不到内容", async () => {
    expect((await get("/audio/nonexistent.mp3")).status).toBe(404);
    // 目录不是可预览对象（直接读会 EISDIR）
    expect((await get("/audio")).status).toBe(404);
    // 归一化后的 ".." 会被 fetch 自己吃掉，这里用百分号编码确保服务端真的收到越界路径。
    expect((await get("/%2e%2e/omni-studio.db")).status).not.toBe(200);
    expect((await get("/audio/%2e%2e/%2e%2e/omni-studio.db")).status).not.toBe(200);
    // 非法百分号编码：400，而不是把 handler 抛崩变 500。
    expect((await get("/%E0%A4%A.mp3")).status).toBe(400);
  });

  test("媒体请求失败要留下日志（否则整屏预览坏掉时无从查起）", async () => {
    // 首段路径取测试专用名字：日志按「状态码 + 首段」节流，别和上面的用例互相压掉。
    // 越界用 %2f 编码的斜杠：%2e%2e 会被 URL 解析器当成 "." 段提前吃掉（结果是 404 而不是 403）。
    expect((await get("/%2f..%2flogtest-403.png")).status).toBe(403);
    expect((await get("/logtest-404/missing.png")).status).toBe(404);

    const entries = readAppLogsInMemory({ source: "media-server" });
    const forbidden = entries.find((e) => e.event === "media.request.forbidden");
    const missing = entries.find((e) => e.event === "media.request.not_found");
    expect(forbidden?.level).toBe("error");
    expect((forbidden?.detail as { ref?: string } | undefined)?.ref).toContain("logtest-403.png");
    expect(missing?.level).toBe("warn");
    expect((missing?.detail as { ref?: string } | undefined)?.ref).toBe("logtest-404/missing.png");
  });

  test("产出物预览：HTML 按网页返回，同目录相对资源也能取到", async () => {
    const page = await fetch(artifactPreviewUrl(7));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<h1>OK</h1>");

    const css = await fetch(artifactPreviewUrl(7) + "/assets/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("color: red");
  });

  test("产出物预览：未登记的 id / 越界子路径都拿不到文件", async () => {
    expect((await get("/artifact/999")).status).toBe(404);
    expect((await get("/artifact/not-a-number")).status).toBe(404);
    // 8 号登记的是产出物目录之外的文件：解析钩子给了路径，但子路径不能绕出去。
    expect((await get("/artifact/7/../../etc/passwd")).status).not.toBe(200);
  });

  test("产出物 / 工作区预览：多一个斜杠也能取到（空段不参与拼接）", async () => {
    const { registerWorkspaceRoot } = await import("./image-server");
    const rootId = registerWorkspaceRoot(previewDir);

    const page = await fetch(`${base}/workspace/${rootId}//index.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>OK</h1>");

    const css = await fetch(`${base}/artifact/7//assets/style.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("color: red");
  });

  test("工作区预览：只认登记过的 rootId，且不能越出该目录", async () => {
    const { registerWorkspaceRoot } = await import("./image-server");
    const rootId = registerWorkspaceRoot(previewDir);

    const page = await fetch(workspaceFilePreviewUrl(rootId, "index.html"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>OK</h1>");

    const css = await fetch(workspaceFilePreviewUrl(rootId, "assets/style.css"));
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("color: red");

    expect((await get("/workspace/deadbeef/index.html")).status).toBe(404);
    expect((await get(`/workspace/${rootId}/../outside.txt`)).status).not.toBe(200);
    // 目录本身不是可预览对象（空相对路径被 safeJoin 拒掉）
    expect((await get(`/workspace/${rootId}/`)).status).not.toBe(200);
  });
} else {
  test("image-server 端口被占用，跳过路由冒烟测试", () => {
    expect(true).toBe(true);
  });
}
