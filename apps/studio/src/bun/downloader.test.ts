import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { downloadWithResume, partialBytesFor, removePartialFiles } from "./downloader";

/**
 * 下载内核的离线测试：假服务器支持 Range / 返回 503 / 卡死 / 忽略 Range /
 * 返回错区间，覆盖并发续传、重试、装配与旧格式迁移。
 *
 * 数据用 index % 251 生成，逐字节可校验；不依赖外网。
 */

function makeData(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  return buf;
}

type ServerConfig = {
  data: Uint8Array;
  /** 前 N 次请求返回 503（测重试）。 */
  failFirst?: number;
  /** 命中后返回一次错区间（测 Content-Range 校验）。 */
  wrongRangeOnce?: boolean;
  /** 首次请求卡死一次（测卡死重连）。 */
  stallOnce?: boolean;
  /** 卡死时长。 */
  stallOnceMs?: number;
  /**
   * 分片之间的间隔（毫秒）。回环 + 64KB 分片下，512KB 常在客户端处理第一次进度
   * 回调之前就发完了，「下到一半中断」这类用例于是在快机器上随机失败；给分片之间
   * 加一点间隔，中断点才是确定的。
   */
  chunkDelayMs?: number;
  /** 服务器忽略 Range，总是回 200 全量。 */
  ignoreRange?: boolean;
  /** 只让「从 0 开始的区间」失败（构造前缀分片失败的场景）。 */
  failFromZero?: boolean;
  /** 统计。 */
  requests?: { ranges: string[]; total: number };
};

function startServer(cfg: ServerConfig) {
  const requests = cfg.requests ?? { ranges: [], total: 0 };
  let remainingFailures = cfg.failFirst ?? 0;
  let wrongRangePending = cfg.wrongRangeOnce ?? false;
  // 第一条请求卡死一次：测卡死重连时，重连后必须能正常下完。
  let stallPending = cfg.stallOnce ?? false;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.total += 1;
      const range = req.headers.get("range");
      if (range) requests.ranges.push(range);

      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return new Response("boom", { status: 503 });
      }

      const total = cfg.data.byteLength;
      const chunk = 64 * 1024;
      const stallThisRequest = stallPending;
      stallPending = false;
      const makeStream = (from: number, to: number) =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            let offset = from;
            let first = true;
            while (offset <= to) {
              const end = Math.min(to + 1, offset + chunk);
              controller.enqueue(cfg.data.slice(offset, end));
              offset = end;
              // 卡死：连接活着但长时间不下发 → 客户端应掐线重连并从断点续上。
              if (first && stallThisRequest) {
                first = false;
                await Bun.sleep(cfg.stallOnceMs ?? 200);
              }
              // 分片间隔：让"下到一半中断"有确定的窗口（见 chunkDelayMs 注释）。
              if (cfg.chunkDelayMs && offset <= to) await Bun.sleep(cfg.chunkDelayMs);
            }
            controller.close();
          },
        });

      if (!range || cfg.ignoreRange) {
        return new Response(makeStream(0, total - 1), {
          status: 200,
          headers: { "content-length": String(total), etag: "v1" },
        });
      }

      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (cfg.failFromZero && m && Number(m[1]) === 0) {
        return new Response("part 0 down", { status: 500 });
      }
      if (!m) return new Response("bad range", { status: 400 });
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : total - 1;
      if (start >= total) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
      }
      const last = Math.min(end, total - 1);

      if (wrongRangePending) {
        wrongRangePending = false;
        // 故意报一个不是请求区间的 Content-Range。
        const bogusStart = Math.max(0, start - 1);
        return new Response(makeStream(bogusStart, Math.min(bogusStart + (last - start), total - 1)), {
          status: 206,
          headers: {
            "content-range": `bytes ${bogusStart}-${last}/${total}`,
            "content-length": String(last - start + 1),
          },
        });
      }

      return new Response(makeStream(start, last), {
        status: 206,
        headers: {
          "content-range": `bytes ${start}-${last}/${total}`,
          "content-length": String(last - start + 1),
          etag: "v1",
        },
      });
    },
  });
  return { server, requests };
}

let dir: string;
let servers: Array<{ stop: (force?: boolean) => void }> = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "omni-dl-"));
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.stop(true);
});

/** 8 MiB 起步：并行模式的门槛（PARALLEL_MIN_TOTAL = 4 MiB，每片 8 MiB）。 */
const BIG = 20 * 1024 * 1024;

