import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckIcon, DownloadIcon, Loader2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/** 从内置音频服务 URL 推导扩展名（默认 mp3）。 */
function extFromUrl(url: string): string {
  const m = /\.([A-Za-z0-9]+)(?:\?|$)/.exec(url);
  return (m?.[1] ?? "mp3").toLowerCase();
}

/** 生成适合做文件名的建议名称，例如 qwen3-tts-0.6b-20260908143000.mp3。 */
export function audioFileName(url: string, label?: string): string {
  const safe =
    (label ?? "audio")
      .replace(/[\\/:*?"<>|\s·]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "audio";
  const now = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  return `${safe}-${now}.${extFromUrl(url)}`;
}

/**
 * 下载按钮：弹出目录选择框并把对应音频复制到所选目录。
 * 保存成功后短暂显示对勾，tooltip 显示保存路径。
 */
export function AudioDownloadButton({
  url,
  filename,
  className,
}: {
  url: string;
  filename: string;
  className?: string;
}) {
  const t = useT();
  const [saved, setSaved] = useState(false);
  const [savedPath, setSavedPath] = useState<string>();
  const [error, setError] = useState<string>();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mutation = useMutation({
    mutationFn: () => rpcClient.saveAudioToFolder({ url, filename }),
    onSuccess: (r) => {
      if (r.canceled) return;
      if (r.ok) {
        setError(undefined);
        setSavedPath(r.path);
        setSaved(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setSaved(false), 2000);
      } else {
        setError(r.error || t("voice.downloadFailed"));
        setSaved(false);
      }
    },
    onError: () => {
      setError(t("voice.downloadFailed"));
      setSaved(false);
    },
  });

  const tooltip = error
    ? error
    : saved
      ? savedPath
        ? `${t("voice.downloaded")}: ${savedPath}`
        : t("voice.downloaded")
      : t("voice.download");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      tooltip={tooltip}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      className={cn(
        "size-7 shrink-0",
        error ? "text-destructive" : saved ? "text-emerald-500" : "text-muted-foreground",
        className,
      )}
    >
      {mutation.isPending ? (
        <Loader2Icon className="size-4 animate-spin" />
      ) : saved ? (
        <CheckIcon className="size-4" />
      ) : (
        <DownloadIcon className="size-4" />
      )}
    </Button>
  );
}
