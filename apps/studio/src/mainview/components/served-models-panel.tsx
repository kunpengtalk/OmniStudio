import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  FolderIcon,
  Loader2Icon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import Ansi from "ansi-to-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import {
  Terminal,
  TerminalActions,
  TerminalClearButton,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalTitle,
} from "@/components/ai-elements/terminal";
import { useServedStore } from "@stores/served";
import { useT } from "@stores/ui-lang";
import { ENGINE_SHORT_NAMES } from "@/shared/engines";
import { classifyModelName, MODEL_CATEGORY_SETS, type ModelCategory } from "@/shared/modelscope";
import type { ServedModelInfo } from "@/shared/served-models";
import { serverErrorHint } from "@/mainview/lib/server-error";
import { cn } from "@/mainview/lib/utils";

/**
 * 已启动模型（同时驻留多个）的面板：控制台用它管启停，概览页用它看状态。
 *
 * 数据来源双份：主进程推送（`servedModelsChanged`：状态变化立刻反映）+ 轮询兜底
 * （webview 刷新 / HMR 后 store 会重置，推送只在变化时发）。
 */

/** 轮询 + 推送合并写入 store。 */
function useServedModelsSync() {
  const setSnapshot = useServedStore((s) => s.setSnapshot);
  const { data } = useQuery({
    queryKey: ["served-models"],
    queryFn: () => rpcClient.listServedModels(undefined),
    refetchInterval: 4000,
  });
  useEffect(() => {
    if (data) setSnapshot(data);
  }, [data, setSnapshot]);
}

const STATUS_TONE: Record<ServedModelInfo["status"], string> = {
  running: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  starting: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  downloading: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  error: "bg-destructive/15 text-destructive",
  stopped: "bg-muted text-muted-foreground",
};

function StatusChip({ status }: { status: ServedModelInfo["status"] }) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
        STATUS_TONE[status],
      )}
    >
      {(status === "starting" || status === "downloading") && (
        <Loader2Icon className="size-3 animate-spin" />
      )}
      {status === "running" && <span className="size-1.5 rounded-full bg-emerald-500" />}
      {t(`server.status.${status}`)}
    </span>
  );
}