describe("多路并发 + 断点续传", () => {
  test("大文件走多分片并发，各请求不同区间，最终文件逐字节正确", async () => {
    const data = makeData(BIG);
    const { server, requests } = startServer({ data });
    servers.push(server);
    const dest = path.join(dir, "model.safetensors");

    const seen: Array<{ partIndex: number; start: number; end: number }> = [];
    const result = await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      onRangeRequest: (info) => seen.push(info),
    });

    expect(result.size).toBe(BIG);
    expect(statSync(dest).size).toBe(BIG);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(data))).toBe(0);
    // 至少两个分片真的去拿了不同的区间（并发）；分片是 0 基、区间不重叠。
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const starts = new Set(seen.map((s) => s.start));
    expect(starts.size).toBeGreaterThanOrEqual(2);
    expect(seen.some((s) => s.start === 0)).toBe(true);
    // 旁路数据在完成后清理干净，目录里只剩最终文件。
    expect(readdirSync(dir)).toEqual(["model.safetensors"]);
    expect(requests.ranges.length).toBeGreaterThanOrEqual(2);
  });

  test("暂停后重启：只请求缺失区间，不从头重下", async () => {
    const data = makeData(BIG);
    const { server, requests } = startServer({ data });
    servers.push(server);
    const dest = path.join(dir, "big.gguf");

    // 第一次下到 ~40% 就取消。
    const ac = new AbortController();
    let bytes = 0;
    const partial = downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      signal: ac.signal,
      onProgress: (p) => {
        bytes = p.received;
        if (p.received > BIG * 0.35) ac.abort();
      },
    });
    await partial.catch(() => undefined);
    const pausedBytes = partialBytesFor(dest, BIG);
    expect(pausedBytes).toBeGreaterThan(0);
    expect(pausedBytes).toBeLessThan(BIG);
    expect(bytes).toBeGreaterThan(0);

    const firstRoundRanges = requests.ranges.length;
    // 第二次续传：新区间必须从已下载位置开始，而不是 0。
    const resumed = await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, { total: BIG });
    expect(resumed.size).toBe(BIG);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(data))).toBe(0);

    const laterRanges = requests.ranges.slice(firstRoundRanges);
    const restartFromZero = laterRanges.filter((r) => /^bytes=0-\d+$/.test(r));
    // 分片 0 已经就位 → 第二轮不该再出现「从 0 开始的全量区间」。
    expect(restartFromZero.length).toBe(0);
    expect(laterRanges.length).toBeGreaterThan(0);
  });
});

describe("重试与容错", () => {
  test("服务器瞬时 503：自动重试后成功，不把任务判死", async () => {
    const data = makeData(BIG);
    const { server, requests } = startServer({ data, failFirst: 2 });
    servers.push(server);
    const dest = path.join(dir, "retry.bin");

    const result = await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      maxBackoffMs: 20, // 测试里不要真的等 1s/2s
    });
    expect(result.size).toBe(BIG);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(data))).toBe(0);
  });

  test("分片连接卡死（长时间无字节）：掐掉重连续传，最终完整", async () => {
    const data = makeData(BIG);
    // 首条请求卡死 250ms、空闲阈值 50ms → 客户端掐线重连，重连后正常下完。
    const { server, requests } = startServer({ data, stallOnce: true, stallOnceMs: 250 });
    servers.push(server);
    const dest = path.join(dir, "stall.bin");

    const result = await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      idleTimeoutMs: 50,
      maxBackoffMs: 10,
    });
    expect(result.size).toBe(BIG);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(data))).toBe(0);
  }, 30_000);

  test("服务器忽略 Range：自动回退单流，内容正确", async () => {
    const data = makeData(BIG);
    const { server, requests } = startServer({ data, ignoreRange: true });
    servers.push(server);
    const dest = path.join(dir, "norange.bin");

    const result = await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      maxBackoffMs: 10,
    });
    expect(result.size).toBe(BIG);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(data))).toBe(0);
  }, 20_000);

  test("Content-Range 与请求不符：不写坏数据，重试后仍失败要报错", async () => {
    const data = makeData(BIG);
    // 每个分片第一次都收到错区间；重试后正常 → 应该能救回来。
    const { server, requests } = startServer({ data, wrongRangeOnce: true });
    servers.push(server);
    const dest = path.join(dir, "wrongrange.bin");

    const result = await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      maxBackoffMs: 10,
      partAttempts: 2,
    });
    expect(result.size).toBe(BIG);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(data))).toBe(0);
  }, 20_000);
});

