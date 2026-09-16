import { describe, expect, test } from "bun:test";

import { issueMediaCookie, mediaTicketValid, resolveWebAppDir, serveWebAsset } from "./gateway-web";

/**
 * 网页端（/chat、/agent）的网关侧回归测试。
 *
 * 这套东西最容易悄悄坏掉的是"边界"：静态资源能不能被 `../` 带出去、
 * 媒体票据能不能被伪造、产物目录换位置后还能不能找到。数据面（RPC 分发、
 * 白名单）在 rpc/index.ts 里，由那边的 `dispatchRemoteRpc` 负责。
 */

/**
 * 产物目录只在**构建过 webview** 时才在（`bun x vite build` → apps/studio/dist）。
 *
 * 依赖它的两条用例在没构建时**明说跳过**，而不是把"这台机器没构建过"报成红 —— 同时 CI 的
 * 检查作业里补了一步 vite build（与独立的 `vite build` 作业同一条命令），所以它们在 CI 上
 * 是真跑到的，不是被跳过掩盖过去的。
 */
const built = Boolean(resolveWebAppDir());
if (!built) {
  console.warn(
    "[gateway-web.test] 没找到 vite 产物（apps/studio/dist），跳过两条依赖产物的用例；" +
      "在 apps/studio 下跑一次 `bun x vite build` 就会跑起来。",
  );
}

describe("前端产物定位", () => {
  test.skipIf(!built)("能从源码目录找到 vite 产物（apps/studio/dist）", () => {
    // 单测跑到这里时 import.meta.dir 是 src/bun，vite 的 outDir 是 ../../dist。
    const dir = resolveWebAppDir();
    expect(dir).toBeTruthy();
    expect(String(dir)).toContain("dist");
  });
});

describe("静态资源只服务产物目录内的文件", () => {
  test.skipIf(!built)("正常路径能取到入口 HTML，带正确的 Content-Type", () => {
    const res = serveWebAsset("/assets/../index.html");
    // /assets/../index.html 归一化后仍在产物目录内 → 允许
    expect(res?.headers.get("Content-Type")).toContain("text/html");
  });

  test("越界路径一律取不到（不返回任何内容）", () => {
    expect(serveWebAsset("/assets/../../../../etc/passwd")).toBeNull();
    expect(serveWebAsset("/assets/%2e%2e%2f%2e%2e%2fpackage.json")).toBeNull();
    expect(serveWebAsset("/assets/does-not-exist.js")).toBeNull();
  });

  test("只认 /assets/* 与 favicon，其它路径不接管", () => {
    expect(serveWebAsset("/v1/web/rpc")).toBeNull();
    expect(serveWebAsset("/docs")).toBeNull();
  });
});

describe("媒体会话票据", () => {
  const req = (cookie?: string) =>
    new Request("http://127.0.0.1/media/chat/1.png", cookie ? { headers: { cookie } } : {});

  test("刚签发的票据有效，请求里能通过", () => {
    const cookie = issueMediaCookie();
    const pair = cookie.split(";")[0] ?? "";
    expect(mediaTicketValid(req(pair))).toBe(true);
  });

  test("没有 Cookie / 伪造票据 / 过期票据都拒绝", () => {
    expect(mediaTicketValid(req())).toBe(false);
    expect(mediaTicketValid(req("omni_media=1700000000.deadbeef"))).toBe(false);
    // 用真实签名但把过期时间改到过去
    const cookie = issueMediaCookie();
    const value = (cookie.split(";")[0] ?? "").split("=")[1] ?? "";
    const mac = value.split(".")[1] ?? "";
    expect(mediaTicketValid(req(`omni_media=${Date.now() - 1000}.${mac}`))).toBe(false);
  });

  test("票据里带 HttpOnly，脚本读不到", () => {
    expect(issueMediaCookie()).toContain("HttpOnly");
  });
});
