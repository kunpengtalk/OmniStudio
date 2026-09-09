import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  XCircleIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  TerminalSquareIcon,
  GlobeIcon,
  MonitorIcon,
  Loader2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { MODEL_PROFILES } from "@/shared/model-profiles";
import { useServerStore } from "@stores/server";

import { MODEL_QUANTS, formatBytes } from "./constants";
import { SetupHeader, ModeCard, LocalStartStep } from "./shared";

type LocalStep = "prerequisites" | "model" | "start";

export function LocalFlow({
  onComplete,
  onSwitchToRemote,
}: {
  onComplete: () => void;
  onSwitchToRemote: () => void;
}) {
  const [step, setStep] = useState<LocalStep>("prerequisites");
  const [profileId, setProfileId] = useState("lightonocr");
  const [customHfModel, setCustomHfModel] = useState("");
  const [quants, setQuants] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(MODEL_QUANTS).map(([k, v]) => [k, v.defaultQuant])),
  );
  const isCustom = profileId === "custom";

  const serverStatus = useServerStore((s) => s.status);
  const serverLogs = useServerStore((s) => s.logs);

  const llamaCheck = useQuery({
    queryKey: ["llama-server-check"],
    queryFn: () => rpcClient.checkLlamaServer(),
    refetchInterval: (query) => (query.state.data?.found ? false : 3000),
  });

  const startServerMutation = useMutation({
    mutationFn: () => rpcClient.startServer(),
  });

  const llamaFound = llamaCheck.data?.found ?? false;

  const handleStartLocal = async () => {
    const isKnownProfile = MODEL_PROFILES.some((p) => p.id === profileId);
    const info = MODEL_QUANTS[profileId];
    const hfModel = info ? `${info.repo}:${quants[profileId]}` : "";
    const settings: Record<string, string> = {
      SERVER_MODE: "local",
      VLLM_MODEL_PROFILE: isKnownProfile ? profileId : "none",
      CUSTOM_HF_MODEL: isCustom ? customHfModel : hfModel,
    };
    await rpcClient.updateSettings({ settings });
    startServerMutation.mutate();
  };

  const canPickNext = !isCustom || customHfModel.trim().length > 0;

  const steps: LocalStep[] = ["prerequisites", "model", "start"];

  return (
    <>
      <SetupHeader
        title={
          step === "prerequisites"
            ? "Local mode"
            : step === "model"
              ? "Choose a model"
              : "Start server"
        }
        subtitle={
          step === "prerequisites"
            ? "Run models locally with llama-server."
            : step === "model"
              ? "Pick a supported model or enter a custom HuggingFace model."
              : "Starting llama-server with the selected model."
        }
        steps={steps}
        currentStep={step}
      />

      {step === "prerequisites" && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <ModeCard
              icon={<MonitorIcon className="size-4" />}
              label="Local"
              description="Run llama-server locally"
              selected
              onClick={() => {}}
            />
            <ModeCard
              icon={<GlobeIcon className="size-4" />}
              label="URL"
              description="Connect to an API"
              selected={false}
              onClick={onSwitchToRemote}
            />
          </div>

          <div
            className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${llamaFound ? "border-primary/30 bg-primary/5" : "border-border"}`}
          >
            <TerminalSquareIcon className="size-5 shrink-0 text-muted-foreground" />
            <div className="flex-1">
              <p className="text-sm font-medium">llama-server</p>
              {llamaFound ? (
                <p className="text-xs text-primary">Found at {llamaCheck.data?.path}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Not found on PATH. Install via{" "}
                  <code className="rounded bg-muted px-1 text-[11px]">brew install llama.cpp</code>{" "}
                  or download from GitHub.
                </p>
              )}
            </div>
            {llamaFound ? (
              <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
            ) : llamaCheck.isLoading ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <XCircleIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
          </div>

          <Button disabled={!llamaFound} onClick={() => setStep("model")}>
            Next
            <ArrowRightIcon />
          </Button>
        </div>
      )}

      {step === "model" && (
        <div className="flex flex-col gap-3">
          {MODEL_PROFILES.map((profile) => {
            const info = MODEL_QUANTS[profile.id];
            const selected = profileId === profile.id;
            return (
              <div
                key={profile.id}
                role="button"
                tabIndex={0}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground/40"
                }`}
                onClick={() => setProfileId(profile.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setProfileId(profile.id);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{profile.label}</span>
                    {profile.badge && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {profile.badge}
                      </span>
                    )}
                  </div>
                  <p className="truncate font-mono text-[11px] text-muted-foreground/70">
                    {info?.repo}
                  </p>
                </div>
                {info && info.quants.length > 1 && (
                  <Select
                    value={quants[profile.id]}
                    onValueChange={(v) => {
                      setProfileId(profile.id);
                      setQuants((prev) => ({ ...prev, [profile.id]: v }));
                    }}
                  >
                    <SelectTrigger
                      className="h-7 w-[130px] shrink-0 text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {info.quants.map((q) => (
                        <SelectItem key={q.name} value={q.name}>
                          <p>{q.name}</p>
                          <span className="text-muted-foreground tabular-nums">
                            {formatBytes(q.size)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            );
          })}

          <button
            type="button"
            className={`flex flex-col gap-1 rounded-lg border px-4 py-3 text-left transition-colors ${
              isCustom
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground/40"
            }`}
            onClick={() => setProfileId("custom")}
          >
            <span className="text-sm font-medium">Custom model</span>
            <span className="text-xs text-muted-foreground">
              Enter a HuggingFace GGUF model. Runs in raw mode (no formatting).
            </span>
          </button>
          {isCustom && (
            <Input
              placeholder="e.g. user/Model-GGUF:Q4_K_M"
              value={customHfModel}
              onChange={(e) => setCustomHfModel(e.target.value)}
              className="h-8 text-sm"
              autoFocus
            />
          )}

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep("prerequisites")}>
              <ArrowLeftIcon data-icon="inline-start" />
              Back
            </Button>
            <Button
              className="flex-1"
              size="sm"
              disabled={!canPickNext}
              onClick={() => setStep("start")}
            >
              Next
              <ArrowRightIcon />
            </Button>
          </div>
        </div>
      )}

      {step === "start" && (
        <LocalStartStep
          onBack={() => setStep("model")}
          onStart={handleStartLocal}
          onComplete={onComplete}
          serverStatus={serverStatus}
          serverLogs={serverLogs}
          startError={startServerMutation.data?.error}
        />
      )}
    </>
  );
}
