import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SearchIcon,
  DownloadIcon,
  CheckCircle2Icon,
  XCircleIcon,
  Loader2Icon,
  Trash2Icon,
  StoreIcon,
  FolderOpenIcon,
  SparklesIcon,
  HardDriveIcon,
  ChevronRightIcon,
  StarIcon,
  CpuIcon,
  PlayIcon,
  AlertTriangleIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Badge } from "@ui/badge";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import { Separator } from "@ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useModelDetailStore } from "@stores/model-detail";
import { useRouter } from "@stores/router";
import { useServerStore } from "@stores/server";
import { useT } from "@stores/ui-lang";
import {
  MODEL_PRESETS,
  MODEL_CATEGORIES,
  classifyModel,
  matchCategory,
  ENGINE_OPTIONS,
  fileKind,
  engineSupports,
  repoFormatHint,
  type ModelCategory,
  type InferenceEngine,
  type ModelScopeModel,
} from "@/shared/modelscope";
import { serverErrorHint } from "@/mainview/lib/server-error";
import { cn } from "@/mainview/lib/utils";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function formatParams(params: number): string {
  if (!params) return "";
  if (params >= 1e9) return `${(params / 1e9).toFixed(1)}B`;
  if (params >= 1e6) return `${(params / 1e6).toFixed(0)}M`;
  return String(params);
}

const CAT_BADGE_CLASSES: Record<string, string> = {
  chat: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  tts: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
  asr: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  image: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  other: "bg-muted text-muted-foreground",
};

