import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, RadarIcon, BlocksIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import type { DiscoveredSkillGroup } from "@/shared/skills";

export function ScanPane() {
  const t = useT();
  const queryClient = useQueryClient();
  const [removeOriginal, setRemoveOriginal] = useState(true);
  const scan = useQuery({
    queryKey: ["skills-scan"],
    queryFn: () => rpcClient.skillsScanDiscovered(undefined),
  });
  const importOne = useMutation({
    mutationFn: (g: DiscoveredSkillGroup) =>
      rpcClient.skillsImportDiscovered({ name: g.name, paths: g.locations.map((l) => l.path), removeOriginal }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills-scan"] }),
  });
  const importAll = useMutation({
    mutationFn: () => rpcClient.skillsImportAllDiscovered({ groups: scan.data?.groups ?? [], removeOriginal }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills-scan"] }),
  });

  const groups = (scan.data?.groups ?? []).filter((g) => !g.imported);
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-xs text-muted-foreground">{t("skills.market.scanHint")}</p>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-3.5 accent-primary"
            checked={removeOriginal}
            onChange={(e) => setRemoveOriginal(e.target.checked)}
          />
          {t("skills.market.removeOriginal")}
        </label>
        <Button size="sm" variant="outline" disabled={groups.length === 0 || importAll.isPending} onClick={() => importAll.mutate()}>
          {importAll.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <RadarIcon data-icon="inline-start" />}
          {t("skills.market.importAll")}
        </Button>
      </div>
      {scan.isLoading ? (
        <div className="flex justify-center py-16"><Spinner className="size-5" /></div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <RadarIcon className="size-7 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground">{t("skills.market.scanEmpty")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g) => (
            <div key={`${g.name}:${g.locations[0]?.path}`} className="flex items-center gap-3 rounded-lg border px-4 py-3">
              <BlocksIcon className="size-4 shrink-0 text-muted-foreground/50" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{g.name}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground/70">
                  {g.locations.map((l) => l.path).join(" · ")}
                </p>
              </div>
              <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={importOne.isPending} onClick={() => importOne.mutate(g)}>
                {t("skills.market.adopt")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
