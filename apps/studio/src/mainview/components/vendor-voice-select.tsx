import { useId } from "react";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { Input } from "@ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Label } from "@ui/label";
import { vendorVoices, type AudioVendorId } from "@/shared/tts-voices";

/**
 * 云厂商音色选择：官方音色下拉 + 自定义音色 ID 输入。
 *
 * 为什么两个控件而不是一个：音色名是各家自己的 id，除了平台列的官方音色，还有
 * 用户自己复刻出来的（阶跃的复刻音色就是一个自定义 id）。所以**下拉是快捷方式、
 * 输入框才是真值** —— 点下拉等于把官方 id 填进输入框，复刻音色直接手填即可。
 *
 * 布局按「窄面板里的选择器一律上下排」来（同 CloudModelSelect）：三个控件竖着摞，
 * 触发器一律 `w-full min-w-0`（SelectTrigger 默认是 w-fit，长音色名会撑破单元格
 * 压到隔壁列上），下拉弹层给固定宽度，免得 id 被挤成省略号。
 * 厂商没有内置目录时只渲染输入框，与改造前完全一致。
 */
export function VendorVoiceField({
  vendor,
  value,
  onChange,
  placeholder,
  label,
  className,
  labelClassName = "text-[11px] text-muted-foreground",
}: {
  vendor: AudioVendorId;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  className?: string;
  /** 标签样式由调用方定：通话页的字段比语音页矮一档，两边各自保持一致。 */
  labelClassName?: string;
}) {
  const t = useT();
  const inputId = useId();
  const voices = vendorVoices(vendor);
  const known = voices.some((v) => v.id === value);

  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <Label htmlFor={inputId} className={labelClassName}>
        {label}
      </Label>
      {voices.length > 0 && (
        /* value 始终是字符串（受控）：在"有值但不在清单里"时给一条同值的「自定义」项，
           既让触发器有东西可显示，也不会让 Radix 在受控 / 非受控之间来回切。 */
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger size="sm" className="h-8 w-full min-w-0 text-xs">
            <SelectValue placeholder={t("voice.vendorVoice.custom")} />
          </SelectTrigger>
          <SelectContent
            position="popper"
            sideOffset={6}
            className="w-[20rem] max-w-[min(20rem,90vw)]"
          >
            {!known && value.trim() ? (
              <SelectItem value={value}>
                <span className="min-w-0 flex-1 truncate">{t("voice.vendorVoice.custom")}</span>
              </SelectItem>
            ) : null}
            {voices.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                <span className="min-w-0 flex-1 truncate">{v.label}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                  {v.id}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // 有官方清单时输入框就是"自定义音色"那一栏（复刻音色直接填 id）；
        // 没有清单时它就是唯一的音色栏，占位符用调用方给的那个。
        placeholder={voices.length > 0 ? t("voice.vendorVoice.customPlaceholder") : placeholder}
        className="h-8 text-xs"
      />
    </div>
  );
}