function InstalledModelRow({
  model,
  engine,
}: {
  model: {
    repo: string;
    fileName: string;
    path: string;
    size: number;
    isActive: boolean;
    isChatModel: boolean;
    category: ModelCategory;
    favorite: boolean;
  };
  engine: InferenceEngine;
}) {
  const queryClient = useQueryClient();
  const t = useT();
  const serverStatus = useServerStore((s) => s.status);
  const kind = fileKind(model.fileName);
  const compatible = engineSupports(engine, kind);
  const [startError, setStartError] = useState<string | null>(null);

  const setActiveMutation = useMutation({
    mutationFn: () => rpcClient.setActiveModel({ path: model.path }),
    onSuccess: () => {
      setStartError(null);
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err: unknown) => setStartError(String(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => rpcClient.deleteLocalModel({ path: model.path }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["installed-models"] }),
  });
  const favoriteMutation = useMutation({
    mutationFn: () => rpcClient.toggleFavoriteModel({ path: model.path }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["installed-models"] }),
  });
  const startMutation = useMutation({
    mutationFn: async () => {
      if (!model.isActive) {
        const act = await rpcClient.setActiveModel({ path: model.path });
        if (!act.ok) throw new Error(act.error || "Failed to activate model");
      }
      const status = useServerStore.getState().status;
      const res =
        status === "running" || status === "starting" || status === "downloading"
          ? await rpcClient.restartServer()
          : await rpcClient.startServer();
      if (!res.ok) throw new Error(res.error || "Failed to start server");
      return res;
    },
    onSuccess: () => {
      setStartError(null);
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err: unknown) =>
      setStartError(err instanceof Error ? err.message.replace(/^Error:\s*/i, "") : String(err)),
  });
  const serverBusy = serverStatus === "starting" || serverStatus === "downloading";
  const startErrorHint = startError ? serverErrorHint(t, startError) : null;

  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{model.fileName}</span>
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full px-1.5 text-[10px] font-medium",
              CAT_BADGE_CLASSES[model.category],
            )}
          >
            {t(`models.cat.${model.category}`)}
          </span>
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[10px] font-medium",
              kind === "gguf"
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
                : kind === "safetensors"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {kind === "gguf"
              ? t("models.format.gguf")
              : kind === "safetensors"
                ? t("models.format.safetensors")
                : t("models.format.other")}
          </span>
          {!compatible && (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-amber-100 px-1.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              <AlertTriangleIcon className="size-3" />
              {t("models.autoSwitchEngine")}
            </span>
          )}
          {model.isActive && (
            <Badge variant="default" className="gap-1 text-[10px]">
              <SparklesIcon className="size-3" /> {t("models.inUse")}
            </Badge>
          )}
          {model.isChatModel && (
            <Badge variant="secondary" className="text-[10px]">
              Chat
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
          {model.repo}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {formatBytes(model.size)}
        </p>
        {startError && (
          <div className="mt-1 space-y-0.5">
            {startErrorHint && (
              <p className="flex items-start gap-1 text-[11px] text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 break-words">{startErrorHint}</span>
              </p>
            )}
            <p className="flex items-start gap-1 text-[11px] text-destructive/70">
              <span className="mt-1.5 size-0.5 shrink-0 rounded-full bg-destructive/50" />
              <span className="min-w-0 break-words">{startError}</span>
            </p>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={model.favorite ? t("models.unfavorite") : t("models.favorite")}
          onClick={() => favoriteMutation.mutate()}
          disabled={favoriteMutation.isPending}
          className={model.favorite ? "text-amber-500" : "text-muted-foreground"}
        >
          <StarIcon className={cn("size-4", model.favorite && "fill-amber-500")} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={startMutation.isPending || serverBusy}
          onClick={() => startMutation.mutate()}
        >
          {startMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {serverStatus === "running" ? t("models.restartServer") : t("models.startServer")}
        </Button>
        <Button
          variant={model.isActive ? "default" : "outline"}
          size="sm"
          className="h-7 text-xs"
          disabled={model.isActive || setActiveMutation.isPending}
          onClick={() => setActiveMutation.mutate()}
        >
          {setActiveMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <CheckCircle2Icon data-icon="inline-start" />
          )}
          {model.isActive ? t("models.inUse") : t("models.activate")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("common.delete")}
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function InstalledModels({ activeCategory, favoritesOnly, engine, showAll, onShowAllChange }: { activeCategory: ModelCategory | "all"; favoritesOnly: boolean; engine: InferenceEngine; showAll: boolean; onShowAllChange: (v: boolean) => void }) {
  const t = useT();
  const { data, isLoading } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  const models = (data?.models ?? []).filter(
    (m) =>
      (activeCategory === "all" || m.category === activeCategory) &&
      (!favoritesOnly || m.favorite) &&
      (showAll || fileKind(m.fileName) === "other" || engineSupports(engine, fileKind(m.fileName))),
  );

  if (models.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
        <HardDriveIcon className="size-6 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">{t("models.noInstalled")}</p>
        {!showAll && (
          <button
            type="button"
            onClick={() => onShowAllChange(true)}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            {t("models.showAllFormats")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {models.map((m) => (
        <InstalledModelRow key={m.path} model={m} engine={engine} />
      ))}
    </div>
  );
}

function SearchResultRow({
  model,
}: {
  model: ModelScopeModel;
}) {
  const t = useT();
  const setSource = useModelDetailStore((s) => s.setSource);
  const setRoute = useRouter((s) => s.setRoute);

  const cat = classifyModel(model);
  const formatHint = repoFormatHint(model.id);

  const openDetail = () => {
    setSource({ kind: "search", model });
    setRoute({ path: "model-detail" });
  };

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:border-muted-foreground/40"
      onClick={openDetail}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{model.name || model.id}</span>
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full px-1.5 text-[10px] font-medium",
              CAT_BADGE_CLASSES[cat],
            )}
          >
            {t(`models.cat.${cat}`)}
          </span>
          {formatHint === "gguf" && (
            <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-blue-100 px-1.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
              {t("models.format.gguf")}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
          {model.id}
        </p>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{model.downloads} downloads</span>
          {model.params > 0 && <span>· {formatParams(model.params)} params</span>}
          {model.license && <span>· {model.license}</span>}
          <span>· {formatBytes(model.fileSize)} total</span>
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {t("models.viewDetail")}
        <ChevronRightIcon className="size-4" />
      </span>
    </button>
  );
}

export function ModelsScreen() {
  const t = useT();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [activeCategory, setActiveCategory] = useState<ModelCategory | "all">("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showAllFormats, setShowAllFormats] = useState(false);
  const { engine, setEngine, isSaving } = useEngine();
  const setSource = useModelDetailStore((s) => s.setSource);
  const setRoute = useRouter((s) => s.setRoute);

  const searchQuery = useQuery({
    queryKey: ["modelscope-search", submitted],
    queryFn: () => rpcClient.searchModelScope({ query: submitted, page: 1 }),
    enabled: submitted.trim().length > 0,
  });

  const handleSearch = () => {
    setSubmitted(query.trim());
  };

  const filteredResults = (searchQuery.data?.models ?? []).filter((m) =>
    matchCategory(m as unknown as ModelScopeModel, activeCategory),
  );

  const filteredPresets = MODEL_PRESETS.filter(
    (p) =>
      (!p.engine || p.engine === "all" || p.engine === engine) &&
      matchCategory({ ...p, tags: [`task:${p.app === "chat" ? "text-generation" : p.app === "tts" ? "text-to-speech" : p.app === "asr" ? "auto-speech-recognition" : "text-to-image-synthesis"}`, `custom_tag:${p.app}`], tasks: [] } as unknown as ModelScopeModel, activeCategory),
  );

  const openPreset = (preset: (typeof MODEL_PRESETS)[number]) => {
    setSource({ kind: "preset", preset });
    setRoute({ path: "model-detail" });
  };

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-30 pt-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <StoreIcon className="size-5" />
            {t("models.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("models.subtitle")}</p>
        </div>

        {/* Inference engine */}
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <CpuIcon className="size-3.5" />
            {t("settings.engine")}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Select value={engine} onValueChange={(v) => setEngine(v as InferenceEngine)} disabled={isSaving}>
              <SelectTrigger className="h-8 w-72 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENGINE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t("models.engineHint")}</p>
          </div>
        </div>

        {/* Category filter */}
        <div className="flex flex-wrap gap-1.5">
          {MODEL_CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.value;
            return (
              <button
                key={cat.value}
                type="button"
                onClick={() => setActiveCategory(cat.value)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                )}
              >
                {t(cat.labelKey)}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 opacity-50" />
            <Input
              placeholder={t("models.searchPlaceholder")}
              className="pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
          </div>
          <Button onClick={handleSearch} disabled={!query.trim()}>
            {searchQuery.isFetching ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SearchIcon data-icon="inline-start" />
            )}
            {t("models.search")}
          </Button>
        </div>

        {/* Search results */}
        {submitted && (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("models.results")}: "{submitted}"
              {activeCategory !== "all" && (
                <span className="ml-2 inline-flex h-5 items-center rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
                  {t(`models.cat.${activeCategory}`)}
                </span>
              )}
            </h3>
            {searchQuery.isLoading ? (
              <div className="flex justify-center py-10"><Spinner className="size-5" /></div>
            ) : searchQuery.isError ? (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                <XCircleIcon className="size-4" />
                {t("models.searchFailed")}: {String(searchQuery.error)}
              </div>
            ) : filteredResults.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">{t("models.noResults")}</p>
            ) : (
              filteredResults.map((m) => (
                <SearchResultRow key={m.id} model={m} />
              ))
            )}
          </div>
        )}

        <Separator />

        {/* Recommended presets */}
        <div>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {t("models.recommended")}
            {activeCategory !== "all" && (
              <span className="ml-1.5 text-primary">— {t(`models.cat.${activeCategory}`)}</span>
            )}
          </h3>
          <div className="flex flex-wrap gap-2">
            {filteredPresets.map((preset) => (
              <button
                key={preset.repo}
                type="button"
                className="rounded-lg border px-3 py-2 text-left transition-colors hover:border-muted-foreground/40"
                onClick={() => openPreset(preset)}
              >
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{preset.label}</p>
                  <span className={cn("inline-flex h-4 items-center rounded-full px-1 text-[9px] font-medium", CAT_BADGE_CLASSES[preset.app])}>
                    {t(`models.cat.${preset.app}`)}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">{preset.repo}</p>
              </button>
            ))}
          </div>
        </div>

        <Separator />

        {/* Installed */}
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <FolderOpenIcon className="size-4" />
              {t("models.installed")}
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFavoritesOnly((v) => !v)}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  favoritesOnly
                    ? "border-amber-500/60 text-amber-500"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                <StarIcon className={cn("size-3.5", favoritesOnly && "fill-amber-500")} />
                {t("models.favoritesOnly")}
              </button>
              <button
                type="button"
                onClick={() => setShowAllFormats((v) => !v)}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  showAllFormats
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {showAllFormats ? t("models.engineOnly") : t("models.showAllFormats")}
              </button>
            </div>
          </div>
          <InstalledModels
            activeCategory={activeCategory}
            favoritesOnly={favoritesOnly}
            engine={engine}
            showAll={showAllFormats}
            onShowAllChange={setShowAllFormats}
          />
        </div>

        <p className="text-center text-[11px] text-muted-foreground/60">
          <DownloadIcon className="mr-1 inline size-3" />
          {t("models.downloadHint")}
        </p>
      </div>
    </ScrollArea>
  );
}
