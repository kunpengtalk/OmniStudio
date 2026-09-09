import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  XCircleIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  GlobeIcon,
  MonitorIcon,
  PlusIcon,
  Building2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Spinner } from "@ui/spinner";

import { REMOTE_PROVIDERS } from "./constants";
import { SetupHeader, ModeCard, SummaryRow } from "./shared";

type RemoteStep = "provider" | "credentials" | "test";

const CUSTOM_ID = "custom";

export function RemoteFlow({
  onComplete,
  onSwitchToLocal,
}: {
  onComplete: () => void;
  onSwitchToLocal: () => void;
}) {
  const [step, setStep] = useState<RemoteStep>("provider");
  // 选中的服务商 id：默认第一个国内服务商，仍可一键自定义。
  const [providerId, setProviderId] = useState<string>(REMOTE_PROVIDERS[0]!.id);
  const [baseUrl, setBaseUrl] = useState(REMOTE_PROVIDERS[0]!.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const provider = REMOTE_PROVIDERS.find((p) => p.id === providerId);
  const isCustom = providerId === CUSTOM_ID;

  const pickProvider = (id: string) => {
    const chosen = REMOTE_PROVIDERS.find((p) => p.id === id);
    setProviderId(id);
    setBaseUrl(chosen?.baseUrl ?? "");
    // 只在用户还没填模型名时预填该服务商的第一个常见模型。
    if (chosen && chosen.models[0] && !modelName.trim()) {
      setModelName(chosen.models[0]);
    }
  };

  const testConnection = useMutation({
    mutationFn: () => rpcClient.checkConnection({ baseUrl, apiKey: apiKey || "EMPTY" }),
  });

  const saveSettings = useMutation({
    mutationFn: async () => {
      const settings: Record<string, string> = {
        SERVER_MODE: "remote",
        VLLM_API_BASE: baseUrl,
        VLLM_API_KEY: apiKey || "EMPTY",
        VLLM_MODEL_NAME: modelName,
        VLLM_MODEL_PROFILE: "none",
      };
      return rpcClient.updateSettings({ settings });
    },
    onSuccess: () => onComplete(),
  });

  const canProceedToCredentials = isCustom ? baseUrl.trim().length > 0 : true;
  const canProceedToTest = baseUrl.trim().length > 0 && modelName.trim().length > 0;
  const steps: RemoteStep[] = ["provider", "credentials", "test"];

  return (
    <>
      <SetupHeader
        title={
          step === "provider"
            ? "选择服务商"
            : step === "credentials"
              ? "填写 API Key"
              : "测试连接"
        }
        subtitle={
          step === "provider"
            ? "选择服务商后只需填入 API Key；自定义需手动填写 URL。"
            : step === "credentials"
              ? "填入服务商的 API Key（在服务商控制台获取）。"
              : "验证服务器是否可达。"
        }
        steps={steps}
        currentStep={step}
      />

      {step === "provider" && (
        <div className="flex flex-col gap-3">
          {/* 顶部仍是 Local / URL 的模式切换，保持入口一致 */}
          <div className="grid grid-cols-2 gap-2">
            <ModeCard
              icon={<MonitorIcon className="size-4" />}
              label="Local"
              description="Run llama-server locally"
              selected={false}
              onClick={onSwitchToLocal}
            />
            <ModeCard
              icon={<GlobeIcon className="size-4" />}
              label="URL"
              description="Connect to an API"
              selected
              onClick={() => {}}
            />
          </div>

          <div className="grid max-h-[42vh] grid-cols-1 gap-2 overflow-y-auto pr-1">
            {REMOTE_PROVIDERS.map((p) => {
              const selected = providerId === p.id;
              const isCustomOpt = p.id === CUSTOM_ID;
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-muted-foreground/40"
                  }`}
                  onClick={() => pickProvider(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") pickProvider(p.id);
                  }}
                >
                  <div
                    className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${
                      selected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isCustomOpt ? (
                      <PlusIcon className="size-4" />
                    ) : (
                      <Building2Icon className="size-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p.label}</span>
                      {p.vendor && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {p.vendor}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
                      {isCustomOpt ? "手动填写完整 Base URL" : p.baseUrl}
                    </p>
                    {p.note && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground/70">{p.note}</p>
                    )}
                  </div>
                  {selected && <CheckCircle2Icon className="mt-1 size-4 shrink-0 text-primary" />}
                </div>
              );
            })}
          </div>

          <Button disabled={!canProceedToCredentials} onClick={() => setStep("credentials")}>
            下一步：填入 API Key
            <ArrowRightIcon />
          </Button>
          <Button variant="ghost" size="sm" className="self-center" onClick={onComplete}>
            跳过 — 直接进入应用
          </Button>
        </div>
      )}

      {step === "credentials" && (
        <div className="flex flex-col gap-3">
          {/* Base URL：只有自定义才需要手动输入 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider" className="text-xs">
              服务商
            </Label>
            <Select
              value={providerId}
              onValueChange={(v) => pickProvider(v)}
            >
              <SelectTrigger id="provider" className="h-8 w-full text-sm">
                <SelectValue placeholder="选择服务商" />
              </SelectTrigger>
              <SelectContent>
                {REMOTE_PROVIDERS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isCustom && (
              <p className="text-[11px] text-muted-foreground">
                已自动填入 {provider?.label} 的接口地址，可直接填写 Key。
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="apiKey" className="text-xs">
              API Key
            </Label>
            <Input
              id="apiKey"
              type="password"
              placeholder={isCustom ? "服务商的 API Key（可选）" : "粘贴你的 API Key"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="baseUrl" className="text-xs">
              Base URL
              {!isCustom && (
                <span className="ml-1 font-normal text-muted-foreground">（自动带出，不可修改）</span>
              )}
            </Label>
            {isCustom ? (
              <Input
                id="baseUrl"
                placeholder="http://your-server/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="h-8 text-sm font-mono"
              />
            ) : (
              <div
                className="flex h-8 items-center rounded-md border bg-muted/40 px-3 font-mono text-sm text-muted-foreground"
                title={baseUrl}
              >
                <span className="truncate">{baseUrl}</span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="modelName" className="text-xs">
              Model Name
            </Label>
            {!isCustom && provider!.models.length > 0 ? (
              <Select value={modelName} onValueChange={setModelName}>
                <SelectTrigger id="modelName" className="h-8 w-full text-sm">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {provider!.models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="modelName"
                placeholder="e.g. deepseek-chat"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                className="h-8 text-sm"
              />
            )}
            {isCustom && (
              <p className="text-[11px] text-muted-foreground">
                直接输入模型 ID，下拉选项适用于预置服务商。
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep("provider")}>
              <ArrowLeftIcon data-icon="inline-start" />
              上一步
            </Button>
            <Button className="flex-1" size="sm" disabled={!canProceedToTest} onClick={() => setStep("test")}>
              下一步：测试连接
              <ArrowRightIcon />
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="self-center" onClick={onComplete}>
            跳过 — 直接进入应用
          </Button>
        </div>
      )}

      {step === "test" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5 rounded-md bg-muted/50 px-3 py-2.5">
            <SummaryRow label="服务商" value={provider?.label ?? "自定义"} />
            <SummaryRow label="URL" value={baseUrl} />
            <SummaryRow label="Model" value={modelName} />
            <SummaryRow label="API Key" value={apiKey ? "••••••••" : "None"} />
          </div>

          {testConnection.isSuccess && (
            <div
              className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ${
                testConnection.data?.connected
                  ? "bg-primary/10 text-primary"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {testConnection.data?.connected ? (
                <>
                  <CheckCircle2Icon className="size-3.5 shrink-0" />
                  连接成功
                </>
              ) : (
                <>
                  <XCircleIcon className="size-3.5 shrink-0" />
                  连接失败 — 请检查 URL、Key 与服务商状态
                </>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep("credentials")}>
              <ArrowLeftIcon data-icon="inline-start" />
              上一步
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => testConnection.mutate()}
              disabled={testConnection.isPending}
            >
              {testConnection.isPending ? <Spinner data-icon="inline-start" /> : null}
              测试连接
            </Button>
          </div>

          <Button
            size="sm"
            onClick={() => saveSettings.mutate()}
            disabled={
              saveSettings.isPending || !testConnection.isSuccess || !testConnection.data?.connected
            }
          >
            {saveSettings.isPending && <Spinner data-icon="inline-start" />}
            开始使用
          </Button>
          <Button variant="ghost" size="sm" className="self-center" onClick={onComplete}>
            跳过 — 直接进入应用
          </Button>
        </div>
      )}
    </>
  );
}
