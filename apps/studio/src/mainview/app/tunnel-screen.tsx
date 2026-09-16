import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckIcon,
  CloudIcon,
  DownloadIcon,
  ExternalLinkIcon,
  KeyIcon,
  Loader2Icon,
  PowerIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { ScrollArea } from "@ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { CopyButton } from "@components/copy-button";
import { PageHeader, PageShell, SettingRow, SettingsSection } from "@components/setting-ui";
import { useTunnelStore } from "@stores/tunnel";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

function StatusChip({ tone, children }: { tone: "ok" | "warn" | "muted" | "bad"; children: React.ReactNode }) {
  const cls = {
    ok: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    muted: "bg-muted text-muted-foreground",
    bad: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium", cls)}>
      {children}
    </span>
  );
}

type TunnelConfig = {
  enabled: boolean;
  mode: "quick" | "token";
  protocol: "auto" | "http2" | "quic";
  token: string;
  publicHost: string;
};

const DEFAULT_CONFIG: TunnelConfig = {
  enabled: false,
  mode: "quick",
  protocol: "auto",
  token: "",
  publicHost: "",
};

/** 去掉首尾空白再比较，避免「没改却提示有修改」。 */
function isDirty(a: TunnelConfig, b: TunnelConfig): boolean {
  return (
    a.enabled !== b.enabled ||
    a.mode !== b.mode ||
    a.protocol !== b.protocol ||
    a.token.trim() !== b.token.trim() ||
    a.publicHost.trim() !== b.publicHost.trim()
  );
}

/**
 * 远程访问：用 Cloudflare 隧道把本地网关暴露到公网。
 *
 * 交互与网关页保持一致：启停只有一个开关（立即生效），其余设置先进暂存区，
 * 由唯一的「保存并重启隧道」落地。
 *
 * 界面上刻意把三件事摆在最前面，因为它们最容易出问题：
 *   1. 公网地址（快速隧道每次启动都会变）；
 *   2. API Key（没有 Key 不允许开隧道，否则等于把模型和记忆库公开）；
 *   3. cloudflared 是否就绪（没装就一键下载，不让用户自己去 brew install）。
 */
