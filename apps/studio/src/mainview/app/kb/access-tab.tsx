import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  LinkIcon,
  Loader2Icon,
  MessageCircleIcon,
  PlayIcon,
  PlugZapIcon,
  PowerIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { KbView } from "@/bun/knowledge";

/** 点击复制的行：图标 + 等宽文本 + 复制按钮（成功后打勾反馈）。 */
function CopyLine({ value, secret }: { value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5">
      <code className={cn("min-w-0 flex-1 truncate font-mono text-xs", secret && "blur-[3px] hover:blur-0 transition-all")}>
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={handleCopy}
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-emerald-500" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </Button>
    </div>
  );
}

/** 三种接入方式的卡片头（图标 muted，状态徽标用语义色）。 */
function ChannelCard({
  icon,
  title,
  ready,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  ready: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </span>
        <span className="text-xs font-semibold">{title}</span>
        <Badge
          variant="secondary"
          className={cn(
            "ml-auto h-5 px-1.5 text-[10px]",
            ready ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
          )}
        >
          {ready ? t("kb.access.ready") : t("kb.access.setup")}
        </Badge>
      </div>
      <div className="flex flex-col gap-2.5 text-[11px] leading-5 text-muted-foreground">{children}</div>
    </div>
  );
}

export function KbAccessTab({ kb }: { kb: KbView }) {
  const t = useT();
  const queryClient = useQueryClient();

  const gatewayQuery = useQuery({
    queryKey: ["gateway-status"],
    queryFn: () => rpcClient.getGatewayStatus(undefined),
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  const startMutation = useMutation({
    mutationFn: () => rpcClient.startGateway(undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["gateway-status"] }),
  });
  const stopMutation = useMutation({
    mutationFn: () => rpcClient.stopGateway(undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["gateway-status"] }),
  });
  const regenKeyMutation = useMutation({
    mutationFn: () => rpcClient.generateGatewayKey(undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const gw = gatewayQuery.data;
  const apiKey = settingsQuery.data?.settings?.GATEWAY_API_KEY ?? "";
  const running = gw?.status === "running";
  const mcpUrl = running && gw?.url ? `${gw.url.replace(/\/+$/, "")}/mcp` : "";

  const clientConfig = useMemo(() => {
    if (!mcpUrl) return "";
    return JSON.stringify(
      {
        mcpServers: {
          "omnistudio-kb": {
            type: "http",
            url: mcpUrl,
            ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
          },
        },
      },
      null,
      2,
    );
  }, [mcpUrl, apiKey]);

  const [configCopied, setConfigCopied] = useState(false);
  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(clientConfig);
      setConfigCopied(true);
      window.setTimeout(() => setConfigCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 py-3">
        {/* 三种接入方式 */}
        <div className="grid gap-3 md:grid-cols-3">
          <ChannelCard
            icon={<MessageCircleIcon className="size-4" />}
            title={t("kb.access.chat.title")}
            ready
          >
            <p>{t("kb.access.chat.desc")}</p>
          </ChannelCard>
          <ChannelCard
            icon={<BotIcon className="size-4" />}
            title={t("kb.access.agent.title")}
            ready
          >
            <p>{t("kb.access.agent.desc")}</p>
            <code className="self-start rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
              knowledge_search
            </code>
          </ChannelCard>
          <ChannelCard
            icon={<PlugZapIcon className="size-4" />}
            title={t("kb.access.mcp.title")}
            ready={running}
          >
            <p>{t("kb.access.mcp.desc")}</p>
          </ChannelCard>
        </div>

        {/* MCP 服务详情 */}
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold">
              <PlugZapIcon className="size-4 text-muted-foreground" />
              {t("kb.access.mcp.serviceTitle")}
            </span>
            <Badge
              variant="secondary"
              className={cn(
                "h-5 gap-1 px-1.5 text-[10px]",
                running ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
              )}
            >
              <span className={cn("size-1.5 rounded-full", running ? "bg-emerald-500" : "bg-muted-foreground/50")} />
              {running ? t("kb.access.mcp.running") : t("kb.access.mcp.stopped")}
            </Badge>
            <div className="ml-auto flex items-center gap-1.5">
              {running ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2.5 text-xs"
                  onClick={() => stopMutation.mutate()}
                  disabled={stopMutation.isPending}
                >
                  {stopMutation.isPending ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <PowerIcon className="size-3.5" />
                  )}
                  {t("kb.access.mcp.stop")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-7 gap-1.5 px-2.5 text-xs"
                  onClick={() => startMutation.mutate()}
                  disabled={startMutation.isPending}
                >
                  {startMutation.isPending ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <PlayIcon className="size-3.5" />
                  )}
                  {t("kb.access.mcp.start")}
                </Button>
              )}
            </div>
          </div>

          {!running && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
              {t("kb.access.mcp.offlineHint")}
            </p>
          )}

          {running && mcpUrl && (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                  <LinkIcon className="size-3.5 text-muted-foreground" />
                  {t("kb.access.mcp.endpoint")}
                </span>
                <CopyLine value={mcpUrl} />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                  <KeyRoundIcon className="size-3.5 text-muted-foreground" />
                  {t("kb.access.mcp.apiKey")}
                </span>
                {apiKey ? (
                  <CopyLine value={apiKey} secret />
                ) : (
                  <p className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                    <ShieldCheckIcon className="size-3.5 shrink-0" />
                    {t("kb.access.mcp.noKey")}
                  </p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit h-7 gap-1.5 px-2.5 text-xs"
                  onClick={() => regenKeyMutation.mutate()}
                  disabled={regenKeyMutation.isPending}
                >
                  {regenKeyMutation.isPending ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3.5" />
                  )}
                  {t("kb.access.mcp.regenKey")}
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-foreground">
                  {t("kb.access.mcp.configTitle")}
                </span>
                <div className="relative">
                  <pre className="max-h-56 overflow-auto rounded-lg border bg-muted/40 px-3 py-2.5 font-mono text-[11px] leading-5">
                    {clientConfig}
                  </pre>
                  <Button
                    variant="outline"
                    size="sm"
                    className="absolute top-2 right-2 h-6 gap-1 px-2 text-[10px]"
                    onClick={copyConfig}
                  >
                    {configCopied ? (
                      <CheckIcon className="size-3 text-emerald-500" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                    {configCopied ? t("common.copied") : t("common.copy")}
                  </Button>
                </div>
                <p className="text-[10px] leading-4 text-muted-foreground/80">
                  {t("kb.access.mcp.configHint")}
                </p>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-[10px] leading-4 text-muted-foreground/70">
          {t("kb.access.mcp.toolsHint", { name: kb.name })}
        </p>
      </div>
    </div>
  );
}
