import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, Loader2Icon, ExternalLinkIcon, CheckIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { InstallState } from "../parts";
import type { SkillsShSkill } from "@/shared/skills";

export function MarketCard({ skill, installed }: { skill: SkillsShSkill; installed: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const install = useMutation({
    mutationFn: () => rpcClient.skillsInstallFromMarket({ source: skill.source, skillId: skill.skillId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const [owner] = skill.source.split("/");
  return (
    <div className="flex items-center gap-3 rounded-lg border px-4 py-3">
      <img
        src={`https://github.com/${owner}.png?size=32`}
        alt=""
        className="size-8 shrink-0 rounded-md"
        onError={(e) => {
          (e.target as HTMLImageElement).style.visibility = "hidden";
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          {installed && (
            <span className="inline-flex h-5 items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
              <CheckIcon className="size-2.5" />
              {t("skills.installed")}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
          {skill.source} · {skill.installs.toLocaleString()} {t("skills.installs")}
        </p>
      </div>
      <InstallState ref={`${skill.source}/${skill.skillId}`} />
      <a
        href={`https://skills.sh/${skill.source}/${skill.skillId}`}
        target="_blank"
        rel="noreferrer"
        title="skills.sh"
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ExternalLinkIcon className="size-3.5" />
      </a>
      <Button
        size="sm"
        variant={installed ? "outline" : "default"}
        className="h-7 shrink-0"
        disabled={install.isPending}
        onClick={() => install.mutate()}
      >
        {install.isPending ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : (
          <DownloadIcon data-icon="inline-start" />
        )}
        {installed ? t("skills.reinstall") : t("skills.install")}
      </Button>
    </div>
  );
}
