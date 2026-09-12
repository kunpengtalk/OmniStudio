import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileTextIcon,
  LayersIcon,
  LibraryIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { Textarea } from "@ui/textarea";
import { useKbStore, type KbTab } from "@stores/kb";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { KbView } from "@/bun/knowledge";
import { KbDocsTab } from "./docs-tab";
import { KbRecallTab } from "./recall-tab";
import { KbSettingsTab } from "./settings-tab";
import { KbGovernanceTab } from "./governance-tab";
import { KbAccessTab } from "./access-tab";

/** 知识库列表（侧栏 / 主页 / 聊天选择器共用）。 */
export function useKbListQuery() {
  return useQuery({ queryKey: ["kb-list"], queryFn: () => rpcClient.kbList(undefined) });
}

/**
 * 「不使用」在状态里是空字符串，但 Radix 的 SelectItem 不接受空字符串 value
 * （它会直接抛错：Select 关闭时 children 也会渲染进游离 DocumentFragment 收集
 * 候选项文本，所以一打开弹窗就炸），这里用哨兵值代替再映射回空串。
 */
const NO_MODEL = "__none__";

/** 新建知识库弹窗（侧栏「新建」与主页空状态共用，开关在 kb store）。
 *  嵌入/重排模型可创建时就选（默认「不使用」），高级配置（地址/密钥）在设置页。 */
