/**
 * 引擎 / 语言包的多链路下载。
 *
 * 这些资产原本只挂在 GitHub 上，而 github.com 在国内多数网络下不可达：直连要等满
 * TCP 超时才失败（macOS 约 75s），再碰上 `AbortSignal.timeout(600_000)` 就是每个源
 * 白等 10 分钟，用户看到的是「正在下载引擎…」一直不动。这里统一做四件事：
 *
 *   1. 先探一下直连能不能通（结果带缓存）：能通就直连优先，海外用户走最快的那条；
 *      不能通就直接跳过，不再浪费 75s。
 *   2. 依次尝试多个 GitHub 加速镜像；每条链路只给很短的“拿到响应头”预算，连不上立刻换。
 *   3. 传输阶段有停摆看门狗：中途一个字节都不来超过 stallMs 就换链路。
 *   4. 链路之间会“对冲”：当前这条跑太久还不结束，就把下一条也开起来，谁先完成用谁 ——
 *      镜像快慢随机（实测同一条镜像 28s ~ 180s+ 都有），串行等待会把耗时相加。
 *
 * 全部失败才返回错误，错误里带上每条链路的具体原因，并写进统一日志。
 * 加一条下载链路只需往 GITHUB_MIRRORS 里追加一项。
 */

import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { logEvent } from "./app-log";
import type { AppLogSource } from "./app-log";

/** GitHub 加速镜像（前缀式：`<mirror><原始 URL>`）。按实测可用性排序。 */
export const GITHUB_MIRRORS = [
  "https://gh-proxy.com/",
  "https://ghfast.top/",
  "https://ghproxy.net/",
] as const;

/** 单条链路“拿到响应头”的预算。连不上就立刻换链路，不在这里耗时间。 */
const FIRST_BYTE_MS = 8_000;

/** 单条链路的传输总预算。 */
const TRANSFER_MS = 180_000;

/** 传输中多久没有新数据判定为卡死（代理挂住时通常是一个字节都不来）。 */
const STALL_MS = 15_000;

/** 对冲阈值：这条链路跑了这么久还没结束，就把下一条也开起来，谁先完成用谁。 */
const HEDGE_AFTER_MS = 45_000;

/** 同时最多跑几条链路（对冲只多开一条，避免把带宽摊薄到两条都变慢）。 */
const MAX_PARALLEL = 2;

/** 直连可达性探测的超时与缓存时长。 */
const PROBE_MS = 2_500;
const PROBE_TTL_MS = 3 * 60_000;

/** 单文件上限，防止代理返回无穷流把内存吃光（引擎与语言包都远小于这个数）。 */
const MAX_BYTES = 256 * 1024 * 1024;

/** `origin -> 是否直连可达`，带 TTL；全部链路都失败时会被清掉，下次点击重新探测。 */
const probeCache = new Map<string, { ok: boolean; at: number }>();

export function clearSourceProbeCache(): void {
  probeCache.clear();
}

/** 轻量往返探测：能完成一次 HTTP 响应就算通，状态码是 404/403 也算（说明网络是通的）。 */
async function originReachable(origin: string): Promise<boolean> {
  const cached = probeCache.get(origin);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.ok;
  let ok = false;
  try {
    await fetch(`${origin}/robots.txt`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_MS),
    });
    ok = true;
  } catch {
    ok = false;
  }
  probeCache.set(origin, { ok, at: Date.now() });
  return ok;
}

/**
 * 候选链路的通用排序：直连能通就直连优先，不能通则镜像在前、直连降到最后当兜底。
 * `mirrors` / `extras` 都是完整的 URL（前缀式镜像由调用方拼好）。
 */
async function orderSources(
  direct: string,
  mirrors: string[],
  extras: string[] = [],
): Promise<string[]> {
  const reachable = await originReachable(new URL(direct).origin).catch(() => false);
  return reachable ? [direct, ...mirrors, ...extras] : [...mirrors, ...extras, direct];
}

/** GitHub Release 资产的候选链路。 */
export function githubReleaseUrls(repo: string, tag: string, asset: string): Promise<string[]> {
  const direct = `https://github.com/${repo}/releases/download/${tag}/${asset}`;
  return orderSources(direct, GITHUB_MIRRORS.map((m) => `${m}${direct}`));
}

