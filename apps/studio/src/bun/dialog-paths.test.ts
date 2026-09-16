import { beforeEach, expect, test } from "bun:test";

import {
  isDialogPickedPath,
  rememberDialogPickedPaths,
  resetDialogPickedPaths,
} from "./dialog-paths";

beforeEach(() => resetDialogPickedPaths());

test("只有记过的路径才算数", () => {
  rememberDialogPickedPaths(["/Users/me/Documents/合同.pdf"]);
  expect(isDialogPickedPath("/Users/me/Documents/合同.pdf")).toBe(true);
  // 没选过的一律拒绝（webview 自己编的路径正是在这里被挡下）
  expect(isDialogPickedPath("/Users/me/.ssh/id_rsa")).toBe(false);
  expect(isDialogPickedPath("")).toBe(false);
  expect(isDialogPickedPath("   ")).toBe(false);
});

test("前后空格按同一路径处理（对话框返回值原样传回时可能带空白）", () => {
  rememberDialogPickedPaths(["  /tmp/a.png  "]);
  expect(isDialogPickedPath("/tmp/a.png")).toBe(true);
});

test("多选一次记多条", () => {
  rememberDialogPickedPaths(["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
  expect(isDialogPickedPath("/tmp/a.png")).toBe(true);
  expect(isDialogPickedPath("/tmp/c.png")).toBe(true);
});

test("上限：超出的按最早插入的丢，剩下的仍然可用", () => {
  const paths = Array.from({ length: 520 }, (_, i) => `/tmp/pick-${i}.png`);
  rememberDialogPickedPaths(paths);
  expect(isDialogPickedPath("/tmp/pick-0.png")).toBe(false);
  expect(isDialogPickedPath("/tmp/pick-519.png")).toBe(true);
});