function formatUptime(startedAt: number | undefined): string {
  if (!startedAt) return "";
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

/** 端点 + 一键复制（外部工具要拿这个地址去连）。 */
function EndpointCopy({ endpoint }: { endpoint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用：忽略
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={endpoint}
      className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      <span className="truncate">{endpoint}</span>
      {copied ? (
        <CheckIcon className="size-3 shrink-0 text-emerald-500" />
      ) : (
        <CopyIcon className="size-3 shrink-0" />
      )}
    </button>
  );
}

/** 单个已启动模型：状态 / 端点 / 设为当前 / 重启 / 卸载。 */
function ServedModelRow({ model }: { model: ServedModelInfo }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["served-models"] });
    queryClient.invalidateQueries({ queryKey: ["chat-models"] });
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    queryClient.invalidateQueries({ queryKey: ["installed-models"] });
  };

  const activateMutation = useMutation({
    mutationFn: () => rpcClient.setActiveServedModel({ id: model.id }),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(String(e)),
  });
  const restartMutation = useMutation({
    mutationFn: () => rpcClient.restartServedModel({ id: model.id }),
    onSuccess: (res) => {
      setError(res.ok ? null : (res.error ?? t("console.restartFailed")));
      invalidate();
    },
    onError: (e: unknown) => setError(String(e)),
  });
  const unloadMutation = useMutation({
    mutationFn: () => rpcClient.stopServedModel({ id: model.id }),
    onSuccess: (res) => {
      if (!res.ok) setError(res.error ?? t("console.unloadFailed"));
      invalidate();
    },
    onError: (e: unknown) => setError(String(e)),
  });

  const busy =
    activateMutation.isPending || restartMutation.isPending || unloadMutation.isPending;
  const starting = model.status === "starting" || model.status === "downloading";
  const rawError = error ?? model.error;
  const hint = serverErrorHint(t, rawError);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {model.isDir && <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />}
        <span className="min-w-0 truncate text-sm font-medium">
          {model.servedName || model.label}
        </span>
        <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
          {ENGINE_SHORT_NAMES[model.engine]}
        </span>
        <StatusChip status={model.status} />
        {model.usesDefaultPort && (
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            {t("console.defaultPort")}
          </span>
        )}
        {model.isActive && (
          <Badge variant="default" className="gap-1 text-[10px]">
            <StarIcon className="size-3" /> {t("console.activeModel")}
          </Badge>
        )}
        {model.status === "running" && model.startedAt && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {t("console.uptime")} {formatUptime(model.startedAt)}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {!model.isActive && model.status === "running" && (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => activateMutation.mutate()}
            >
              <StarIcon data-icon="inline-start" />
              {t("console.setActive")}
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            tooltip={t("console.restart")}
            disabled={busy || starting}
            onClick={() => restartMutation.mutate()}
          >
            {restartMutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <RotateCcwIcon data-icon="inline-start" />
            )}
            {t("console.restart")}
          </Button>
          <Button
            variant="destructive"
            size="xs"
            tooltip={t("console.unload")}
            disabled={busy}
            onClick={() => unloadMutation.mutate()}
          >
            {unloadMutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SquareIcon data-icon="inline-start" />
            )}
            {t("console.unload")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <EndpointCopy endpoint={model.endpoint} />
        <span className="font-mono text-[11px] text-muted-foreground/70">{model.servedName}</span>
        {model.repo && (
          <span className="max-w-72 truncate text-[11px] text-muted-foreground/70">
            {model.repo}
          </span>
        )}
      </div>

      {rawError && (
        <div className="space-y-0.5">
          {hint && (
            <p className="flex items-start gap-1 text-[11px] text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{hint}</span>
            </p>
          )}
          <p className="flex items-start gap-1 text-[11px] text-destructive/70">
            <span className="mt-1.5 size-0.5 shrink-0 rounded-full bg-destructive/50" />
            <span className="min-w-0 break-words">{rawError}</span>
          </p>
        </div>
      )}
    </div>
  );
}

