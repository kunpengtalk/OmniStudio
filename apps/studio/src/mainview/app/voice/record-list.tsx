import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLinesIcon, MicIcon, Wand2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { audioFileName } from "@components/audio-download";
import { MediaSourceBadge } from "@components/media-source-badge";
import {
  MediaDownloadButton,
  RecordDeleteButton,
  RecordDeleteDialog,
} from "@components/record-actions";
import { ToolSwitcher } from "@components/sidebar-parts";
import { Badge } from "@ui/badge";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuItem,
} from "@ui/sidebar";
import { useVoiceStore, type VoiceTab } from "@stores/voice";
import { useT } from "@stores/ui-lang";
import type { VoiceRecordRow } from "../../../bun/voice";
import { cn } from "@/mainview/lib/utils";
import { AudioPlayButton, releaseAudio, useAudioRow } from "./audio-player";

const VOICE_TAB_ICONS: Record<VoiceTab, React.ReactNode> = {
  tts: <AudioLinesIcon className="size-4" />,
  asr: <MicIcon className="size-4" />,
  clone: <Wand2Icon className="size-4" />,
};

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** 秒数写成 12s / 1:05（记录里只有毫秒时长时才有）。 */
function durationLabel(ms: number | null): string | null {
  if (!ms || ms <= 0) return null;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
}

/**
 * 一行记录：**点整行进右侧看这条记录**，左侧那颗 20px 的键只负责试听。
 *
 * 一行的高度只有两种信息（写的是什么 / 什么时候、用什么做的），操作按钮跟着第二行走
 * 且默认藏着 —— 一屏十几条记录时，按钮全亮着比内容还抢眼。
 */
function RecordRow({
  record,
  selected,
  onOpen,
  onRequestDelete,
  deleting,
}: {
  record: VoiceRecordRow;
  selected: boolean;
  onOpen: () => void;
  onRequestDelete: () => void;
  deleting: boolean;
}) {
  const t = useT();
  // 只订阅"是不是我在响 + 响到哪了"这几个原始值：空闲的行不会跟着进度重渲染。
  const { current, percent } = useAudioRow(record.audioUrl ?? undefined);
  const failed = record.status === "failed";
  const meta = record.model || record.voice;
  const duration = durationLabel(record.durationMs);

  const preview = failed
    ? (record.error ?? t("voice.failed"))
    : (record.text ?? "").trim() || t("voice.records.noText");

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      title={t("voice.records.open")}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group/voice relative flex w-full cursor-pointer items-start gap-2 overflow-hidden rounded-md border p-1.5 text-left outline-none transition-colors",
        selected
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:bg-muted/60 focus-visible:bg-muted/60",
      )}
    >
      {record.audioUrl ? (
        <AudioPlayButton url={record.audioUrl} size="xs" className="mt-0.5" />
      ) : (
        // 没有音频（失败 / 只有文字）时留一样大的空位，各行的文字左边缘才对得齐。
        <span className="mt-0.5 size-5 shrink-0" />
      )}

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "line-clamp-2 text-[11px] leading-snug",
            failed ? "text-destructive/90" : "text-foreground/80",
          )}
        >
          {preview}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/70 tabular-nums">
          <span className="shrink-0">{hhmm(record.createdAt)}</span>
          {duration && <span className="shrink-0">{duration}</span>}
          {meta && <span className="min-w-0 flex-1 truncate font-mono">{meta}</span>}
          <MediaSourceBadge source={record.source} iconOnly />
          {/* 操作按钮跟着第二行走（这一行右边本来是空的），不占正文的宽度。 */}
          <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/voice:opacity-100 group-focus-within/voice:opacity-100">
            {record.audioUrl && (
              <MediaDownloadButton
                compact
                labels={{ idle: t("voice.download") }}
                save={() =>
                  rpcClient.saveAudioToFolder({
                    url: record.audioUrl!,
                    filename: audioFileName(record.audioUrl!, meta || record.kind),
                  })
                }
              />
            )}
            <RecordDeleteButton disabled={deleting} onDelete={onRequestDelete} />
          </span>
        </span>
      </span>

      {/* 正在响的那一行才画进度：一条 3px 的填充，不占高度（列表里没有播放条的位置）。 */}
      {current && (
        <span
          className="absolute bottom-0 left-0 h-[3px] bg-primary/80 transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}

export function VoiceRecordList() {
  const t = useT();
  const { tab, setTab, focusRecordId, setFocusRecordId } = useVoiceStore();
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["voice-records", tab],
    queryFn: () => rpcClient.listVoiceRecords({ kind: tab }),
  });
  const records = data?.records ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteVoiceRecord({ id }),
    onSuccess: (_r, id) => {
      // 删掉的正好是右侧正在看的那条时把选中收回去，否则右侧会停在一条已经不存在的记录上。
      if (focusRecordId === id) setFocusRecordId(null);
      // 这一条还在响就先停掉：文件已经没了，播放条只会停在半路。
      const gone = records.find((r) => r.id === id);
      if (gone?.audioUrl) releaseAudio(gone.audioUrl);
      setConfirmDelete(null);
      queryClient.invalidateQueries({ queryKey: ["voice-records"] });
    },
  });

  return (
    <SidebarGroup className="min-h-0 flex-1">
      {/* 语音工具菜单：语音合成 / 语音识别 / 声音克隆（与生图页侧栏入口同款） */}
      <ToolSwitcher
        columns={3}
        active={tab}
        onSelect={setTab}
        items={[
          { key: "tts", icon: <AudioLinesIcon className="size-4" />, labelKey: "voice.tab.tts" },
          { key: "asr", icon: <MicIcon className="size-4" />, labelKey: "voice.tab.asr" },
          { key: "clone", icon: <Wand2Icon className="size-4" />, labelKey: "voice.tab.clone" },
        ]}
      />
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          {VOICE_TAB_ICONS[tab]}
          {t(`voice.tab.${tab}`)}
        </span>
        <SidebarMenuBadge>
          <Badge variant="secondary" className="h-5 text-[10px]">
            {records.length}
          </Badge>
        </SidebarMenuBadge>
      </SidebarGroupLabel>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-1">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : records.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {t("voice.records.empty")}
            </div>
          ) : (
            records.map((r) => (
              <SidebarMenuItem key={r.id} className="px-1">
                <RecordRow
                  record={r}
                  selected={focusRecordId === r.id}
                  onOpen={() => setFocusRecordId(r.id)}
                  onRequestDelete={() => setConfirmDelete(r.id)}
                  deleting={deleteMutation.isPending}
                />
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>

      <RecordDeleteDialog
        open={confirmDelete != null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={t("voice.records.deleteTitle")}
        description={t("voice.records.deleteDesc")}
        pending={deleteMutation.isPending}
        onConfirm={() => confirmDelete != null && deleteMutation.mutate(confirmDelete)}
      />
    </SidebarGroup>
  );
}
