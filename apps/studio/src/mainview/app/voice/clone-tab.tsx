import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wand2Icon, XIcon, Loader2Icon, Trash2Icon, FileAudioIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import { AudioDownloadButton, audioFileName } from "@components/audio-download";
import { ResultError, ResultEmpty } from "@components/media-result";
import type { VoiceClone } from "../../../bun/voice";
import { cn } from "@/mainview/lib/utils";
import { formatTime, PlayAudio, RecordHistoryBar } from "./parts";
import { useFocusedVoiceRecord } from "./use-focused-record";

/** 一条克隆：名字 / 模型 / 时间 + 试听、下载、删除。 */
function CloneCard({
  clone,
  focused,
  pending,
  onDelete,
  cardRef,
}: {
  clone: VoiceClone;
  focused: boolean;
  pending: boolean;
  onDelete: () => void;
  cardRef: (node: HTMLDivElement | null) => void;
}) {
  const t = useT();
  return (
    <div
      ref={cardRef}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors",
        // 左侧历史点进来时，右边这一条描个边 —— "点的就是它"。
        focused ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30" : "border-border",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{clone.name}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {clone.model ? `· ${clone.model}` : ""} {formatTime(clone.createdAt)}
        </p>
      </div>
      {clone.audioUrl && (
        <div className="flex shrink-0 items-center gap-1">
          <PlayAudio url={clone.audioUrl} className="w-44" />
          <AudioDownloadButton
            url={clone.audioUrl}
            filename={audioFileName(clone.audioUrl, `clone-${clone.name}`)}
          />
        </div>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        tooltip={t("voice.clone.delete")}
        disabled={pending}
        onClick={onDelete}
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
}

export function CloneTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [ref, setRef] = useState<{ ref: string; url: string } | null>(null);

  const { data } = useQuery({
    queryKey: ["voice-clones"],
    queryFn: () => rpcClient.listVoiceClones(),
  });
  const clones = data?.clones ?? [];
  const { record: historyRecord, setFocusRecordId } = useFocusedVoiceRecord();
  // 克隆记录和克隆本身是一回事，靠那份参考音频的路径对上（记录里存的就是它）。
  const focusedCloneId = historyRecord
    ? clones.find(
        (c) =>
          c.refAudioPath &&
          c.refAudioPath === (historyRecord.refAudioPath ?? historyRecord.audioPath),
      )?.id
    : undefined;
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!focusedCloneId) return;
    cardRefs.current
      .get(focusedCloneId)
      ?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [focusedCloneId]);

  const pick = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "mp3,wav,m4a,aac,flac,ogg,opus,webm,wma,mp4",
      });
      if (paths.length === 0) return;
      const { files } = await rpcClient.stageAudio({ paths });
      if (files[0]) setRef(files[0]);
    },
  });

  const create = useMutation({
    mutationFn: () => rpcClient.createVoiceClone({ name, audioRef: ref!.ref }),
    onSuccess: () => {
      setName("");
      setRef(null);
      queryClient.invalidateQueries({ queryKey: ["voice-clones"] });
      queryClient.invalidateQueries({ queryKey: ["voice-records"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => rpcClient.deleteVoiceClone({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["voice-clones"] }),
  });

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧：创建克隆 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
        <p className="text-xs text-muted-foreground">{t("voice.clone.desc")}</p>

        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
          <div>
            <Label htmlFor="clone-name" className="mb-1 block text-xs">
              {t("voice.clone.name")}
            </Label>
            <Input
              id="clone-name"
              placeholder={t("voice.clone.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={pick.isPending} onClick={() => pick.mutate()}>
              {pick.isPending ? <Spinner data-icon="inline-start" /> : <FileAudioIcon data-icon="inline-start" />}
              {ref ? t("voice.clone.picked") : t("voice.clone.pickRef")}
            </Button>
            {ref && (
              <Button variant="ghost" size="icon-sm" tooltip={t("voice.remove")} onClick={() => setRef(null)}>
                <XIcon className="size-4" />
              </Button>
            )}
          </div>
          {ref && <PlayAudio url={ref.url} />}

          <ResultError error={create.isError ? String(create.error) : undefined} />

          <Button
            size="lg"
            className="w-full"
            onClick={() => create.mutate()}
            disabled={!name.trim() || !ref || create.isPending}
          >
            {create.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <Wand2Icon data-icon="inline-start" />
            )}
            {create.isPending ? t("voice.clone.creating") : t("voice.clone.create")}
          </Button>
        </div>

        </div>
      </aside>

      {/* 右侧：克隆列表。左侧历史点进来时列表里那一条描边并滚到眼前 —— 克隆记录与克隆
          本身是一回事，为它再开一块详情没有意义。 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {historyRecord && (
          <RecordHistoryBar
            record={historyRecord}
            onClose={() => setFocusRecordId(null)}
            className="shrink-0"
          />
        )}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
          {clones.length === 0 ? (
            <ResultEmpty
              icon={<Wand2Icon className="size-9 text-primary" />}
              title={t("voice.clone.empty")}
              hint={t("voice.clone.desc")}
            />
          ) : (
            <div className="w-full max-w-md">
              <h3 className="mb-2 text-sm font-medium">{t("voice.clone.list")}</h3>
              <div className="flex flex-col gap-2">
                {clones.map((c: VoiceClone) => (
                  <CloneCard
                    key={c.id}
                    clone={c}
                    focused={focusedCloneId === c.id}
                    pending={remove.isPending}
                    onDelete={() => remove.mutate(c.id)}
                    cardRef={(node) => {
                      if (node) cardRefs.current.set(c.id, node);
                      else cardRefs.current.delete(c.id);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

