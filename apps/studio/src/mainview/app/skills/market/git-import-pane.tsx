import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SearchIcon, DownloadIcon, Loader2Icon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@ui/dialog";
import { useT } from "@stores/ui-lang";

export function GitImportPane() {
  const t = useT();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<{ tempDir: string; skills: { relPath: string; name: string; description: string | null }[] } | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const previewMutation = useMutation({
    mutationFn: () => rpcClient.skillsGitPreview({ url }),
    onSuccess: (data) => {
      setError(data.ok ? null : (data.error ?? "preview failed"));
      if (data.ok && data.tempDir && data.skills) {
        setPreview({ tempDir: data.tempDir, skills: data.skills });
        setPicked(Object.fromEntries(data.skills.map((s) => [s.relPath, true])));
        setNames(Object.fromEntries(data.skills.map((s) => [s.relPath, s.name])));
      }
    },
    onError: (e) => setError(String(e)),
  });
  const confirmMutation = useMutation({
    mutationFn: () => {
      const items = (preview?.skills ?? [])
        .filter((s) => picked[s.relPath])
        .map((s) => ({ relPath: s.relPath, name: names[s.relPath] || s.name }));
      return rpcClient.skillsGitConfirm({ url, tempDir: preview!.tempDir, items });
    },
    onSuccess: () => {
      setPreview(null);
      setUrl("");
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  return (
    <div className="flex max-w-xl flex-col gap-3 p-4">
      <p className="text-xs text-muted-foreground">{t("skills.market.gitHint")}</p>
      <div className="flex gap-2">
        <Input
          placeholder="https://github.com/user/repo 或 user/repo"
          className="h-9 flex-1 font-mono text-xs"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && url.trim() && previewMutation.mutate()}
        />
        <Button size="sm" className="h-9" disabled={!url.trim() || previewMutation.isPending} onClick={() => previewMutation.mutate()}>
          {previewMutation.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SearchIcon data-icon="inline-start" />}
          {t("skills.market.preview")}
        </Button>
      </div>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
      )}
      <Dialog open={!!preview} onOpenChange={(open) => {
        if (!open && preview) {
          rpcClient.skillsGitCancelPreview({ tempDir: preview.tempDir });
          setPreview(null);
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("skills.market.pickSkills")}</DialogTitle>
            <DialogDescription>{t("skills.market.pickHint")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto">
            {(preview?.skills ?? []).map((s) => (
              <label key={s.relPath} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={!!picked[s.relPath]}
                  onChange={(e) => setPicked((p) => ({ ...p, [s.relPath]: e.target.checked }))}
                />
                <span className="w-44 truncate font-mono text-[11px] text-muted-foreground">{s.relPath}</span>
                <input
                  className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                  value={names[s.relPath] ?? s.name}
                  onChange={(e) => setNames((n) => ({ ...n, [s.relPath]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => {
              if (preview) {
                rpcClient.skillsGitCancelPreview({ tempDir: preview.tempDir });
                setPreview(null);
              }
            }}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={confirmMutation.isPending} onClick={() => confirmMutation.mutate()}>
              {confirmMutation.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <DownloadIcon data-icon="inline-start" />}
              {t("skills.install")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
