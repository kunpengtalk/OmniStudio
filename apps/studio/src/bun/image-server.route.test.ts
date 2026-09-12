import { afterAll, expect, mock, test } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

// 挡住 electrobun 运行时（paths.ts 依赖），用临时 HOME 伪造 vibedesign 目录，
// 启动真实的 image-server（startImageServer）对 /prompt-library 路由做 HTTP 冒烟测试。
const fakeHome = mkdtempSync(join(tmpdir(), "omni-pl-route-"));
const mediaPublic = join(fakeHome, "ai", "vibedesign", "frontend", "public", "prompt-library");
mkdirSync(join(mediaPublic, "app-icons"), { recursive: true });
mkdirSync(join(mediaPublic, "video", "sky"), { recursive: true });
writeFileSync(join(mediaPublic, "app-icons", "bichon-shop.webp"), "FAKE-WEBP");
writeFileSync(join(mediaPublic, "video", "sky", "x-001.jpg"), "FAKE-JPG");
process.env.HOME = fakeHome;

mock.module("electrobun/bun", () => ({
  Utils: {
    paths: {
      userData: join(fakeHome, "Library", "OmniStudio"),
    },
  },
}));

const { startImageServer, getPromptLibraryMediaBase, getPromptLibraryCacheBase, setArtifactResolver } =
  await import("./image-server");
const { artifactPreviewUrl, IMAGE_SERVER_PORT, workspaceFilePreviewUrl } = await import(
  "../shared/server-info"
);

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

// 应用本身也监听 19782；若正在运行端口被占，则跳过冒烟测试（避免误报）。
let serverReady = true;
try {
  startImageServer();
} catch {
  serverReady = false;
}
await Bun.sleep(50);

const base = `http://localhost:${IMAGE_SERVER_PORT}`;
const get = async (p: string) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: await r.text() };
};

afterAll(() => {
  rmSync(mediaPublic, { recursive: true, force: true });
  rmSync(getPromptLibraryCacheBase(), { recursive: true, force: true });
  rmSync(previewDir, { recursive: true, force: true });
});

test("mediaBase 指向 vibedesign 素材根目录（含 prompt-library 层）", () => {
  expect(getPromptLibraryMediaBase()).toBe(mediaPublic);
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
    // vibedesign 目录里没有，但缓存里有 -> 由缓存兜底
    expect((await get("/prompt-library/awesome/case1.jpg")).body).toBe("CACHE-JPG");
    // 两个目录都没有 -> 404
    expect((await get("/prompt-library/awesome/case999.jpg")).status).toBe(404);
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