/** 启动入口：从已下载的模型里挑一个（引擎按格式自动选），后台启动。 */
function StartServedModelForm() {
  const t = useT();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const models = data?.models;

  // 只有对话类、且某个引擎能加载的模型能作为对话服务器启动；
  // 嵌入 / 语音 / 生图那些由各自的 App 面板管，不在这里混着列。
  const options = useMemo(
    () =>
      (models ?? []).filter((m) => {
        const category: ModelCategory = m.category ?? classifyModelName(m.fileName);
        const isChat =
          MODEL_CATEGORY_SETS.chat.includes(category) || category === "other";
        return isChat && (m.kind === "gguf" || m.kind === "safetensors");
      }),
    [models],
  );

  const startMutation = useMutation({
    mutationFn: () => rpcClient.startServedModel({ path }),
    onSuccess: (res) => {
      setError(res.ok ? null : (res.error ?? t("console.startFailed")));
      queryClient.invalidateQueries({ queryKey: ["served-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    },
    onError: (e: unknown) => setError(String(e)),
  });

  const errorHint = serverErrorHint(t, error);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">{t("console.pickModel")}</span>
          <Select value={path} onValueChange={setPath} disabled={startMutation.isPending}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue placeholder={t("console.pickModelEmpty")} />
            </SelectTrigger>
            <SelectContent className="w-[30rem] max-w-[min(30rem,90vw)]">
              {options.map((m) => (
                <SelectItem key={m.path} value={m.runtimeTarget || m.path}>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    {m.isDir && (
                      <FolderIcon className="size-3 shrink-0 text-muted-foreground/60" />
                    )}
                    <span className="truncate">{m.fileName}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
                    <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
                      {m.kind === "gguf" ? "GGUF" : "safetensors"}
                    </span>
                    <span className="max-w-44 truncate">{m.repo}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={!path || startMutation.isPending}
          onClick={() => startMutation.mutate()}
        >
          {startMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {t("console.start")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground/70">{t("console.startHint")}</p>
      {error && (
        <div className="space-y-0.5">
          {errorHint && (
            <p className="flex items-start gap-1 text-[11px] text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{errorHint}</span>
            </p>
          )}
          <p className="text-[11px] text-destructive/70">{error}</p>
        </div>
      )}
    </div>
  );
}

const ANSI_RENDER_LIMIT = 30_000;

/** 某个实例的日志（实时尾随：store 里的增量 + 首次拉全量）。 */
function ServedModelTerminal({ model }: { model: ServedModelInfo }) {
  const t = useT();
  const logs = useServedStore((s) => s.logs[model.id]) ?? "";
  const setLog = useServedStore((s) => s.setLog);
  const clearLog = useServedStore((s) => s.clearLog);

  useEffect(() => {
    if (logs) return;
    // store 里还没有这个实例的日志（刚打开页面 / 刚 reload）：拉一次全量。
    rpcClient.getServedModelLogs({ id: model.id }).then((res) => {
      if (res.logs) setLog(model.id, res.logs);
    });
  }, [model.id, logs, setLog]);

  const renderText = logs.length > ANSI_RENDER_LIMIT ? logs.slice(-ANSI_RENDER_LIMIT) : logs;
  const truncated = logs.length > ANSI_RENDER_LIMIT;
  const streaming = model.status === "starting" || model.status === "downloading";

  return (
    <Terminal
      output={logs}
      isStreaming={streaming}
      className="min-h-0 flex-1"
      onClear={() => {
        clearLog(model.id);
        rpcClient.clearServedModelLogs({ id: model.id });
      }}
    >
      <TerminalHeader>
        <TerminalTitle>{model.servedName || model.label}</TerminalTitle>
        <TerminalActions>
          <TerminalCopyButton />
          <TerminalClearButton />
        </TerminalActions>
      </TerminalHeader>
      <TerminalContent className="max-h-none min-h-40 flex-1">
        <pre className="wrap-break-word whitespace-pre-wrap">
          {truncated && <span className="text-zinc-600">{"… (earlier output trimmed)\n\n"}</span>}
          <Ansi>{renderText}</Ansi>
          {!logs && (
            <span className="text-zinc-500">{t("console.noLogs")}</span>
          )}
        </pre>
      </TerminalContent>
    </Terminal>
  );
}

/**
 * 已启动模型面板。
 * - `compact`（概览页）：只列状态行，不给启动表单，不挂日志窗口。
 * - 完整（控制台）：启动入口 + 列表 + 每个实例的日志。
 */
export function ServedModelsPanel({ compact = false }: { compact?: boolean }) {
  const t = useT();
  useServedModelsSync();
  const models = useServedStore((s) => s.models);

  if (models.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
          {t("console.empty")}
        </p>
        {!compact && <StartServedModelForm />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {models.map((model) => (
        <ServedModelRow key={model.id} model={model} />
      ))}
      {!compact && <StartServedModelForm />}
    </div>
  );
}

/** 控制台的日志区：选择实例 + 实时终端（每个实例一份日志）。 */
export function ServedModelLogs() {
  const t = useT();
  const models = useServedStore((s) => s.models);
  const activeId = useServedStore((s) => s.activeId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = models.find((m) => m.id === selectedId) ?? models.find((m) => m.id === activeId) ?? models[0];

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-6 text-xs text-muted-foreground">
        {t("console.noLogsHint")}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {models.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{t("console.logSource")}</span>
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger size="sm" className="h-7 min-w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.servedName || m.label}
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    :{m.port}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <ServedModelTerminal model={selected} />
    </div>
  );
}

/** 控制台头部的「停止全部」按钮。 */
export function StopAllServedButton() {
  const t = useT();
  const queryClient = useQueryClient();
  const models = useServedStore((s) => s.models);
  const mutation = useMutation({
    mutationFn: async () => {
      for (const model of models) {
        await rpcClient.stopServedModel({ id: model.id });
      }
      await rpcClient.stopServer();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["served-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={models.length === 0 || mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <Trash2Icon data-icon="inline-start" />
      )}
      {t("console.stopAll")}
    </Button>
  );
}
