import { expect, test } from "bun:test";

import { newTaskWorkspace } from "./new-session";

/**
 * 「新任务」（⌘N / 顶部按钮 / 侧栏动作区）建在哪个工作区。
 *
 * 两种错法都真实发生过：
 *   - 在项目里按 ⌘N，新会话跑到全局默认目录去 —— 用户以为"在当前项目里接着开"，实际没有；
 *   - 反过来把全局默认路径**写死**进新会话 —— 临时会话被当成项目，从侧栏「会话」段跑到
 *     一个以默认目录命名的分组里，以后改全局默认它们也不会跟着走。
 */

test("当前会话挂在项目里：新任务接着开在那个文件夹", () => {
  expect(newTaskWorkspace("/repo/alpha", false)).toBe("/repo/alpha");
});

test("当前会话跟随全局：不把默认路径钉进新会话", () => {
  expect(newTaskWorkspace("/Users/me/workspace", true)).toBeUndefined();
});

test("还没有工作区（刚启动 / 设置没读回来）：跟随全局", () => {
  expect(newTaskWorkspace("", true)).toBeUndefined();
  expect(newTaskWorkspace("", false)).toBeUndefined();
});