/**
 * GitHub 仓库内文件（raw）的候选链路。
 * 除加速镜像外多挂一条 jsDelivr：它是 Fastly 上的独立 CDN，与 GitHub 及其加速站不同源。
 */
export function githubRawUrls(repo: string, branch: string, file: string): Promise<string[]> {
  const direct = `https://github.com/${repo}/raw/${branch}/${file}`;
  const mirrors = GITHUB_MIRRORS.map((m) => `${m}${direct}`);
  const jsdelivr = `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${file}`;
  return orderSources(direct, mirrors, [jsdelivr]);
}

/** 非 GitHub 官方域 + 自带镜像的候选链路。 */
export function officialWithMirrors(direct: string, mirrors: string[]): Promise<string[]> {
  return orderSources(direct, mirrors);
}

export type DownloadAttempt = { host: string; url: string; ms: number; error?: string };

export type DownloadResult =
  | { ok: true; source: string; bytes: number; attempts: DownloadAttempt[] }
  | { ok: false; error: string; attempts: DownloadAttempt[] };

/** 各阶段的时间预算（默认取文件头的常量，测试 / 小文件可以调小）。 */
export type DownloadBudget = { firstByteMs?: number; transferMs?: number; stallMs?: number };

type ResolvedBudget = { firstByteMs: number; transferMs: number; stallMs: number };

function resolveBudget(budget?: DownloadBudget): ResolvedBudget {
  return {
    firstByteMs: budget?.firstByteMs ?? FIRST_BYTE_MS,
    transferMs: budget?.transferMs ?? TRANSFER_MS,
    stallMs: budget?.stallMs ?? STALL_MS,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 可取消的等待：对冲到点用的定时器必须在别人先跑完时清掉。
 * 不清的话每开一条链路就留一个最长 45s 的句柄（测试里 `bun test` 会因此挂住不退出）。
 */
function sleepCancellable(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * 代理出错时经常回一个 HTML / 文本错误页，而不是原始文件（状态码还是 200）。
 * 这类内容按扩展名解压会得到一个莫名其妙的 tar 报错，不如在这里就判掉、直接换链路。
 */
function looksLikeErrorPage(head: Uint8Array): boolean {
  const slice = head.subarray(0, 128);
  for (const b of slice) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b > 0x7e) return false; // 含二进制字节 = 不是网页
  }
  const text = Buffer.from(slice).toString("utf8").trimStart().toLowerCase();
  if (!text) return false;
  return (
    text.startsWith("<!doctype") ||
    text.startsWith("<html") ||
    text.startsWith("{") ||
    text.startsWith("[") ||
    text.includes("not found")
  );
}

/**
 * 单次下载：先等响应头，再流式收内容，全程有两个看门狗兜着。
 *
 * 看门狗只 abort、不依赖 fetch 自己把 abort 传导到响应体 —— 每一步都用 `abortPromise`
 * 与网络操作赛跑，所以「连不上」和「传一半不动了」都一定会及时结束，而不是挂在那里。
 * `ctl` 由调用方持有，用来在对冲时掐掉落败的那条。
 */
async function downloadOnce(
  url: string,
  file: string,
  budget: ResolvedBudget,
  ctl: AbortController,
): Promise<{ bytes: number; head: Uint8Array }> {
  let note = "";
  let headerTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (headerTimer) clearTimeout(headerTimer);
    if (watchdog) clearInterval(watchdog);
    headerTimer = null;
    watchdog = null;
  };

  let triggerAbort = () => {};
  const abortPromise = new Promise<never>((_, reject) => {
    triggerAbort = () => reject(new Error(note || "已中止"));
  });
  abortPromise.catch(() => {}); // 没人 race 它时不要冒 unhandled rejection
  // ctl 被外部（对冲落败）或看门狗中止时，同步点燃 abortPromise，不依赖 fetch 是否传导。
  ctl.signal.addEventListener(
    "abort",
    () => {
      note ||= "已被更快的那条链路取代";
      triggerAbort();
    },
    { once: true },
  );
  const dead = (why: string) => {
    note ||= why;
    ctl.abort();
  };

  try {
    headerTimer = setTimeout(
      () => dead(`连接超时（${budget.firstByteMs / 1000}s 内没有响应）`),
      budget.firstByteMs,
    );

    const res = await Promise.race([
      fetch(url, { redirect: "follow", signal: ctl.signal }),
      abortPromise,
    ]);
    if (headerTimer) clearTimeout(headerTimer);
    headerTimer = null;
    if (!res.ok) {
      // 失败响应也要把 body 放掉：镜像回 403/404 时通常带一段 HTML，不 cancel 的话
      // 这个连接会一直挂着等 GC，而"换下一条链路"意味着这类失败是常态而非例外。
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.body) throw new Error("响应没有内容");

    const deadline = Date.now() + budget.transferMs;
    let lastByteAt = Date.now();
    watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > budget.stallMs) {
        dead(`传输停滞（${budget.stallMs / 1000}s 没有新数据）`);
      } else if (Date.now() > deadline) {
        dead(`传输超时（超过 ${budget.transferMs / 1000}s）`);
      }
    }, 25);

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), abortPromise]);
        if (done) break;
        if (!value?.byteLength) continue;
        bytes += value.byteLength;
        lastByteAt = Date.now();
        if (bytes > MAX_BYTES) dead(`文件过大（超过 ${MAX_BYTES / 1024 / 1024}MB）`);
        chunks.push(value);
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }

    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error("内容为空");
    await Bun.write(file, buf);
    // `Bun.write` 一旦开始就拦不住：对冲落败的那条链路可能在**外层已经清理过临时文件**
    // 之后才把内容写完，于是下载明明成功、目标目录里却留下一个几百 MB 的 `.partN`。
    // 落盘之后再看一眼中止标记 —— 已中止就自己把文件删掉再报错，边界就收在这里。
    if (ctl.signal.aborted) {
      rmSync(file, { force: true });
      throw new Error(note || "已中止");
    }
    return { bytes: buf.length, head: buf.subarray(0, 128) };
  } catch (e) {
    // ctl.abort() 会让 fetch 直接抛 AbortError，这里统一换成看得懂的中文原因。
    if (note && ctl.signal.aborted) throw new Error(note, { cause: e });
    throw e;
  } finally {
    stop();
  }
}

