import { expect, test } from "bun:test";

import { describeCaptureContext, describeCaptureFailure, describeMicFailure } from "./capture-errors";

// ---------------------------------------------------------------------------
// 采集权限失败时的提示文案。
//
// 浏览器教程里那套解释（换 HTTPS、给 iframe 加 allow="microphone"、关掉扩展）在
// **桌面客户端里全都不适用**：我们是 Electrobun 的原生窗口、内容从本地 views:// 加载。
// 真实成因只有「系统隐私开关」「之前拒绝过且被记住」「设备不存在 / 被占用」三类，
// 提示必须直接指到该点的地方，而不是让用户去调 HTTPS。
// ---------------------------------------------------------------------------

function domError(name: string): unknown {
  return new DOMException(name, name);
}

test("麦克风 NotAllowedError：指到系统隐私开关，不讲 HTTPS / iframe", () => {
  const msg = describeMicFailure(domError("NotAllowedError"));
  expect(msg).toContain("麦克风被拒绝");
  expect(msg).toContain("隐私与安全性");
  expect(msg).toContain("麦克风");
  expect(msg).toContain("重启");
  // 桌面端不存在"换 HTTPS"这个动作，写了只会误导。
  expect(msg).not.toContain("HTTPS");
  expect(msg).not.toContain("iframe");
});

test("麦克风：SecurityError 与 NotAllowedError 同一套指引", () => {
  expect(describeMicFailure(domError("SecurityError"))).toBe(describeMicFailure(domError("NotAllowedError")));
});

test("麦克风：没有设备 / 被占用各自说到点上", () => {
  expect(describeMicFailure(domError("NotFoundError"))).toContain("没有找到可用的麦克风");
  expect(describeMicFailure(domError("NotFoundError"))).not.toContain("被拒绝");
  expect(describeMicFailure(domError("NotReadableError"))).toContain("被其它程序占用");
});

test("麦克风：认不出的错误保留原文，不吞信息", () => {
  expect(describeMicFailure(new Error("boom"))).toContain("boom");
  expect(describeMicFailure("plain")).toContain("plain");
});

test("摄像头 NotAllowedError：指到隐私设置里的摄像头，不是麦克风", () => {
  const msg = describeCaptureFailure("camera", domError("NotAllowedError"));
  expect(msg).toContain("摄像头");
  expect(msg).toContain("隐私与安全性");
  // 麦克风那句提示在这里是错的：用户会去开错开关。
  expect(msg).not.toContain("麦克风");
});

test("屏幕共享：用户在选择器里取消（NotAllowedError）不当成错误", () => {
  expect(describeCaptureFailure("screen", domError("NotAllowedError"))).toBeNull();
});

test("屏幕共享：真的打不开时仍给提示", () => {
  expect(describeCaptureFailure("screen", domError("NotFoundError"))).toContain("屏幕");
  expect(describeCaptureFailure("screen", new Error("boom"))).toContain("boom");
});

// ---------------------------------------------------------------------------
// 现场快照：NotAllowedError 的三种成因在 message 上完全一样，只有这几个字段能分辨。
// ---------------------------------------------------------------------------

test("现场快照带 secure / protocol / origin：自定义 scheme 不算安全上下文是根因之一", () => {
  const line = describeCaptureContext(new DOMException("The request is not allowed", "NotAllowedError"));
  expect(line).toContain("name=NotAllowedError");
  expect(line).toContain("secure=");
  expect(line).toContain("protocol=");
  expect(line).toContain("origin=");
  // 用户手势 / iframe / HTTPS 在原生窗口里都可排除，这条才是要看的。
  expect(line).toContain("nativeShell=");
});

test("现场快照截断超长 message，不把整段堆栈灌进日志", () => {
  const line = describeCaptureContext(new Error("x".repeat(500)));
  expect(line.length).toBeLessThan(400);
});
