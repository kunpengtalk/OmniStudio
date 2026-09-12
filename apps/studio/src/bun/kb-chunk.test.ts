import { describe, expect, test } from "bun:test";

import { chunkContentHash, contextText, splitIntoChunks, splitIntoChunksWithMeta } from "./kb-chunk";

/** 用偏移切回原文，验证溯源信息没有随切片漂移。 */
function sliceBack(text: string, piece: { charStart: number; charEnd: number }): string {
  return text.slice(piece.charStart, piece.charEnd).trim();
}

describe("kb-chunk 切片与溯源", () => {
  /** 每节都撑到分块预算之上（200），保证一节一个分块，标题归属可断言。 */
  const filler = "补充说明文字".repeat(20);
  const section = (level: number, title: string, body: string) =>
    `${"#".repeat(level)} ${title}\n${body}${filler}`;
  const doc = [
    section(1, "退款政策", "自购买之日起 7 天内可申请无理由退款。"),
    section(2, "部分退款", "超过 7 天但在 30 天内，有质量问题的可申请部分退款。"),
    section(1, "保修条款", "整机保修一年，配件保修 90 天。"),
  ].join("\n\n");

  test("标题路径跟着内容走", () => {
    const pieces = splitIntoChunksWithMeta(doc, 200, 0);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(pieces[0]!.headingPath).toBe("退款政策");
    const partial = pieces.find((p) => p.content.includes("部分退款"));
    expect(partial?.headingPath).toBe("退款政策 > 部分退款");
    const warranty = pieces.find((p) => p.content.includes("保修一年"));
    expect(warranty?.headingPath).toBe("保修条款");
  });

  test("字符偏移能切回原文", () => {
    const pieces = splitIntoChunksWithMeta(doc, 200, 0);
    expect(pieces.length).toBeGreaterThan(0);
    for (const piece of pieces) {
      expect(sliceBack(doc, piece)).toBe(piece.content);
      expect(piece.charEnd).toBeGreaterThan(piece.charStart);
    }
    // 偏移单调递增，不重叠（overlap=0 时）
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]!.charStart).toBeGreaterThanOrEqual(pieces[i - 1]!.charEnd);
    }
  });

  test("代码围栏内的 # 不当标题、空行不断段", () => {
    const code = ["# 用法", "", "```bash", "# 这是注释不是标题", "", "echo hi", "```", "", "结束。"].join("\n");
    const pieces = splitIntoChunksWithMeta(code, 400, 0);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.headingPath).toBe("用法");
    expect(pieces[0]!.content).toContain("# 这是注释不是标题");
  });

  test("超长段硬切后偏移仍能切回原文", () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const pieces = splitIntoChunksWithMeta(long, 200, 40);
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) expect(sliceBack(long, piece)).toBe(piece.content);
  });

  test("硬切不劈开代理对", () => {
    const emoji = "😀".repeat(60);
    const pieces = splitIntoChunksWithMeta(emoji, 200, 0);
    for (const piece of pieces) {
      // 落单的代理码点是损坏信号
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(piece.content)).toBe(false);
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(piece.content)).toBe(false);
    }
  });

  test("splitIntoChunks 兼容封装只吐正文", () => {
    const chunks = splitIntoChunks(doc, 200, 0);
    expect(chunks.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
    expect(chunks.some((c) => c.startsWith("#"))).toBe(true);
  });

  test("上下文增强文本把标题路径并进嵌入输入", () => {
    expect(contextText("手册.md", "退款政策 > 部分退款", "正文")).toBe("手册.md › 退款政策 > 部分退款\n正文");
    expect(contextText("手册.md", null, "正文")).toBe("手册.md\n正文");
    expect(contextText("", null, "正文")).toBe("正文");
  });

  test("分块内容哈希稳定且区分内容", () => {
    expect(chunkContentHash("abc")).toBe(chunkContentHash("abc"));
    expect(chunkContentHash("abc")).not.toBe(chunkContentHash("abd"));
  });
});
