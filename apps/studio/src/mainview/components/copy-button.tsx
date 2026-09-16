// 复制按钮：原本在 OCR / 翻译 / 提示词三处各写一份（点击 → 图标切换 + 1.5s 复位）。
//
// 统一后顺带修一处小健壮性问题：webview 里 `navigator.clipboard` 可能不可用，
// 原来只有 OCR 那份做了可选链与 catch，另两份会抛。文本不同页可传 label /
// copiedLabel 保留各自措辞（例如 OCR 的“复制文本”）；代码行 / 卡片角标等紧凑
// 位置用 iconOnly + title（图标按钮）。
import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";

export function CopyButton({
  text,
  label,
  copiedLabel,
  variant = "ghost",
  size = "sm",
  iconOnly = false,
  title,
  className,
}: {
  text: string;
  /** 未复制时的按钮文案，缺省用通用「复制」。 */
  label?: string;
  /** 复制后的按钮文案，缺省用通用「已复制」。 */
  copiedLabel?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  /** 只显示图标（用于代码行 / 卡片角标等紧凑位置），此时靠 title 提供提示。 */
  iconOnly?: boolean;
  title?: string;
  className?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant={variant}
      size={size}
      disabled={!text}
      title={title}
      className={className}
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <CheckIcon data-icon={iconOnly ? undefined : "inline-start"} className="text-emerald-500" />
      ) : (
        <CopyIcon data-icon={iconOnly ? undefined : "inline-start"} />
      )}
      {!iconOnly && (copied ? (copiedLabel ?? t("common.copied")) : (label ?? t("common.copy")))}
    </Button>
  );
}
