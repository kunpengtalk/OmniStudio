import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  XCircleIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  GlobeIcon,
  MonitorIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Spinner } from "@ui/spinner";

import { REMOTE_PROFILES } from "./constants";
import { SetupHeader, ModeCard, SummaryRow } from "./shared";

type RemoteStep = "credentials" | "test";

export function RemoteFlow({
  onComplete,
  onSwitchToLocal,
}: {
  onComplete: () => void;
  onSwitchToLocal: () => void;
}) {
  const [step, setStep] = useState<RemoteStep>("credentials");
  const [baseUrl, setBaseUrl] = useState("http://localhost:8080/v1");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [profileId, setProfileId] = useState("none");

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
        VLLM_MODEL_PROFILE: profileId,
      };
      return rpcClient.updateSettings({ settings });
    },
    onSuccess: () => onComplete(),
  });

  const canProceed = baseUrl.length > 0 && modelName.trim().length > 0;
  const steps: RemoteStep[] = ["credentials", "test"];

  return (
    <>
      <SetupHeader
        title={step === "credentials" ? "URL mode" : "Test connection"}
        subtitle={
          step === "credentials"
            ? "Connect to an OpenAI-compatible API."
            : "Verify that the server is reachable."
        }
        steps={steps}
        currentStep={step}
      />

      {step === "credentials" && (
        <div className="flex flex-col gap-3">
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="baseUrl" className="text-xs">
              Base URL
            </Label>
            <Input
              id="baseUrl"
              placeholder="http://localhost:8080/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="apiKey" className="text-xs">
              API Key <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="apiKey"
              placeholder="Leave empty if not required"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="modelName" className="text-xs">
              Model Name
            </Label>
            <Input
              id="modelName"
              placeholder="e.g. gpt-4o"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profileId" className="text-xs">
              Parsing Profile
            </Label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger id="profileId" className="h-8 w-full text-sm">
                <SelectValue placeholder="Select parsing profile" />
              </SelectTrigger>
              <SelectContent>
                {REMOTE_PROFILES.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button disabled={!canProceed} onClick={() => setStep("test")}>
            Next
            <ArrowRightIcon />
          </Button>
        </div>
      )}

      {step === "test" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5 rounded-md bg-muted/50 px-3 py-2.5">
            <SummaryRow label="URL" value={baseUrl} />
            <SummaryRow label="Model" value={modelName} />
            <SummaryRow
              label="Profile"
              value={REMOTE_PROFILES.find((p) => p.id === profileId)?.label ?? profileId}
            />
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
                  Connected successfully
                </>
              ) : (
                <>
                  <XCircleIcon className="size-3.5 shrink-0" />
                  Connection failed — check URL and server status
                </>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep("credentials")}>
              <ArrowLeftIcon data-icon="inline-start" />
              Back
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => testConnection.mutate()}
              disabled={testConnection.isPending}
            >
              {testConnection.isPending ? <Spinner data-icon="inline-start" /> : null}
              Test Connection
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
            Get Started
          </Button>
        </div>
      )}
    </>
  );
}
