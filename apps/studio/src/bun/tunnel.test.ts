import { describe, expect, test } from "bun:test";

import { cloudflaredAssetFor, looksLikeExecutable } from "./cloudflared";
import { detectTunnelFatal, hostFromUrl, isTunnelConnectedLine, parseQuickTunnelUrl } from "./tunnel";

/**
 * 内网穿透的纯逻辑单测。
 *
 * 这里刻意只测"解析官方输出 / 平台适配"这类确定性逻辑：隧道本身要连 Cloudflare
 * 边缘，没法在单测里跑；但**域名解析和致命错误判定**恰恰是最容易悄悄坏掉的部分
 * （cloudflared 换个日志措辞、多一行框线就会解析不到），坏了的后果是"隧道明明
 * 起来了，界面一直转圈"。
 */

describe("cloudflaredAssetFor", () => {
  test("macOS 用官方 tgz，且没有 32 位产物", () => {
    expect(cloudflaredAssetFor("darwin", "arm64")).toEqual({
      asset: "cloudflared-darwin-arm64.tgz",
      archive: "tgz",
    });
    expect(cloudflaredAssetFor("darwin", "x64")).toEqual({
      asset: "cloudflared-darwin-amd64.tgz",
      archive: "tgz",
    });
    expect(cloudflaredAssetFor("darwin", "ia32")).toBeNull();
  });

  test("Linux 只有裸二进制（官方不发 .tgz）", () => {
    expect(cloudflaredAssetFor("linux", "x64")).toEqual({
      asset: "cloudflared-linux-amd64",
      archive: "raw",
    });
    expect(cloudflaredAssetFor("linux", "arm64")).toEqual({
      asset: "cloudflared-linux-arm64",
      archive: "raw",
    });
    expect(cloudflaredAssetFor("linux", "arm")).toEqual({
      asset: "cloudflared-linux-arm",
      archive: "raw",
    });
  });

  test("Windows 没有 arm64 产物，回落到 amd64（x64 仿真）", () => {
    expect(cloudflaredAssetFor("win32", "x64")?.asset).toBe("cloudflared-windows-amd64.exe");
    expect(cloudflaredAssetFor("win32", "arm64")?.asset).toBe("cloudflared-windows-amd64.exe");
    expect(cloudflaredAssetFor("win32", "ia32")?.asset).toBe("cloudflared-windows-386.exe");
  });

  test("未知平台返回 null（界面提示手动安装，而不是下载错的东西）", () => {
    expect(cloudflaredAssetFor("freebsd", "x64")).toBeNull();
    expect(cloudflaredAssetFor("aix", "ppc64")).toBeNull();
  });
});

describe("parseQuickTunnelUrl", () => {
  // cloudflared 真实输出：域名被框线包着，前后还有时间戳与日志级别。
  const banner = [
    "2026-09-15T10:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so without a",
    "+--------------------------------------------------------------------------------------------+",
    "|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
    "|  https://random-words-here.trycloudflare.com                                               |",
    "+--------------------------------------------------------------------------------------------+",
  ].join("\n");

  test("从框线横幅里取出域名", () => {
    expect(parseQuickTunnelUrl(banner)).toBe("https://random-words-here.trycloudflare.com");
  });

  test("拆分到两个 chunk 时，后半段单独匹配不到（所以主流程用滚动缓冲）", () => {
    const head = banner.slice(0, banner.indexOf("random"));
    const tail = banner.slice(banner.indexOf("random"));
    expect(parseQuickTunnelUrl(head)).toBeNull();
    expect(parseQuickTunnelUrl(tail)).toBeNull();
    expect(parseQuickTunnelUrl(head + tail)).toBe("https://random-words-here.trycloudflare.com");
  });

  test("命名隧道 / 普通日志里没有 trycloudflare 域名", () => {
    expect(parseQuickTunnelUrl("INF Registered tunnel connection connIndex=0")).toBeNull();
    expect(parseQuickTunnelUrl("INF Your tunnel ai.example.com is served")).toBeNull();
  });
});

describe("hostFromUrl", () => {
  test("取主机名并小写，去掉端口与路径", () => {
    expect(hostFromUrl("https://Ai.Example.com/")).toBe("ai.example.com");
    expect(hostFromUrl("https://abc.trycloudflare.com")).toBe("abc.trycloudflare.com");
    expect(hostFromUrl("ai.example.com:8443")).toBe("ai.example.com");
    expect(hostFromUrl("  ai.example.com  ")).toBe("ai.example.com");
  });

  test("空输入返回空串（调用方据此判定「没填」）", () => {
    expect(hostFromUrl("")).toBe("");
    expect(hostFromUrl("   ")).toBe("");
  });
});

describe("isTunnelConnectedLine", () => {
  test("识别边缘连接日志", () => {
    expect(isTunnelConnectedLine("2026-09-15T10:00:00Z INF Registered tunnel connection connIndex=0")).toBe(true);
    expect(isTunnelConnectedLine("INF Connection 1 registered")).toBe(false);
  });
});

describe("detectTunnelFatal", () => {
  test("快速隧道被拒 / Token 无效：直接判定没救", () => {
    expect(detectTunnelFatal("ERR Failed to request quick Tunnel: bad request")).toContain("快速隧道");
    expect(detectTunnelFatal("ERR Invalid tunnel token")).toContain("Token 无效");
  });

  test("重连类错误不算致命（cloudflared 自己会重试，等超时更准）", () => {
    expect(detectTunnelFatal("ERR Failed to dial to edge with quic: timeout")).toBeNull();
    expect(detectTunnelFatal("WRN Connection terminated, retrying")).toBeNull();
    expect(detectTunnelFatal("INF Retrying connection in 1s")).toBeNull();
  });
});

describe("looksLikeExecutable", () => {
  test("认得 Mach-O / ELF / PE 魔数", () => {
    expect(looksLikeExecutable(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0]))).toBe(true);
    expect(looksLikeExecutable(new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0]))).toBe(true);
    expect(looksLikeExecutable(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0]))).toBe(true);
    expect(looksLikeExecutable(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBe(true);
  });

  test("挡住代理错误页与半截文件", () => {
    // "<!DOCTYPE html>" / 短文件 / 空内容
    expect(looksLikeExecutable(new TextEncoder().encode("<!DOCTYPE"))).toBe(false);
    expect(looksLikeExecutable(new TextEncoder().encode("404"))).toBe(false);
    expect(looksLikeExecutable(new Uint8Array([]))).toBe(false);
  });
});
