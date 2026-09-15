import { expect, test } from "bun:test";

import { parseWorkspaceRecents, withRecentWorkspace, workspaceLabel } from "./workspace";

test("展示名取路径最后一段，尾部斜杠不算一段", () => {
  expect(workspaceLabel("/Users/me/code/OmniStudio")).toBe("OmniStudio");
  expect(workspaceLabel("/Users/me/code/OmniStudio/")).toBe("OmniStudio");
  expect(workspaceLabel("")).toBe("");
});

test("最近工作区：坏 JSON 与非字符串项都丢掉，不抛异常", () => {
  expect(parseWorkspaceRecents(undefined)).toEqual([]);
  expect(parseWorkspaceRecents("{不是 JSON")).toEqual([]);
  expect(parseWorkspaceRecents('{"a":1}')).toEqual([]);
  expect(parseWorkspaceRecents('["/a", 3, null, "/b"]')).toEqual(["/a", "/b"]);
});

test("把一个工作区提到最前：去重 + 最多 8 条", () => {
  expect(withRecentWorkspace(["/b", "/a"], "/a")).toEqual(["/a", "/b"]);
  expect(withRecentWorkspace([], "/a")).toEqual(["/a"]);
  const nine = Array.from({ length: 9 }, (_, i) => `/w${i}`);
  const next = withRecentWorkspace(nine, "/new");
  expect(next).toHaveLength(8);
  expect(next[0]).toBe("/new");
  // 满员时挤掉的是最旧那条
  expect(next).not.toContain("/w8");
});
