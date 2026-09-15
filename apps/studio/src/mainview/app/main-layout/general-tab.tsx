import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleAlertIcon, GlobeIcon, LoaderIcon, NetworkIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { Spinner } from "@ui/spinner";
import { Switch } from "@ui/switch";
import { useT } from "@stores/ui-lang";
import {
  PROXY_MODES,
  maskProxyUrl,
  normalizeProxyUrl,
  proxyForUrl,
  type ProxyConfig,
  type ProxyMode,
} from "@/shared/proxy";
import { cn } from "@/mainview/lib/utils";
import { PageHeader, SettingsSection, SettingRow } from "./setting-ui";

/** 「谁走代理、谁直连」的采样地址：覆盖用户最关心的四类目标。 */
const SAMPLES: { key: string; url: string }[] = [
  { key: "settings.proxy.sample.models", url: "https://www.modelscope.cn/openapi/v1/models?page=1" },
  { key: "settings.proxy.sample.cloud", url: "https://api.openai.com/v1/models" },
  { key: "settings.proxy.sample.local", url: "http://127.0.0.1:8080/v1/models" },
  { key: "settings.proxy.sample.lan", url: "http://192.168.1.9:11434/v1/models" },
];

/**
 * 设置 → 偏好 → 通用：网络代理。
 *
 * 这张卡决定「出去的网络请求怎么走」：云端模型（对话 / 生图 / 语音 / OCR / 视频）、
 * 模型与引擎下载、联网检索、远端备份都按这里的设置走代理，回环地址（本地推理服务、
 * 网关、媒体服务）永远直连 —— 判定规则与主进程同一份（`shared/proxy.ts`），
 * 所以界面上的采样与真实行为不会说两套话。
 */