export function KbCreateDialog() {
  const t = useT();
  const queryClient = useQueryClient();
  const open = useKbStore((s) => s.createOpen);
  const setOpen = useKbStore((s) => s.setCreateOpen);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [rerankModel, setRerankModel] = useState("");

  // 弹窗打开时才拉模型候选（跟随当前服务商的 /v1/models + 云厂商模型表）。
  const embedModelsQuery = useQuery({
    queryKey: ["kb-embedding-models", ""],
    queryFn: () => rpcClient.kbEmbeddingModels(undefined),
    enabled: open,
    staleTime: 60_000,
  });
  const rerankModelsQuery = useQuery({
    queryKey: ["kb-rerank-models", ""],
    queryFn: () => rpcClient.kbRerankModels(undefined),
    enabled: open,
    staleTime: 60_000,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      rpcClient.kbCreate({
        name,
        description,
        embeddingModel: embeddingModel || undefined,
        rerankModel: rerankModel || undefined,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["kb-list"] });
      useKbStore.getState().setSelectedKbId(data.kb.id);
      setOpen(false);
    },
  });

  const modelSelect = (
    id: string,
    value: string,
    onChange: (v: string) => void,
    models: string[],
    loading: boolean,
  ) => (
    <Select value={value || NO_MODEL} onValueChange={(v) => onChange(v === NO_MODEL ? "" : v)}>
      <SelectTrigger id={id} className="h-8 w-full text-xs">
        <SelectValue placeholder={t("kb.create.notUse")} />
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={6} className="max-h-64 max-w-72">
        <SelectItem value={NO_MODEL} className="text-xs">
          {t("kb.create.notUse")}
        </SelectItem>
        {loading && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            {t("kb.create.loadingModels")}
          </div>
        )}
        {!loading && models.length === 0 && (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t("kb.create.noModels")}</div>
        )}
        {models.map((m) => (
          <SelectItem key={m} value={m} className="text-xs">
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("kb.create.title")}</DialogTitle>
          <DialogDescription>{t("kb.create.desc")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-name">{t("kb.create.name")}</Label>
            <Input
              id="kb-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("kb.create.namePlaceholder")}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-desc">{t("kb.create.descLabel")}</Label>
            <Textarea
              id="kb-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("kb.create.descPlaceholder")}
              rows={2}
              className="resize-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-embed-select">{t("kb.create.embedding")}</Label>
            {modelSelect(
              "kb-embed-select",
              embeddingModel,
              setEmbeddingModel,
              embedModelsQuery.data?.models ?? [],
              embedModelsQuery.isLoading,
            )}
            <p className="text-[10px] leading-4 text-muted-foreground/80">
              {t("kb.create.embeddingHint")}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-rerank-select">{t("kb.create.rerank")}</Label>
            {modelSelect(
              "kb-rerank-select",
              rerankModel,
              setRerankModel,
              rerankModelsQuery.data?.models ?? [],
              rerankModelsQuery.isLoading,
            )}
            <p className="text-[10px] leading-4 text-muted-foreground/80">
              {t("kb.create.rerankHint")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            {t("kb.create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TABS: { key: KbTab; labelKey: string }[] = [
  { key: "docs", labelKey: "kb.tab.docs" },
  { key: "recall", labelKey: "kb.tab.recall" },
  { key: "settings", labelKey: "kb.tab.settings" },
  { key: "governance", labelKey: "kb.tab.governance" },
  { key: "access", labelKey: "kb.tab.access" },
];

function StatCard({
  icon,
  value,
  label,
  caption,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  caption?: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl border bg-card px-3 py-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold tabular-nums leading-tight">{value}</span>
        <span className="block truncate text-[10px] leading-tight text-muted-foreground">
          {label}
          {caption ? ` · ${caption}` : ""}
        </span>
      </span>
    </div>
  );
}

/** 库详情头部：名称/描述 + 四格统计带 + 标签栏。 */
function KbHeader({ kb }: { kb: KbView }) {
  const t = useT();
  const setTab = useKbStore((s) => s.setTab);
  const tab = useKbStore((s) => s.tab);

  const vectorPct =
    kb.chunkCount > 0 ? Math.round((kb.embeddedCount / kb.chunkCount) * 100) : kb.embeddingModel ? 0 : 100;

  return (
    <div className="flex shrink-0 flex-col gap-3 border-b px-6 pb-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <LibraryIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold leading-tight">{kb.name}</h1>
          {kb.description && (
            <p className="truncate text-[11px] leading-tight text-muted-foreground">{kb.description}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <StatCard
          icon={<FileTextIcon className="size-4" />}
          value={String(kb.docCount)}
          label={t("kb.stats.docs")}
        />
        <StatCard
          icon={<LayersIcon className="size-4" />}
          value={String(kb.chunkCount)}
          label={t("kb.stats.chunks")}
        />
        <StatCard
          icon={<SparklesIcon className="size-4" />}
          value={kb.embeddingModel ? `${kb.embeddedCount}/${kb.chunkCount}` : "—"}
          label={t("kb.stats.vectors")}
          caption={kb.embeddingModel ? `${vectorPct}%` : undefined}
        />
        <StatCard
          icon={<SearchIcon className="size-4" />}
          value={kb.embeddingModel ? t("kb.stats.mixed") : t("kb.stats.keyword")}
          label={t("kb.stats.retrieval")}
          caption={t("kb.stats.topKCaption", { count: String(kb.topK) })}
        />
      </div>

      <div className="flex w-fit items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              "rounded-md px-3 py-1 text-xs transition-colors",
              tab === item.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function KbScreen() {
  const t = useT();
  const selectedKbId = useKbStore((s) => s.selectedKbId);
  const setSelectedKbId = useKbStore((s) => s.setSelectedKbId);
  const tab = useKbStore((s) => s.tab);
  const listQuery = useKbListQuery();

  const kbs = listQuery.data?.kbs ?? [];
  const selected: KbView | null = kbs.find((k) => k.id === selectedKbId) ?? null;

  // 选中项被删除后回落到第一个
  useEffect(() => {
    if (listQuery.isSuccess && !selected && kbs.length > 0) {
      setSelectedKbId(kbs[0]!.id);
    }
  }, [listQuery.isSuccess, selected, kbs, setSelectedKbId]);

  if (listQuery.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (kbs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <LibraryIcon className="size-7" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t("kb.empty.title")}</p>
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">{t("kb.empty.hint")}</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => useKbStore.getState().setCreateOpen(true)}>
          <PlusIcon className="size-3.5" />
          {t("kb.create.submit")}
        </Button>
        <KbCreateDialog />
      </div>
    );
  }

  if (!selected) return null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <KbHeader kb={selected} />
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "docs" && <KbDocsTab kb={selected} />}
        {tab === "recall" && <KbRecallTab kb={selected} />}
        {tab === "settings" && <KbSettingsTab kb={selected} />}
        {tab === "governance" && <KbGovernanceTab kb={selected} />}
        {tab === "access" && <KbAccessTab kb={selected} />}
      </div>
      <KbCreateDialog />
    </div>
  );
}
