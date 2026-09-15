import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * 侧栏横向滚动条的回归测试。
 *
 * 已发生的故障：会话标题是 nowrap 的，而会话行是 flex 项 —— **flex 项的自动最小尺寸
 * 是内容的最小宽度**，于是一条 40 字的首条消息把整行顶到 530px，而侧栏只有 275px，
 * 列表（overflow-y: auto，其 overflow-x 会被计算成 auto）就长出一条横向滚动条。
 * 正确的行为是：行能被压回容器宽度，标题走省略号。
 *
 * 布局在 happy-dom 里量不出来（没有排版引擎），所以这里钉住两条声明本身 ——
 * 它们不是样式偏好，是"长标题只截断、不横向滚"的硬约束。
 */
const css = readFileSync(join(import.meta.dir, "agent-pi.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\n\\}`).exec(css);
  if (!match) throw new Error(`找不到 ${selector} 的规则`);
  return match[1]!;
}

test("会话行能被压到容器宽度，标题才能落到省略号上", () => {
  expect(rule(".pi-thread")).toContain("min-width: 0");
  // 标题自身的省略号：min-width: 0 只管得住行，文字还要自己截
  const title = rule(".pi-thread-title");
  expect(title).toContain("min-width: 0");
  expect(title).toContain("text-overflow: ellipsis");
  expect(title).toContain("white-space: nowrap");
});

test("文本列表只纵向滚：overflow-y:auto 会把 overflow-x 也算成 auto", () => {
  for (const selector of [
    ".pi-scroll-group",
    ".pi-notif-list",
    ".pi-menu-scroll",
    ".composer-ac-list",
    ".wp-scroll",
    ".composer-stack-panels",
  ]) {
    expect(rule(selector)).toContain("overflow-x: hidden");
  }
});

/**
 * 会话行点击区的回归测试。
 *
 * 已发生的故障：`<button>` 的 `width: auto` 是按**内容**算的（fit-content），而行外面
 * 还套着一层装行尾"更多"按钮的定位 div，拿不到父级 flex 的 stretch —— 整行的点击区
 * 只有文字那么宽，点在行右侧的空白处没反应；标题长的行还会被撑到侧栏外面，把"更多"
 * 按钮顶到点不着的位置（实测行宽 320px、侧栏只有 275px）。
 *
 * 真机上的命中区在 happy-dom 里量不出来（没有排版引擎），所以这里钉住声明本身 ——
 * 这两处宽度不是样式偏好，是"点哪一行都算点到"的硬约束。
 */
test("会话行与「查看更多」必须显式铺满整行", () => {
  expect(rule(".pi-thread")).toContain("width: 100%");
  expect(rule(".pi-list-more")).toContain("width: 100%");
});

/**
 * 输入框上方那几张进度卡片（待办 / 目标 / 方案 / 队列）的底色回归测试。
 *
 * 已发生的故障：卡片是**浮在消息流上方**的，而它们用 shadcn 的 `bg-muted/30`
 * （30% 透明）当底 —— 透明底挡不住任何东西，底下的正文直接透上来，两段文字
 * 叠在一起看着像渲染错乱。卡片必须取 Agent 工作台自己的不透明 token，
 * 颜色同理（两套灰阶混用会在暗色主题下错位）。
 *
 * 真机上的合成结果量不出来，所以这里钉住两条：外壳取的是不透明 token，
 * 且四张卡片都不再自带半透明底。
 */
test("浮在消息流上方的卡片必须是不透明底", () => {
  const panel = rule(".composer-panel");
  expect(panel).toContain("background: var(--ds-bg-composer)");
  // 卡片区是滚动容器，卡片还要守住自己的高度，否则会被 flex 压扁
  expect(panel).toContain("flex: none");
  expect(rule(".composer-panel.accent")).toContain("var(--ds-bg-composer)");
});

test("进度卡片不自带半透明底，统一用 .composer-panel 骨架", () => {
  const files = ["todo-panel.tsx", "goal-panel.tsx", "queue-panel.tsx", "plan-card.tsx"];
  for (const file of files) {
    const src = readFileSync(join(import.meta.dir, "..", "app", "agent", file), "utf8");
    expect(src).toContain("composer-panel");
    expect(src).not.toMatch(/bg-(muted|primary)\/\d/);
  }
});
