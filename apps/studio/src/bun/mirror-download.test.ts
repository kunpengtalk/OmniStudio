import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GITHUB_MIRRORS,
  clearSourceProbeCache,
  fetchAssetFromSources,
  githubRawUrls,
  githubReleaseUrls,
} from "./mirror-download";

const realFetch = globalThis.fetch;

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let handler: Handler;
let dir: string;
let dest: string;

/** 假响应体：默认内容不是可读文本，免得被 `looksLikeErrorPage` 判掉。 */
function blob(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(size).fill(0x1f);
}

function reply(body: Uint8Array<ArrayBuffer>, status = 200): Response {
  return new Response(body, { status });
}

/** 一条链路完全不响应（连接挂住）。 */
function hang(): Promise<Response> {
  return new Promise<Response>(() => {});
}

/** 直连 GitHub：探测与真实下载都连不上。 */
function githubDown(url: string): Response | Promise<Response> | undefined {
  if (url.startsWith("https://github.com/")) throw new Error("Unable to connect. Is the computer able to access the url?");
  return undefined;
}

function install(fn: Handler): void {
  handler = fn;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

beforeEach(() => {
  clearSourceProbeCache();
  dir = mkdtempSync(path.join(tmpdir(), "omni-mirror-"));
  dest = path.join(dir, "asset.bin");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("候选链路排序", () => {
  test("直连 GitHub 不通：镜像在前，直连降到最后兜底", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      throw new Error("不该走到这里");
    });
    const urls = await githubReleaseUrls("o/r", "v1", "a.tgz");
    expect(urls).toHaveLength(GITHUB_MIRRORS.length + 1);
    for (const [i, mirror] of GITHUB_MIRRORS.entries()) {
      expect(urls[i]).toBe(`${mirror}https://github.com/o/r/releases/download/v1/a.tgz`);
    }
    expect(urls[urls.length - 1]).toBe("https://github.com/o/r/releases/download/v1/a.tgz");
  });

  test("直连 GitHub 可达：直连排第一（海外用户不必绕镜像）", async () => {
    install((url) => {
      if (url === "https://github.com/robots.txt") return reply(blob(8));
      throw new Error("不该走到这里");
    });
    const urls = await githubReleaseUrls("o/r", "v1", "a.tgz");
    expect(urls[0]).toBe("https://github.com/o/r/releases/download/v1/a.tgz");
  });

  test("raw 文件多一条 jsDelivr（独立 CDN），且排在直连兜底之前", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      throw new Error("不该走到这里");
    });
    const urls = await githubRawUrls("tesseract-ocr/tessdata_fast", "main", "eng.traineddata");
    const jsdelivr = "https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/eng.traineddata";
    expect(urls).toContain(jsdelivr);
    expect(urls.indexOf(jsdelivr)).toBeLessThan(urls.indexOf("https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata"));
  });
});

