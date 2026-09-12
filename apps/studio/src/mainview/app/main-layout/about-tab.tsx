import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenIcon,
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GlobeIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  RssIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useUpdateStore } from "@lib/update-store";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { Separator } from "@ui/separator";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import { RELEASE_REPO_URL, RELEASES_URL, type ReleaseCheckResult } from "@/shared/release";
import { cn } from "@/mainview/lib/utils";
import logoUrl from "@/mainview/assets/omni-logo.png";

const WEBSITE_URL = "https://kunpengtalk.com";

export function AboutTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [manualResult, setManualResult] = useState<ReleaseCheckResult | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);

  const { data: about } = useQuery({
    queryKey: ["about-info"],
    queryFn: () => rpcClient.getAboutInfo(),
  });
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const { data: cachedCheck } = useQuery({
    queryKey: ["release-check"],
    queryFn: () => rpcClient.getReleaseCheck(),
    staleTime: 60_000,
  });
  const updateState = useUpdateStore((s) => s.updateState);

  const checkMutation = useMutation({
    mutationFn: () => rpcClient.checkReleaseUpdate({ force: true }),
    onSuccess: (result) => {
      setManualResult(result);
      setNotesExpanded(false);
      queryClient.setQueryData<ReleaseCheckResult | null>(["release-check"], result);
    },
  });

  const startUpdateMutation = useMutation({
    mutationFn: () => rpcClient.startAutoUpdate(),
  });

  const openUrlMutation = useMutation({
    mutationFn: (url: string) => rpcClient.openGatewayDocs({ url }),
  });

  const saveSettingsMutation = useMutation({
    mutationFn: (values: Record<string, string>) => rpcClient.updateSettings({ settings: values }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const settingsMap = settings?.settings ?? {};
  const result = manualResult ?? cachedCheck ?? null;

  const uptimeSeconds = about?.sessionStartedAt
    ? Math.floor(Date.now() / 1000 - about.sessionStartedAt / 1000)
    : 0;
  const uptime = (() => {
    const h = Math.floor(uptimeSeconds / 3600);
    const m = Math.floor((uptimeSeconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  })();

  const latest = result?.latest ?? null;
  const hasUpdate = !!latest && !result?.upToDate && !result?.error;
  const updaterBusy = updateState.status === "downloading";
  const updaterReady = updateState.status === "update-ready";

  const linkRows = [
    { icon: BookOpenIcon, title: t("settings.aboutTab.helpDocs"), url: RELEASE_REPO_URL },
    { icon: RssIcon, title: t("settings.aboutTab.changelog"), url: RELEASES_URL },
    { icon: GlobeIcon, title: t("settings.aboutTab.website"), url: WEBSITE_URL },
    { icon: MessageSquareIcon, title: t("settings.aboutTab.feedback"), url: `${RELEASE_REPO_URL}/issues/new` },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* 更新卡片 */}
      <div className="rounded-2xl border p-5">
        <div className="flex items-start gap-4">
          <img src={logoUrl} alt="OmniStudio" className="size-14 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">OmniStudio</h2>
              {about?.version && about.version !== "0.0.0" && (
                <Badge variant="secondary" className="font-mono text-[11px]">
                  v{about.version}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.aboutTab.tagline")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending}
          >
            {checkMutation.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            {t("settings.aboutTab.checkUpdate")}
          </Button>
        </div>

        {/* 检查结果状态区 */}
        <div className="mt-4">
          {checkMutation.isPending ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner />
              {t("settings.aboutTab.checking")}
            </p>
          ) : result?.error ? (
            <p className="text-xs text-destructive">
              {t("settings.aboutTab.checkFailed")}：{result.error}
            </p>
          ) : result && !result.latest ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <p className="text-xs text-muted-foreground">{t("settings.aboutTab.noReleases")}</p>
              <Button variant="outline" size="sm" onClick={() => openUrlMutation.mutate(RELEASES_URL)}>
                <ExternalLinkIcon data-icon="inline-start" />
                {t("settings.aboutTab.viewOnGitHub")}
              </Button>
            </div>
          ) : result?.upToDate ? (
            <p className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckIcon className="size-4" />
              {t("settings.aboutTab.upToDate")}
            </p>
          ) : hasUpdate && latest ? (
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
              <div className="flex items-center gap-2">
                <RefreshCwIcon className="size-4 text-primary" />
                <p className="text-sm font-medium">{t("settings.aboutTab.updateAvailable")}</p>
                <Badge variant="secondary" className="font-mono text-[11px]">
                  v{latest.version}
                </Badge>
              </div>
              {(latest.name || latest.publishedAt) && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {[
                    latest.name,
                    latest.publishedAt ? new Date(latest.publishedAt).toLocaleDateString() : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {latest.body && (
                <div className="mt-2">
                  <p
                    className={cn(
                      "whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground",
                      !notesExpanded && "max-h-32 overflow-hidden",
                    )}
                  >
                    {latest.body}
                  </p>
                  <button
                    type="button"
                    onClick={() => setNotesExpanded((v) => !v)}
                    className="mt-1 text-[11px] text-primary hover:underline"
                  >
                    {notesExpanded ? t("settings.aboutTab.collapse") : t("settings.aboutTab.showAll")}
                  </button>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {updaterBusy ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner />
                    {t("settings.aboutTab.downloading")}
                  </span>
                ) : updaterReady ? (
                  <Button size="sm" onClick={() => rpcClient.applyUpdate()}>
                    <DownloadIcon data-icon="inline-start" />
                    {t("settings.aboutTab.restartInstall")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => startUpdateMutation.mutate()}
                    disabled={startUpdateMutation.isPending}
                  >
                    <DownloadIcon data-icon="inline-start" />
                    {t("settings.aboutTab.downloadUpdate")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openUrlMutation.mutate(latest.htmlUrl)}
                >
                  <ExternalLinkIcon data-icon="inline-start" />
                  {t("settings.aboutTab.viewOnGitHub")}
                </Button>
              </div>
              {updateState.status === "error" && (
                <p className="mt-2 text-[11px] text-destructive">
                  {t("settings.aboutTab.downloadFailed")}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("settings.aboutTab.idle")}</p>
          )}
          {result && (
            <p className="mt-1.5 text-[11px] text-muted-foreground/70">
              {t("settings.aboutTab.lastChecked")} {new Date(result.checkedAt).toLocaleTimeString()}
            </p>
          )}
        </div>

        <Separator className="my-4" />

        {/* 自动更新 / 测试计划开关 */}
        <div className="flex flex-col gap-3">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="text-sm">{t("settings.aboutTab.autoUpdate")}</span>
              <span className="block text-[11px] text-muted-foreground">
                {t("settings.aboutTab.autoUpdateDesc")}
              </span>
            </span>
            <input
              type="checkbox"
              checked={settingsMap.AUTO_UPDATE !== "0"}
              onChange={(e) => saveSettingsMutation.mutate({ AUTO_UPDATE: e.target.checked ? "1" : "0" })}
              className="size-4 accent-[var(--primary)]"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="text-sm">{t("settings.aboutTab.beta")}</span>
              <span className="block text-[11px] text-muted-foreground">
                {t("settings.aboutTab.betaDesc")}
              </span>
            </span>
            <input
              type="checkbox"
              checked={settingsMap.UPDATE_CHANNEL === "beta"}
              onChange={(e) =>
                saveSettingsMutation.mutate({ UPDATE_CHANNEL: e.target.checked ? "beta" : "stable" })
              }
              className="size-4 accent-[var(--primary)]"
            />
          </label>
        </div>
      </div>

      {/* 资源列表 */}
      <div className="divide-y rounded-2xl border">
        {linkRows.map((row) => (
          <div key={row.title} className="flex items-center gap-3 px-4 py-3">
            <row.icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{row.title}</span>
            <Button variant="outline" size="sm" onClick={() => openUrlMutation.mutate(row.url)}>
              {t("settings.aboutTab.view")}
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-3 px-4 py-3">
          <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{t("settings.aboutTab.dataDir")}</span>
            {about?.dataDir && (
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {about.dataDir}
              </span>
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => about?.dataDir && rpcClient.openPath({ path: about.dataDir })}
          >
            {t("settings.aboutTab.open")}
          </Button>
        </div>
      </div>

      {/* 版本信息 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{t("settings.aboutTab.version")}</p>
          <p className="font-mono text-xs">{about?.version ?? "—"}</p>
        </div>
        <div className="rounded-lg border px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{t("settings.aboutTab.channel")}</p>
          <p className="text-xs">
            {about?.channel === "beta"
              ? t("settings.updateChannel.beta")
              : t("settings.updateChannel.stable")}
          </p>
        </div>
        <div className="rounded-lg border px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{t("settings.aboutTab.uptime")}</p>
          <p className="font-mono text-xs tabular-nums">{uptime}</p>
        </div>
        <div className="rounded-lg border px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{t("settings.aboutTab.dataDir")}</p>
          <p className="truncate font-mono text-xs" title={about?.dataDir}>
            {about?.dataDir ?? "—"}
          </p>
        </div>
      </div>
    </div>
  );
}
