// 媒体类结果页（语音 / 图像 / 视频）共用的展示件。
//
// 抽出来的原因：`ResultError` 曾在三个屏里各写一份、逐字相同。这类「结果区」的
// 组件一旦各写各的，改一次样式要改三处，且很容易只改到其中一两个。
import type { ReactNode } from "react";

/** 生成 / 转写失败时的错误条；没有错误就什么都不渲染（调用点可直接内联）。 */
export function ResultError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
      {error}
    </div>
  );
}

/** 空状态：图标 + 标题 + 可选提示。用于「还没开始 / 没有结果」。 */
export function ResultEmpty({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
        {icon}
      </div>
      <p className="text-lg font-medium">{title}</p>
      {hint && <p className="max-w-xs text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}