describe("多链路回退", () => {
  test("第一条通就收工，不再打后面的链路", async () => {
    const hits: string[] = [];
    install((url) => {
      hits.push(url);
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) return reply(blob(4096));
      throw new Error("后面这条不该被请求");
    });

    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("gh-proxy.com");
    expect(res.attempts).toHaveLength(1);
    expect(existsSync(dest)).toBe(true);
    expect(hits.filter((u) => u.startsWith("https://ghfast.top/"))).toHaveLength(0);
  });

  test("HTTP 403 会换下一条链路", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) return reply(blob(32), 403);
      if (url.startsWith("https://ghfast.top/")) return reply(blob(4096));
      throw new Error("不该走到这里");
    });

    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("ghfast.top");
    expect(res.attempts[0]?.error).toBe("HTTP 403");
  });

  test("代理回 200 + HTML 错误页时不算成功（解压前就换源）", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) {
        return reply(new TextEncoder().encode("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>"));
      }
      if (url.startsWith("https://ghfast.top/")) return reply(blob(4096));
      throw new Error("不该走到这里");
    });

    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attempts[0]?.error).toContain("网页");
    expect(res.source).toBe("ghfast.top");
  });

  test("accept 判定内容不可用时同样换源", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) return reply(blob(16));
      if (url.startsWith("https://ghfast.top/")) return reply(blob(4096));
      throw new Error("不该走到这里");
    });

    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
      accept: (_file, _head, bytes) => (bytes >= 4096 ? null : `文件太小（${bytes} 字节）`),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("ghfast.top");
    expect(res.attempts[0]?.error).toContain("文件太小");
  });

  test("accept 自己抛异常时也换源，而不是把整次下载判死", async () => {
    // accept 是调用方的代码（解压 / chmod / 装语言包），抛异常完全可能。它若直接冒出去，
    // 后面的链路一条都不会试、engine.download.all-failed 也不会落 —— 用户看到的是
    // "下载失败"但日志里什么都没有，而其实下一条链路是好的。
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) return reply(blob(16));
      if (url.startsWith("https://ghfast.top/")) return reply(blob(4096));
      throw new Error("不该走到这里");
    });

    let calls = 0;
    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
      accept: () => {
        calls += 1;
        if (calls === 1) throw new Error("tar: 解压失败");
        return null;
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("ghfast.top");
    expect(res.attempts.map((a) => a.host)).toEqual(["gh-proxy.com", "ghfast.top"]);
    expect(res.attempts[0]?.error).toBe("tar: 解压失败");
  });
});

describe("快速失败（不等满）", () => {
  test("链路不响应时按 firstByte 预算掐掉换源", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) return hang();
      if (url.startsWith("https://ghfast.top/")) return reply(blob(4096));
      throw new Error("不该走到这里");
    });

    const started = Date.now();
    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
      budget: { firstByteMs: 80 },
    });
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attempts[0]?.error).toContain("连接超时");
    expect(res.source).toBe("ghfast.top");
    // 关键：没有被那条挂住的链路拖住（否则会等到预算上限之外的很久）。
    expect(elapsed).toBeLessThan(2000);
  });

  test("传输中途一个字节都不来时由停摆看门狗掐掉", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }));
      }
      if (url.startsWith("https://ghfast.top/")) return reply(blob(4096));
      throw new Error("不该走到这里");
    });

    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
      budget: { stallMs: 80 },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attempts[0]?.error).toContain("传输停滞");
  });

  test("一直有数据但总量超预算时由传输预算掐掉", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) {
        // 给一个字节然后保持连接：停摆看门狗够不着，只能靠总预算收场。
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(blob(8)); } }));
      }
      if (url.startsWith("https://ghfast.top/")) return reply(blob(4096));
      throw new Error("不该走到这里");
    });

    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
      budget: { transferMs: 10, stallMs: 10_000 },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attempts[0]?.error).toContain("传输超时");
  });
});

