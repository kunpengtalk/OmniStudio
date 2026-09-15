/**
 * 代理（设置 → 偏好 → 通用）冒烟：设置解析 → fetch 包装 → 子进程 env / WebSocket 选项
 * → 真实过一个本地 HTTP 代理（端到端） → 「测试代理」按钮。
 *
 * 跑法：bun run scripts/proxy-smoke.ts（或 OMNI_DATA_DIR=… 指定目录保留现场）。
 *
 * 为什么是独立脚本而不是 `bun test` 用例：bun test 的模块 mock 是**进程级**的，
 * chat / gateway 等测试会 `mock.module("./db/settings")`，跑在它们后面的用例读不到
 * 真实设置（本文件需要写设置并立刻读回）；独立进程也顺带让「装全局 fetch 包装」
 * 这类副作用不会漏给别的测试文件。
 */
import { mkdtempSync, rmSync } from "fs";
import { networkInterfaces } from "os";
import { tmpdir } from "os";
import path from "path";

const providedDataDir = process.env.OMNI_DATA_DIR;
const dataDir = providedDataDir ?? mkdtempSync(path.join(tmpdir(), "omni-proxy-smoke-"));
process.env.OMNI_DATA_DIR = dataDir;

// 装包装之前先留住原始 fetch：假代理要把请求转发给真正的 fetch，否则会递归。
const realFetch = globalThis.fetch;

const { installProxyFetch, uninstallProxyFetch } = await import("../src/bun/proxy");
const Proxy = await import("../src/bun/proxy");
const { updateSettings } = await import("../src/bun/db/settings");

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? ""}`}`);
  if (!ok) failed++;
};

const setProxy = (mode: string, url: string, allowLocalNetwork = true) =>
  updateSettings({
    PROXY_MODE: mode,
    PROXY_URL: url,
    PROXY_ALLOW_LOCAL_NETWORK: allowLocalNetwork ? "1" : "0",
  });

