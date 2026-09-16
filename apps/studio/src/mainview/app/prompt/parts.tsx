import { useEffect, useRef, useState } from "react";
import { ImageIcon, ArrowRightIcon, FilmIcon, Loader2Icon, BookMarkedIcon, SearchIcon, XIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { CopyButton } from "@components/copy-button";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { Input } from "@ui/input";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { usePromptNow } from "./use-prompt-now";
import type { PromptRow } from "../../../bun/prompt-library";

/** 工具栏搜索框（广场 / 我的 两处工具栏逐字相同，抽此件）。 */
export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const t = useT();
  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-52 pl-8 text-xs"
      />
      {value && (
        <button
          type="button"
          aria-label={t("common.cancel")}
          onClick={() => onChange("")}
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function PromptMedia({
  item,
  className,
  fit = "cover",
}: {
  item: PromptRow;
  className?: string;
  /** 卡片墙要铺满裁切（cover）；详情要看到整张图（contain）。 */
  fit?: "cover" | "contain";
}) {
  const [src, setSrc] = useState<string | null>(item.image);
  const [triedLocal, setTriedLocal] = useState(false);
  const ratio = item.ratio || "1 / 1";
  return (
    <div
      className={cn("relative w-full overflow-hidden bg-muted/60", className)}
      style={{ aspectRatio: ratio }}
    >
      {src ? (
        <img
          src={src}
          alt={item.name}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (triedLocal) {
              setSrc(null);
              return;
            }
            setTriedLocal(true);
            if (item.mediaKey) {
              void rpcClient.ensurePromptMedia({ path: item.mediaKey }).then((res) => {
                setSrc(res?.url ?? null);
              });
            } else {
              setSrc(null);
            }
          }}
          className={cn("absolute inset-0 size-full", fit === "contain" ? "object-contain" : "object-cover")}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-muted via-muted/40 to-background text-muted-foreground/50">
          {item.kind === "video" ? (
            <FilmIcon className="size-7" />
          ) : (
            <ImageIcon className="size-7" />
          )}
        </div>
      )}
      {/* hover 预览提示词（与参考原型一致） */}
      <div className="absolute inset-0 flex items-end bg-transparent transition-colors duration-200 group-hover:bg-black/55">
        <p className="line-clamp-5 p-3 text-left text-[11px] leading-relaxed text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          {item.prompt || item.summary || item.name}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 卡片（广场 / 我的 共用；extraActions 为操作区尾部附加按钮）
// ---------------------------------------------------------------------------


export function PromptCard({
  item,
  onOpen,
  extraActions,
}: {
  item: PromptRow;
  onOpen: () => void;
  extraActions?: React.ReactNode;
}) {
  const t = useT();
  const hasMedia = item.kind !== "llm";

  return (
    <article className="group mb-4 break-inside-avoid overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-lg">
      {hasMedia && (
        <button
          type="button"
          className="relative block w-full cursor-zoom-in"
          title={t("prompt.viewDetail")}
          onClick={onOpen}
        >
          <PromptMedia item={item} />
        </button>
      )}

      <div className="p-3.5">
        <button
          type="button"
          className="block w-full text-left"
          title={t("prompt.viewDetail")}
          onClick={onOpen}
        >
          <h3 className="truncate text-sm font-semibold text-foreground" title={item.name}>
            {item.name}
          </h3>
        </button>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {item.sourceKey && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
              {t("prompt.fromPlaza")}
            </Badge>
          )}
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
          {item.kind === "video" && item.mode && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
              {item.mode}
            </Badge>
          )}
        </div>

        {/* 预览：图片/视频用小结，大模型用提示词前几行 */}
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
          {item.kind === "llm" && item.summary ? item.summary : item.prompt}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <CopyButton text={item.prompt} label={t("prompt.copy")} variant="outline" />
          <Button
            size="sm"
            className="flex-1"
            disabled={!item.prompt}
            onClick={() => usePromptNow(item)}
          >
            {t("prompt.useIt")}
            <ArrowRightIcon data-icon="inline-end" className="size-3.5" />
          </Button>
          {extraActions}
        </div>
      </div>
    </article>
  );
}

/** 「加入我的提示词」按钮（广场卡片 / 详情浮层用）。 */

export function JoinMineButton({
  added,
  busy,
  onClick,
}: {
  added: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <Button
      size="icon-sm"
      variant={added ? "secondary" : "outline"}
      disabled={added || busy}
      tooltip={added ? t("prompt.added") : t("prompt.addToMine")}
      onClick={onClick}
    >
      {busy ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <BookMarkedIcon className="size-3.5" />
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// 详情浮层（左右切换 + 复制 / 去试试 / 附加操作）
// ---------------------------------------------------------------------------


export function InfiniteSentinel({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          onLoadMore();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);
  return <div ref={ref} className="h-4" />;
}