export function TunnelScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const liveInfo = useTunnelStore((s) => s.info);
  const logs = useTunnelStore((s) => s.logs);
  const clearLogs = useTunnelStore((s) => s.clearLogs);

  const [staged, setStaged] = useState<TunnelConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState<TunnelConfig>(DEFAULT_CONFIG);

  const { data } = useQuery({
    queryKey: ["tunnel-status"],
    queryFn: () => rpcClient.getTunnelStatus(),
    refetchInterval: 3000,
  });
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  // 同步服务端配置：首次加载采纳；正在编辑（有未保存修改）时不覆盖输入框。
  useEffect(() => {
    const settings = settingsData?.settings;
    if (!settings) return;
    const next: TunnelConfig = {
      enabled: (settings.TUNNEL_ENABLED ?? "0") === "1",
      mode: settings.TUNNEL_MODE === "token" ? "token" : "quick",
      protocol:
        settings.TUNNEL_PROTOCOL === "http2" || settings.TUNNEL_PROTOCOL === "quic"
          ? settings.TUNNEL_PROTOCOL
          : "auto",
      token: settings.TUNNEL_TOKEN ?? "",
      publicHost: settings.TUNNEL_PUBLIC_HOST ?? "",
    };
    setSaved(next);
    setStaged((prev) => (isDirty(prev, next) ? prev : next));
  }, [settingsData]);

  const dirty = isDirty(staged, saved);
  const patch = (partial: Partial<TunnelConfig>) => setStaged((prev) => ({ ...prev, ...partial }));

  const info = data ?? liveInfo;
  const status = info?.status ?? "stopped";
  const url = info?.url ?? "";
  const installed = info?.binary.installed ?? false;
  const apiKeySet = info?.apiKeySet ?? false;
  const gatewayRunning = info?.gatewayRunning ?? false;
  const targetUrl = info?.targetUrl ?? `http://127.0.0.1:${info?.gatewayPort ?? 10000}`;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["tunnel-status"] });
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    queryClient.invalidateQueries({ queryKey: ["gateway-status"] });
  };

  /** 唯一的保存入口：写全部配置并重启隧道。 */
  const saveMutation = useMutation({
    mutationFn: async () => {
      await rpcClient.updateSettings({
        settings: {
          TUNNEL_MODE: staged.mode,
          TUNNEL_PROTOCOL: staged.protocol,
          TUNNEL_TOKEN: staged.token.trim(),
          TUNNEL_PUBLIC_HOST: staged.publicHost.trim(),
        },
      });
      const res = await rpcClient.restartTunnel();
      if (!res.ok) throw new Error(res.error || "Failed to restart tunnel");
    },
    onSuccess: () => {
      invalidate();
      setSaved({ ...staged });
    },
  });

  /** 启停开关：切换后立即生效，不经过「保存」。 */
  const toggleMutation = useMutation({
    mutationFn: async (next: boolean) => {
      await rpcClient.updateSettings({ settings: { TUNNEL_ENABLED: next ? "1" : "0" } });
      if (!next) {
        await rpcClient.stopTunnel();
        return;
      }
      const res = await rpcClient.startTunnel();
      if (!res.ok) throw new Error(res.error || "Failed to start tunnel");
    },
    onSettled: invalidate,
  });

  const installMutation = useMutation({
    mutationFn: async () => {
      clearLogs();
      const res = await rpcClient.installCloudflared();
      if (!res.ok) throw new Error(res.error || "Failed to install cloudflared");
    },
    onSettled: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const res = await rpcClient.removeCloudflared();
      if (!res.ok) throw new Error(res.error || "Failed to remove cloudflared");
    },
    onSettled: invalidate,
  });

  const generateKeyMutation = useMutation({
    mutationFn: async () => {
      // 新建一把网关 API Key（走 设置 → 网关 里同一份列表，可在那边停用 / 删除）。
      // 网关每个请求现读 Key，不需要重启；隧道那边由主进程在新建后自动重新对账
      // （"有 Key 才允许开启"）。
      const res = await rpcClient.createGatewayKey({
        name: t("settings.tunnel.security.keyName"),
      });
      if (!res.ok) throw new Error(res.error || "Failed to create API key");
    },
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["gateway-keys"] });
    },
  });

  const busy = toggleMutation.isPending || saveMutation.isPending;
  const showToken = staged.mode === "token";

  const curlExample = url
    ? `curl ${url}/v1/chat/completions \\\n  -H "Authorization: Bearer <你的 API Key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "<模型 ID>", "messages": [{"role": "user", "content": "hi"}]}'`
    : "";

  return (
    <ScrollArea className="h-full">
      <PageShell>
        <PageHeader title={t("settings.tunnel.title")} description={t("settings.tunnel.desc")} />

        {/* 状态 + 公网地址 + 启停 */}
        <SettingsSection
          title={t("settings.tunnel.status.title")}
          actions={
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
              {t("settings.tunnel.enabled")}：{staged.enabled ? t("common.on") : t("common.off")}
            </Button>
          }
        >
          <SettingRow title={t("settings.tunnel.publicUrl")} description={t("settings.tunnel.publicUrlDesc")}>
            <StatusChip tone={status === "running" ? "ok" : status === "starting" ? "warn" : status === "error" ? "bad" : "muted"}>
              {status === "running" || status === "starting" ? (
                <Loader2Icon className={cn("size-3", status === "starting" && "animate-spin")} />
              ) : (
                <CloudIcon className="size-3" />
              )}
              {t(`settings.tunnel.status.${status}`)}
            </StatusChip>
            {url ? (
              <>
                <code className="max-w-72 truncate font-mono text-[11px]">{url}</code>
                <CopyButton text={url} iconOnly title={t("common.copy")} className="size-7 shrink-0" />
                <Button
                  variant="outline"
                  size="icon-sm"
                  tooltip={t("settings.tunnel.open")}
                  className="shrink-0"
                  onClick={() => rpcClient.openGatewayDocs({ url: `${url}/docs` })}
                >
                  <ExternalLinkIcon className="size-3.5" />
                </Button>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground">{t("settings.tunnel.publicUrl.empty")}</span>
            )}
          </SettingRow>

          <SettingRow
            title={t("settings.tunnel.target")}
            description={
              status === "running"
                ? info?.connected
                  ? t("settings.tunnel.connected")
                  : t("settings.tunnel.connecting")
                : t("settings.tunnel.targetDesc")
            }
          >
            <code className="font-mono text-[11px] text-muted-foreground">{targetUrl}</code>
          </SettingRow>

          {info?.notice && (
            <div className="flex items-start gap-1.5 border-b px-4 py-3 text-[11px] text-amber-600 last:border-b-0 dark:text-amber-400">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              <span className="whitespace-pre-wrap">{info.notice}</span>
            </div>
          )}
          {info?.error && (
            <div className="flex items-start gap-1.5 border-b px-4 py-3 text-[11px] text-destructive last:border-b-0">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              <span className="whitespace-pre-wrap break-all">{info.error}</span>
            </div>
          )}
          {toggleMutation.error && (
            <div className="flex items-start gap-1.5 border-b px-4 py-3 text-[11px] text-destructive last:border-b-0">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              <span className="whitespace-pre-wrap break-all">
                {(toggleMutation.error as Error).message}
              </span>
            </div>
          )}
        </SettingsSection>

        {/* 安全：开隧道的前置条件，缺一项就开不起来 */}
        <SettingsSection title={t("settings.tunnel.security.title")} description={t("settings.tunnel.security.desc")}>
          <SettingRow
            title={
              <span className="flex items-center gap-1.5">
                <KeyIcon className="size-3.5 text-muted-foreground" />
                {t("settings.tunnel.security.apiKey")}
              </span>
            }
            description={apiKeySet ? t("settings.tunnel.security.apiKey.desc") : t("settings.tunnel.security.apiKey.missing")}
          >
            {apiKeySet ? (
              <StatusChip tone="ok">
                <ShieldCheckIcon className="size-3" />
                {t("settings.tunnel.security.apiKey.set")}
              </StatusChip>
            ) : (
              <Button
                variant="default"
                size="sm"
                className="h-7 text-xs"
                disabled={generateKeyMutation.isPending}
                onClick={() => generateKeyMutation.mutate()}
              >
                {generateKeyMutation.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="size-3 animate-spin" />
                ) : (
                  <SparklesIcon data-icon="inline-start" className="size-3" />
                )}
                {t("settings.tunnel.security.generate")}
              </Button>
            )}
          </SettingRow>

          <SettingRow title={t("settings.tunnel.security.gateway")} description={t("settings.tunnel.security.gatewayDesc")}>
            <StatusChip tone={gatewayRunning ? "ok" : "warn"}>
              {gatewayRunning ? <CheckIcon className="size-3" /> : <AlertTriangleIcon className="size-3" />}
              {gatewayRunning
                ? t("settings.tunnel.security.gateway.running")
                : t("settings.tunnel.security.gateway.stopped")}
            </StatusChip>
          </SettingRow>
        </SettingsSection>

        {/* 隧道设置：暂存 + 唯一保存入口 */}
        <SettingsSection title={t("settings.tunnel.config.title")}>
          <SettingRow title={t("settings.tunnel.config.mode")} description={t("settings.tunnel.config.modeDesc")}>
            <Select
              value={staged.mode}
              onValueChange={(value) => patch({ mode: value === "token" ? "token" : "quick" })}
            >
              <SelectTrigger className="h-8 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quick">{t("settings.tunnel.config.mode.quick")}</SelectItem>
                <SelectItem value="token">{t("settings.tunnel.config.mode.token")}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            title={t("settings.tunnel.config.protocol")}
            description={t("settings.tunnel.config.protocolDesc")}
          >
            <Select
              value={staged.protocol}
              onValueChange={(value) =>
                patch({ protocol: value === "http2" ? "http2" : value === "quic" ? "quic" : "auto" })
              }
            >
              <SelectTrigger className="h-8 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("settings.tunnel.config.protocol.auto")}</SelectItem>
                <SelectItem value="http2">{t("settings.tunnel.config.protocol.http2")}</SelectItem>
                <SelectItem value="quic">{t("settings.tunnel.config.protocol.quic")}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          {showToken && (
            <>
              <SettingRow title={t("settings.tunnel.config.token")} description={t("settings.tunnel.config.tokenDesc")} stacked>
                <Input
                  type="password"
                  value={staged.token}
                  onChange={(e) => patch({ token: e.target.value })}
                  placeholder={t("settings.tunnel.config.token.placeholder")}
                  className="h-8 font-mono text-xs"
                  spellCheck={false}
                />
              </SettingRow>
              <SettingRow
                title={t("settings.tunnel.config.publicHost")}
                description={t("settings.tunnel.config.publicHostDesc")}
                stacked
              >
                <Input
                  value={staged.publicHost}
                  onChange={(e) => patch({ publicHost: e.target.value })}
                  placeholder={t("settings.tunnel.config.publicHost.placeholder")}
                  className="h-8 font-mono text-xs"
                  spellCheck={false}
                />
              </SettingRow>
            </>
          )}

          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
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
              {t("settings.tunnel.save")}
            </Button>
            <p className="text-[11px] text-muted-foreground/70">
              {dirty ? t("settings.tunnel.dirtyHint") : t("settings.tunnel.cleanHint")}
            </p>
          </div>

          <p className="border-t px-4 py-3 text-[11px] text-muted-foreground/70">
            {showToken ? t("settings.tunnel.config.tokenHint") : t("settings.tunnel.config.quickHint")}
          </p>
        </SettingsSection>

        {/* cloudflared：应用自己下载，用户不需要预装 */}
        <SettingsSection
          title={t("settings.tunnel.binary.title")}
          description={t("settings.tunnel.binary.desc")}
          actions={
            installed ? (
              <div className="flex items-center gap-2">
                <StatusChip tone="ok">
                  <CheckIcon className="size-3" />
                  {info?.binary.source === "path"
                    ? t("settings.tunnel.binary.system")
                    : t("settings.tunnel.binary.managed")}
                </StatusChip>
                {info?.binary.source === "managed" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    disabled={removeMutation.isPending}
                    onClick={() => removeMutation.mutate()}
                  >
                    <Trash2Icon className="size-3" />
                    {t("settings.tunnel.binary.remove")}
                  </Button>
                )}
              </div>
            ) : (
              <Button
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={installMutation.isPending}
                onClick={() => installMutation.mutate()}
              >
                {installMutation.isPending ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3" />
                )}
                {installMutation.isPending
                  ? t("settings.tunnel.binary.downloading")
                  : t("settings.tunnel.binary.download")}
              </Button>
            )
          }
        >
          <SettingRow title={t("settings.tunnel.binary.state")} description={installed ? info?.binary.path : t("settings.tunnel.binary.missingDesc")} stacked>
            {installed ? (
              <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <code className="max-w-full break-all font-mono">{info?.binary.path}</code>
                {info?.binary.version && (
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono">v{info.binary.version}</span>
                )}
              </span>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {installMutation.error ? (installMutation.error as Error).message : t("settings.tunnel.binary.missing")}
              </p>
            )}
          </SettingRow>

          {logs.length > 0 && (
            <div className="border-t px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{t("settings.tunnel.binary.logs")}</span>
                <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={clearLogs}>
                  {t("settings.tunnel.binary.clearLogs")}
                </Button>
              </div>
              <pre className="max-h-48 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {logs.join("")}
              </pre>
            </div>
          )}
        </SettingsSection>

        {/* 远程怎么用：直接给可复制的调用示例 */}
        <SettingsSection title={t("settings.tunnel.usage.title")} description={t("settings.tunnel.usage.desc")}>
          <SettingRow title={t("settings.tunnel.usage.curl")} stacked>
            {url ? (
              <>
                <pre className="overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                  {curlExample}
                </pre>
                <div className="flex items-center gap-2">
                  <CopyButton text={curlExample} size="sm" className="h-7 text-xs" />
                  <span className="text-[11px] text-muted-foreground/70">{t("settings.tunnel.usage.keyHint")}</span>
                </div>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">{t("settings.tunnel.usage.empty")}</p>
            )}
          </SettingRow>
          <p className="px-4 py-3 text-[11px] text-muted-foreground/70">{t("settings.tunnel.usage.mcpHint")}</p>
        </SettingsSection>
      </PageShell>
    </ScrollArea>
  );
}
