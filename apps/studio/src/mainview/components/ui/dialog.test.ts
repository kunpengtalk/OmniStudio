import { expect, test } from "bun:test";

import { cn } from "../../lib/utils";
import { DIALOG_DEFAULT_WIDTH, dialogWidthClass } from "./dialog";

/**
 * 弹窗宽度的回归测试：调用方写的 max-w-* 必须真的生效。
 *
 * 背景见 dialog.tsx 上 DIALOG_DEFAULT_WIDTH 的注释 —— Tailwind v4 的样式表里
 * `max-w-sm`（无论是否带 sm: 变体）都排在 `max-w-lg` / `max-w-4xl` 之后，默认宽度一旦
 * 无条件叠上去，桌面上所有弹窗都会被压回 384px（提示词详情弹窗就是这么被挤扁、
 * 底部按钮被裁掉的）。
 *
 * 这里不渲染 DOM：happy-dom 的样式层叠本来就跑不出真实结果，而这些测试文件还会共用
 * 同一个全局 window、互相踩（跑整个 mainview 目录时那几个 Radix 弹窗测试就是这么挂的）。
 * 断言落在「最终类名」这一层，样式表顺序由上面那份注释兜住。
 */
test("调用方写了 max-w-* 时，默认宽度让位", () => {
  expect(dialogWidthClass("max-w-4xl")).toBeUndefined();
  expect(dialogWidthClass("max-w-lg")).toBeUndefined();
  expect(dialogWidthClass("max-w-sm")).toBeUndefined();
  expect(dialogWidthClass("flex max-h-[85vh] max-w-[min(56rem,calc(100%-2rem))] p-0")).toBeUndefined();
  // max-h-* 不是 max-w-*，别误判
  expect(dialogWidthClass("max-h-[85vh] p-0")).toBe(DIALOG_DEFAULT_WIDTH);
});

test("sm:max-w-* 的调用方保留默认值，小屏仍有 384px 兜底", () => {
  expect(dialogWidthClass("max-h-[80vh] sm:max-w-2xl")).toBe(DIALOG_DEFAULT_WIDTH);
  expect(dialogWidthClass("lg:max-w-lg")).toBe(DIALOG_DEFAULT_WIDTH);
});

test("没写宽度的弹窗才吃到默认值", () => {
  expect(dialogWidthClass()).toBe(DIALOG_DEFAULT_WIDTH);
  expect(dialogWidthClass("flex flex-col gap-0 p-0")).toBe(DIALOG_DEFAULT_WIDTH);
});

test("默认值是普通工具类，且合并后调用方宽度在场", () => {
  // 一旦写成 sm:max-w-sm，变体在样式表里排在普通工具类之后，会把调用方的宽度顶掉。
  expect(DIALOG_DEFAULT_WIDTH.startsWith("sm:")).toBe(false);

  const merged = cn("fixed z-50 grid w-full", dialogWidthClass("max-w-4xl"), "max-w-4xl");
  expect(merged).toContain("max-w-4xl");
  expect(merged).not.toContain(DIALOG_DEFAULT_WIDTH);

  expect(cn("fixed z-50 grid w-full", dialogWidthClass(), undefined)).toContain(
    DIALOG_DEFAULT_WIDTH,
  );

  // sm: 变体的调用方与默认值共存，靠样式表里变体在后取胜（回归到旧写法就会失效）。
  const withVariant = cn("fixed z-50 grid w-full", dialogWidthClass("sm:max-w-2xl"), "sm:max-w-2xl");
  expect(withVariant).toContain("sm:max-w-2xl");
  expect(withVariant).toContain(DIALOG_DEFAULT_WIDTH);
});

test("提示词详情弹窗：868px 的两栏宽度能真的落到元素上", () => {
  // app/prompt/detail-dialog.tsx 里那个把图片和提示词分两栏的详情弹窗。
  const detail = "flex max-h-[85vh] max-w-[min(56rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0";
  const merged = cn("fixed z-50 grid w-full", dialogWidthClass(detail), detail);
  expect(merged).toContain("max-w-[min(56rem,calc(100%-2rem))]");
  expect(merged).not.toContain(DIALOG_DEFAULT_WIDTH);
});
