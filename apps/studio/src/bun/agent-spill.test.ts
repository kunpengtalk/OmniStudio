import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  MAX_SPILLS_PER_CONVERSATION,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  capToolResultText,
  clearConversationSpills,
  conversationSpillDir,
  isSpillPath,
  pruneSpills,
  spillRoot,
  spillToolOutput,
  truncateForModel,
} from "./agent-spill";

describe("truncateForModel", () => {
  test("没超限就原样返回", () => {
    const result = truncateForModel("短输出");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("短输出");
  });

  test("超限时写清三件事：被截了、还差多少、去哪儿找原文", () => {
    const text = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 500);
    const result = truncateForModel(text, { spillPath: "/data/tool-output/7/a.txt" });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("输出被截断");
    expect(result.text).toContain("500 个字符");
    expect(result.text).toContain("不要");
    expect(result.text).toContain("/data/tool-output/7/a.txt");
    expect(result.text).toContain("read_file");
    // 前半段必须原样保留：模型要基于它继续推理。
    expect(result.text.startsWith(text.slice(0, 100))).toBe(true);
  });

  test("转存失败（没有路径）时退化成旧文案，但不撒谎说原文还在", () => {
    const text = "y".repeat(MAX_TOOL_OUTPUT_CHARS + 1);
    const result = truncateForModel(text, { spillPath: null });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("输出被截断");
    expect(result.text).not.toContain("已经存到");
    // 仍然给出可执行的下一步（缩小范围重试）。
    expect(result.text).toContain("grep");
  });
});

describe("capToolResultText", () => {
  test("硬上限之内原样返回", () => {
    expect(capToolResultText("abc")).toBe("abc");
  });

  test("超过内存硬上限时丢尾部并说明原因（bash 输出在读之前不知道有多大）", () => {
    const huge = "z".repeat(1000);
    const capped = capToolResultText(huge, 100);
    expect(capped.startsWith("z".repeat(100))).toBe(true);
    expect(capped).toContain("输出过大");
    expect(capped.length).toBeLessThan(huge.length);
  });

  test("默认硬上限比展示上限大两个量级（先落盘、再截断给模型看）", () => {
    expect(MAX_TOOL_RESULT_CHARS).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS * 10);
  });
});

describe("spillToolOutput", () => {
  test("写到会话目录、能原样读回，并带上工具名", () => {
    const text = `完整输出 ${"x".repeat(50)}`;
    const spill = spillToolOutput({ conversationId: 91_001, toolName: "bash", text });
    expect(spill).not.toBeNull();
    expect(spill!.path.startsWith(conversationSpillDir(91_001))).toBe(true);
    expect(spill!.path).toContain("bash");
    expect(spill!.path.endsWith(".txt")).toBe(true);
    expect(readFileSync(spill!.path, "utf8")).toBe(text);
    expect(spill!.truncated).toBe(false);
    clearConversationSpills(91_001);
    expect(existsSync(spill!.path)).toBe(false);
  });

  test("工具名进文件名前消毒（含路径分隔符也不会跑出目录）", () => {
    const spill = spillToolOutput({
      conversationId: 91_002,
      toolName: "../../etc/passwd",
      text: "hi",
    });
    expect(spill).not.toBeNull();
    expect(spill!.path.startsWith(conversationSpillDir(91_002))).toBe(true);
    expect(spill!.path).not.toContain("..");
    clearConversationSpills(91_002);
  });

  test("超过写盘上限时截断，并在结果里如实标注", () => {
    const spill = spillToolOutput({
      conversationId: 91_003,
      toolName: "bash",
      text: "a".repeat(50),
      maxBytes: 10,
    });
    expect(spill!.truncated).toBe(true);
    expect(readFileSync(spill!.path, "utf8")).toBe("a".repeat(10));
    clearConversationSpills(91_003);
  });

  test("只保留最近 N 个转存文件", () => {
    const dir = conversationSpillDir(91_004);
    const written: string[] = [];
    for (let index = 0; index < MAX_SPILLS_PER_CONVERSATION + 5; index += 1) {
      // 文件名以时间戳开头，同一毫秒内会重名 —— 这里靠循环里的小延迟拉开。
      const spill = spillToolOutput({
        conversationId: 91_004,
        toolName: `tool${index}`,
        text: String(index),
      });
      written.push(spill!.path);
      Bun.sleepSync(2);
    }
    const kept = readdirSync(dir).filter((name) => name.endsWith(".txt"));
    expect(kept.length).toBeLessThanOrEqual(MAX_SPILLS_PER_CONVERSATION);
    // 最新的那个一定还在（清理只针对更早的）。
    expect(existsSync(written[written.length - 1]!)).toBe(true);
    clearConversationSpills(91_004);
  });

  test("目录里没有 .txt 时清理不动手", () => {
    expect(pruneSpills("/definitely/not/a/dir")).toBe(0);
  });
});

describe("isSpillPath（那两处窄口子的边界）", () => {
  test("字面在转存目录里就算（写之前文件还不存在）", () => {
    const dir = conversationSpillDir(91_777);
    mkdirSync(dir, { recursive: true });
    try {
      expect(isSpillPath(path.join(dir, "还没写出来的.txt"))).toBe(true);
      expect(isSpillPath(dir)).toBe(true);
    } finally {
      clearConversationSpills(91_777);
    }
  });

  test("目录外的路径不算，别处也不被认成转存", () => {
    expect(isSpillPath("/tmp/whatever.txt")).toBe(false);
    expect(isSpillPath(path.join(spillRoot(), "..", "settings.db"))).toBe(false);
  });

  test("软链接指向凭据文件时不算：否则三道门一起被绕过", () => {
    // `tool-output/<会话>/x` 若是软链，光比字面路径会放行：凭据黑名单
    // （agent-tools）、工作区外读取授权（permissions）本来都靠这个函数开口子，
    // 于是"看起来在转存目录里"变成一张通行证。bash 工具自己就能建这个软链。
    const dir = conversationSpillDir(91_778);
    mkdirSync(dir, { recursive: true });
    const secret = path.join(tmpdir(), `omni-not-secret-${process.pid}.txt`);
    writeFileSync(secret, "凭据");
    const link = path.join(dir, "sneaky.txt");
    try {
      rmSync(link, { force: true });
      symlinkSync(secret, link);
      expect(isSpillPath(link)).toBe(false);
      // 会话目录本身指向别处（整目录替换）同样不算。
      const linkedDir = path.join(spillRoot(), "91_779");
      rmSync(linkedDir, { recursive: true, force: true });
      symlinkSync(tmpdir(), linkedDir);
      expect(isSpillPath(path.join(linkedDir, "x.txt"))).toBe(false);
    } finally {
      rmSync(link, { force: true });
      rmSync(path.join(spillRoot(), "91_779"), { force: true });
      rmSync(secret, { force: true });
      clearConversationSpills(91_778);
    }
  });
});