describe("远端变化与旧格式", () => {
  test("远端文件大小变了：丢弃旧分片重下，不拼出坏文件", async () => {
    const first = makeData(BIG);
    const { server: firstServer, requests: firstRequests } = startServer({ data: first });
    servers.push(firstServer);
    const dest = path.join(dir, "changed.bin");

    // 先下 30% 留下 sidecar。
    const ac = new AbortController();
    await downloadWithResume(`http://127.0.0.1:${firstServer.port}/f`, dest, {
      total: BIG,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.received > BIG * 0.3) ac.abort();
      },
    }).catch(() => undefined);
    expect(existsSync(`${dest}.download.json`)).toBe(true);

    // 远端换成不同大小（+3 MiB）的文件。
    const secondData = makeData(BIG + 3 * 1024 * 1024);
    const { server: secondServer } = startServer({ data: secondData });
    servers.push(secondServer);

    const result = await downloadWithResume(`http://127.0.0.1:${secondServer.port}/f`, dest, {
      total: secondData.byteLength,
      onRangeRequest: () => {},
    });
    expect(result.size).toBe(secondData.byteLength);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(secondData))).toBe(0);
  }, 30_000);

  test("老版本留下的半成品最终文件：被拆进分片后续传，不重下已有字节", async () => {
    const data = makeData(BIG);
    const { server, requests } = startServer({ data });
    servers.push(server);
    const dest = path.join(dir, "legacy.bin");

    // 模拟老版本单流：直接写了前 6 MiB 到最终路径，没有 sidecar/分片。
    const legacyBytes = 6 * 1024 * 1024;
    writeFileSync(dest, Buffer.from(data.slice(0, legacyBytes)));
    expect(readdirSync(dir)).toEqual(["legacy.bin"]);

    const ac = new AbortController();
    await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      signal: ac.signal,
      // 一开始就取消：只想看「旧字节有没有被认领成分片」。
      onProgress: () => ac.abort(),
    }).catch(() => undefined);

    const parts = readdirSync(dir).filter((n) => n.includes(".part"));
    expect(parts.length).toBeGreaterThan(0);
    const adopted = parts.reduce((sum, n) => sum + statSync(path.join(dir, n)).size, 0);
    expect(adopted).toBe(legacyBytes);
    // 认领之后没再向服务器要已下载的字节：第一个分片请求不从 0 开始。
    const fromZero = requests.ranges.filter((r) => r === "bytes=0-5242879");
    expect(fromZero.length).toBe(0);

    const resumed = await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, { total: BIG });
    expect(resumed.size).toBe(BIG);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(data))).toBe(0);
  }, 30_000);

  test("前缀分片一直失败：最终文件不出现「中间有洞」的坏内容", async () => {
    const data = makeData(BIG);
    // 从 0 开始的分片永远 500，后面的分片能正常下完。
    const { server, requests } = startServer({ data, failFromZero: true });
    servers.push(server);
    const dest = path.join(dir, "hole.bin");

    const failure = downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      maxBackoffMs: 5,
      partAttempts: 2,
      rounds: 2,
    });
    await expect(failure).rejects.toThrow();

    // 后面的分片确实下到了（否则这个测试没意义）。
    const parts = readdirSync(dir).filter((n) => n.includes(".part"));
    expect(parts.length).toBeGreaterThan(0);
    expect(requests.ranges.some((r) => !r.startsWith("bytes=0-"))).toBe(true);

    // 最终文件里绝不能出现「从中间开始的正确数据」：前面那段（part0 的区间）
    // 必须还是空的，后面的字节也不该被当成已下载进度。
    const sidecar = JSON.parse(readFileSync(`${dest}.download.json`, "utf8")) as {
      flushed: number;
      parts: { have: number }[];
    };
    expect(sidecar.flushed).toBe(0);
    expect(sidecar.parts[0]!.have).toBe(0);
    if (existsSync(dest)) {
      const head = readFileSync(dest).subarray(0, 64);
      expect(head.every((b) => b === 0)).toBe(true);
    }
  }, 30_000);

  test("调用方给的 total 过期（远端更大）：自动重新探测后下完", async () => {
    const actual = makeData(BIG + 5 * 1024 * 1024);
    const { server } = startServer({ data: actual });
    servers.push(server);
    const dest = path.join(dir, "stale-hint.bin");

    // 市场列表里的旧大小（比真实文件小）—— 不能因此下出坏文件或判死。
    const result = await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      maxBackoffMs: 10,
      partAttempts: 2,
      rounds: 2,
    });
    expect(result.size).toBe(actual.byteLength);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(actual))).toBe(0);
  }, 30_000);
});

describe("旁路数据管理", () => {
  test("removePartialFiles 清掉最终文件、分片与 sidecar", async () => {
    const data = makeData(BIG);
    const { server, requests } = startServer({ data });
    servers.push(server);
    const dest = path.join(dir, "cleanup.bin");

    const ac = new AbortController();
    await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: BIG,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.received > BIG * 0.2) ac.abort();
      },
    }).catch(() => undefined);
    expect(readdirSync(dir).some((n) => n.includes(".part"))).toBe(true);

    removePartialFiles(dest);
    expect(readdirSync(dir)).toEqual([]);
    expect(partialBytesFor(dest, BIG)).toBe(0);
  }, 20_000);

  test("小文件走单流也能断点续传", async () => {
    const size = 512 * 1024; // 低于并行门槛
    const data = makeData(size);
    // 分片之间留间隔：否则整个文件可能在第一次进度回调被处理前就发完了，
    // 「中断」落到下载结束之后，断言随即随机失败（CI 上就是这样挂的）。
    const { server, requests } = startServer({ data, chunkDelayMs: 25 });
    servers.push(server);
    const dest = path.join(dir, "small.json");

    const ac = new AbortController();
    await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, {
      total: size,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.received > 0) ac.abort();
      },
    }).catch(() => undefined);

    const before = statSync(dest).size;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(size);

    await downloadWithResume(`http://127.0.0.1:${server.port}/f`, dest, { total: size });
    expect(Buffer.compare(readFileSync(dest), Buffer.from(data))).toBe(0);
    // 第二次是从断点续的（带了 Range）。
    expect(requests.ranges.some((r) => !r.startsWith("bytes=0-"))).toBe(true);
  }, 20_000);
});
