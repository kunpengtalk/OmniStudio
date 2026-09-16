import { expect, test } from "bun:test";

// 四个变体对应原来四处各写一份的小卡：类串必须逐字保留（统一不能改观感）。
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const { StatCard } = await import("./stat-card");

function render(props: Parameters<typeof StatCard>[0]) {
  return renderToStaticMarkup(createElement(StatCard, props));
}

const ICON = createElement("svg", { key: "i" });

test("row（记忆概览）：图标胶囊 + text-lg 数值", () => {
  const html = render({ label: "总数", value: 12, icon: ICON });
  expect(html).toContain("flex items-center gap-3 rounded-xl border bg-card px-4 py-3");
  expect(html).toContain("text-lg");
  expect(html).toContain("size-8 shrink-0 items-center justify-center rounded-lg bg-muted");
});

test("rowCompact（知识库详情）：紧凑行 + caption 追加在标签后", () => {
  const html = render({ variant: "rowCompact", label: "分块", value: "10", icon: ICON, caption: "80%" });
  expect(html).toContain("flex min-w-0 flex-1 items-center gap-2.5 rounded-xl border bg-card px-3 py-2");
  expect(html).toContain("分块 · 80%");
  expect(html).toContain("text-[10px]");
});

test("stack（概览页）：图标在标签行、text-2xl 数值与 hint", () => {
  const html = render({ variant: "stack", label: "请求", value: "3", icon: ICON, hint: "近 1 分钟" });
  expect(html).toContain("rounded-xl border bg-card p-4");
  expect(html).toContain("text-2xl");
  expect(html).toContain("近 1 分钟");
  expect(html).toContain("flex items-center gap-1.5 text-xs text-muted-foreground");
});

test("stackCompact（知识库治理）：muted 底、无图标、值在上标签在下", () => {
  const html = render({ variant: "stackCompact", label: "已入库", value: "42" });
  expect(html).toContain("flex flex-col gap-0.5 rounded-lg border bg-muted/30 px-2.5 py-1.5");
  expect(html).not.toContain("<svg");
  // 值先于标签
  expect(html.indexOf(">42<")).toBeLessThan(html.indexOf("已入库"));
});
