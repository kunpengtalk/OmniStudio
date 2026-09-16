import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, Trash2Icon, FolderOpenIcon, FolderPlusIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Label } from "@ui/label";
import { useT } from "@stores/ui-lang";
import { formatBytes } from "./parts";

export function ModelDirsManager() {
  const t = useT();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{ dir: string; count: number; totalSize: number; files: { name: string; repo: string; size: number; kind: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirsQuery = useQuery({
    queryKey: ["model-dirs"],
    queryFn: () => rpcClient.getModelDirs(),
  });
  const entries = dirsQuery.data?.entries ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["model-dirs"] });
    queryClient.invalidateQueries({ queryKey: ["installed-models"] });
  };

  const pickMutation = useMutation({
    mutationFn: async () => {
      const { path: dir } = await rpcClient.openDirectoryDialog(undefined);
      if (!dir) return null;
      return { dir, preview: await rpcClient.scanModelDir({ dir }) };
    },
    onSuccess: (res) => {
      setNotice(null);
      if (!res) return;
      if (!res.preview.ok) {
        setError(res.preview.error ?? t("models.dirs.scanFailed"));
        setPending(null);
        return;
      }
      setError(null);
      setPending({ dir: res.dir, ...res.preview });
    },
    onError: (e: unknown) => setError(String(e)),
  });

  const addMutation = useMutation({
    mutationFn: (dir: string) => rpcClient.addModelDir({ dir }),
    onSuccess: (res, dir) => {
      if (!res.ok) {
        setError(res.error ?? t("models.dirs.scanFailed"));
        return;
      }
      setError(null);
      setPending(null);
      setNotice(t("models.dirs.added", { count: String(res.count ?? 0), dir }));
      invalidate();
    },
    onError: (e: unknown) => setError(String(e)),
  });

  const removeMutation = useMutation({
    mutationFn: (dir: string) => rpcClient.removeModelDir({ dir }),
    onSuccess: (res) => {
      if (!res.ok) setError(res.error ?? null);
      else setNotice(null);
      invalidate();
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{t("models.dirs.title")}</Label>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={pickMutation.isPending}
          onClick={() => pickMutation.mutate()}
        >
          {pickMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <FolderPlusIcon data-icon="inline-start" className="size-3.5" />
          )}
          {t("models.dirs.add")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("models.dirs.hint")}</p>

      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <div key={entry.path} className="flex items-center gap-2 rounded-lg border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px]">{entry.path}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>
                  {entry.kind === "primary"
                    ? t("models.dirs.primary")
                    : entry.kind === "hf-cache"
                      ? t("models.dirs.hfCache")
                      : t("models.dirs.extra")}
                </span>
                <span>·</span>
                {entry.exists ? (
                  <>
                    <span>{t("models.dirs.count", { count: String(entry.count) })}</span>
                    <span>·</span>
                    <span>{formatBytes(entry.size)}</span>
                  </>
                ) : (
                  <span className="text-amber-600 dark:text-amber-400">
                    {t("models.dirs.missing")}
                  </span>
                )}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("models.showInFolder")}
              onClick={() => void rpcClient.showInExplorer({ filePath: entry.path })}
            >
              <FolderOpenIcon className="size-3.5" />
            </Button>
            {entry.kind === "extra" && (
              <Button
                variant="ghost"
                size="icon-sm"
                tooltip={t("models.dirs.remove")}
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate(entry.path)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>

      {pending && (
        <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
          <p className="text-xs">
            {t("models.dirs.previewTitle", { count: String(pending.count), size: formatBytes(pending.totalSize) })}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{pending.dir}</p>
          <ul className="flex flex-col gap-0.5">
            {pending.files.slice(0, 5).map((f) => (
              <li key={`${f.repo}/${f.name}`} className="truncate text-[11px] text-muted-foreground">
                {f.repo} / {f.name}
              </li>
            ))}
            {pending.count > 5 && (
              <li className="text-[11px] text-muted-foreground">
                {t("models.dirs.moreFiles", { count: String(pending.count - 5) })}
              </li>
            )}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" disabled={addMutation.isPending} onClick={() => addMutation.mutate(pending.dir)}>
              {t("models.dirs.confirmAdd")}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}
      {notice && <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{notice}</p>}
    </div>
  );
}
