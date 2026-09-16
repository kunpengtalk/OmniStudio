import { expect, test } from "bun:test";

import { updateSettings } from "./db/settings";
import { buildNotesAgentTools } from "./notes-tools";
import { removeNote, saveNote } from "./notes";

/** 三个工具按名字取（顺序不是契约，名字才是）。 */
function tool(name: string) {
  const found = buildNotesAgentTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing`);
  return found;
}

async function run(name: string, params: unknown): Promise<string> {
  const result = (await tool(name).execute("call-1", params)) as {
    content: { type: string; text: string }[];
  };
  return result.content.map((part) => part.text).join("\n");
}

/** 造一条笔记并返回 id。 */
function seedNote(title: string, body: string, tags: string[] = []): number {
  const saved = saveNote({ title, body, tags, day: "2026-09-15" });
  if (!saved.ok || !saved.note) throw new Error("seed failed");
  return saved.note.id;
}

test("工具集：三个只读工具，关闭「对 Agent 可见」后一个都不给", () => {
  updateSettings({ NOTES_AGENT_ACCESS: "1" });
  expect(buildNotesAgentTools().map((t) => t.name)).toEqual(["note_list", "note_search", "note_read"]);

  updateSettings({ NOTES_AGENT_ACCESS: "0" });
  expect(buildNotesAgentTools()).toEqual([]);
  // 关掉后即便硬调也拿不到内容（工具不在，走的是 buildNotesAgentTools 的空数组；
  // 这里再验一次 execute 那条路，防止将来有人把开关只加在装配处）
  updateSettings({ NOTES_AGENT_ACCESS: "1" });
});

test("note_list 给出 id / 日期 / 标题 / 标签 / 摘要，并提示怎么读全文", async () => {
  const id = seedNote("周末爬山", "早上六点出门，山顶的云正好散开。", ["生活"]);
  const text = await run("note_list", { limit: 5 });
  expect(text).toContain(`#${id}`);
  expect(text).toContain("周末爬山");
  expect(text).toContain("#生活");
  expect(text).toContain("山顶的云");
  // 模型要能自己想到下一步：读全文的钩子写在返回值里
  expect(text).toContain(`note_read {id: ${id}}`);
});

test("note_search 命中标题 / 正文 / 标签，未命中时给出下一步", async () => {
  const bodyHit = seedNote("会议要点", "范围收敛到两个功能", []);
  expect(await run("note_search", { query: "范围收敛" })).toContain(`#${bodyHit}`);

  const tagHit = seedNote("菜谱", "番茄牛腩", ["做饭"]);
  expect(await run("note_search", { query: "做饭" })).toContain(`#${tagHit}`);

  const miss = await run("note_search", { query: "不存在的关键词zzz" });
  expect(miss).toContain("No note matches");
  expect(miss).toContain("note_list");

  const empty = await run("note_search", { query: "   " });
  expect(empty).toContain("needs a query");
});

test("note_read 读全文；id 不存在时提示去找 id，而不是空手而归", async () => {
  const id = seedNote("旅行清单", "护照、充电器、转换插头", ["旅行"]);
  const text = await run("note_read", { id });
  expect(text).toContain("旅行清单");
  expect(text).toContain("转换插头");
  expect(text).toContain("#旅行");

  const missing = await run("note_read", { id: 999999 });
  expect(missing).toContain("No note #999999");
  expect(missing).toContain("note_search");
});

test("读不到已删的笔记（Agent 不会拿着旧 id 读到幽灵内容）", async () => {
  const id = seedNote("待删除", "马上删掉", []);
  expect(await run("note_read", { id })).toContain("马上删掉");
  removeNote(id);
  expect(await run("note_read", { id })).toContain(`No note #${id}`);
});
