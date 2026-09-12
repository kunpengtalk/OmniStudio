import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { getWorkspaceChanges, getWorkspaceDiff, isGitRepo } from "./workspace-changes";
import { parseUnifiedDiff } from "../shared/diff";

/**
 * 「审查」页签的数据来源：git 仓库给文件清单 + 增删行数 + unified diff，
 * 非仓库 / 工作区不存在时也不抛异常（界面回落到本会话改动）。
 */

const root = mkdtempSync(path.join(tmpdir(), "omni-changes-"));
const plain = mkdtempSync(path.join(tmpdir(), "omni-changes-plain-"));

async function git(args: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd: ["git", "-C", root, ...args], stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

mkdirSync(path.join(root, "src"), { recursive: true });
writeFileSync(path.join(root, "src", "keep.ts"), "export const keep = 1;\n");
await git(["init", "-q"]);
await git(["config", "user.email", "test@example.com"]);
await git(["config", "user.name", "Test"]);
await git(["add", "."]);
await git(["commit", "-qm", "init"]);

// 改一个已跟踪文件 + 新增一个未跟踪文件
writeFileSync(path.join(root, "src", "keep.ts"), "export const keep = 1;\nexport const added = 2;\n");
writeFileSync(path.join(root, "src", "brand-new.ts"), "line1\nline2\n");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

test("git 仓库：列出改动文件与增删行数", async () => {
  expect(await isGitRepo(root)).toBe(true);
  const changes = await getWorkspaceChanges(root);
  expect(changes.isRepo).toBe(true);

  const modified = changes.files.find((file) => file.path === "src/keep.ts");
  expect(modified?.status).toBe("M");
  expect(modified?.added).toBe(1);
  expect(modified?.removed).toBe(0);

  const untracked = changes.files.find((file) => file.path === "src/brand-new.ts");
  expect(untracked?.status).toBe("??");
  // 未跟踪文件没有 numstat，行数是数出来的
  expect(untracked?.added).toBe(2);
});

test("unified diff：改过的文件给标准 diff，未跟踪文件跟 /dev/null 比", async () => {
  const modified = await getWorkspaceDiff(root, "src/keep.ts");
  expect(modified.binary).toBe(false);
  expect(modified.diff).toContain("@@");
  expect(modified.diff).toContain("+export const added = 2;");

  const untracked = await getWorkspaceDiff(root, "src/brand-new.ts");
  expect(untracked.diff).toContain("+line1");
  expect(untracked.diff).toContain("+line2");
});

test("越界路径被拒（面板里点不到工作区之外）", async () => {
  await expect(getWorkspaceDiff(root, "../../etc/passwd")).rejects.toThrow();
  await expect(getWorkspaceDiff(root, "/etc/passwd")).rejects.toThrow();
});

test("非仓库 / 不存在的目录不抛异常", async () => {
  const plainChanges = await getWorkspaceChanges(plain);
  expect(plainChanges.isRepo).toBe(false);
  expect(plainChanges.files).toEqual([]);

  const missing = await getWorkspaceChanges("/definitely/not/here");
  expect(missing.isRepo).toBe(false);
  expect(missing.error).toBeTruthy();
});

test("diff 行分类：+ / - / @@ / 上下文", () => {
  const lines = parseUnifiedDiff(
    ["diff --git a/x b/x", "@@ -1,2 +1,2 @@", "-old", "+new", " same"].join("\n"),
  );
  expect(lines.map((line) => line.type)).toEqual(["meta", "meta", "del", "add", "context"]);
  expect(lines[3]?.text).toBe("new");
});
