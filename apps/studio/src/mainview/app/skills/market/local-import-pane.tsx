import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, Loader2Icon, FolderInputIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { useT } from "@stores/ui-lang";

export function LocalImportPane() {
  const t = useT();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const install = useMutation({
    mutationFn: () => rpcClient.skillsInstallLocal({ path }),
    onSuccess: (data) => {
      if (data.ok) {
        setError(null);
        setResult(`${t("skills.install.done")}: ${data.id}`);
        queryClient.invalidateQueries({ queryKey: ["skills"] });
      } else {
        setError(data.error ?? "install failed");
      }
    },
  });
  const batch = useMutation({
    mutationFn: () => rpcClient.skillsBatchImportFolder({ path }),
    onSuccess: (data) => {
      setError(data.errors.length > 0 ? data.errors.join("; ") : null);
      setResult(`${t("skills.market.batchDone")}: ${data.installed.length}`);
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  return (
    <div className="flex max-w-xl flex-col gap-3 p-4">
      <p className="text-xs text-muted-foreground">{t("skills.market.localHint")}</p>
      <div className="flex gap-2">
        <Input
          placeholder={t("skills.market.localPlaceholder")}
          className="h-9 flex-1 font-mono text-xs"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && path.trim() && install.mutate()}
        />
        <Button size="sm" className="h-9" disabled={!path.trim() || install.isPending} onClick={() => install.mutate()}>
          {install.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <DownloadIcon data-icon="inline-start" />}
          {t("skills.install")}
        </Button>
        <Button size="sm" variant="outline" className="h-9" disabled={!path.trim() || batch.isPending} onClick={() => batch.mutate()}>
          {batch.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <FolderInputIcon data-icon="inline-start" />}
          {t("skills.market.batchImport")}
        </Button>
      </div>
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}
      {result && !error && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600">{result}</div>}
    </div>
  );
}
