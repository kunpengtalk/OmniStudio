import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AudioLinesIcon, BookOpenIcon, ImageIcon, VideoIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { KbImageViewer } from "@components/kb-image-viewer";
import { useT } from "@stores/ui-lang";
import type { KbCitation, KbModality } from "../../../shared/knowledge";

/**
 * 助手消息底部的知识库引用溯源条（自 chat-screen 抽出）：
 * 编号 + 来源文档胶囊，图片引用带 24px 缩略图，点击开大图查看器。
 */

/** 媒体直嵌块引用的模态图标（与 docs/recall 的 MEDIA_META 同语言；模块级避免每次渲染重建）。 */
const MODALITY_ICONS: Record<KbModality, typeof ImageIcon> = {
  image: ImageIcon,
  audio: AudioLinesIcon,
  video: VideoIcon,
};

/**
 * 图片引用胶囊的缩略图：与 docs-tab MediaChunkBlock 同 queryKey（"kb-chunk-media"）
 * 共享缓存；取图失败 / 旧引用缺 chunkId（enabled 门控零请求）回退模态图标。
 * 点击 stopPropagation 后开大图查看器，不影响胶囊其余部分。
 */
function CitationThumb({ chunkId, onOpen }: { chunkId: number | null; onOpen: () => void }) {
  const mediaQuery = useQuery({
    // 缩略图基本不变（媒体文件不会被就地改写，重建时 chunk id 会换），缓存期拉长。
    queryKey: ["kb-chunk-media", chunkId],
    queryFn: () => rpcClient.kbChunkMedia({ chunkId: chunkId! }),
    // 旧引用没有 chunkId（历史消息）：不发请求，图标照旧。
    enabled: Boolean(chunkId),
    staleTime: 10 * 60_000,
  });
  // 请求落定但拿不到图（文件缺失等）回退模态图标；pending 期间同样先给图标。
  if (mediaQuery.isError || mediaQuery.data?.dataUrl == null) {
    return <ImageIcon className="size-3 shrink-0" aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      className="shrink-0 overflow-hidden rounded-md"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <img src={mediaQuery.data.dataUrl} alt="" className="size-6 rounded-md object-cover" />
    </button>
  );
}

/** 助手消息底部的知识库引用溯源：编号 + 来源文档，悬浮显示片段预览。 */
export function CitationBar({ citations }: { citations: KbCitation[] }) {
  const t = useT();
  // 单实例大图查看器：点缩略图记 chunkId，关闭清空。
  const [viewerChunkId, setViewerChunkId] = useState<number | null>(null);
  if (citations.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 pt-0.5">
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
        <BookOpenIcon className="size-3" />
        {t("chat.citations")}
      </span>
      {citations.map((c) => {
        const MediaIcon = c.modality ? MODALITY_ICONS[c.modality] : null;
        return (
          <span
            key={`${c.docId}-${c.seq}-${c.n}`}
            title={c.snippet}
            className="inline-flex max-w-56 items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {c.modality === "image" ? (
              <CitationThumb
                chunkId={c.chunkId ?? null}
                onOpen={() => {
                  if (c.chunkId != null) setViewerChunkId(c.chunkId);
                }}
              />
            ) : (
              MediaIcon && <MediaIcon className="size-3 shrink-0" />
            )}
            <span className="font-mono text-primary/80">[{c.n}]</span>
            <span className="truncate">{c.docName}</span>
            <span className="shrink-0 font-mono text-muted-foreground/60">#{c.seq}</span>
          </span>
        );
      })}
      <KbImageViewer
        chunkId={viewerChunkId}
        open={viewerChunkId != null}
        onClose={() => setViewerChunkId(null)}
      />
    </div>
  );
}
