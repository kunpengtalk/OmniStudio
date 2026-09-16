import { ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { CopyButton } from "@components/copy-button";
import { Button } from "@ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@ui/dialog";
import { ScrollArea } from "@ui/scroll-area";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { PromptMedia } from "./parts";
import { usePromptNow } from "./use-prompt-now";
import type { PromptRow } from "../../../bun/prompt-library";

export function PromptDetailDialog({
  items,
  index,
  onClose,
  onStep,
  footerExtra,
}: {
  items: PromptRow[];
  index: number;
  onClose: () => void;
  onStep: (delta: number) => void;
  footerExtra?: React.ReactNode;
}) {
  const t = useT();
  const item = items[index];
  if (!item) return null;
  const hasMedia = item.kind !== "llm";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-[min(56rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0 sm:rounded-2xl">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          {hasMedia && (
            <div className="relative flex shrink-0 items-center justify-center bg-muted/50 p-4 md:w-1/2">
              {/* max-h-full：竖版（9:16 / 2:3 / 3:4 占题库大头）按宽度算出来的高度会顶穿
                  85vh 的弹窗，这里压回面板高度，超出的部分由 contain 缩放而不是被裁掉。 */}
              <PromptMedia item={item} className="max-h-full rounded-lg border" fit="contain" />
              {items.length > 1 && (
                <>
                  <button
                    type="button"
                    aria-label={t("prompt.prev")}
                    onClick={() => onStep(-1)}
                    className="absolute top-1/2 left-3 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 text-foreground shadow transition-colors hover:bg-background"
                  >
                    <ChevronLeftIcon className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("prompt.next")}
                    onClick={() => onStep(1)}
                    className="absolute top-1/2 right-3 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 text-foreground shadow transition-colors hover:bg-background"
                  >
                    <ChevronRightIcon className="size-4" />
                  </button>
                </>
              )}
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-3 border-b py-4 pr-12 pl-5">
              <div className="min-w-0">
                <DialogHeader>
                  <DialogTitle className="truncate text-left text-base">{item.name}</DialogTitle>
                </DialogHeader>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="text-[10px] font-normal">
                    {t(`prompt.kind.${item.kind}`)}
                  </Badge>
                  {item.subcategory && (
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      {item.subcategory}
                    </Badge>
                  )}
                  {item.sourceLabel && (
                    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                      {item.sourceLabel}
                    </Badge>
                  )}
                  {item.sourceKey && (
                    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                      {t("prompt.fromPlaza")}
                    </Badge>
                  )}
                  {item.kind === "video" && (
                    <span className="text-[10px] text-muted-foreground">
                      {item.mode}
                      {item.duration ? ` · ${item.duration}s` : ""}
                      {item.ratio ? ` · ${item.ratio.replace(/\s/g, "")}` : ""}
                    </span>
                  )}
                </div>
                {item.summary && (
                  <DialogDescription className="mt-1.5 text-xs">{item.summary}</DialogDescription>
                )}
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="px-5 py-4">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                  {item.prompt}
                </p>
              </div>
            </ScrollArea>

            <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3.5">
              <CopyButton text={item.prompt} label={t("prompt.copyFull")} variant="outline" />
              <Button className="flex-1" disabled={!item.prompt} onClick={() => usePromptNow(item)}>
                {t("prompt.useIt")}
                <ArrowRightIcon data-icon="inline-end" className="size-3.5" />
              </Button>
              {footerExtra}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 提示词广场（内置精选题库）
// ---------------------------------------------------------------------------
