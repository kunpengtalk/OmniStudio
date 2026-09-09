import { useState } from "react";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 音频播放器：加载失败（文件已删除/不存在/无法解码）时给出提示，
 * 避免显示一个点了没反应的死播放器。
 */
export function AudioPlayer({ url, className }: { url: string; className?: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={cn(
          "flex h-7 items-center overflow-hidden rounded-md bg-destructive/5 px-2 text-[10px] text-destructive",
          className,
        )}
      >
        <span className="truncate">{t("voice.records.missing")}</span>
      </div>
    );
  }

  return (
    <audio
      controls
      src={url}
      preload="metadata"
      onError={() => setFailed(true)}
      className={cn("h-8 w-full", className)}
    />
  );
}
