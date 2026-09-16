import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  WaypointsIcon,
  CopyIcon,
  CheckIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PowerIcon,
  RefreshCwIcon,
  AlertTriangleIcon,
  KeyIcon,
  Trash2Icon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { formatRecordTime } from "@lib/format";
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
import { ScrollArea } from "@ui/scroll-area";
import { useServedModelsSync } from "@components/served-models-panel";
import { CopyButton } from "@components/copy-button";
import { PageShell } from "@components/setting-ui";
import { useGatewayStore } from "@stores/gateway";
import { useServedStore } from "@stores/served";
import { useT } from "@stores/ui-lang";
import type { ServedModelInfo } from "@/shared/served-models";
import { cn } from "@/mainview/lib/utils";
import { maskGatewayKey } from "@/shared/gateway-key";

const STATUS_CLS: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  starting: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  stopped: "bg-muted text-muted-foreground",
  error: "bg-destructive/10 text-destructive",
};

const KEY_BADGE_CLS = {
  enabled: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  disabled: "bg-muted text-muted-foreground",
} as const;

function EndpointRow({
  label,
  url,
  onCopy,
  disabled = false,
}: {
  label: ReactNode;
  url: string;
  onCopy: (text: string) => void;
  /** 禁用复制：嵌入实例未运行时这一行显示的是占位文案，不是可复制的地址。 */
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
      <span className="w-40 shrink-0 truncate text-[11px] text-muted-foreground">{label}</span>
      <code
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-[11px]",
          disabled && "text-muted-foreground/70",
        )}
      >
        {url}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        tooltip="Copy"
        className="shrink-0"
        disabled={disabled}
        onClick={() => {
          onCopy(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

type GatewayConfig = { enabled: boolean; port: string };

const DEFAULT_CONFIG: GatewayConfig = { enabled: true, port: "10000" };

/** 去掉首尾空白再比较，避免「没改却提示有修改」。 */
function isDirty(a: GatewayConfig, b: GatewayConfig): boolean {
  return a.enabled !== b.enabled || a.port.trim() !== b.port.trim();
}

/**
 * 网关：本地 OpenAI 兼容 API 服务的状态、开关、端点与文档入口。
 *
 * 交互约定（避免出现多套「保存 / 启动」）：
 * - 启停只有一个入口：右上角「启用网关」开关，切换后立即写设置并启动 / 停止；
 * - 端口进暂存区，由「保存并重启」落地；
 * - API Key **不走暂存区**：新建 / 停用 / 删除都在主进程立即落库（网关每个请求现读
 *   Key，不需要重启），密钥值默认掩码展示、按需显示或复制。
 */
export function GatewayScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const liveStatus = useGatewayStore((s) => s.status);

  // 嵌入实例快照：与「已启动模型」面板同一条同步链路（推送 + 4s 轮询兜底冷加载）。
  // 零新 RPC —— 直连地址需要的数据这里已经全有。
  useServedModelsSync();
  const servedModels = useServedStore((s) => s.models);

  const [staged, setStaged] = useState<GatewayConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState<GatewayConfig>(DEFAULT_CONFIG);

  // 密钥值默认掩码，只有用户点过「显示」的那几把才展示明文（按 id 记录）。
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [keyError, setKeyError] = useState("");
  const [confirmAction, setConfirmAction] = useState<{
    kind: "delete" | "disable";
    id: string;
    name: string;
  } | null>(null);

  const { data } = useQuery({
    queryKey: ["gateway-status"],
    queryFn: () => rpcClient.getGatewayStatus(),
    refetchInterval: 3000,
  });
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const { data: keysData } = useQuery({
    queryKey: ["gateway-keys"],
    queryFn: () => rpcClient.listGatewayKeys(undefined),
  });

  // 同步服务端配置：首次加载时采纳；正在编辑（有未保存修改）时不覆盖输入框。
  useEffect(() => {
    const settings = settingsData?.settings;
    if (!settings) return;
    const next: GatewayConfig = {
      enabled: (settings.GATEWAY_ENABLED ?? "1") !== "0",
      port: settings.GATEWAY_PORT ?? "10000",
    };
    setSaved(next);
    setStaged((prev) => (isDirty(prev, next) ? prev : next));
  }, [settingsData]);

  const dirty = isDirty(staged, saved);
  const patch = (partial: Partial<GatewayConfig>) => setStaged((prev) => ({ ...prev, ...partial }));

  const status = data?.status ?? liveStatus;
  const url = data?.url ?? `http://127.0.0.1:${staged.port}`;

  const keys = keysData?.keys ?? [];
  const enabledKeyCount = keys.filter((k) => k.enabled).length;

  /** 唯一的保存入口：写全部配置并重启网关。 */
  const saveMutation = useMutation({
    mutationFn: async () => {
      await rpcClient.updateSettings({
        settings: {
          GATEWAY_ENABLED: staged.enabled ? "1" : "0",
          GATEWAY_PORT: staged.port.trim() || "10000",
        },
      });
      const res = await rpcClient.restartGateway();
      if (!res.ok) throw new Error(res.error || "Failed to restart gateway");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["gateway-status"] });
      setSaved({ ...staged });
    },
  });

  /** 启停开关：切换后立即生效，不经过「保存」。 */
  const toggleMutation = useMutation({
    mutationFn: async (next: boolean) => {
      await rpcClient.updateSettings({ settings: { GATEWAY_ENABLED: next ? "1" : "0" } });
      if (next) await rpcClient.startGateway();
      else await rpcClient.stopGateway();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["gateway-status"] });
    },
  });

  /**
   * Key 列表的失效范围：列表本身 + settings（主进程把"最早启用的那把"镜像进
   * GATEWAY_API_KEY，/health、文档、CLI 示例、KB 接入页都读它）+ 隧道状态（没 Key
   * 时隧道必须下线，隧道页要跟着变）。
   */
  const invalidateKeys = () => {
    queryClient.invalidateQueries({ queryKey: ["gateway-keys"] });
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    queryClient.invalidateQueries({ queryKey: ["tunnel-status"] });
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => rpcClient.createGatewayKey({ name }),
    onSuccess: (res) => {
      if (!res.ok) {
        setKeyError(res.error ?? "");
        return;
      }
      setCreateOpen(false);
      setNewName("");
      setKeyError("");
      invalidateKeys();
    },
  });

  const toggleKeyMutation = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      rpcClient.setGatewayKeyEnabled({ id: vars.id, enabled: vars.enabled }),
    onSuccess: (res) => {
      setKeyError(res.ok ? "" : (res.error ?? ""));
      if (res.ok) invalidateKeys();
    },
  });

  const deleteKeyMutation = useMutation({
    mutationFn: (id: string) => rpcClient.deleteGatewayKey({ id }),
    onSuccess: (res) => {
      setKeyError(res.ok ? "" : (res.error ?? ""));
      if (res.ok) invalidateKeys();
    },
  });

  const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

  const endpoints: { labelKey: string; path: string }[] = [
    { labelKey: "settings.gateway.endpoints.docs", path: "/docs" },
    { labelKey: "settings.gateway.endpoints.models", path: "/v1/models" },
    { labelKey: "settings.gateway.endpoints.chat", path: "/v1/chat/completions" },
    { labelKey: "settings.gateway.endpoints.responses", path: "/v1/responses" },
    { labelKey: "settings.gateway.endpoints.messages", path: "/v1/messages" },
    { labelKey: "settings.gateway.endpoints.speech", path: "/v1/audio/speech" },
    { labelKey: "settings.gateway.endpoints.transcriptions", path: "/v1/audio/transcriptions" },
    { labelKey: "settings.gateway.endpoints.image", path: "/v1/images/generations" },
    { labelKey: "settings.gateway.endpoints.health", path: "/health" },
  ];

  const busy = toggleMutation.isPending || saveMutation.isPending;
  const keyBusy =
    createMutation.isPending || toggleKeyMutation.isPending || deleteKeyMutation.isPending;

  /**
   * 直连嵌入实例：取最后一个「运行中」的嵌入实例，与主进程 `getActiveEmbeddingPort()`
   * 同源（注册表按插入序迭代，最后一个 running 胜出）—— 所以这里是循环覆盖而不是
   * 找第一个命中。
   *
   * host 固定写 127.0.0.1，不用实例 `endpoint` 里的主机名 —— 它来自 SERVER_HOST，
   * 可能是 0.0.0.0，复制出去连不上。
   */
  let embeddingInstance: ServedModelInfo | undefined;
  for (const model of servedModels) {
    if (model.purpose === "embedding" && model.status === "running") embeddingInstance = model;
  }
  const embeddingUrl = embeddingInstance
    ? `http://127.0.0.1:${embeddingInstance.port}/v1/embeddings`
    : "";

  return (
    <ScrollArea className="h-full">
      <PageShell>
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <WaypointsIcon className="size-5" />
            {t("settings.gateway.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("settings.gateway.desc")}</p>
        </div>

        {/* 状态 + 启停开关 + 文档入口 */}
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium",
                STATUS_CLS[status],
              )}
            >
              {status === "running" || status === "starting" ? (
                <Loader2Icon className={cn("size-3", status === "starting" && "animate-spin")} />
              ) : (
                <PowerIcon className="size-3" />
              )}
              {t(`settings.gateway.status.${status}`)}
            </span>
            <code className="truncate font-mono text-xs text-muted-foreground">{url}</code>
            {data?.configuredPort && data.port !== data.configuredPort && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                {t("settings.gateway.portConflict")}
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={staged.enabled ? "default" : "outline"}
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => {
                  const next = !staged.enabled;
                  patch({ enabled: next });
                  setSaved((prev) => ({ ...prev, enabled: next }));
                  toggleMutation.mutate(next);
                }}
              >
                {toggleMutation.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="size-3 animate-spin" />
                ) : (
                  <PowerIcon data-icon="inline-start" className="size-3" />
                )}
                {t("settings.gateway.enabled")}：{staged.enabled ? t("common.on") : t("common.off")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={!url}
                onClick={() => rpcClient.openGatewayDocs({ url: `${url}/docs` })}
              >
                <ExternalLinkIcon className="size-3" />
                {t("settings.gateway.openDocs")}
              </Button>
            </div>
          </div>

          {data?.notice && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              {data.notice}
            </p>
          )}
          {data?.error && (
            <p className="flex items-start gap-1.5 text-[11px] text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              {data.error}
            </p>
          )}

          {/* 端口：进暂存区，由唯一的「保存并重启」落地 */}
          <div className="flex flex-wrap items-end gap-3 border-t pt-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="gateway-port" className="text-[11px] text-muted-foreground">
                {t("settings.gateway.port")}
              </Label>
              <Input
                id="gateway-port"
                type="number"
                value={staged.port}
                onChange={(e) => patch({ port: e.target.value })}
                className="h-8 w-32 font-mono text-xs"
              />
            </div>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={!dirty || busy}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" className="size-3" />
              )}
              {t("settings.gateway.restart")}
            </Button>
            <p className="text-[11px] text-muted-foreground/70">
              {dirty ? t("settings.gateway.dirtyHint") : t("settings.gateway.cleanHint")}
            </p>
          </div>
        </div>

        {/* API Key：多把 Key 各自启用 / 停用 / 删除，改动立即落库生效 */}
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <KeyIcon className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">{t("settings.gateway.keys.title")}</h3>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                enabledKeyCount > 0 ? KEY_BADGE_CLS.enabled : KEY_BADGE_CLS.disabled,
              )}
            >
              {enabledKeyCount > 0
                ? t("settings.gateway.keys.count", { n: String(enabledKeyCount) })
                : t("settings.gateway.keys.notSet")}
            </span>
            <Button
              size="sm"
              className="ml-auto h-7 text-xs"
              disabled={keyBusy}
              onClick={() => {
                setNewName("");
                setKeyError("");
                setCreateOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" className="size-3" />
              {t("settings.gateway.keys.new")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("settings.gateway.keys.desc")}</p>

          {keys.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.gateway.keys.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {keys.map((k) => (
                <div
                  key={k.id}
                  className={cn(
                    "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2",
                    !k.enabled && "opacity-60",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium">{k.name}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                          k.enabled ? KEY_BADGE_CLS.enabled : KEY_BADGE_CLS.disabled,
                        )}
                      >
                        {k.enabled
                          ? t("settings.gateway.keys.state.enabled")
                          : t("settings.gateway.keys.state.disabled")}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <code className="truncate font-mono text-[11px] text-muted-foreground">
                        {revealed[k.id] ? k.key : maskGatewayKey(k.key)}
                      </code>
                      <span className="text-[10px] text-muted-foreground/60">
                        {t("settings.gateway.keys.createdAt", {
                          time: formatRecordTime(k.createdAt),
                        })}
                      </span>
                    </div>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={
                        revealed[k.id]
                          ? t("settings.gateway.keys.hide")
                          : t("settings.gateway.keys.reveal")
                      }
                      tooltip={
                        revealed[k.id]
                          ? t("settings.gateway.keys.hide")
                          : t("settings.gateway.keys.reveal")
                      }
                      onClick={() =>
                        setRevealed((prev) => ({ ...prev, [k.id]: !prev[k.id] }))
                      }
                    >
                      {revealed[k.id] ? (
                        <EyeOffIcon className="size-3.5" />
                      ) : (
                        <EyeIcon className="size-3.5" />
                      )}
                    </Button>
                    <CopyButton
                      text={k.key}
                      iconOnly
                      size="icon-sm"
                      variant="ghost"
                      title={t("settings.gateway.keys.copy")}
                      className="text-muted-foreground hover:text-foreground"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[11px]"
                      disabled={keyBusy}
                      onClick={() => {
                        if (k.enabled && enabledKeyCount === 1) {
                          // 停用最后一把 = 网关回到"对本机进程开放访问"，先问一句。
                          setConfirmAction({ kind: "disable", id: k.id, name: k.name });
                          return;
                        }
                        toggleKeyMutation.mutate({ id: k.id, enabled: !k.enabled });
                      }}
                    >
                      {k.enabled
                        ? t("settings.gateway.keys.disable")
                        : t("settings.gateway.keys.enable")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("settings.gateway.keys.delete")}
                      tooltip={t("settings.gateway.keys.delete")}
                      className="text-muted-foreground hover:text-destructive"
                      disabled={keyBusy}
                      onClick={() => setConfirmAction({ kind: "delete", id: k.id, name: k.name })}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {keys.length > 0 && enabledKeyCount === 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              {t("settings.gateway.keys.noEnabled")}
            </p>
          )}
          {keyError && (
            <p className="flex items-start gap-1.5 text-[11px] text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              {keyError}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground/70">
            {t("settings.gateway.keys.hint")}
          </p>
        </div>

        {/* Endpoints */}
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <WaypointsIcon className="size-4 text-muted-foreground" />
            {t("settings.gateway.endpoints.title")}
          </h3>
          <div className="flex flex-col gap-1.5">
            <EndpointRow label={t("settings.gateway.endpoints.base")} url={url} onCopy={copy} />
            {endpoints.map((e) => (
              <EndpointRow key={e.path} label={t(e.labelKey)} url={`${url}${e.path}`} onCopy={copy} />
            ))}
          </div>

          {/*
            嵌入服务单独成块：上面每一行都以网关地址打头，而直连行指向的是本机推理
            实例（地址前缀不同），混在同一列表里容易被当成又一个网关端点。
          */}
          <div className="mt-3 flex flex-col gap-1.5 border-t pt-3">
            <EndpointRow
              label={t("settings.gateway.endpoints.embeddings")}
              url={`${url}/v1/embeddings`}
              onCopy={copy}
            />
            {/* 无实例时就地显示「未运行」并禁用复制（不隐藏该行 —— 空态本身要让用户看见） */}
            <EndpointRow
              label={t("settings.gateway.endpoints.embeddingsDirect")}
              url={embeddingUrl || t("settings.gateway.endpoints.embeddingsOffline")}
              onCopy={copy}
              disabled={!embeddingUrl}
            />
            <p className="text-[11px] text-muted-foreground/70">
              {t("settings.gateway.endpoints.embeddingsHint")}
            </p>
          </div>

          <p className="mt-2 text-[11px] text-muted-foreground/70">{t("settings.gateway.protocol.hint")}</p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">{t("settings.gateway.endpoints.hint")}</p>
        </div>

        {/* 新建密钥：名字必填，值由主进程生成并直接落库（不需要「保存并重启」） */}
        <Dialog
          open={createOpen}
          onOpenChange={(next) => {
            if (!next) setCreateOpen(false);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("settings.gateway.keys.dialogTitle")}</DialogTitle>
              <DialogDescription>{t("settings.gateway.keys.dialogDesc")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5 py-1">
              <Label htmlFor="gateway-key-name" className="text-xs">
                {t("settings.gateway.keys.name")}
              </Label>
              <Input
                id="gateway-key-name"
                value={newName}
                autoFocus
                maxLength={60}
                placeholder={t("settings.gateway.keys.namePlaceholder")}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim() && !createMutation.isPending) {
                    createMutation.mutate(newName);
                  }
                }}
              />
              {keyError && <p className="text-[11px] text-destructive">{keyError}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={!newName.trim() || createMutation.isPending}
                onClick={() => createMutation.mutate(newName)}
              >
                {createMutation.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="size-3 animate-spin" />
                ) : (
                  <PlusIcon data-icon="inline-start" className="size-3" />
                )}
                {t("settings.gateway.keys.save")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 删除 / 停用最后一把：共用同一个确认弹窗 */}
        <Dialog
          open={confirmAction !== null}
          onOpenChange={(next) => {
            if (!next) setConfirmAction(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {confirmAction?.kind === "delete"
                  ? t("settings.gateway.keys.deleteTitle")
                  : t("settings.gateway.keys.disableLastTitle")}
              </DialogTitle>
              <DialogDescription>
                {confirmAction?.kind === "delete"
                  ? t("settings.gateway.keys.deleteBody")
                  : t("settings.gateway.keys.disableLastBody")}{" "}
                <span className="font-medium text-foreground">「{confirmAction?.name}」</span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setConfirmAction(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant={confirmAction?.kind === "delete" ? "destructive" : "default"}
                size="sm"
                disabled={keyBusy}
                onClick={() => {
                  if (!confirmAction) return;
                  const { kind, id } = confirmAction;
                  setConfirmAction(null);
                  if (kind === "delete") deleteKeyMutation.mutate(id);
                  else toggleKeyMutation.mutate({ id, enabled: false });
                }}
              >
                {confirmAction?.kind === "delete" ? (
                  <Trash2Icon data-icon="inline-start" className="size-3.5" />
                ) : (
                  <PowerIcon data-icon="inline-start" className="size-3.5" />
                )}
                {confirmAction?.kind === "delete"
                  ? t("settings.gateway.keys.delete")
                  : t("settings.gateway.keys.disable")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PageShell>
    </ScrollArea>
  );
}
