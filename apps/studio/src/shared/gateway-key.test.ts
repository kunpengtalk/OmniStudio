import { describe, expect, test } from "bun:test";

import { maskGatewayKey } from "./gateway-key";

/**
 * 掩码规则：界面上默认看到的是 `osk-****…`，真实值只在用户点「显示」时才渲染。
 * 这三条是"密钥不会明文躺在屏幕上"的最低保证。
 */
describe("maskGatewayKey", () => {
  test("保留前缀，其余全星号", () => {
    const masked = maskGatewayKey("osk-abcdefghijklmnopqrstuvwx");
    expect(masked).toBe("osk-************");
    expect(masked).not.toContain("abcdef");
  });

  test("不泄漏长度：不同长度掩码结果一致", () => {
    expect(maskGatewayKey("osk-a")).toBe(maskGatewayKey("osk-" + "x".repeat(200)));
  });

  test("无前缀的旧 Key 整个掩掉；空值原样返回", () => {
    expect(maskGatewayKey("legacy-plain-key")).toBe("************");
    expect(maskGatewayKey("")).toBe("");
    expect(maskGatewayKey("   ")).toBe("");
  });
});
