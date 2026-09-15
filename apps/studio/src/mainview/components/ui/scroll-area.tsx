"use client";

import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { cn } from "@lib/utils";

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        // 视口是真正滚动的那层，高度是 height:100% —— 只有祖先链上存在**确定
        // 高度**时百分比才会解析成滚动高度。实测：祖先盒子只给 max-h（自身高度
        // 由内容决定）时，视口会被内容撑开 1889px 顶穿 384px 的根，列表被裁掉
        // 且拉不动；根给 max-h 也一样。所以调用方要给滚动区一个确定高度
        // （h-*、h-full、flex-1 + 父级 h-*），min-h-0 保证它在 flex 里能收缩。
        //
        // 尾两项藏的是**视口自己的原生滚动条**：Radix 的视口固定 overflow:scroll，
        // 它明确要求调用方用 CSS 把原生条藏掉（见 react-scroll-area 的 viewport
        // 注释）。少了这一步，滚动区里会同时出现「原生条 + 下面那个自定义拇指」，
        // 系统开着"始终显示滚动条"时更是常驻一条灰杠。
        className="size-full min-h-0 rounded-[inherit] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      // 细拇指（6px）与工作台的滚动条约定一致：静止时不画，指针进到容器里才浮出来
      // —— Radix 默认 type="hover" 已经保证后半句，这里只管粗细与颜色。
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-1.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-1.5 data-vertical:border-l data-vertical:border-l-transparent",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border transition-colors hover:bg-muted-foreground/40"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
