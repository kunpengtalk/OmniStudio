import { expect, test } from "bun:test";

// 与 model-category-chips.test.tsx 同一套静态渲染做法：不需要 DOM。
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const { SegmentedControl } = await import("./segmented-control");

const TEXT = [
  { value: "local", label: "本地" },
  { value: "cloud", label: "云端" },
] as const;

const ICON = [
  { value: "a", label: "A", icon: createElement("svg", { key: "a" }) },
  { value: "b", label: "B", icon: createElement("svg", { key: "b" }) },
] as const;

function render(props: Parameters<typeof SegmentedControl>[0]) {
  return renderToStaticMarkup(createElement(SegmentedControl, props));
}

test("默认 detached：容器带内边距，按钮是圆角块", () => {
  const html = render({ value: "local", onChange: () => {}, options: TEXT });
  expect(html).toContain("gap-0.5 rounded-lg border bg-background p-0.5");
  expect(html).toContain("rounded-md px-2 py-1 font-medium");
  // 选中态用主色，未选中是 muted
  expect(html).toContain("bg-primary text-primary-foreground");
  expect(html).toContain("text-muted-foreground hover:bg-muted hover:text-foreground");
});

test("attached：容器裁切圆角，纯文字用 px-3，带图标收窄成 px-2 并留间距", () => {
  const text = render({ variant: "attached", value: "local", onChange: () => {}, options: TEXT });
  expect(text).toContain("flex overflow-hidden rounded-lg border");
  expect(text).toContain("px-3 py-1.5");
  expect(text).not.toContain("gap-1.5");

  const icon = render({ variant: "attached", value: "a", onChange: () => {}, options: ICON });
  expect(icon).toContain("gap-1.5 px-2 py-1.5");
  expect(icon).not.toContain("px-3 py-1.5");
  // 两颗图标都渲染出来
  expect([...icon.matchAll(/<svg/g)].length).toBe(2);
});

test("禁用时所有按钮都 disabled，点击不触发", () => {
  const html = render({ value: "local", onChange: () => {}, options: TEXT, disabled: true });
  expect([...html.matchAll(/disabled=""/g)].length).toBe(2);
});

test("自定义 className 能叠加到容器上（各页宽度/外边距不同）", () => {
  const html = render({ value: "local", onChange: () => {}, options: TEXT, className: "mb-2 w-fit" });
  expect(html).toContain("mb-2 w-fit");
});
