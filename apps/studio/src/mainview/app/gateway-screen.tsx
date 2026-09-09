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

/** 网关：本地 OpenAI 兼容 API 服务的状态、开关、端点与文档入口。 */
export function GatewayScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const liveStatus = useGatewayStore((s) => s.status);
  const [enabled, setEnabled] = useState(true);
  const [port, setPort] = useState("10000");

  const { data } = useQuery({
    queryKey: ["gateway-status"],
    queryFn: () => rpcClient.getGatewayStatus(),
    refetchInterval: 3000,
  });
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  useEffect(() => {
    if (settingsData?.settings) {
      setEnabled((settingsData.settings.GATEWAY_ENABLED ?? "1") !== "0");
      setPort(settingsData.settings.GATEWAY_PORT ?? "10000");
    }
  }, [settingsData]);

  const status = data?.status ?? liveStatus;
  const url = data?.url ?? `http://127.0.0.1:${port}`;

  const saveRestartMutation = useMutation({
    mutationFn: () =>
      rpcClient.updateSettings({
        settings: {
          GATEWAY_ENABLED: enabled ? "1" : "0",
          GATEWAY_PORT: port.trim() || "10000",
        },
      }),
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      const res = await rpcClient.restartGateway();
      if (!res.ok) {
        throw new Error(res.error || "Failed to restart gateway");
      }
      queryClient.invalidateQueries({ queryKey: ["gateway-status"] });
    },
  });

  const startMutation = useMutation({
    mutationFn: () => rpcClient.startGateway(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["gateway-status"] }),
  });
  const stopMutation = useMutation({
    mutationFn: () => rpcClient.stopGateway(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["gateway-status"] }),
  });

  const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

  const endpoints: { labelKey: string; path: string }[] = [
    { labelKey: "settings.gateway.endpoints.docs", path: "/docs" },
    { labelKey: "settings.gateway.endpoints.models", path: "/v1/models" },
    { labelKey: "settings.gateway.endpoints.chat", path: "/v1/chat/completions" },
    { labelKey: "settings.gateway.endpoints.speech", path: "/v1/audio/speech" },
    { labelKey: "settings.gateway.endpoints.transcriptions", path: "/v1/audio/transcriptions" },
    { labelKey: "settings.gateway.endpoints.image", path: "/v1/images/generations" },
    { labelKey: "settings.gateway.endpoints.health", path: "/health" },
  ];

  const busy = startMutation.isPending || stopMutation.isPending || saveRestartMutation.isPending;

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

        {/* Status */}
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
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={busy || status === "running" || status === "starting"}
                onClick={() => startMutation.mutate()}
              >
                <PowerIcon data-icon="inline-start" className="size-3" />
                {t("settings.gateway.start")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={busy || status === "stopped"}
                onClick={() => stopMutation.mutate()}
              >
                {t("settings.gateway.stop")}
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

          {/* Settings: enable + port */}
          <div className="flex flex-wrap items-end gap-3 border-t pt-3">
            <Button
              type="button"
              size="sm"
              variant={enabled ? "default" : "outline"}
              className="h-8 text-xs"
              onClick={() => setEnabled((v) => !v)}
            >
              <PowerIcon data-icon="inline-start" className="size-3" />
              {t("settings.gateway.enabled")}：{enabled ? t("common.on") : t("common.off")}
            </Button>
            <div className="flex flex-col gap-1">
              <Label htmlFor="gateway-port" className="text-[11px] text-muted-foreground">
                {t("settings.gateway.port")}
              </Label>
              <Input
                id="gateway-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="h-8 w-32 font-mono text-xs"
              />
            </div>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={busy}
              onClick={() => saveRestartMutation.mutate()}
            >
              {saveRestartMutation.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" className="size-3" />
              )}
              {t("settings.gateway.restart")}
            </Button>
            <p className="text-[11px] text-muted-foreground/70">{t("settings.gateway.restartHint")}</p>
          </div>
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
          <p className="mt-2 text-[11px] text-muted-foreground/70">{t("settings.gateway.endpoints.hint")}</p>
        </div>
      </div>
    </ScrollArea>
  );
}