describe("链路对冲（不把耗时相加）", () => {
  test("主链路迟迟不结束时提前开下一条，谁先完成用谁", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) return hang();
      if (url.startsWith("https://ghfast.top/")) return reply(blob(4096));
      throw new Error("不该走到这里");
    });

    const started = Date.now();
    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
      // 主链路迟迟不给结果，但也没到 firstByte 预算 —— 只能靠对冲收场。
      budget: { firstByteMs: 30_000 },
      hedgeAfterMs: 60,
    });
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("ghfast.top");
    // 落败的那条不该出现在“已尝试”里（它是被取代的，不是失败的）。
    expect(res.attempts.map((a) => a.host)).toEqual(["ghfast.top"]);
    // 关键：总耗时接近最快那条，而不是两条相加。
    expect(elapsed).toBeLessThan(2000);
    expect(existsSync(dest)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".part"))).toEqual([]);
  });

  test("落败链路在清理之后才写完盘：自己删掉临时文件，不留残片", async () => {
    // 时间线：主链路内容 t≈100 才收完、写盘被拖到 t≈120（大文件本来就慢），
    // 对冲链路 t≈30 启动、t≈150 完成并赢下这次下载，外层 finally 在 t≈150 扫过一遍
    // 临时文件 —— 此时主链路的 `Bun.write` 已经开始（abort 拦不住已经开始的那次写），
    // 它要到 t≈220 才落盘。没有落盘后的中止检查的话，主链路写完就把 asset.bin.part0
    // 留在目录里：下载明明成功，却多出一个几百 MB 的残片。
    const realWrite = Bun.write;
    Bun.write = (async (...args: Parameters<typeof Bun.write>) => {
      await new Promise((r) => setTimeout(r, 120));
      return realWrite(...args);
    }) as typeof Bun.write;

    /** 内容晚一点才到（模拟慢速链路）：head 与 blob 一样，不会被判成错误页。 */
    const slowBody = (delayMs: number) =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await new Promise((r) => setTimeout(r, delayMs));
            controller.enqueue(blob(4096));
            controller.close();
          },
        }),
        { status: 200 },
      );

    try {
      install((url) => {
        const r = githubDown(url);
        if (r) return r;
        if (url.startsWith("https://gh-proxy.com/")) return slowBody(100);
        if (url.startsWith("https://ghfast.top/")) return reply(blob(2048));
        throw new Error("不该走到这里");
      });

      const res = await fetchAssetFromSources({
        urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
        dest,
        what: "测试引擎",
        source: "app",
        budget: { firstByteMs: 30_000 },
        hedgeAfterMs: 30,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.source).toBe("ghfast.top");
      expect(existsSync(dest)).toBe(true);
      // 等过落败链路的写盘时间，再确认它把残片清掉了。
      await new Promise((r) => setTimeout(r, 400));
      expect(readdirSync(dir).filter((f) => f.includes(".part"))).toEqual([]);
    } finally {
      Bun.write = realWrite;
    }
  });

  test("主链路在阈值内完成就不开对冲", async () => {
    let hedgeRequested = false;
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) return reply(blob(4096));
      hedgeRequested = true;
      return reply(blob(16), 403);
    });

    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "测试引擎",
      source: "app",
      hedgeAfterMs: 5_000,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("gh-proxy.com");
    expect(hedgeRequested).toBe(false);
  });
});

describe("全部失败", () => {
  test("报出每条链路的原因，且不留下半个文件", async () => {
    install((url) => {
      const r = githubDown(url);
      if (r) return r;
      if (url.startsWith("https://gh-proxy.com/")) return reply(blob(32), 403);
      if (url.startsWith("https://ghfast.top/")) return hang();
      throw new Error("不该走到这里");
    });

    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "audio.cpp 推理引擎",
      source: "app",
      budget: { firstByteMs: 60 },
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.attempts).toHaveLength(GITHUB_MIRRORS.length + 1);
    expect(res.error).toContain("audio.cpp 推理引擎下载失败");
    expect(res.error).toContain("gh-proxy.com：HTTP 403");
    expect(res.error).toContain("ghfast.top：连接超时");
    expect(res.error).toContain("github.com：Unable to connect");
    expect(res.error).toContain("先打开代理再点一次");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("失败不动 dest：已装好的文件不能被误删（OCR 的 dest 就是最终路径）", async () => {
    const good = "已经装好的语言包";
    await Bun.write(dest, good);
    install(() => {
      throw new Error("Unable to connect");
    });

    const res = await fetchAssetFromSources({
      urls: await githubReleaseUrls("o/r", "v1", "a.tgz"),
      dest,
      what: "Tesseract 语言包",
      source: "app",
      budget: { firstByteMs: 60 },
    });

    expect(res.ok).toBe(false);
    expect(await Bun.file(dest).text()).toBe(good);
    expect(readdirSync(dir)).toEqual(["asset.bin"]);
  });
});
