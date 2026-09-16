import { expect, test } from "bun:test";

import { noteDraftFromMessage } from "./note-draft";

const NOW = new Date(2026, 8, 15, 16, 30); // 2026-09-15 本地时间

test("取 # 标题当标题，正文不留重复的那一行", () => {
  const draft = noteDraftFromMessage("# 爬山路线\n\n早上六点出门。\n- 带上长焦", "对话", NOW)!;
  expect(draft.title).toBe("爬山路线");
  expect(draft.body).toBe("早上六点出门。\n- 带上长焦");
  expect(draft.tags).toEqual(["对话"]);
  expect(draft.day).toBe("2026-09-15");
});

test("首行短且还有下文时，首行当标题并从正文里取走", () => {
  const draft = noteDraftFromMessage("**结论**：先做 A\n\n理由是……", "Agent", NOW)!;
  expect(draft.title).toBe("结论：先做 A");
  expect(draft.body).toBe("理由是……");
});

test("单行消息：标题是截断后的首行，正文保持完整", () => {
  const long = "这是一段很长的单行回答，".repeat(10);
  const draft = noteDraftFromMessage(long, "对话", NOW)!;
  expect(draft.title.length).toBe(60);
  expect(draft.body).toBe(long);
});

test("首行过长时不当标题（免得标题成了半句话）", () => {
  const firstLine = "第一行其实是一整段很长的说明文字，远超过标题该有的长度所以不能整行拿去当标题用，这里再补一些字把它撑到七十个字符以上，确保它确实过长了。";
  expect(firstLine.length).toBeGreaterThan(60);
  const body = `${firstLine}\n\n第二段。`;
  const draft = noteDraftFromMessage(body, "对话", NOW)!;
  // 正文完整保留（首行没有被"取走"）
  expect(draft.body).toBe(body);
  expect(draft.title).toBe(firstLine.slice(0, 60));
});

test("只有标题行时正文不丢：标题取标记，正文仍是原文", () => {
  const draft = noteDraftFromMessage("## 只有一行", "对话", NOW)!;
  expect(draft.title).toBe("只有一行");
  expect(draft.body).toBe("## 只有一行");
});

test("空内容返回 null（调用方据此禁用按钮）", () => {
  expect(noteDraftFromMessage("", "对话", NOW)).toBeNull();
  expect(noteDraftFromMessage("   \n\n ", "对话", NOW)).toBeNull();
  expect(noteDraftFromMessage(undefined as unknown as string, "对话", NOW)).toBeNull();
});
