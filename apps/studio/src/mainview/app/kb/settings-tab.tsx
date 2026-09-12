import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownWideNarrowIcon,
  CheckCircle2Icon,
  Loader2Icon,
  SaveIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
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
import { Switch } from "@ui/switch";
import { useKbStore } from "@stores/kb";
import { useT } from "@stores/ui-lang";
import type { KbView } from "@/bun/knowledge";

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
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
      <Label className="sm:w-36 sm:shrink-0 sm:pt-1.5 sm:text-xs">{label}</Label>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {children}
        {hint && <p className="text-[10px] leading-4 text-muted-foreground/80">{hint}</p>}
      </div>
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
      className={
        danger
          ? "mt-2 flex flex-col gap-4 rounded-xl border border-destructive/25 bg-card p-4"
          : "flex flex-col gap-4 rounded-xl border bg-card p-4"
      }
    >
      <h2
        className={
          danger
            ? "flex items-center gap-1.5 text-xs font-semibold text-destructive"
            : "flex items-center gap-1.5 text-xs font-semibold"
        }
      >
        {icon}
        {title}
      </h2>
      {children}
    </section>
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

  // 切换知识库 / 服务端数据刷新（如维度被写入）时同步表单
  useEffect(() => {
    setForm(formFromKb(kb));
    setResetNotice(false);
    setTestResult(null);
    setRerankTestResult(null);
  }, [kb.id, kb.updatedAt, kb.embeddingDim]);

  const set = <K extends keyof FormState>(key: K, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const dirty = JSON.stringify(form) !== JSON.stringify(formFromKb(kb));

  const modelsQuery = useQuery({
    queryKey: ["kb-embedding-models", form.embeddingBase],
    queryFn: () =>
      rpcClient.kbEmbeddingModels({
        base: form.embeddingBase || undefined,
        apiKey: form.embeddingApiKey || undefined,
      }),
  });

  const rerankModelsQuery = useQuery({
    queryKey: ["kb-rerank-models", form.rerankBase],
    queryFn: () =>
      rpcClient.kbRerankModels({
        base: form.rerankBase || undefined,
        apiKey: form.rerankApiKey || undefined,
      }),
  });

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

  const [rerankTestResult, setRerankTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
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

  const embeddingSuggestions = (modelsQuery.data?.models ?? []).filter((m) =>
    /embed|bge|gte|nomic|e5|jina|minilm/i.test(m),
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      <div className="mx-auto flex max-w-xl flex-col gap-4 py-3">
        <Section icon={<SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.basic")}>
          <FormRow label={t("kb.create.name")}>
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              className="h-8 text-xs"
            />
          </FormRow>
          <FormRow label={t("kb.create.descLabel")}>
            <Input
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder={t("kb.create.descPlaceholder")}
              className="h-8 text-xs"
            />
          </FormRow>
        </Section>

        <Section icon={<SparklesIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.embedding")}>
          <p className="text-[11px] leading-4 text-muted-foreground">{t("kb.settings.embeddingHint")}</p>
          <FormRow label={t("kb.settings.embeddingModel")}>
            <div className="flex items-center gap-2">
              <Input
                value={form.embeddingModel}
                onChange={(e) => set("embeddingModel", e.target.value)}
                placeholder={t("kb.settings.embeddingModelPlaceholder")}
                list="kb-embed-models"
                className="h-8 flex-1 text-xs"
              />
              <datalist id="kb-embed-models">
                {[...embeddingSuggestions, ...(modelsQuery.data?.models ?? []).filter((m) => !embeddingSuggestions.includes(m))].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
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
          </FormRow>
          <FormRow
            label={t("kb.settings.embeddingBase")}
            hint={t("kb.settings.embeddingBaseHint")}
          >
            <Input
              value={form.embeddingBase}
              onChange={(e) => set("embeddingBase", e.target.value)}
              placeholder={t("kb.settings.embeddingBasePlaceholder")}
              className="h-8 text-xs"
            />
          </FormRow>
          <FormRow label="API Key" hint={t("kb.settings.keyHint")}>
            <Input
              type="password"
              value={form.embeddingApiKey}
              onChange={(e) => set("embeddingApiKey", e.target.value)}
              placeholder={t("kb.settings.keyPlaceholder")}
              className="h-8 text-xs"
            />
          </FormRow>
          {!form.embeddingModel.trim() && (
            <p className="flex items-start gap-1.5 rounded-lg border border-foreground/10 bg-muted/40 px-2.5 py-1.5 text-[10px] leading-4 text-muted-foreground">
              <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
              {t("kb.settings.keywordOnlyNote")}
            </p>
          )}
        </Section>

        <Section icon={<ArrowDownWideNarrowIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.rerank")}>
          <p className="text-[11px] leading-4 text-muted-foreground">{t("kb.settings.rerankHint")}</p>
          <FormRow label={t("kb.settings.rerankModel")}>
            <div className="flex items-center gap-2">
              <Input
                value={form.rerankModel}
                onChange={(e) => set("rerankModel", e.target.value)}
                placeholder={t("kb.settings.rerankModelPlaceholder")}
                list="kb-rerank-models"
                className="h-8 flex-1 text-xs"
              />
              <datalist id="kb-rerank-models">
                {(rerankModelsQuery.data?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
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
          </FormRow>
          <FormRow label={t("kb.settings.rerankBase")} hint={t("kb.settings.rerankBaseHint")}>
            <Input
              value={form.rerankBase}
              onChange={(e) => set("rerankBase", e.target.value)}
              placeholder={t("kb.settings.embeddingBasePlaceholder")}
              className="h-8 text-xs"
            />
          </FormRow>
          <FormRow label="API Key" hint={t("kb.settings.keyHint")}>
            <Input
              type="password"
              value={form.rerankApiKey}
              onChange={(e) => set("rerankApiKey", e.target.value)}
              placeholder={t("kb.settings.keyPlaceholder")}
              className="h-8 text-xs"
            />
          </FormRow>
        </Section>

        <Section icon={<SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.params")}>
          <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
            <FormRow label={t("kb.settings.chunkSize")} hint={t("kb.settings.chunkSizeHint")}>
              <Input
                type="number"
                min={200}
                max={4000}
                value={form.chunkSize}
                onChange={(e) => set("chunkSize", e.target.value)}
                className="h-8 w-28 text-xs"
              />
            </FormRow>
            <FormRow label={t("kb.settings.chunkOverlap")} hint={t("kb.settings.chunkOverlapHint")}>
              <Input
                type="number"
                min={0}
                max={1000}
                value={form.chunkOverlap}
                onChange={(e) => set("chunkOverlap", e.target.value)}
                className="h-8 w-28 text-xs"
              />
            </FormRow>
            <FormRow label={t("kb.settings.topK")} hint={t("kb.settings.topKHint")}>
              <Input
                type="number"
                min={1}
                max={30}
                value={form.topK}
                onChange={(e) => set("topK", e.target.value)}
                className="h-8 w-28 text-xs"
              />
            </FormRow>
          </div>
          <p className="text-[10px] leading-4 text-muted-foreground/80">{t("kb.settings.reingestNote")}</p>
        </Section>

        <Section icon={<ShieldCheckIcon className="size-3.5 text-muted-foreground" />} title={t("kb.settings.retrieval")}>
          <FormRow label={t("kb.settings.minScore")} hint={t("kb.settings.minScoreHint")}>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={form.minScore}
              onChange={(e) => set("minScore", e.target.value)}
              className="h-8 w-28 text-xs"
            />
          </FormRow>
          <FormRow label={t("kb.settings.expandNeighbors")} hint={t("kb.settings.expandNeighborsHint")}>
            <Switch
              size="sm"
              checked={form.expandNeighbors}
              onCheckedChange={(v) => setForm((prev) => ({ ...prev, expandNeighbors: v }))}
            />
          </FormRow>
          <FormRow label={t("kb.settings.mcpExposed")} hint={t("kb.settings.mcpExposedHint")}>
            <Switch
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

        <div className="flex items-center justify-end gap-2">
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
