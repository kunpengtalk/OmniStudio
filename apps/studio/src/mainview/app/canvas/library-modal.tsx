/**
 * 素材库：应用里**所有**生成产物的集中地 —— 生图 / 生视频 / 生音乐 / 语音四个页签，
 * 点一条就插回画布成节点。画布因此成为"散落各处的生成结果"的归集处：
 * 数据还是那些数据（各自的记录表），只是在这里被一个地方看见、被一个地方取用。
 *
 * 「添加节点 → 导入资源 → 素材库」与工具坞 / 左下角入口打开的都是这一个面板。
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Image as ImageIcon,
  ClapperboardIcon,
  MusicIcon,
  AudioWaveformIcon,
  PlusIcon,
  FolderOpenIcon,
} from "lucide-react";

import { Button } from "@ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@ui/tabs";
import { chatImageUrl } from "@/shared/server-info";
import { rpcClient } from "@lib/rpc";
import { useCanvasStore } from "./canvas-store";
import type { CanvasNodeKind } from "@/shared/canvas";
import { useT } from "@stores/ui-lang";

type LibraryTab = "image" | "video" | "music" | "voice";

export function LibraryModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  const [tab, setTab] = useState<LibraryTab>("image");

  const images = useQuery({
    queryKey: ["image-records"],
    queryFn: () => rpcClient.listImageRecords({ limit: 60 }),
    enabled: open,
  });
  const videos = useQuery({
    queryKey: ["video-records"],
    queryFn: () => rpcClient.listVideoRecords({ limit: 60 }),
    enabled: open,
  });
  const music = useQuery({
    queryKey: ["music-records"],
    queryFn: () => rpcClient.listMusicRecords({ limit: 60 }),
    enabled: open,
  });
  const voices = useQuery({
    queryKey: ["voice-records"],
    queryFn: () => rpcClient.listVoiceRecords({ kind: "tts" }),
    enabled: open,
  });

  /** 插入一条生成结果：建对应节点、落到视口中心附近，稍微错开避免完全叠住。 */
  const insert = (kind: CanvasNodeKind, ref: string, prompt: string, title?: string) => {
    const s = useCanvasStore.getState();
    const label = t(`canvas.node.${kind}`);
    const n = s.nodes.filter((x) => x.kind === kind).length + 1;
    const id = s.addNode(kind, 0, 0, title?.slice(0, 60) || t("canvas.nodeTitle", { name: label, n: String(n) }));
    s.updateNode(id, { resultRef: ref, prompt, status: "success" });
    const vp = s.viewport;
    const rect = document.querySelector("[data-canvas-viewport]")?.getBoundingClientRect();
    const cx = rect ? (rect.width / 2 - vp.x) / vp.k - 180 : 0;
    const cy = rect ? (rect.height / 2 - vp.y) / vp.k - 140 : 0;
    s.updateNode(id, { x: Math.round(cx + (n % 4) * 32), y: Math.round(cy + (n % 4) * 28) });
  };

  const imageItems = (images.data?.records ?? []).filter((r) => r.status === "done" && r.imagePath);
  const videoItems = (videos.data?.records ?? []).filter((r) => r.status === "done" && r.videoPath);
  const musicItems = (music.data?.records ?? []).filter((r) => r.status === "done" && r.audioPath);
  const voiceItems = (voices.data?.records ?? []).filter((r) => r.status === "done" && r.audioPath);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-canvas-no-zoom>
        <DialogHeader>
          <DialogTitle className="text-sm">{t("canvas.library.title")}</DialogTitle>
        </DialogHeader>
        <p className="-mt-1 text-[11px] text-muted-foreground">{t("canvas.library.hint")}</p>
        <Tabs value={tab} onValueChange={(v) => setTab(v as LibraryTab)}>
          <TabsList className="w-full">
            <TabsTrigger value="image" className="flex-1 gap-1">
              <ImageIcon className="size-3.5" />{t("canvas.library.tab.image")}
              <Count n={imageItems.length} />
            </TabsTrigger>
            <TabsTrigger value="video" className="flex-1 gap-1">
              <ClapperboardIcon className="size-3.5" />{t("canvas.library.tab.video")}
              <Count n={videoItems.length} />
            </TabsTrigger>
            <TabsTrigger value="music" className="flex-1 gap-1">
              <MusicIcon className="size-3.5" />{t("canvas.library.tab.music")}
              <Count n={musicItems.length} />
            </TabsTrigger>
            <TabsTrigger value="voice" className="flex-1 gap-1">
              <AudioWaveformIcon className="size-3.5" />{t("canvas.library.tab.voice")}
              <Count n={voiceItems.length} />
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="max-h-96 min-h-40 overflow-y-auto">
          {tab === "image" ? (
            <LibraryGrid
              loading={images.isLoading}
              items={imageItems.map((r) => ({
                key: `img-${r.id}`,
                thumb: chatImageUrl(r.imagePath!),
                label: r.prompt || "",
                onInsert: () => insert("image", r.imagePath!, r.prompt || ""),
              }))}
            />
          ) : null}
          {tab === "video" ? (
            <LibraryGrid
              loading={videos.isLoading}
              items={videoItems.map((r) => ({
                key: `vid-${r.id}`,
                thumb: r.firstFrameUrl ?? null,
                label: r.prompt || "",
                onInsert: () => insert("video", r.videoPath!, r.prompt || ""),
              }))}
            />
          ) : null}
          {tab === "music" ? (
            <LibraryGrid
              loading={music.isLoading}
              items={musicItems.map((r) => ({
                key: `mus-${r.id}`,
                thumb: r.coverUrl ?? null,
                label: r.title || r.caption || "",
                onInsert: () => insert("music", r.audioPath!, r.caption || "", r.title || undefined),
              }))}
            />
          ) : null}
          {tab === "voice" ? (
            <LibraryGrid
              loading={voices.isLoading}
              items={voiceItems.map((r) => ({
                key: `voc-${r.id}`,
                thumb: null,
                label: r.text || "",
                onInsert: () => insert("audio", r.audioPath!, "", r.text?.slice(0, 40) || undefined),
              }))}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Count({ n }: { n: number }) {
  if (n === 0) return null;
  return <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{n}</span>;
}

type LibraryItem = { key: string; thumb: string | null; label: string; onInsert: () => void };

function LibraryGrid({ items, loading }: { items: LibraryItem[]; loading: boolean }) {
  const t = useT();
  if (loading) return <div className="grid place-items-center py-10 text-xs text-muted-foreground">…</div>;
  if (items.length === 0) return <div className="grid place-items-center py-10 text-xs text-muted-foreground">{t("canvas.library.empty")}</div>;
  return (
    <div className="grid grid-cols-4 gap-2 p-1">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="group relative flex flex-col overflow-hidden rounded-lg border bg-muted/30 text-left transition-colors hover:border-primary/60"
          onClick={item.onInsert}
          title={t("canvas.library.insert")}
        >
          <div className="grid aspect-square w-full place-items-center overflow-hidden bg-muted/50">
            {item.thumb ? (
              <img src={item.thumb} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : (
              <PlusIcon className="size-5 text-muted-foreground" />
            )}
          </div>
          <span className="line-clamp-2 px-1.5 py-1 text-[10px] leading-tight text-muted-foreground">{item.label || "—"}</span>
          <span className="absolute right-1 top-1 hidden rounded bg-background/90 p-0.5 shadow group-hover:block">
            <PlusIcon className="size-3.5" />
          </span>
        </button>
      ))}
    </div>
  );
}

/** 左下角 / 工具坞共用的素材库入口。 */
export function LibraryButton({ onOpen, variant = "pill" }: { onOpen: () => void; variant?: "pill" | "icon" }) {
  const t = useT();
  if (variant === "icon") {
    return (
      <button
        type="button"
        aria-label={t("canvas.library.title")}
        title={t("canvas.library.title")}
        className="grid size-9 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={onOpen}
      >
        <FolderOpenIcon className="size-4" />
      </button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 gap-1.5 rounded-full bg-background/90 shadow-sm backdrop-blur"
      onClick={onOpen}
    >
      <FolderOpenIcon className="size-3.5" />
      {t("canvas.library.title")}
    </Button>
  );
}
