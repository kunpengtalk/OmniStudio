import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownWideNarrowIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CloudIcon,
  Loader2Icon,
  RefreshCwIcon,
  SaveIcon,
  ServerIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/collapsible";
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
import { Switch } from "@ui/switch";
import { useKbStore } from "@stores/kb";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { KbView } from "@/bun/knowledge";
import { KbModelSelect, serviceLabelKey, useKbModelCandidates, type KbServiceKind } from "./model-select";

type FormState = {
  name: string;
  description: string;
  embeddingModel: string;
  embeddingBase: string;
  embeddingApiKey: string;
  rerankModel: string;
  rerankBase: string;
  rerankApiKey: string;
  chunkSize: string;
  chunkOverlap: string;
  topK: string;
  minScore: string;
  expandNeighbors: boolean;
  mcpExposed: boolean;
};

function formFromKb(kb: KbView): FormState {
  return {
    name: kb.name,
    description: kb.description ?? "",
    embeddingModel: kb.embeddingModel,
    embeddingBase: kb.embeddingBase,
    embeddingApiKey: kb.embeddingApiKey,
    rerankModel: kb.rerankModel,
    rerankBase: kb.rerankBase,
    rerankApiKey: kb.rerankApiKey,
    chunkSize: String(kb.chunkSize),
    chunkOverlap: String(kb.chunkOverlap),
    topK: String(kb.topK),
    minScore: String(kb.minScore),
    expandNeighbors: kb.expandNeighbors,
    mcpExposed: kb.mcpExposed,
  };
}

/** 表单行：标签固定宽度在左、控件在右，全表单统一对齐轴线。 */
function FormRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
      <Label htmlFor={htmlFor} className="sm:w-32 sm:shrink-0 sm:pt-1.5 sm:text-xs">
        {label}
      </Label>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {children}
        {hint && <p className="text-[10px] leading-4 text-muted-foreground/80">{hint}</p>}
      </div>
    </div>
  );
}

/** 紧凑字段：标签在上、控件与说明在下（数值参数成组排列时用，不会撑破卡片）。 */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[10px] leading-4 text-muted-foreground/80">{hint}</p>}
    </div>
  );
}

function Section({
  icon,
  title,
  children,
  danger,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-card p-4",
        danger && "border-destructive/25",
      )}
    >
      <h2
        className={cn(
          "flex items-center gap-1.5 text-xs font-semibold",
          danger && "text-destructive",
        )}
      >
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * 当前实际使用的服务：地址由后端解析（本地推理服务 / 云服务商槽位 / 手填地址），
 * 说清本地服务无需密钥——用户不必为了用本机模型去配 Key。
 */
function ServiceLine({
  service,
}: {
  service?: { base: string; kind: KbServiceKind };
}) {
  const t = useT();
  if (!service) return null;
  const Icon = service.kind === "local" ? ServerIcon : CloudIcon;
  return (
    <p className="flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        {t(serviceLabelKey(service.kind))}
        {service.base ? ` · ${service.base}` : ""} ·{" "}
        {service.kind === "local" ? t("kb.settings.serviceNoKey") : t("kb.settings.serviceKeyHint")}
      </span>
    </p>
  );
}