/** 替换全局 fetch 跑一段断言，跑完一定还原（后面还要用真 fetch 做端到端）。 */
async function withFetchStub(
  stub: (input: unknown, init?: Record<string, unknown>) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// 1. 设置 → 生效配置
// ---------------------------------------------------------------------------
setProxy("custom", "127.0.0.1:7890/");
const custom = Proxy.readProxyConfig();
check(
  "自定义代理：缺协议补全、去尾斜杠",
  custom.mode === "custom" && custom.url === "http://127.0.0.1:7890",
  JSON.stringify(custom),
);

setProxy("custom", "socks5://127.0.0.1:1080");
check("socks 地址不接受（Bun 不支持），按直连", Proxy.readProxyConfig().url === "");

setProxy("none", "http://127.0.0.1:7890");
check("不使用代理：配置里没有地址", Proxy.readProxyConfig().url === "");

setProxy("custom", "http://127.0.0.1:7890", false);
check("「允许访问本地网络地址」开关落到配置", Proxy.readProxyConfig().allowLocalNetwork === false);
setProxy("custom", "http://127.0.0.1:7890", true);

updateSettings({ PROXY_MODE: "banana" });
check("脏数据回落到系统代理", Proxy.readProxyConfig().mode === "system");

// ---------------------------------------------------------------------------
// 2. fetch 包装：谁带 proxy、谁不带
// ---------------------------------------------------------------------------
setProxy("custom", "http://127.0.0.1:7890");
const calls: { url: string; proxy: string | null; unix: unknown }[] = [];

await withFetchStub(
  async (input, init) => {
    calls.push({
      url: String(input),
      proxy: (init?.proxy as string) ?? null,
      unix: init?.unix ?? null,
    });
    return new Response("ok");
  },
  async () => {
    installProxyFetch();
    installProxyFetch(); // 幂等
    try {
      await fetch("https://huggingface.co/api/models");
      await fetch("http://127.0.0.1:8080/v1/models");
      await fetch("http://192.168.1.9:11434/v1/models");
      await fetch("https://api.openai.com/v1/models", { proxy: "http://explicit:9" } as never);
      await fetch("http://control", { unix: "/tmp/omni.sock" } as never);
    } finally {
      uninstallProxyFetch();
    }
  },
);

check(
  "云端与下载地址带上 proxy",
  calls[0]?.proxy === "http://127.0.0.1:7890",
  JSON.stringify(calls[0]),
);
check("本地推理服务（127.0.0.1）直连", calls[1]?.proxy === null);
check("局域网服务默认直连", calls[2]?.proxy === null);
check("调用方显式指定的 proxy 不被覆盖", calls[3]?.proxy === "http://explicit:9");
check("本机 IPC（unix socket）不带 proxy 且选项原样保留", calls[4]?.proxy === null && calls[4]?.unix === "/tmp/omni.sock");

// 关掉「允许访问本地网络地址」后，局域网改走代理；本地服务仍直连。
setProxy("custom", "http://127.0.0.1:7890", false);
const calls2: (string | null)[] = [];
await withFetchStub(
  async (_input, init) => {
    calls2.push((init?.proxy as string) ?? null);
    return new Response("ok");
  },
  async () => {
    installProxyFetch();
    try {
      await fetch("http://192.168.1.9:11434/v1/models");
      await fetch("http://127.0.0.1:8080/v1/models");
    } finally {
      uninstallProxyFetch();
    }
  },
);
check(
  "关掉本地网络直连后局域网走代理、本地仍直连",
  calls2[0] === "http://127.0.0.1:7890" && calls2[1] === null,
  JSON.stringify(calls2),
);

// ---------------------------------------------------------------------------
// 3. 子进程 env 与 WebSocket 选项
// ---------------------------------------------------------------------------
setProxy("custom", "http://127.0.0.1:7890");
const childEnv = Proxy.proxyChildEnv();
check(
  "子进程 env：HTTP(S)_PROXY + NO_PROXY（回环恒在）",
  childEnv.HTTPS_PROXY === "http://127.0.0.1:7890" &&
    (childEnv.NO_PROXY ?? "").includes("127.0.0.1") &&
    (childEnv.NO_PROXY ?? "").includes("10.0.0.0/8"),
  JSON.stringify(childEnv),
);
check(
  "WebSocket 选项带 proxy（Edge TTS / 实时通话到公网）",
  Proxy.proxyWebSocketOptions("wss://dashscope.aliyuncs.com/api-ws/v1/realtime").proxy ===
    "http://127.0.0.1:7890",
);
check(
  "WebSocket 指到本机 / 局域网时不带 proxy（与 fetch 同一套回环判据）",
  !("proxy" in Proxy.proxyWebSocketOptions("ws://127.0.0.1:9999/realtime")) &&
    !("proxy" in Proxy.proxyWebSocketOptions("ws://192.168.1.9:9999/realtime")),
);

process.env.HTTP_PROXY = "http://from-shell:1234";
Proxy.syncProxyEnv();
check("syncProxyEnv：自定义代理时写入进程环境", process.env.HTTPS_PROXY === "http://127.0.0.1:7890");
check(
  "syncProxyEnv：代理模式下 NO_PROXY 是精确清单（不是 *，否则子进程也全直连）",
  process.env.NO_PROXY !== "*" && process.env.NO_PROXY!.includes("127.0.0.1"),
  process.env.NO_PROXY,
);
setProxy("none", "http://127.0.0.1:7890");
Proxy.syncProxyEnv();
check(
  "syncProxyEnv：不使用代理时连用户 shell 的变量一起清掉，并用 NO_PROXY=* 压住已记住的代理",
  process.env.HTTP_PROXY === undefined &&
    process.env.HTTPS_PROXY === undefined &&
    process.env.NO_PROXY === "*",
  `HTTP_PROXY=${process.env.HTTP_PROXY} NO_PROXY=${process.env.NO_PROXY}`,
);

// ---------------------------------------------------------------------------
// 4. 端到端：真的从本地 HTTP 代理绕一圈
//
// 假代理只用「记下请求 + 回一句 proxied:…」来证明请求走了代理，**不再转发** ——
// 转发要用真 fetch，而 Bun 把环境里的代理记在 HTTP 客户端里（见 syncProxyEnv 的注释），
// 转发请求会再进一次代理、绕成环。响应体是判定依据：`target:…` = 直连落到目标，
// `proxied:…` = 从代理过。
// ---------------------------------------------------------------------------
const proxied: string[] = [];
const target = Bun.serve({
  port: 0,
  hostname: "0.0.0.0",
  fetch: (req) => new Response(`target:${new URL(req.url).pathname}`),
});
const proxyServer = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    proxied.push(url.href);
    return new Response(`proxied:${url.pathname}`);
  },
});

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((info) => info && !info.internal && info.family === "IPv4")?.address;

