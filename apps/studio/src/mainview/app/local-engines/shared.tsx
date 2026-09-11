import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  CloudDownloadIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  UploadCloudIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import { useModelDownloadStore } from "@stores/model-download";
import { useT } from "@stores/ui-lang";
import type { ModelCategory } from "@/shared/modelscope";
import { cn } from "@/mainview/lib/utils";

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

// ---------------------------------------------------------------------------
// 卡片 / 标签
// ---------------------------------------------------------------------------

export function PanelCard({
  title,
  icon,
  hint,
  action,
  children,
  className,
}: {
  title?: string;
  icon?: React.ReactNode;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border p-4", className)}>
      {(title || action) && (
        <div className="flex items-center gap-2">
          {icon}
          {title && <h3 className="text-sm font-medium">{title}</h3>}
          {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
          {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <span className="text-[11px] text-muted-foreground" id={htmlFor}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------

export type EngineStatusTone = "off" | "busy" | "on" | "error";

const TONE_DOT: Record<EngineStatusTone, string> = {
  off: "bg-muted-foreground/50",
  busy: "bg-amber-500 animate-pulse",
  on: "bg-emerald-500",
  error: "bg-destructive",
};

const TONE_TEXT: Record<EngineStatusTone, string> = {
  off: "text-muted-foreground",
  busy: "text-amber-600 dark:text-amber-400",
  on: "text-emerald-600 dark:text-emerald-400",
  error: "text-destructive",
};

/** 状态行：圆点 + 文案（参照设置页「运行状态」排版）。 */
export function StatusRow({
  label,
  tone,
  text,
  extra,
}: {
  label: string;
  tone: EngineStatusTone;
  text: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", TONE_TEXT[tone])}>
        <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
        {text}
      </span>
      {extra}
    </div>
  );
}

/** ServerStatus（server store）→ 展示 tone。 */
export function serverTone(status: string): EngineStatusTone {
  if (status === "running") return "on";
  if (status === "starting" || status === "downloading") return "busy";
  if (status === "error") return "error";
  return "off";
}

// ---------------------------------------------------------------------------
// 设置读写
// ---------------------------------------------------------------------------

export function useSettingsBlob() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
}

export function useSettingsPatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, string>) => rpcClient.updateSettings({ settings: patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });
}

/** 失焦 / Enter 提交的单值输入（数字或文本）。 */
export function CommitInput({
  label,
  value,
  onCommit,
  type = "text",
  placeholder,
  readOnly,
  mono,
  className,
}: {
  label?: string;
  value: string;
  onCommit?: (value: string) => void;
  type?: string;
  placeholder?: string;
  readOnly?: boolean;
  mono?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      {label && <FieldLabel>{label}</FieldLabel>}
      <Input
        type={type}
        value={draft}
        readOnly={readOnly}
        placeholder={placeholder}
        className={cn("h-8 text-xs", mono && "font-mono")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (readOnly || !onCommit) return;
          if (draft.trim() !== "" && draft !== value) onCommit(draft.trim());
          else setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

/** 失焦提交的多行输入（启动命令参数）。 */
export function CommitTextarea({
  label,
  hint,
  value,
  placeholder,
  onCommit,
}: {
  label?: string;
  hint?: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <textarea
        value={draft}
        placeholder={placeholder}
        rows={2}
        className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground focus-visible:border-ring"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
          else setDraft(value);
        }}
      />
      {hint && <span className="text-[11px] text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 模型下载控件（复用全局下载队列）
// ---------------------------------------------------------------------------

export function DownloadControls({
  repo,
  fileName,
  category,
  source,
  installed,
  installedText,
}: {
  repo: string;
  fileName: string;
  category?: ModelCategory;
  source?: "modelscope" | "huggingface";
  installed?: boolean;
  installedText?: string;
}) {
  const t = useT();
  const tasks = useModelDownloadStore((s) => s.tasks);
  const task = tasks.find((x) => x.repo === repo && x.fileName === fileName && x.status !== "canceled");

  const startMutation = useMutation({
    mutationFn: () => rpcClient.startModelDownload({ repo, fileName, category, source }),
  });
  const pauseMutation = useMutation({ mutationFn: () => rpcClient.pauseModelDownload({ id: task!.id }) });
  const resumeMutation = useMutation({ mutationFn: () => rpcClient.resumeModelDownload({ id: task!.id }) });

  if (installed && !task) {
    return (
      <Badge variant="secondary" className="shrink-0 gap-1 text-[10px]">
        <CheckCircle2Icon className="size-3" /> {installedText ?? t("engine.installed")}
      </Badge>
    );
  }

  if (!task) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 text-xs"
        disabled={startMutation.isPending}
        onClick={() => startMutation.mutate()}
      >
        {startMutation.isPending ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : (
          <CloudDownloadIcon data-icon="inline-start" />
        )}
        {t("engine.download")}
      </Button>
    );
  }

  const active = task.status === "downloading" || task.status === "queued";
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="w-32">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{task.status === "paused" ? "已暂停" : task.status === "failed" ? "失败" : "下载中"}</span>
          <span className="tabular-nums">
            {task.percent != null ? `${task.percent.toFixed(0)}%` : task.status === "queued" ? "排队" : "…"}
          </span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              task.status === "failed" ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${task.percent ?? 0}%` }}
          />
        </div>
      </div>
      {active ? (
        <Button
          variant="outline"
          size="icon-sm"
          tooltip={t("downloads.pause")}
          disabled={task.status === "queued"}
          onClick={() => pauseMutation.mutate()}
        >
          <PauseIcon className="size-3.5" />
        </Button>
      ) : task.status === "paused" ? (
        <Button variant="outline" size="icon-sm" tooltip={t("downloads.resume")} onClick={() => resumeMutation.mutate()}>
          <PlayIcon className="size-3.5" />
        </Button>
      ) : task.status === "failed" ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => resumeMutation.mutate()}
        >
          <RotateCcwIcon data-icon="inline-start" className="size-3" />
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 引擎安装（二进制下载）
// ---------------------------------------------------------------------------

export function EngineInstallRow({
  installed,
  detail,
  onInstall,
  installing,
  note,
}: {
  installed: boolean;
  detail?: string;
  onInstall: () => void;
  installing?: boolean;
  note?: string;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusRow
        label={t("engine.engineStatus")}
        tone={installed ? "on" : "off"}
        text={installed ? detail ?? t("engine.status.ready") : t("engine.status.notInstalled")}
      />
      {!installed && (
        <Button size="sm" className="h-7 text-xs" disabled={installing} onClick={onInstall}>
          {installing ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <CloudDownloadIcon data-icon="inline-start" />
          )}
          {t("engine.downloadEngine")}
        </Button>
      )}
      {note && <span className="text-[11px] text-muted-foreground/70">{note}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 本地模型文件导入（拖拽 / 点击选择）
// ---------------------------------------------------------------------------

const MODEL_FILE_TYPES = "gguf,safetensors,bin,pt,pth,ckpt,onnx,ggml";

export function ModelFileImportZone() {
  const t = useT();
  const queryClient = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const doImport = async (sourcePath: string) => {
    setImporting(true);
    setError(null);
    try {
      const res = await rpcClient.importModelFile({ sourcePath });
      if (!res.ok || !res.path) throw new Error(res.error ?? "import failed");
      await rpcClient.setActiveModel({ path: res.path });
      await queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const pick = async () => {
    try {
      const { paths } = await rpcClient.openFileDialog({ allowedFileTypes: MODEL_FILE_TYPES });
      if (paths[0]) await doImport(paths[0]);
    } catch {
      // dialog canceled
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{t("engine.modelFile")}</FieldLabel>
      <div
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = Array.from(e.dataTransfer.files)[0] as (File & { path?: string }) | undefined;
          if (f?.path) void doImport(f.path);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => {
          if (!importing) void pick();
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/20 hover:border-muted-foreground/40",
          importing && "pointer-events-none opacity-70",
        )}
      >
        {importing ? (
          <>
            <Spinner className="size-5 text-primary" />
            <p className="text-xs text-muted-foreground">{t("engine.importing")}</p>
          </>
        ) : (
          <>
            <UploadCloudIcon className="size-5 text-muted-foreground/60" />
            <p className="text-xs text-muted-foreground">{t("engine.importHint")}</p>
            <p className="text-[10px] font-mono text-muted-foreground/50">{t("engine.importHintFormats")}</p>
          </>
        )}
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OpenAI 兼容服务商表单（ASR / TTS / OCR 远程来源共用）
// ---------------------------------------------------------------------------

export function ProviderForm({
  base,
  apiKey,
  model,
  saving,
  onSave,
}: {
  base: string;
  apiKey: string;
  model: string;
  saving?: boolean;
  onSave: (cfg: { base: string; apiKey: string; model: string }) => void;
}) {
  const t = useT();
  const [form, setForm] = useState({ base, apiKey, model });
  useEffect(() => setForm({ base, apiKey, model }), [base, apiKey, model]);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 sm:col-span-2">
        <FieldLabel>{t("engine.provider.base")}</FieldLabel>
        <Input
          value={form.base}
          placeholder="https://api.example.com/v1"
          className="h-8 font-mono text-xs"
          onChange={(e) => setForm((f) => ({ ...f, base: e.target.value }))}
        />
      </label>
      <label className="flex flex-col gap-1">
        <FieldLabel>{t("engine.provider.apiKey")}</FieldLabel>
        <Input
          type="password"
          value={form.apiKey}
          className="h-8 font-mono text-xs"
          onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
        />
      </label>
      <label className="flex flex-col gap-1">
        <FieldLabel>{t("engine.provider.model")}</FieldLabel>
        <Input
          value={form.model}
          className="h-8 font-mono text-xs"
          onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
        />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button size="sm" disabled={saving} onClick={() => onSave(form)}>
          {saving ? <Spinner data-icon="inline-start" /> : null}
          {t("common.save")}
        </Button>
        <Label className="sr-only">{t("common.save")}</Label>
      </div>
    </div>
  );
}