type Outcome =
  | { ok: true; bytes: number; head: Uint8Array; file: string }
  | { ok: false; error: string };

type Attempt = {
  url: string;
  host: string;
  file: string;
  startedAt: number;
  ctl: AbortController;
  settled: Promise<Outcome>;
};

function startAttempt(url: string, file: string, budget: ResolvedBudget): Attempt {
  const ctl = new AbortController();
  const startedAt = Date.now();
  const settled: Promise<Outcome> = downloadOnce(url, file, budget, ctl)
    .then(({ bytes, head }): Outcome => {
      if (looksLikeErrorPage(head)) throw new Error("返回的是网页 / 错误页，不是文件");
      return { ok: true, bytes, head, file };
    })
    .catch((e): Outcome => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return { url, host: hostOf(url), file, startedAt, ctl, settled };
}

/**
 * 从候选链路下载到 `dest`，成功时 `dest` 里就是完整文件。
 *
 * 每条链路先各自下到 `dest.partN`（不会互相踩），完整落盘后才调用 `accept` 落位；
 * `accept` 返回错误字符串（例如解压后没找到目标文件、内容 magic 不对）也算这条链路失败，
 * 会继续试后面的链路。全部失败时 `dest` 与所有临时文件都会被清掉，不留半个文件。
 */
export async function fetchAssetFromSources(opts: {
  urls: string[];
  dest: string;
  /** 人类可读的资产名，进日志与错误提示，如「audio.cpp 推理引擎」。 */
  what: string;
  /** 日志归属的子系统。 */
  source: AppLogSource;
  /** 落盘后的额外校验 / 落位；返回错误字符串表示这个链路的内容不能用。 */
  accept?: (file: string, head: Uint8Array, bytes: number) => string | null | Promise<string | null>;
  budget?: DownloadBudget;
  /** 对冲阈值（默认 45s）。设成很大的值等于关掉对冲，只为测试留的口子。 */
  hedgeAfterMs?: number;
}): Promise<DownloadResult> {
  const { urls, dest, what, source, accept } = opts;
  const budget = resolveBudget(opts.budget);
  const hedgeAfterMs = opts.hedgeAfterMs ?? HEDGE_AFTER_MS;
  mkdirSync(path.dirname(dest), { recursive: true });

  const attempts: DownloadAttempt[] = [];
  const running = new Set<Attempt>();
  let next = 0;
  let lastLaunchAt = 0;

  const launch = (): void => {
    const url = urls[next];
    if (url === undefined) return;
    const attempt = startAttempt(url, `${dest}.part${next}`, budget);
    next += 1;
    running.add(attempt);
    lastLaunchAt = attempt.startedAt;
  };

  const fail = (attempt: Attempt, error: string, ms: number): void => {
    attempts.push({ host: attempt.host, url: attempt.url, ms, error });
    logEvent({
      level: "warn",
      source,
      event: "engine.download.source-failed",
      message: `${what}：${attempt.host} 这条链路不通，换下一个`,
      detail: { what, host: attempt.host, error, ms, url: attempt.url },
    });
  };

  try {
    for (;;) {
      if (running.size === 0) {
        if (next >= urls.length) break;
        launch();
      } else if (
        next < urls.length &&
        running.size < MAX_PARALLEL &&
        Date.now() - lastLaunchAt >= hedgeAfterMs
      ) {
        launch();
      }

      const canLaunch = next < urls.length && running.size < MAX_PARALLEL;
      const hedgeIn = canLaunch ? Math.max(0, hedgeAfterMs - (Date.now() - lastLaunchAt)) : Infinity;
      const hedge = hedgeIn === Infinity ? null : sleepCancellable(hedgeIn);
      const settled = await Promise.race([
        ...[...running].map((a) => a.settled.then((r) => ({ a, r }))),
        ...(hedge ? [hedge.promise.then(() => null)] : []),
      ]);
      hedge?.cancel();
      if (!settled) continue; // 到点，下一轮把下一条链路开起来

      running.delete(settled.a);
      const ms = Date.now() - settled.a.startedAt;
      if (!settled.r.ok) {
        fail(settled.a, settled.r.error, ms);
        continue;
      }

      // 已经完整落盘，但内容不一定能用（代理错误页 / 解压失败）—— accept 说了算。
      // accept 是调用方的代码（解压、chmod、装语言包），它抛异常时按"这条链路的内容
      // 不能用"处理：让流程继续试后面的链路，而不是把整个下载判死、连日志都不落。
      let rejected: string | null = null;
      try {
        rejected = (await accept?.(settled.r.file, settled.r.head, settled.r.bytes)) ?? null;
      } catch (e) {
        rejected = e instanceof Error ? e.message : String(e);
      }
      if (rejected) {
        rmSync(settled.r.file, { force: true });
        fail(settled.a, rejected, ms);
        continue;
      }

      attempts.push({ host: settled.a.host, url: settled.a.url, ms });
      renameSync(settled.r.file, dest);
      logEvent({
        level: "info",
        source,
        event: "engine.download.ok",
        message: `${what} 下载成功（${settled.a.host}）`,
        detail: { what, host: settled.a.host, bytes: settled.r.bytes, ms, url: settled.a.url },
      });
      return { ok: true, source: settled.a.host, bytes: settled.r.bytes, attempts };
    }
  } finally {
    for (const a of running) a.ctl.abort();
    for (let i = 0; i < next; i += 1) rmSync(`${dest}.part${i}`, { force: true });
  }

  // 所有链路都失败 —— 清掉探测缓存，让用户下次点击重新判断直连是否恢复。
  // 注意：这里不动 `dest`。下载全程只写 `dest.partN`（已在上面的 finally 里清掉），
  // 只有成功才 rename 到 `dest`，所以失败时 `dest` 要么不存在、要么是上一个好文件
  // （OCR 的 dest 就是最终语言包路径，误删会把已装好的删掉）。
  clearSourceProbeCache();

  const detail = attempts
    .map((a) => `${a.host}：${a.error ?? "未知原因"}`)
    .join("；")
    .slice(0, 400);
  logEvent({
    level: "error",
    source,
    event: "engine.download.all-failed",
    message: `${what} 下载失败：已尝试 ${attempts.length} 条链路均不可用`,
    detail: { what, attempts },
  });
  return {
    ok: false,
    attempts,
    error: `${what}下载失败：已尝试 ${attempts.length} 条链路均不可用 —— ${detail}。请检查网络后重试；若你的网络需要代理，先打开代理再点一次。`,
  };
}
