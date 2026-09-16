import { useState } from "react";
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
import { formatTime, PlayAudio } from "./parts";

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

      {/* 右侧：克隆列表 */}
      <main className="relative min-w-0 flex-1 overflow-y-auto">
        <div className="flex h-full min-h-0 items-center justify-center p-8">
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
                  <div key={c.id} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {c.model ? `· ${c.model}` : ""} {formatTime(c.createdAt)}
                      </p>
                    </div>
                    {c.audioUrl && (
                      <div className="flex shrink-0 items-center gap-1">
                        <PlayAudio url={c.audioUrl} className="w-40" />
                        <AudioDownloadButton
                          url={c.audioUrl}
                          filename={audioFileName(c.audioUrl, `clone-${c.name}`)}
                        />
                      </div>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      tooltip={t("voice.clone.delete")}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(c.id)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