/** 折叠的「自定义接口」：默认收起，只有填过地址/密钥的知识库才自动展开。 */
function AdvancedService({
  open,
  onOpenChange,
  customized,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customized: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="flex flex-col gap-3">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          {t("kb.settings.advanced")}
          {customized && (
            <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
              {t("kb.settings.advancedOn")}
            </span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function KbSettingsTab({ kb }: { kb: KbView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const setSelectedKbId = useKbStore((s) => s.setSelectedKbId);
  const [form, setForm] = useState<FormState>(() => formFromKb(kb));
  const [resetNotice, setResetNotice] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; dim?: number; error?: string } | null>(null);
  const [rerankTestResult, setRerankTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  // null = 还没手动开合过 → 按「是否已自定义地址/密钥」决定初始展开状态
  const [embedAdvanced, setEmbedAdvanced] = useState<boolean | null>(null);
  const [rerankAdvanced, setRerankAdvanced] = useState<boolean | null>(null);

  // 切换知识库 / 服务端数据刷新（如维度被写入）时同步表单
  useEffect(() => {
    setForm(formFromKb(kb));
    setResetNotice(false);
    setTestResult(null);
    setRerankTestResult(null);
    setEmbedAdvanced(null);
    setRerankAdvanced(null);
  }, [kb.id, kb.updatedAt, kb.embeddingDim]);

  const set = <K extends keyof FormState>(key: K, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const dirty = JSON.stringify(form) !== JSON.stringify(formFromKb(kb));

  // 候选模型跟随「当前会用的地址」：重排地址留空时跟嵌入地址（与检索时的解析一致）。
  const embedCandidates = useKbModelCandidates("embedding", form.embeddingBase, form.embeddingApiKey);
  const rerankCandidates = useKbModelCandidates(
    "rerank",
    form.rerankBase || form.embeddingBase,
    form.rerankApiKey,
  );

  const saveMutation = useMutation({
    mutationFn: () =>
      rpcClient.kbUpdate({
        id: kb.id,
        patch: {
          name: form.name,
          description: form.description,
          embeddingModel: form.embeddingModel,
          embeddingBase: form.embeddingBase,
          embeddingApiKey: form.embeddingApiKey,
          rerankModel: form.rerankModel,
          rerankBase: form.rerankBase,
          rerankApiKey: form.rerankApiKey,
          chunkSize: Number(form.chunkSize) || 800,
          chunkOverlap: Number(form.chunkOverlap) || 120,
          topK: Number(form.topK) || 6,
          minScore: Number(form.minScore) || 0,
          expandNeighbors: form.expandNeighbors,
          mcpExposed: form.mcpExposed,
        },
      }),
    onSuccess: (data) => {
      setResetNotice(data.embeddingsReset);
      queryClient.invalidateQueries({ queryKey: ["kb-list"] });
    },
  });

  const testMutation = useMutation({
    mutationFn: () =>
      rpcClient.kbTestEmbedding({
        base: form.embeddingBase || undefined,
        apiKey: form.embeddingApiKey || undefined,
        model: form.embeddingModel,
      }),
    onSuccess: (data) => setTestResult(data),
  });

  const testRerankMutation = useMutation({
    mutationFn: () =>
      rpcClient.kbTestRerank({
        base: form.rerankBase || undefined,
        apiKey: form.rerankApiKey || undefined,
        model: form.rerankModel,
      }),
    onSuccess: (data) => setRerankTestResult(data),
  });

  const deleteMutation = useMutation({
    mutationFn: () => rpcClient.kbDelete({ id: kb.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kb-list"] });
      setSelectedKbId(null);
      setConfirmDelete(false);
    },
  });

  const embedCustomized = Boolean(form.embeddingBase.trim() || form.embeddingApiKey.trim());
  const rerankCustomized = Boolean(form.rerankBase.trim() || form.rerankApiKey.trim());

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-4">
        <Section icon={<SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.basic")}>
          <FormRow label={t("kb.create.name")} htmlFor="kb-settings-name">
            <Input
              id="kb-settings-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              className="h-8 text-xs"
            />
          </FormRow>
          <FormRow label={t("kb.create.descLabel")} htmlFor="kb-settings-desc">
            <Input
              id="kb-settings-desc"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder={t("kb.create.descPlaceholder")}
              className="h-8 text-xs"
            />
          </FormRow>
        </Section>

        <Section icon={<SparklesIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.embedding")}>
          <p className="text-[11px] leading-4 text-muted-foreground">{t("kb.settings.embeddingHint")}</p>
          <FormRow label={t("kb.settings.model")} htmlFor="kb-settings-embedding-model">
            <div className="flex items-center gap-2">
              <KbModelSelect
                id="kb-settings-embedding-model"
                ariaLabel={t("kb.settings.embedding")}
                value={form.embeddingModel}
                onChange={(m) => {
                  set("embeddingModel", m);
                  setTestResult(null);
                }}
                candidates={embedCandidates.data}
                loading={embedCandidates.isLoading}
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                tooltip={t("chat.modelRefresh")}
                aria-label={t("chat.modelRefresh")}
                className="shrink-0"
                onClick={() => embedCandidates.refetch()}
                disabled={embedCandidates.isFetching}
              >
                <RefreshCwIcon className={cn("size-3.5", embedCandidates.isFetching && "animate-spin")} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1 px-2.5 text-xs"
                onClick={() => testMutation.mutate()}
                disabled={!form.embeddingModel.trim() || testMutation.isPending}
              >
                {testMutation.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <CheckCircle2Icon className="size-3.5" />
                )}
                {t("kb.settings.test")}
              </Button>
            </div>
            {testResult && (
              <p
                className={
                  testResult.ok
                    ? "text-[10px] text-emerald-600 dark:text-emerald-400"
                    : "text-[10px] text-destructive"
                }
              >
                {testResult.ok ? t("kb.settings.testOk", { dim: String(testResult.dim) }) : testResult.error}
              </p>
            )}
            <ServiceLine service={embedCandidates.data?.service} />
          </FormRow>
          <AdvancedService
            open={embedAdvanced ?? embedCustomized}
            onOpenChange={setEmbedAdvanced}
            customized={embedCustomized}
          >
            <FormRow label={t("kb.settings.embeddingBase")} hint={t("kb.settings.embeddingBaseHint")}>
              <Input
                value={form.embeddingBase}
                onChange={(e) => set("embeddingBase", e.target.value)}
                placeholder={t("kb.settings.embeddingBasePlaceholder")}
                className="h-8 text-xs"
              />
            </FormRow>
            <FormRow label={t("kb.settings.apiKey")} hint={t("kb.settings.keyHint")}>
              <Input
                type="password"
                value={form.embeddingApiKey}
                onChange={(e) => set("embeddingApiKey", e.target.value)}
                placeholder={t("kb.settings.keyPlaceholder")}
                className="h-8 text-xs"
              />
            </FormRow>
          </AdvancedService>
          {!form.embeddingModel.trim() && (
            <p className="flex items-start gap-1.5 rounded-lg border border-foreground/10 bg-muted/40 px-2.5 py-1.5 text-[10px] leading-4 text-muted-foreground">
              <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
              {t("kb.settings.keywordOnlyNote")}
            </p>
          )}
        </Section>

        <Section icon={<ArrowDownWideNarrowIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.rerank")}>
          <p className="text-[11px] leading-4 text-muted-foreground">{t("kb.settings.rerankHint")}</p>
          <FormRow label={t("kb.settings.model")} htmlFor="kb-settings-rerank-model">
            <div className="flex items-center gap-2">
              <KbModelSelect
                id="kb-settings-rerank-model"
                ariaLabel={t("kb.settings.rerank")}
                value={form.rerankModel}
                onChange={(m) => {
                  set("rerankModel", m);
                  setRerankTestResult(null);
                }}
                candidates={rerankCandidates.data}
                loading={rerankCandidates.isLoading}
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                tooltip={t("chat.modelRefresh")}
                aria-label={t("chat.modelRefresh")}
                className="shrink-0"
                onClick={() => rerankCandidates.refetch()}
                disabled={rerankCandidates.isFetching}
              >
                <RefreshCwIcon className={cn("size-3.5", rerankCandidates.isFetching && "animate-spin")} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1 px-2.5 text-xs"
                onClick={() => testRerankMutation.mutate()}
                disabled={!form.rerankModel.trim() || testRerankMutation.isPending}
              >
                {testRerankMutation.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <CheckCircle2Icon className="size-3.5" />
                )}
                {t("kb.settings.test")}
              </Button>
            </div>
            {rerankTestResult && (
              <p
                className={
                  rerankTestResult.ok
                    ? "text-[10px] text-emerald-600 dark:text-emerald-400"
                    : "text-[10px] text-destructive"
                }
              >
                {rerankTestResult.ok ? t("kb.settings.rerankTestOk") : rerankTestResult.error}
              </p>
            )}
            <ServiceLine service={rerankCandidates.data?.service} />
          </FormRow>
          <AdvancedService
            open={rerankAdvanced ?? rerankCustomized}
            onOpenChange={setRerankAdvanced}
            customized={rerankCustomized}
          >
            <FormRow label={t("kb.settings.rerankBase")} hint={t("kb.settings.rerankBaseHint")}>
              <Input
                value={form.rerankBase}
                onChange={(e) => set("rerankBase", e.target.value)}
                placeholder={t("kb.settings.embeddingBasePlaceholder")}
                className="h-8 text-xs"
              />
            </FormRow>
            <FormRow label={t("kb.settings.apiKey")} hint={t("kb.settings.keyHint")}>
              <Input
                type="password"
                value={form.rerankApiKey}
                onChange={(e) => set("rerankApiKey", e.target.value)}
                placeholder={t("kb.settings.keyPlaceholder")}
                className="h-8 text-xs"
              />
            </FormRow>
          </AdvancedService>
        </Section>

        <Section icon={<SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.params")}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t("kb.settings.chunkSize")} hint={t("kb.settings.chunkSizeHint")} htmlFor="kb-chunk-size">
              <Input
                id="kb-chunk-size"
                type="number"
                min={200}
                max={4000}
                value={form.chunkSize}
                onChange={(e) => set("chunkSize", e.target.value)}
                className="h-8 w-full text-xs"
              />
            </Field>
            <Field label={t("kb.settings.chunkOverlap")} hint={t("kb.settings.chunkOverlapHint")} htmlFor="kb-chunk-overlap">
              <Input
                id="kb-chunk-overlap"
                type="number"
                min={0}
                max={1000}
                value={form.chunkOverlap}
                onChange={(e) => set("chunkOverlap", e.target.value)}
                className="h-8 w-full text-xs"
              />
            </Field>
            <Field label={t("kb.settings.topK")} hint={t("kb.settings.topKHint")} htmlFor="kb-top-k">
              <Input
                id="kb-top-k"
                type="number"
                min={1}
                max={30}
                value={form.topK}
                onChange={(e) => set("topK", e.target.value)}
                className="h-8 w-full text-xs"
              />
            </Field>
          </div>
          <p className="text-[10px] leading-4 text-muted-foreground/80">{t("kb.settings.reingestNote")}</p>
        </Section>

        <Section icon={<ShieldCheckIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.retrieval")}>
          <FormRow
            label={t("kb.settings.minScore")}
            htmlFor="kb-settings-min-score"
            hint={t("kb.settings.minScoreHint")}
          >
            <Input
              id="kb-settings-min-score"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={form.minScore}
              onChange={(e) => set("minScore", e.target.value)}
              className="h-8 w-28 text-xs"
            />
          </FormRow>
          <FormRow
            label={t("kb.settings.expandNeighbors")}
            htmlFor="kb-settings-expand-neighbors"
            hint={t("kb.settings.expandNeighborsHint")}
          >
            <Switch
              id="kb-settings-expand-neighbors"
              size="sm"
              checked={form.expandNeighbors}
              onCheckedChange={(v) => setForm((prev) => ({ ...prev, expandNeighbors: v }))}
            />
          </FormRow>
          <FormRow
            label={t("kb.settings.mcpExposed")}
            htmlFor="kb-settings-mcp-exposed"
            hint={t("kb.settings.mcpExposedHint")}
          >
            <Switch
              id="kb-settings-mcp-exposed"
              size="sm"
              checked={form.mcpExposed}
              onCheckedChange={(v) => setForm((prev) => ({ ...prev, mcpExposed: v }))}
            />
          </FormRow>
        </Section>

        {resetNotice && (
          <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {t("kb.settings.resetNotice")}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 border-t pt-4">
          {dirty && (
            <span className="mr-auto text-[11px] text-muted-foreground">
              {t("kb.settings.unsaved")}
            </span>
          )}
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending || !form.name.trim()}
          >
            {saveMutation.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SaveIcon className="size-3.5" />
            )}
            {saveMutation.isSuccess && !dirty ? t("kb.settings.saved") : t("common.save")}
          </Button>
        </div>

        <Section icon={<Trash2Icon className="size-3.5" />} title={t("kb.settings.danger")} danger>
          <Button
            variant="outline"
            size="sm"
            className="w-fit gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2Icon className="size-3.5" />
            {t("kb.settings.deleteKb")}
          </Button>
        </Section>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("kb.settings.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("kb.settings.deleteBody")}{" "}
              <span className="font-medium text-foreground">「{kb.name}」</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
