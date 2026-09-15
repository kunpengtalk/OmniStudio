import { beforeEach, expect, test } from "bun:test";

import { isViewing, resetViewState, setViewState, shouldNotifyTurnEnd } from "./view-state";

beforeEach(() => {
  resetViewState();
});

test("只有「窗口聚焦 + 正是这个会话」才算在看", () => {
  // 初始：没在看任何会话（刚启动时还没有会话被选中）
  expect(isViewing(7)).toBe(false);
  setViewState({ conversationId: 7 });
  expect(isViewing(7)).toBe(true);
  expect(isViewing(8)).toBe(false);

  // 人切到别的应用：会话还选着，但窗口失焦 —— 不能算在看
  setViewState({ focused: false });
  expect(isViewing(7)).toBe(false);
  setViewState({ focused: true });
  expect(isViewing(7)).toBe(true);

  // 切到「新任务」页 / 别的应用页：前端报 null
  setViewState({ conversationId: null });
  expect(isViewing(7)).toBe(false);
});

test("部分更新：切会话不会把焦点状态带跑，反之亦然", () => {
  setViewState({ focused: false });
  setViewState({ conversationId: 3 });
  expect(isViewing(3)).toBe(false);

  setViewState({ focused: true });
  expect(isViewing(3)).toBe(true);

  // 只报会话、不报焦点时，焦点保持上一次的值
  setViewState({ conversationId: 4 });
  expect(isViewing(3)).toBe(false);
  expect(isViewing(4)).toBe(true);
});

test("跑完的通知：无人值守一律发，交互式只在没看着时发", () => {
  // 无人值守：没人在看，照发
  expect(shouldNotifyTurnEnd({ headless: true, conversationId: 7 })).toBe(true);

  // 交互式 + 正看着这个会话：不打扰
  setViewState({ conversationId: 7, focused: true });
  expect(shouldNotifyTurnEnd({ headless: false, conversationId: 7 })).toBe(false);

  // 同一个会话，但人切到别的应用去了
  setViewState({ focused: false });
  expect(shouldNotifyTurnEnd({ headless: false, conversationId: 7 })).toBe(true);

  // 窗口聚焦，但看的是另一个会话
  setViewState({ conversationId: 8, focused: true });
  expect(shouldNotifyTurnEnd({ headless: false, conversationId: 7 })).toBe(true);
});
