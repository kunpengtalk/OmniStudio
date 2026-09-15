import { beforeEach, expect, test } from "bun:test";

import { useAgentStore } from "./agent";

/**
 * 运行态（`running`）的权威来源是后端：只有它知道"刷新窗口之后还在不在跑"、
 * "自动化在后台起的这一轮算不算数"。这里钉住它不被两件事带偏：
 *   1. 别的会话的推送 —— 后台会话跑完不该让当前这一屏停止转圈；
 *   2. 刚点发送的那一瞬间 —— 请求还在路上、后端尚未登记，此时把状态清掉
 *      会让秒数和停止按钮闪一下就没（看着像"自己停了"）。
 */

const store = () => useAgentStore.getState();

beforeEach(() => {
  store().clear();
  store().setConversationId(1);
});

test("后端说在跑：点亮运行态", () => {
  store().setRunningFor(1, true);
  expect(store().running).toBe(true);
});

test("后端说没在跑：解除运行态", () => {
  store().setRunningFor(1, true);
  useAgentStore.setState({ runningSince: Date.now() - 60_000 });
  store().setRunningFor(1, false);
  expect(store().running).toBe(false);
});

test("别的会话的运行态不改变当前这一屏", () => {
  store().setRunningFor(2, true);
  expect(store().running).toBe(false);

  store().setRunningFor(1, true);
  store().setRunningFor(2, false);
  expect(store().running).toBe(true);
});

test("刚发出的一轮：后端还没登记时不清运行态", () => {
  store().setRunning(true); // 点发送
  store().setRunningFor(1, false); // 请求还在路上，后端此刻还是"没在跑"
  expect(store().running).toBe(true);
});

test("后端确认过在跑之后，收尾立刻生效（短回合在宽限窗口内跑完也不会留着转圈）", () => {
  store().setRunning(true);
  store().setRunningFor(1, true); // 后端登记了：这一轮确实在跑
  store().setRunningFor(1, false); // 两秒后跑完，推送到达 —— 此刻仍在宽限窗口内
  expect(store().running).toBe(false);
});

test("宽限过后：后端说停了就停（漏掉一条推送也能自己纠正）", () => {
  store().setRunning(true);
  // 把"刚发出"的时刻往前拨，等价于等过了宽限窗口。
  useAgentStore.setState({ runningSince: Date.now() - 60_000 });
  store().setRunningFor(1, false);
  expect(store().running).toBe(false);
});

test("本地收尾（停止 / chatDone）立刻生效，不等宽限", () => {
  store().setRunning(true);
  store().setRunning(false);
  expect(store().running).toBe(false);
  expect(store().runningSince).toBeNull();
});

test("切会话：运行态跟着清（上一个会话在跑 ≠ 这个会话在跑）", () => {
  store().setRunningFor(1, true);
  store().setConversationId(2);
  expect(store().running).toBe(false);
  // 迟到的推送属于上一个会话：不能把新会话点亮。
  store().setRunningFor(1, true);
  expect(store().running).toBe(false);
});

/**
 * 轨迹的增量合并（`mergeEvents`）。
 *
 * 跑动中界面按 `afterId` 定期追平推送丢掉的那几条 —— 同一条事件可能既走了推送
 * 又被追平取回来，所以这里必须按 id 去重；顺序也必须按 id 排（追平是"补历史"，
 * 不是"追加到现在"）。这是"执行到一半记录加不上"的最后一道保险，丢了就是
 * 用户看到界面永远停在某一刻。
 */
const traceEvent = (id: number, conversationId = 1) => ({
  id,
  conversationId,
  messageId: 10,
  kind: "tool_start" as const,
  toolName: "bash",
  args: null,
  output: null,
  isError: 0,
  subagentId: null,
  createdAt: id,
});

test("轨迹增量：补上的事件按 id 排好，重复到达的不渲染两遍", () => {
  store().setEvents([traceEvent(1), traceEvent(2)]);
  store().mergeEvents([traceEvent(4), traceEvent(3)]); // 追平拿回来的顺序不保证
  expect(store().events.map((e) => e.id)).toEqual([1, 2, 3, 4]);

  // 推送与追平撞在同一条上（真实会发生）：列表不变。
  store().mergeEvents([traceEvent(4)]);
  expect(store().events.map((e) => e.id)).toEqual([1, 2, 3, 4]);

  // 空数组是常态（没丢推送时每次追平都返回空），不能把列表清掉。
  store().mergeEvents([]);
  expect(store().events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
});

test("轨迹增量：别的会话的事件不串进来", () => {
  store().setEvents([traceEvent(1)]);
  store().mergeEvents([traceEvent(2, 2)]);
  expect(store().events.map((e) => e.id)).toEqual([1]);
});

test("点产物：右侧面板打开这个产物的预览页签", () => {
  useAgentStore.setState({ panelOpen: false, panelTabs: [{ kind: "artifacts" }], activeTabIndex: 0 });
  store().setPreview({ source: "artifact", artifactId: 7 });

  expect(store().panelOpen).toBe(true);
  expect(store().panelTabs[store().panelTabs.length - 1]).toEqual({ kind: "artifact", artifactId: 7 });
  expect(store().activeTabIndex).toBe(store().panelTabs.length - 1);

  // 同一个产物再点一次：聚焦已有页签，不叠重复的。
  store().setPreview({ source: "artifact", artifactId: 7 });
  expect(store().panelTabs.filter((tab) => tab.kind === "artifact")).toHaveLength(1);

  store().closePreviewTabs();
});

test("「查看所有产物」：聚焦常驻的产出物页签并展开面板", () => {
  useAgentStore.setState({ panelOpen: false, panelTabs: [], activeTabIndex: 0 });
  store().openPanelTab({ kind: "artifacts" });
  expect(store().panelOpen).toBe(true);
  expect(store().panelTabs).toEqual([{ kind: "artifacts" }]);

  // 已经开着就不再叠一个（用户点两次不该出现两个产出物页签）。
  store().openPanelTab({ kind: "artifacts" });
  expect(store().panelTabs).toHaveLength(1);
});