export function GeneralTab({
  form,
  updateField,
}: {
  form: Record<string, string>;
  updateField: (key: string, value: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<string | null>(null);

  const mode = (PROXY_MODES as readonly string[]).includes(form.PROXY_MODE ?? "")
    ? (form.PROXY_MODE as ProxyMode)
    : "system";
  const rawUrl = form.PROXY_URL ?? "";
  const allowLocalNetwork = (form.PROXY_ALLOW_LOCAL_NETWORK ?? "1") !== "0";
  const urlCheck = rawUrl.trim() ? normalizeProxyUrl(rawUrl) : null;
  const urlInvalid = mode === "custom" && !!urlCheck && !urlCheck.ok;

  const statusQuery = useQuery({
    queryKey: ["proxy-status"],
    queryFn: () => rpcClient.getProxyStatus(undefined),
    // 系统代理可能被别的程序改掉：进页面时取一次，之后手动刷新（保存 / 测试）即可。
    staleTime: 30_000,
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      rpcClient.updateSettings({
        settings: {
          PROXY_MODE: mode,
          PROXY_URL: rawUrl.trim(),
          PROXY_ALLOW_LOCAL_NETWORK: allowLocalNetwork ? "1" : "0",
        },
      }),
    onSuccess: () => {
      setTestResult(null);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["proxy-status"] });
    },
  });

  const testMutation = useMutation({
    // 带上表单里正在编辑的值：用户可以先填地址试通再保存。
    mutationFn: () =>
      rpcClient.testProxy({
        mode,
        url: rawUrl.trim(),
        allowLocalNetwork,
      }),
    onSuccess: (result) => {
      setTestResult(
        result.ok
          ? t("settings.proxy.testOk", {
              status: String(result.status ?? 200),
              ms: String(result.latencyMs ?? 0),
              host: result.target ?? "",
            })
          : t("settings.proxy.testFailed", { error: result.error ?? "" }),
      );
      queryClient.invalidateQueries({ queryKey: ["proxy-status"] });
    },
    onError: (error) => {
      setTestResult(t("settings.proxy.testFailed", { error: String(error) }));
    },
  });

  // 采样用「当前界面上的草稿」而不是已保存的值：换完就能看到谁走代理，不用先保存。
  const status = statusQuery.data;
  const draftConfig: ProxyConfig = {
    mode,
    url:
      mode === "custom"
        ? urlCheck?.ok
          ? urlCheck.url
          : ""
        : mode === "system"
          ? (status?.systemUrl ?? "")
          : "",
    allowLocalNetwork,
  };
  const effectiveLabel =
    mode === "none"
      ? t("settings.proxy.direct")
      : draftConfig.url
        ? maskProxyUrl(draftConfig.url)
        : t("settings.proxy.direct");

  const saveDisabled = saveMutation.isPending || urlInvalid || (mode === "custom" && !rawUrl.trim());

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("settings.general.title")} description={t("settings.general.desc")} />

      <SettingsSection title={t("settings.proxy.title")} description={t("settings.proxy.desc")}>
        <SettingRow title={t("settings.proxy.mode")} description={t("settings.proxy.modeDesc")}>
          <Select
            value={mode}
            onValueChange={(value) => {
              updateField("PROXY_MODE", value);
              setTestResult(null);
            }}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t("settings.proxy.mode.system")}</SelectItem>
              <SelectItem value="custom">{t("settings.proxy.mode.custom")}</SelectItem>
              <SelectItem value="none">{t("settings.proxy.mode.none")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {mode === "custom" && (
          <SettingRow title={t("settings.proxy.url")} description={t("settings.proxy.urlDesc")} stacked>
            <Input
              value={rawUrl}
              onChange={(e) => {
                updateField("PROXY_URL", e.target.value);
                setTestResult(null);
              }}
              placeholder="http://127.0.0.1:7890"
              spellCheck={false}
              className={cn("h-8 font-mono text-xs", urlInvalid && "border-destructive")}
            />
            {urlCheck && !urlCheck.ok && (
              <p className="flex items-start gap-1 text-[11px] text-destructive">
                <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
                {urlCheck.error}
              </p>
            )}
          </SettingRow>
        )}

        <SettingRow
          title={t("settings.proxy.allowLocalNetwork")}
          description={t("settings.proxy.allowLocalNetworkDesc")}
        >
          <Switch
            checked={allowLocalNetwork}
            onCheckedChange={(on) => updateField("PROXY_ALLOW_LOCAL_NETWORK", on ? "1" : "0")}
            aria-label={t("settings.proxy.allowLocalNetwork")}
          />
        </SettingRow>

        <SettingRow title={t("settings.proxy.current")} description={t("settings.proxy.currentDesc")}>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              {mode === "none" || !draftConfig.url ? (
                <NetworkIcon className="size-3.5" />
              ) : (
                <GlobeIcon className="size-3.5 text-primary" />
              )}
              {effectiveLabel}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={testMutation.isPending || saveDisabled}
              onClick={() => testMutation.mutate()}
            >
              {testMutation.isPending ? (
                <LoaderIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <GlobeIcon data-icon="inline-start" />
              )}
              {testMutation.isPending ? t("settings.proxy.testing") : t("settings.proxy.test")}
            </Button>
          </div>
        </SettingRow>

        {testResult && (
          <div className="border-b px-4 py-2 text-[11px] text-muted-foreground">{testResult}</div>
        )}

        {/* 采样：把「谁走代理、谁直连」摊开说清楚，省得用户对着日志猜。 */}
        <div className="flex flex-col gap-1 px-4 py-3">
          <Label className="text-[11px] font-normal text-muted-foreground">
            {t("settings.proxy.samples")}
          </Label>
          {SAMPLES.map((sample) => {
            const viaProxy = proxyForUrl(sample.url, draftConfig) != null;
            return (
              <div
                key={sample.key}
                data-slot="proxy-sample"
                data-via-proxy={viaProxy ? "true" : "false"}
                className="flex items-center gap-2 text-[11px]"
              >
                <span className="w-36 shrink-0 truncate text-muted-foreground">{t(sample.key)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/70">
                  {new URL(sample.url).host}
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    viaProxy
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {viaProxy ? t("settings.proxy.viaProxy") : t("settings.proxy.direct")}
                </span>
              </div>
            );
          })}
        </div>

        {mode === "system" && status?.pacUrl && !status.systemUrl && (
          <div className="border-b px-4 py-2 text-[11px] text-amber-600 dark:text-amber-500">
            {t("settings.proxy.pacHint")}
          </div>
        )}

        <div className="flex items-center gap-3 px-4 py-3">
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveDisabled}>
            {saveMutation.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : saveMutation.isSuccess ? (
              <CheckIcon data-icon="inline-start" />
            ) : null}
            {saveMutation.isSuccess ? t("common.saved") : t("common.save")}
          </Button>
          <p className="text-[11px] text-muted-foreground">{t("settings.proxy.hint")}</p>
        </div>
      </SettingsSection>

      <p className="text-[11px] text-muted-foreground">{t("settings.proxy.updateHint")}</p>
    </div>
  );
}
