// Skills 市场 Tab：skills.sh 市场（榜单+搜索+安装） / Git 导入 / 本地导入 / 扫描收编。
// 布局与提示词页 PlazaView 同构：固定工具栏（标题+搜索）→ 子区分段切换 → 滚动内容区。
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderInputIcon,
  GitBranchIcon,
  Loader2Icon,
  BlocksIcon,
  RadarIcon,
  SearchIcon,
  PackageSearchIcon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { useSkillsStore, type SkillsMarketTab } from "@stores/skills";
import { useT } from "@stores/ui-lang";
import type { SkillsShSkill, DiscoveredSkillGroup } from "@/shared/skills";
import { InstallState, SegmentedControl, Toolbar, chipClass } from "./parts";

const MARKET_TABS = [
  { value: "marketplace", labelKey: "skills.market.tab", icon: <PackageSearchIcon className="size-3.5" /> },
  { value: "git", labelKey: "skills.market.git", icon: <GitBranchIcon className="size-3.5" /> },
  { value: "local", labelKey: "skills.market.local", icon: <FolderInputIcon className="size-3.5" /> },
  { value: "scan", labelKey: "skills.market.scan", icon: <RadarIcon className="size-3.5" /> },
] as const;

function MarketCard({ skill, installed }: { skill: SkillsShSkill; installed: boolean }) {
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

function MarketplacePane({ search }: { search: string }) {
  const t = useT();
  const board = useSkillsStore((s) => s.marketBoard);
  const setBoard = useSkillsStore((s) => s.setMarketBoard);

  const { data: skillsList } = useQuery({
    queryKey: ["skills"],
    queryFn: () => rpcClient.skillsList(undefined),
  });
  const installedRefs = new Set(
    (skillsList?.skills ?? []).filter((s) => s.sourceType === "skillssh").map((s) => s.sourceRef),
  );

  const query = search.trim();
  const leaderboard = useQuery({
    queryKey: ["skills-market-board", board],
    queryFn: () => rpcClient.skillsMarketLeaderboard({ board }),
    staleTime: 5 * 60 * 1000,
    enabled: query.length === 0,
  });
  const searchQuery = useQuery({
    queryKey: ["skills-market-search", query],
    queryFn: () => rpcClient.skillsMarketSearch({ query, limit: 60 }),
    enabled: query.length > 0,
    staleTime: 2 * 60 * 1000,
  });

  const active = query.length > 0 ? searchQuery : leaderboard;
  const items = active.data?.skills ?? [];

  return (
    <div className="flex flex-col gap-3 p-4">
      {query.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { key: "alltime", labelKey: "skills.board.alltime" },
              { key: "trending", labelKey: "skills.board.trending" },
              { key: "hot", labelKey: "skills.board.hot" },
            ] as const
          ).map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setBoard(b.key)}
              className={chipClass(board === b.key)}
            >
              {t(b.labelKey)}
            </button>
          ))}
        </div>
      )}
      {active.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-5" />
        </div>
      ) : active.isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          {t("skills.market.loadFailed")}: {String(active.error)}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <PackageSearchIcon className="size-7 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground">{t("common.noResults")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((s) => (
            <MarketCard key={s.id} skill={s} installed={installedRefs.has(s.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function GitImportPane() {
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

function LocalImportPane() {
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

function ScanPane() {
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

export function MarketTab() {
  const t = useT();
  const tab = useSkillsStore((s) => s.marketTab);
  const setTab = useSkillsStore((s) => s.setMarketTab);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 450);
    return () => clearTimeout(timer);
  }, [searchInput]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar icon={<PackageSearchIcon className="size-4 text-muted-foreground" />} title={t("skills.nav.market")}>
        {tab === "marketplace" && (
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("skills.market.searchPlaceholder")}
              className="h-8 w-56 pl-8 text-xs"
            />
            {searchInput && (
              <button
                type="button"
                aria-label={t("common.cancel")}
                onClick={() => setSearchInput("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </Toolbar>
      <div className="shrink-0 px-4 py-2">
        <SegmentedControl<SkillsMarketTab>
          value={tab}
          onChange={setTab}
          options={MARKET_TABS.map((x) => ({ value: x.value as SkillsMarketTab, label: t(x.labelKey), icon: x.icon }))}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {tab === "marketplace" && <MarketplacePane search={search} />}
        {tab === "git" && <GitImportPane />}
        {tab === "local" && <LocalImportPane />}
        {tab === "scan" && <ScanPane />}
      </ScrollArea>
    </div>
  );
}
