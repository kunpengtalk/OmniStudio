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
  SparklesIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { ScrollArea } from "@ui/scroll-area";
import { useGatewayStore } from "@stores/gateway";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

const STATUS_CLS: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  starting: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  stopped: "bg-muted text-muted-foreground",
  error: "bg-destructive/10 text-destructive",
};

function EndpointRow({
  label,
  url,
  onCopy,
}: {
  label: ReactNode;
  url: string;
  onCopy: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
      <span className="w-40 shrink-0 truncate text-[11px] text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{url}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        tooltip="Copy"
        className="shrink-0"
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

/** 生成本地网关的 API Key（osk- 前缀 + 随机串），只写暂存区，保存后才生效。 */
function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
  return `osk-${raw.slice(0, 32)}`;
}

type GatewayConfig = { enabled: boolean; port: string; apiKey: string };

const DEFAULT_CONFIG: GatewayConfig = { enabled: true, port: "10000", apiKey: "" };

/** 去掉首尾空白再比较，避免「没改却提示有修改」。 */
function isDirty(a: GatewayConfig, b: GatewayConfig): boolean {
  return (
    a.enabled !== b.enabled || a.port.trim() !== b.port.trim() || a.apiKey.trim() !== b.apiKey.trim()
  );
}

/**
 * 网关：本地 OpenAI 兼容 API 服务的状态、开关、端点与文档入口。
 *
 * 交互约定（避免出现多套「保存 / 启动」）：
 * - 启停只有一个入口：右上角「启用网关」开关，切换后立即写设置并启动 / 停止；
 * - 端口、API Key（含「生成」「清除」）一律先进暂存区，不直接落库；
 * - 落地只有一个按钮：「保存并重启」，且只有出现未保存修改时才可点。
 */
export function GatewayScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const liveStatus = useGatewayStore((s) => s.status);

  const [staged, setStaged] = useState<GatewayConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState<GatewayConfig>(DEFAULT_CONFIG);

  const { data } = useQuery({
    queryKey: ["gateway-status"],
    queryFn: () => rpcClient.getGatewayStatus(),
    refetchInterval: 3000,
  });
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  // 同步服务端配置：首次加载时采纳；正在编辑（有未保存修改）时不覆盖输入框。
  useEffect(() => {
    const settings = settingsData?.settings;
    if (!settings) return;
    const next: GatewayConfig = {
      enabled: (settings.GATEWAY_ENABLED ?? "1") !== "0",
      port: settings.GATEWAY_PORT ?? "10000",
      apiKey: settings.GATEWAY_API_KEY ?? "",
    };
    setSaved(next);
    setStaged((prev) => (isDirty(prev, next) ? prev : next));
  }, [settingsData]);

  const dirty = isDirty(staged, saved);
  const patch = (partial: Partial<GatewayConfig>) => setStaged((prev) => ({ ...prev, ...partial }));

  const status = data?.status ?? liveStatus;
  const url = data?.url ?? `http://127.0.0.1:${staged.port}`;

  /** 唯一的保存入口：写全部配置并重启网关。 */
  const saveMutation = useMutation({
    mutationFn: async () => {
      await rpcClient.updateSettings({
        settings: {
          GATEWAY_ENABLED: staged.enabled ? "1" : "0",
          GATEWAY_PORT: staged.port.trim() || "10000",
          GATEWAY_API_KEY: staged.apiKey.trim(),
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

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 pb-30 pt-2">
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

        {/* API Key：生成 / 清除只改暂存区，与手输一致，统一由「保存并重启」生效 */}
        <div className="flex flex-col gap-2 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <KeyIcon className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">{t("settings.gateway.apiKey.title")}</h3>
            {saved.apiKey ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                {t("settings.gateway.apiKey.enabled")}
              </span>
            ) : (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                {t("settings.gateway.apiKey.placeholder")}
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">{t("settings.gateway.apiKey.desc")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={staged.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
              placeholder={t("settings.gateway.apiKey.placeholder")}
              className="h-8 min-w-52 flex-1 font-mono text-xs"
              spellCheck={false}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => patch({ apiKey: generateApiKey() })}
            >
              <SparklesIcon data-icon="inline-start" className="size-3" />
              {t("settings.gateway.apiKey.generate")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={!staged.apiKey}
              onClick={() => patch({ apiKey: "" })}
            >
              <Trash2Icon data-icon="inline-start" className="size-3" />
              {t("settings.gateway.apiKey.clear")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground/70">
            {dirty ? t("settings.gateway.apiKey.dirtyHint") : t("settings.gateway.apiKey.hint")}
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
          <p className="mt-2 text-[11px] text-muted-foreground/70">{t("settings.gateway.protocol.hint")}</p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">{t("settings.gateway.endpoints.hint")}</p>
        </div>
      </div>
    </ScrollArea>
  );
}
