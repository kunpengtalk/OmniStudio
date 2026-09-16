import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLinesIcon, MicIcon, Trash2Icon, Wand2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { AudioDownloadButton, audioFileName } from "@components/audio-download";
import { MediaSourceBadge } from "@components/media-source-badge";
import { ToolSwitcher } from "@components/sidebar-parts";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
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

const VOICE_TAB_ICONS: Record<VoiceTab, ReactNode> = {
  tts: <AudioLinesIcon className="size-4" />,
  asr: <MicIcon className="size-4" />,
  clone: <Wand2Icon className="size-4" />,
};

function VoiceAudio({ url }: { url: string }) {
  const t = useT();
  const [err, setErr] = useState(false);
  if (err) {
    // 音频文件不存在了(旧记录清理/目录被删),给出明确提示而非死播放器。
    return (
      <p className="rounded bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground">
        {t("voice.records.missing")}
      </p>
    );
  }
  return <audio controls src={url} preload="none" className="h-7 w-full" onError={() => setErr(true)} />;
}

export function VoiceRecordList() {
  const t = useT();
  const { tab, setTab } = useVoiceStore();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["voice-records", tab],
    queryFn: () => rpcClient.listVoiceRecords({ kind: tab }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteVoiceRecord({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["voice-records"] }),
  });

  const records = data?.records ?? [];

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
                <div className="flex w-full flex-col gap-1 rounded-md border px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    {r.status === "failed" ? (
                      <Badge variant="destructive" className="text-[10px]">
                        {t("voice.failed")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        {VOICE_TAB_ICONS[r.kind]}
                        {t(`voice.records.${r.kind}`)}
                      </Badge>
                    )}
                    {r.voice && (
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {r.voice}
                      </span>
                    )}
                    <MediaSourceBadge source={r.source} className="px-1" />
                    <span className="ml-auto text-[10px] text-muted-foreground/70 tabular-nums">
                      {new Date(r.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {r.text && (
                    <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {r.text}
                    </p>
                  )}
                  {r.audioUrl && (
                    <div className="flex items-center gap-1">
                      <VoiceAudio url={r.audioUrl} />
                      <AudioDownloadButton
                        url={r.audioUrl}
                        filename={audioFileName(r.audioUrl, r.model || r.voice || r.kind)}
                      />
                    </div>
                  )}
                  {!r.audioUrl && r.error && (
                    <p className="line-clamp-2 text-[10px] text-destructive">{r.error}</p>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tooltip={t("voice.records.delete")}
                    className="ml-auto h-6 w-6"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(r.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>
    </SidebarGroup>
  );
}