setProxy("custom", `http://127.0.0.1:${proxyServer.port}`);
Proxy.syncProxyEnv();
installProxyFetch();
try {
  const viaLocal = await fetch(`http://127.0.0.1:${target.port}/ping`);
  check(
    "本地服务直连：请求落到目标、没经过代理",
    viaLocal.status === 200 &&
      (await viaLocal.text()) === "target:/ping" &&
      proxied.length === 0,
    `status=${viaLocal.status} proxied=${JSON.stringify(proxied)}`,
  );

  if (lanIp) {
    // 局域网地址走代理（关掉「允许访问本地网络地址」）：请求真的从代理过。
    setProxy("custom", `http://127.0.0.1:${proxyServer.port}`, false);
    Proxy.syncProxyEnv();
    const viaProxy = await fetch(`http://${lanIp}:${target.port}/through-proxy`);
    const body = await viaProxy.text();
    check(
      "局域网走代理：请求真的从本地代理过（响应来自代理）",
      viaProxy.status === 200 &&
        body === "proxied:/through-proxy" &&
        proxied.some((u) => u.includes("/through-proxy")),
      `status=${viaProxy.status} body=${body} proxied=${JSON.stringify(proxied)}`,
    );

    // 打开「允许访问本地网络地址」：同一个地址改成直连，代理不再记录。
    setProxy("custom", `http://127.0.0.1:${proxyServer.port}`, true);
    Proxy.syncProxyEnv();
    const before = proxied.length;
    const direct = await fetch(`http://${lanIp}:${target.port}/direct`);
    check(
      "局域网直连：打开开关后不再经过代理",
      direct.status === 200 &&
        (await direct.text()) === "target:/direct" &&
        proxied.length === before,
      `status=${direct.status} proxied=${proxied.length - before}`,
    );
  } else {
    console.log("· 没有非回环网卡，跳过局域网走代理的端到端断言");
  }
} finally {
  uninstallProxyFetch();
  proxyServer.stop(true);
  target.stop(true);
}

// ---------------------------------------------------------------------------
// 5. 「测试代理」按钮与状态展示
// ---------------------------------------------------------------------------
setProxy("custom", "http://127.0.0.1:7890");
const seenTargets: (string | null)[] = [];
await withFetchStub(
  async (_input, init) => {
    seenTargets.push((init?.proxy as string) ?? null);
    return new Response("{}", { status: 200 });
  },
  async () => {
    const result = await Proxy.testProxyConnection();
    check(
      "测试代理：按当前设置发请求并回状态 / 耗时 / 答话的目标主机",
      result.ok &&
        result.status === 200 &&
        typeof result.latencyMs === "number" &&
        result.url === "http://127.0.0.1:7890" &&
        result.target === "huggingface.co",
      JSON.stringify(result),
    );
  },
);
check("测试代理：请求真的带了 proxy", seenTargets[0] === "http://127.0.0.1:7890", JSON.stringify(seenTargets));

// HuggingFace 在很多网络下本来就不通（国内尤其常见），这时不能把代理报成失败：
// 第一个目标答不上来就换下一个模型源，谁先通算谁。
await withFetchStub(
  async (input) => {
    const url = String(input);
    return new Response("{}", { status: url.includes("huggingface.co") ? 502 : 200 });
  },
  async () => {
    const result = await Proxy.testProxyConnection();
    check(
      "测试代理：HF 不通时回退到下一个模型源，而不是报「代理失败」",
      result.ok && result.target === "www.modelscope.cn",
      JSON.stringify(result),
    );
  },
);

// 设置页可以从表单里带上「还没保存的值」先试一把。
const draftTargets: (string | null)[] = [];
await withFetchStub(
  async (_input, init) => {
    draftTargets.push((init?.proxy as string) ?? null);
    return new Response("{}", { status: 200 });
  },
  async () => {
    const drafted = await Proxy.testProxyConnection({
      mode: "custom",
      url: "127.0.0.1:8888",
      allowLocalNetwork: true,
    });
    check(
      "测试代理：用表单里正在编辑的地址试（未保存也生效，缺协议自动补全）",
      drafted.ok && draftTargets[0] === "http://127.0.0.1:8888",
      JSON.stringify({ drafted, draftTargets }),
    );
    const bad = await Proxy.testProxyConnection({ mode: "custom", url: "socks5://127.0.0.1:1080" });
    check("测试代理：地址无效时直接给提示，不发请求", !bad.ok && (bad.error ?? "").includes("代理地址"), JSON.stringify(bad));
  },
);

setProxy("custom", "http://user:secret@127.0.0.1:7890");
const status = await Proxy.proxyStatus();
check(
  "状态展示：地址脱敏、密码不外泄",
  status.url === "http://user:***@127.0.0.1:7890" && !status.url.includes("secret"),
  JSON.stringify(status),
);

if (!providedDataDir) {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}

console.log(failed === 0 ? "\nProxy smoke 全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
