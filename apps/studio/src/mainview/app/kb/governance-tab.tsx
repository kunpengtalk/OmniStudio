import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardCopyIcon,
  DownloadIcon,
  FileClockIcon,
  FolderOpenIcon,
  HardDriveIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Label } from "@ui/label";
import { Switch } from "@ui/switch";
import { Textarea } from "@ui/textarea";
import { useT } from "@stores/ui-lang";
import type { KbView } from "@/bun/knowledge";
import type { KbEventEntry } from "@/shared/knowledge";

/** 审计动作 → 展示用语气：失败用警示色、删除用次级色，其余保持中性。 */
function toneOf(action: string): "outline" | "secondary" | "destructive" {
  if (action === "doc_failed") return "destructive";
  if (action === "doc_deleted" || action === "kb_deleted") return "secondary";
  return "outline";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** detail 是任意 JSON：只挑最有用的一两个字段做单行摘要。 */
function summarize(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (typeof detail !== "object") return String(detail);
  const obj = detail as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["name", "query", "reason", "error", "docs", "chunks", "hits", "ms", "attempts"]) {
    if (obj[key] === undefined || obj[key] === null) continue;
    const value = obj[key];
    parts.push(`${key}=${typeof value === "string" ? value.slice(0, 80) : String(value)}`);
  }
  return parts.join(" · ");
}

/**
 * 治理标签页：把「这套知识库在企业里能不能交代得清」需要的东西集中在一页 ——
 * 摄取队列是否健康、检索索引占多少内存、谁在什么时候导入/删除了什么、
 * 以及整库导出（迁移/归档）与导入。
 */
export function KbGovernanceTab({ kb }: { kb: KbView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [includeEmbeddings, setIncludeEmbeddings] = useState(true);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  const eventsQuery = useQuery({
    queryKey: ["kb-events", kb.id],
    queryFn: () => rpcClient.kbEvents({ kbId: kb.id, limit: 100 }),
  });
  const queueQuery = useQuery({
    queryKey: ["kb-queue-stats"],
    queryFn: () => rpcClient.kbQueueStats(),
    refetchInterval: 5_000,
  });
  const indexQuery = useQuery({
    queryKey: ["kb-index-stats"],
    queryFn: () => rpcClient.kbIndexStats(),
  });

  const indexStats = useMemo(
    () => (indexQuery.data?.indexes ?? []).find((s) => s.kbId === kb.id) ?? null,
    [indexQuery.data, kb.id],
  );

  const exportMutation = useMutation({
    mutationFn: () => rpcClient.kbExport({ kbId: kb.id, includeEmbeddings }),
    onSuccess: (data) => {
      setExportPath(data.path);
      queryClient.invalidateQueries({ queryKey: ["kb-events", kb.id] });
    },
  });

  const importMutation = useMutation({
    mutationFn: () => rpcClient.kbImport({ json: importJson }),
    onSuccess: () => {
      setImportOpen(false);
      setImportJson("");
      setImportError(null);
      queryClient.invalidateQueries({ queryKey: ["kb-list"] });
    },
    onError: (e) => setImportError(e instanceof Error ? e.message : String(e)),
  });

  const events: KbEventEntry[] = eventsQuery.data?.events ?? [];
  const counts = eventsQuery.data?.counts ?? {};

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 py-3">
        <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold">
            <HardDriveIcon className="size-3.5 text-muted-foreground" />
            {t("kb.gov.health")}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t("kb.gov.queued")} value={String(queueQuery.data?.queued ?? 0)} />
            <Stat label={t("kb.gov.running")} value={String(queueQuery.data?.running ?? 0)} />
            <Stat label={t("kb.gov.failed")} value={String(queueQuery.data?.failed ?? 0)} />
            <Stat label={t("kb.gov.recalls")} value={String(counts.recall ?? 0)} />
          </div>
          <p className="text-[10px] leading-4 text-muted-foreground/80">
            {indexStats
              ? t("kb.gov.indexLoaded", {
                  chunks: String(indexStats.chunks),
                  terms: String(indexStats.terms),
                  vectors: String(indexStats.vectors),
                  bytes: formatBytes(indexStats.bytes),
                })
              : t("kb.gov.indexLazy")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ["kb-events", kb.id] });
                queryClient.invalidateQueries({ queryKey: ["kb-index-stats"] });
                queryClient.invalidateQueries({ queryKey: ["kb-queue-stats"] });
              }}
            >
              <RefreshCwIcon className="size-3" />
              {t("kb.gov.refresh")}
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold">
            <DownloadIcon className="size-3.5 text-muted-foreground" />
            {t("kb.gov.portability")}
          </h2>
          <p className="text-[11px] leading-4 text-muted-foreground">{t("kb.gov.portabilityHint")}</p>
          <div className="flex items-center gap-2">
            <Switch
              size="sm"
              id="kb-export-embed"
              checked={includeEmbeddings}
              onCheckedChange={setIncludeEmbeddings}
            />
            <Label htmlFor="kb-export-embed" className="text-[11px]">
              {t("kb.gov.includeEmbeddings")}
            </Label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={exportMutation.isPending}
              onClick={() => exportMutation.mutate()}
            >
              {exportMutation.isPending ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <DownloadIcon className="size-3" />
              )}
              {t("kb.gov.export")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => setImportOpen(true)}
            >
              <UploadIcon className="size-3" />
              {t("kb.gov.import")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => void rpcClient.kbOpenExportDir()}
            >
              <FolderOpenIcon className="size-3" />
              {t("kb.gov.openDir")}
            </Button>
          </div>
          {exportPath && (
            <div className="flex items-center gap-2 rounded-lg border border-foreground/10 bg-muted/40 px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={exportPath}>
                {exportPath}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 gap-1 px-1.5 text-[10px]"
                onClick={() => void navigator.clipboard.writeText(exportPath)}
              >
                <ClipboardCopyIcon className="size-3" />
                {t("kb.gov.copyPath")}
              </Button>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold">
            <FileClockIcon className="size-3.5 text-muted-foreground" />
            {t("kb.gov.audit")}
          </h2>
          <p className="text-[11px] leading-4 text-muted-foreground">{t("kb.gov.auditHint")}</p>
          {events.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("kb.gov.auditEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {events.map((e) => (
                <li key={e.id} className="flex items-start gap-2 border-b border-border/50 pb-1.5 last:border-0">
                  <Badge variant={toneOf(e.action)} className="mt-0.5 shrink-0 font-mono text-[10px]">
                    {e.action}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px]" title={summarize(e.detail)}>
                      {summarize(e.detail) || "—"}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {formatTime(e.createdAt)} · {e.actor}
                      {e.docId ? ` · doc#${e.docId}` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("kb.gov.import")}</DialogTitle>
            <DialogDescription>{t("kb.gov.importHint")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder='{"format":"omnistudio.kb", ...}'
            className="h-40 font-mono text-[11px]"
          />
          {importError && (
            <p className="flex items-start gap-1.5 text-[11px] text-destructive">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {importError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!importJson.trim() || importMutation.isPending}
              onClick={() => importMutation.mutate()}
            >
              {importMutation.isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <UploadIcon className="size-3.5" />
              )}
              {t("kb.gov.import")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-muted/30 px-2.5 py-1.5">
      <span className="text-sm font-semibold tabular-nums leading-tight">{value}</span>
      <span className="text-[10px] leading-tight text-muted-foreground">{label}</span>
    </div>
  );
}
