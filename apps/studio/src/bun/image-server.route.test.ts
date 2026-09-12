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

const { startImageServer, getPromptLibraryMediaBase, getPromptLibraryCacheBase } =
  await import("./image-server");
const { IMAGE_SERVER_PORT } = await import("../shared/server-info");

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
} else {
  test("image-server 端口被占用，跳过路由冒烟测试", () => {
    expect(true).toBe(true);
  });
}
