import { useState, useEffect, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ServerIcon,
  CpuIcon,
  GaugeIcon,
  BlocksIcon,
  ActivityIcon,
  InfoIcon,
  GlobeIcon,
  CheckIcon,
  XCircleIcon,
  ZapIcon,
  ChevronDownIcon,
  CopyIcon,
  Trash2Icon,
  HardDriveIcon,
  FolderOpenIcon,
  BoxIcon,
  TerminalSquareIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { ScrollArea } from "@ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Spinner } from "@ui/spinner";
import { MODEL_PROFILES } from "@/shared/model-profiles";
import { MODEL_QUANTS, formatBytes } from "../setup-screen/constants";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/collapsible";
import { useUILang } from "@stores/ui-lang";
import { useT } from "@stores/ui-lang";
import { LANGS, type UILang } from "@/shared/i18n";
import { cn } from "@/mainview/lib/utils";
import { ModelsScreen } from "../models-screen";
import { ServerStatsScreen } from "../server-stats";
import { ServerLogsScreen } from "./server-logs";

type SettingsFormState = Record<string, string>;

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  description?: string;
  type?: "text" | "number" | "password";
}

const REMOTE_FIELDS: FieldDef[] = [
  {
    key: "VLLM_API_BASE",
    label: "Base URL",
    placeholder: "http://localhost:8080/v1",
    description: "The base URL of your OpenAI-compatible server",
  },
  {
    key: "VLLM_API_KEY",
    label: "API Key",
    placeholder: "Leave empty if not required",
    description: "Authentication key for the API (optional)",
    type: "password",
  },
  {
    key: "VLLM_MODEL_NAME",
    label: "Model Name",
    placeholder: "e.g. gpt-4o",
    description: "The model identifier sent to your server",
  },
];

/** Engine-specific extra flags shown under advanced params. */
const LLAMA_ADVANCED_FIELDS: FieldDef[] = [
  {
    key: "SERVER_IMAGE_MAX_TOKENS",
    label: "Image Max Tokens",
    placeholder: "2048",
    type: "number",
  },
  { key: "SERVER_TEMP", label: "Temperature", placeholder: "0.2" },
  { key: "SERVER_TOP_P", label: "Top P", placeholder: "0.9" },
];

const VLLM_FIELDS: FieldDef[] = [
  { key: "SERVER_PORT", label: "Port", placeholder: "8080", type: "number" },
  { key: "VLLM_MAX_MODEL_LEN", label: "Max Model Length", placeholder: "8192", type: "number", description: "Maximum sequence length the model can handle" },
  { key: "VLLM_TENSOR_PARALLEL_SIZE", label: "Tensor Parallel", placeholder: "1", type: "number", description: "Number of GPUs for tensor parallelism" },
  { key: "VLLM_GPU_MEMORY_UTILIZATION", label: "GPU Memory Utilization", placeholder: "0.9", description: "Fraction of GPU memory to use (0.0-1.0)" },
  { key: "VLLM_DTYPE", label: "Data Type", placeholder: "auto", description: "auto, float16, bfloat16, float32" },
  { key: "VLLM_ENFORCE_EAGER", label: "Enforce Eager", placeholder: "0", description: "1 = disable CUDA graph (debug)" },
];

const SGLANG_FIELDS: FieldDef[] = [
  { key: "SERVER_PORT", label: "Port", placeholder: "8080", type: "number" },
  { key: "SGLANG_CONTEXT_LENGTH", label: "Context Length", placeholder: "8192", type: "number", description: "Maximum context length" },
  { key: "SGLANG_TP_SIZE", label: "Tensor Parallel", placeholder: "1", type: "number", description: "Number of GPUs for tensor parallelism" },
  { key: "SGLANG_MEM_FRACTION_STATIC", label: "GPU Memory Fraction", placeholder: "0.88", description: "Fraction of GPU memory to use (0.0-1.0)" },
  { key: "SGLANG_CHUNKED_PREFILL_SIZE", label: "Chunked Prefill Size", placeholder: "auto", description: "Chunk size for prefill (0 = disabled)" },
];

const PERFORMANCE_FIELDS: FieldDef[] = [
  { key: "SERVER_CTX_SIZE", label: "Context Size", placeholder: "8192", type: "number" },
  {
    key: "SERVER_GPU_LAYERS",
    label: "GPU Layers",
    placeholder: "-1 (all)",
    description: "-1 = offload all layers to GPU",
    type: "number",
  },
  { key: "SERVER_PARALLEL", label: "Parallel Requests", placeholder: "1", type: "number" },
  { key: "SERVER_BATCH_SIZE", label: "Batch Size", placeholder: "256", type: "number" },
  { key: "SERVER_UBATCH_SIZE", label: "Micro Batch Size", placeholder: "64", type: "number" },
];

const GENERATION_FIELDS: FieldDef[] = [
  {
    key: "MAX_VLLM_RETRIES",
    label: "Max Retries",
    placeholder: "6",
    description: "Retry count for recoverable errors",
    type: "number",
  },
  {
    key: "MAX_VLLM_FAILURE_RETRIES",
    label: "Max Failure Retries",
    placeholder: "0",
    description: "Retry count for hard failures (0 = no retry)",
    type: "number",
  },
  {
    key: "PAGE_CONCURRENCY",
    label: "Page Concurrency",
    placeholder: "3",
    description: "Number of pages processed in parallel",
    type: "number",
  },
];

const CACHE_TYPES = ["q8_0", "q4_0", "q4_1", "f16"];

const ALL_PROFILES = [
  ...MODEL_PROFILES.map((p) => ({ id: p.id, label: p.label })),
  { id: "none", label: "None (raw output)" },
];

const LAUNCHER_TOOLS: { key: string; labelKey: string; tool: string }[] = [
  { key: "LAUNCHER_CODEX_MODEL", labelKey: "settings.integrations.codex", tool: "codex" },
  { key: "LAUNCHER_OPENCODE_MODEL", labelKey: "settings.integrations.opencode", tool: "opencode" },
  { key: "LAUNCHER_OPENCLAW_MODEL", labelKey: "settings.integrations.openclaw", tool: "openclaw" },
  { key: "LAUNCHER_HERMES_MODEL", labelKey: "settings.integrations.hermes", tool: "hermes" },
  { key: "LAUNCHER_PI_MODEL", labelKey: "settings.integrations.pi", tool: "pi" },
  { key: "LAUNCHER_COPILOT_MODEL", labelKey: "settings.integrations.copilot", tool: "copilot" },
];

const CLAUDE_TIERS = [
  { key: "LAUNCHER_CLAUDE_OPUS", labelKey: "settings.integrations.tier.opus" },
  { key: "LAUNCHER_CLAUDE_SONNET", labelKey: "settings.integrations.tier.sonnet" },
  { key: "LAUNCHER_CLAUDE_HAIKU", labelKey: "settings.integrations.tier.haiku" },
];

type SettingsTab =
  | "network"
  | "model"
  | "store"
  | "performance"
  | "integrations"
  | "benchmark"
  | "logs"
  | "stats"
  | "general"
  | "interface";

const TAB_DEFS: { key: SettingsTab; icon: ReactNode; labelKey: string }[] = [
  { key: "network", icon: <ServerIcon className="size-4" />, labelKey: "settings.server" },
  { key: "model", icon: <CpuIcon className="size-4" />, labelKey: "settings.model" },
  { key: "store", icon: <BoxIcon className="size-4" />, labelKey: "settings.store" },
  { key: "performance", icon: <GaugeIcon className="size-4" />, labelKey: "settings.performance" },
  { key: "integrations", icon: <BlocksIcon className="size-4" />, labelKey: "settings.integrations" },
  { key: "benchmark", icon: <ActivityIcon className="size-4" />, labelKey: "settings.benchmark" },
  { key: "logs", icon: <TerminalSquareIcon className="size-4" />, labelKey: "settings.logs" },
  { key: "stats", icon: <HardDriveIcon className="size-4" />, labelKey: "settings.stats" },
  { key: "general", icon: <InfoIcon className="size-4" />, labelKey: "settings.general" },
  { key: "interface", icon: <GlobeIcon className="size-4" />, labelKey: "settings.interface" },
];

function FieldGrid({
  fields,
  form,
  onUpdate,
}: {
  fields: FieldDef[];
  form: SettingsFormState;
  onUpdate: (key: string, value: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.key}>
          <Label htmlFor={field.key} className="mb-1 text-xs">
            {field.label}
          </Label>
          <Input
            id={field.key}
            type={field.type === "password" ? "password" : "text"}
            inputMode={field.type === "number" ? "numeric" : undefined}
            placeholder={field.placeholder}
            value={form[field.key] ?? ""}
            onChange={(e) => onUpdate(field.key, e.target.value)}
            className="h-8 text-xs"
          />
          {field.description && (
            <p className="mt-1 text-[11px] text-muted-foreground">{field.description}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function SaveRow({ mutation, hint }: { mutation: { mutate: () => void; isPending: boolean; isSuccess: boolean }; hint?: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 border-t pt-3">
      <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        {mutation.isPending ? (
          <Spinner data-icon="inline-start" />
        ) : mutation.isSuccess ? (
          <CheckIcon data-icon="inline-start" />
        ) : null}
        {mutation.isSuccess ? t("common.saved") : t("common.save")}
      </Button>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

interface SaveMutationLike {
  mutate: () => void;
  isPending: boolean;
  isSuccess: boolean;
  reset: () => void;
}

function inferBaseUrl(form: SettingsFormState): string {
  const isLocal = (form.SERVER_MODE ?? "local") === "local";
  if (isLocal) {
    return `http://${form.SERVER_HOST || "127.0.0.1"}:${form.SERVER_PORT || "8080"}`;
  }
  return (form.VLLM_API_BASE ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function EndpointRow({
  label,
  url,
  disabled,
  t,
}: {
  label: string;
  url: string;
  disabled?: boolean;
  t: (k: string) => string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-xs tabular-nums">{disabled ? "—" : url}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 text-xs"
        disabled={disabled}
        onClick={copy}
      >
        {copied ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
        {copied ? t("settings.endpoints.copied") : t("settings.endpoints.copy")}
      </Button>
    </div>
  );
}

function NetworkSettings({
  form,
  updateField,
  saveMutation,
  testMutation,
}: {
  form: SettingsFormState;
  updateField: (key: string, value: string) => void;
  saveMutation: SaveMutationLike;
  testMutation: { mutate: () => void; isPending: boolean; isSuccess: boolean; isError: boolean; data?: { connected: boolean } };
}) {
  const t = useT();
  const isLocal = (form.SERVER_MODE ?? "local") === "local";
  const engine = (form.INFERENCE_ENGINE ?? "llama.cpp") as "llama.cpp" | "vllm" | "sglang";
  const tested = testMutation.isSuccess || testMutation.isError;
  const autoStart = (form.AUTO_START_SERVER ?? "1") !== "0";
  const baseUrl = inferBaseUrl(form);

  const engineFields =
    engine === "vllm"
      ? VLLM_FIELDS.filter((f) => f.key !== "SERVER_PORT")
      : engine === "sglang"
        ? SGLANG_FIELDS.filter((f) => f.key !== "SERVER_PORT")
        : LLAMA_ADVANCED_FIELDS;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.server")}</h3>
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="inferenceEngine" className="mb-1 text-xs">{t("settings.engine")}</Label>
              <Select value={engine} onValueChange={(v) => updateField("INFERENCE_ENGINE", v)}>
                <SelectTrigger id="inferenceEngine" className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="llama.cpp">{t("settings.engine.llamacpp")}</SelectItem>
                  <SelectItem value="vllm">{t("settings.engine.vllm")}</SelectItem>
                  <SelectItem value="sglang">{t("settings.engine.sglang")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="serverMode" className="mb-1 text-xs">{t("settings.mode")}</Label>
              <Select value={form.SERVER_MODE ?? "local"} onValueChange={(v) => updateField("SERVER_MODE", v)}>
                <SelectTrigger id="serverMode" className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{t("settings.mode.local")}</SelectItem>
                  <SelectItem value="remote">{t("settings.mode.remote")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {isLocal && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="serverHost" className="mb-1 text-xs">{t("settings.host")}</Label>
                  <Input
                    id="serverHost"
                    placeholder="127.0.0.1"
                    value={form.SERVER_HOST ?? ""}
                    onChange={(e) => updateField("SERVER_HOST", e.target.value)}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="serverPort" className="mb-1 text-xs">Port</Label>
                  <Input
                    id="serverPort"
                    type="text"
                    inputMode="numeric"
                    placeholder="8080"
                    value={form.SERVER_PORT ?? ""}
                    onChange={(e) => updateField("SERVER_PORT", e.target.value)}
                    className="h-8 font-mono text-xs"
                  />
                </div>
              </div>
              <div>
                <Label className="mb-1 block text-xs">{t("settings.autoStart")}</Label>
                <div className="flex gap-2">
                  {(["1", "0"] as const).map((v) => (
                    <Button
                      key={v}
                      type="button"
                      variant={autoStart === (v === "1") ? "default" : "outline"}
                      size="sm"
                      className="h-8 min-w-[64px] text-xs"
                      onClick={() => updateField("AUTO_START_SERVER", v)}
                    >
                      {v === "1" ? t("settings.autoStart.on") : t("settings.autoStart.off")}
                    </Button>
                  ))}
                </div>
              </div>
            </>
          )}

          {isLocal ? (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ChevronDownIcon className="size-3.5" />
                {t("settings.advancedParams")}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <FieldGrid fields={engineFields} form={form} onUpdate={updateField} />
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <FieldGrid fields={REMOTE_FIELDS} form={form} onUpdate={updateField} />
          )}

          {isLocal && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ZapIcon data-icon="inline-start" />
                )}
                {t("settings.testConnection")}
              </Button>
              {tested && (
                <span className={`flex items-center gap-1.5 text-xs ${testMutation.data?.connected ? "text-primary" : "text-destructive"}`}>
                  {testMutation.data?.connected ? (
                    <><CheckIcon className="size-3.5" /> {t("settings.connected")}</>
                  ) : (
                    <><XCircleIcon className="size-3.5" /> {t("settings.failed")}</>
                  )}
                </span>
              )}
            </div>
          )}

          <SaveRow mutation={saveMutation} hint={isLocal ? t("settings.restartHint") : undefined} />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.endpoints.title")}</h3>
        <div className="flex flex-col gap-2">
          <EndpointRow
            label={t("settings.endpoints.chat")}
            url={`${baseUrl}${isLocal ? "" : "/v1"}/v1/chat/completions`}
            disabled={!isLocal && !form.VLLM_API_BASE}
            t={t}
          />
          <EndpointRow
            label={t("settings.endpoints.health")}
            url={`${baseUrl}${isLocal ? "" : "/v1"}/health`}
            disabled={!isLocal && !form.VLLM_API_BASE}
            t={t}
          />
          <EndpointRow
            label={t("settings.endpoints.metrics")}
            url={`${baseUrl}${isLocal ? "" : "/v1"}/metrics`}
            disabled
            t={t}
          />
        </div>
        {!isLocal && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("settings.restartHint")}
          </p>
        )}
      </div>
    </div>
  );
}

function ModelSettings({
  form,
  updateField,
  saveMutation,
  modelDirs,
}: {
  form: SettingsFormState;
  updateField: (key: string, value: string) => void;
  saveMutation: SaveMutationLike;
  modelDirs: { dirs: string[] } | undefined;
}) {
  const t = useT();
  const currentProfileId = form.VLLM_MODEL_PROFILE ?? "chandra";
  const isLocal = (form.SERVER_MODE ?? "local") === "local";
  const isCustomLocal = isLocal && !MODEL_PROFILES.some((p) => p.id === currentProfileId);
  const quantInfo = MODEL_QUANTS[currentProfileId];
  const currentQuant = (() => {
    const custom = form.CUSTOM_HF_MODEL;
    if (custom && quantInfo) {
      const suffix = custom.split(":")[1];
      if (suffix && quantInfo.quants.some((q) => q.name === suffix)) return suffix;
    }
    return quantInfo?.defaultQuant ?? "";
  })();

  const dirs = modelDirs?.dirs ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.model")}</h3>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="localModel" className="mb-1 text-xs">{t("settings.modelPicker")}</Label>
            <div className="flex gap-2">
              <Select
                value={isCustomLocal ? "custom" : currentProfileId}
                onValueChange={(v) => {
                  if (v === "custom") {
                    updateField("VLLM_MODEL_PROFILE", "none");
                    updateField("CUSTOM_HF_MODEL", "");
                  } else {
                    updateField("VLLM_MODEL_PROFILE", v);
                    const info = MODEL_QUANTS[v];
                    updateField("CUSTOM_HF_MODEL", info ? `${info.repo}:${info.defaultQuant}` : "");
                  }
                }}
              >
                <SelectTrigger id="localModel" className="h-8 flex-1 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_PROFILES.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                  {ALL_PROFILES.filter((p) => p.id === "none").map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                  <SelectItem value="custom">Custom HuggingFace model</SelectItem>
                </SelectContent>
              </Select>
              {!isCustomLocal && quantInfo && quantInfo.quants.length > 1 && (
                <Select
                  value={currentQuant}
                  onValueChange={(v) => updateField("CUSTOM_HF_MODEL", `${quantInfo.repo}:${v}`)}
                >
                  <SelectTrigger className="h-8 w-[130px] shrink-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {quantInfo.quants.map((q) => (
                      <SelectItem key={q.name} value={q.name}>
                        <p>{q.name}</p>
                        <span className="text-muted-foreground tabular-nums">{formatBytes(q.size)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {!isCustomLocal && quantInfo && (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground/60">{quantInfo.repo}</p>
            )}
          </div>

          {isCustomLocal && (
            <div>
              <Label htmlFor="customHf" className="mb-1 text-xs">{t("settings.customHf")}</Label>
              <Input
                id="customHf"
                placeholder="e.g. user/Model-GGUF:Q4_K_M"
                value={form.CUSTOM_HF_MODEL ?? ""}
                onChange={(e) => updateField("CUSTOM_HF_MODEL", e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          )}

          <SaveRow mutation={saveMutation} hint={t("settings.restartHint")} />
        </div>
      </div>

      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <FolderOpenIcon className="size-4" />
          {t("settings.modelDirs.title")}
        </h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.modelDirs.desc")}</p>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="modelDirPrimary" className="mb-1 text-xs">{t("settings.modelDirs.primary")}</Label>
            <Input
              id="modelDirPrimary"
              value={dirs[0] ?? ""}
              readOnly
              className="h-8 font-mono text-xs"
            />
          </div>
          <div>
            <Label htmlFor="modelDirExtra" className="mb-1 text-xs">{t("settings.modelDirs.extra")}</Label>
            <Input
              id="modelDirExtra"
              placeholder="/path/one,/path/two"
              value={form.MODEL_DIRS ?? ""}
              onChange={(e) => updateField("MODEL_DIRS", e.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function PerformanceSettings({
  form,
  updateField,
  saveMutation,
}: {
  form: SettingsFormState;
  updateField: (key: string, value: string) => void;
  saveMutation: SaveMutationLike;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <GaugeIcon className="size-4" />
          {t("settings.scheduler.title")}
        </h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.scheduler.desc")}</p>
        <FieldGrid fields={PERFORMANCE_FIELDS} form={form} onUpdate={updateField} />
      </div>

      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <HardDriveIcon className="size-4" />
          {t("settings.cache.title")}
        </h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.cache.desc")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["SERVER_CACHE_TYPE_K", "SERVER_CACHE_TYPE_V"] as const).map((key) => (
            <div key={key}>
              <Label htmlFor={key} className="mb-1 text-xs">{key === "SERVER_CACHE_TYPE_K" ? "Cache Type K" : "Cache Type V"}</Label>
              <Select value={form[key] ?? "q8_0"} onValueChange={(v) => updateField(key, v)}>
                <SelectTrigger id={key} className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CACHE_TYPES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.generation")}</h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.generation.desc")}</p>
        <FieldGrid fields={GENERATION_FIELDS} form={form} onUpdate={updateField} />
      </div>

      <SaveRow mutation={saveMutation} hint={t("settings.restartHint")} />
    </div>
  );
}

function launcherCommand(tool: string, baseUrl: string, model: string): string {
  if (!model) return "";
  if (tool === "claude") {
    return `ANTHROPIC_BASE_URL=${baseUrl} ANTHROPIC_MODEL=${model} ANTHROPIC_API_KEY=EMPTY claude`;
  }
  if (tool === "codex" || tool === "opencode" || tool === "openclaw" || tool === "copilot") {
    return `OPENAI_BASE_URL=${baseUrl}/v1 OPENAI_API_KEY=EMPTY OPENAI_MODEL=${model} ${tool}`;
  }
  return `${tool} --model ${model} --base-url ${baseUrl}/v1`;
}

function IntegrationsSettings({
  form,
  updateField,
  saveMutation,
}: {
  form: SettingsFormState;
  updateField: (key: string, value: string) => void;
  saveMutation: SaveMutationLike;
}) {
  const t = useT();
  const baseUrl = inferBaseUrl(form);
  const mode = form.LAUNCHER_CLAUDE_MODE ?? "local";
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(launcherCommand("claude", baseUrl, form.LAUNCHER_CLAUDE_SONNET || ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-3 text-xs text-muted-foreground">{t("settings.integrations.desc")}</p>
        <h3 className="mb-2 text-sm font-medium">{t("settings.integrations.claude")}</h3>
        <div className="mb-2 flex gap-2">
          <Label className="mb-1 block text-xs">{t("settings.integrations.mode")}</Label>
          <div className="flex gap-2">
            {(["local", "cloud"] as const).map((m) => (
              <Button
                key={m}
                type="button"
                variant={mode === m ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => updateField("LAUNCHER_CLAUDE_MODE", m)}
              >
                {m === "local" ? t("settings.integrations.mode.local") : t("settings.integrations.mode.cloud")}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {CLAUDE_TIERS.map((tier) => (
            <div key={tier.key}>
              <Label htmlFor={tier.key} className="mb-1 text-xs">{t(tier.labelKey)}</Label>
              <Input
                id={tier.key}
                placeholder={mode === "local" ? "local model name" : "e.g. claude-sonnet-4-20250514"}
                value={form[tier.key] ?? ""}
                onChange={(e) => updateField(tier.key, e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-lg border px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground">{t("settings.integrations.command")}</p>
            <p className="truncate font-mono text-xs tabular-nums">
              {launcherCommand("claude", baseUrl, form.LAUNCHER_CLAUDE_SONNET || "") || "—"}
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={copy} disabled={!form.LAUNCHER_CLAUDE_SONNET}>
            {copied ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
            {copied ? t("settings.endpoints.copied") : t("settings.endpoints.copy")}
          </Button>
        </div>
      </div>

      {LAUNCHER_TOOLS.map((tool) => (
        <div key={tool.key}>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-medium">{t(tool.labelKey)}</h3>
            <Label htmlFor={tool.key} className="text-[11px] text-muted-foreground">{t("settings.integrations.model")}</Label>
          </div>
          <Input
            id={tool.key}
            placeholder={mode === "local" ? "local model name" : "e.g. gpt-4o"}
            value={form[tool.key] ?? ""}
            onChange={(e) => updateField(tool.key, e.target.value)}
            className="mb-2 h-8 text-xs"
          />
          <p className="truncate rounded-lg bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">
            {launcherCommand(tool.tool, baseUrl, form[tool.key] || "") || "—"}
          </p>
        </div>
      ))}

      <SaveRow mutation={saveMutation} />
    </div>
  );
}

const BENCHMARK_PRESET_CONTEXTS = [1024, 4096, 8192, 16384, 32768];

function BenchmarkSettings({ form }: { form: SettingsFormState }) {
  const t = useT();
  const [model, setModel] = useState("");
  const [genLength, setGenLength] = useState(128);
  const [batchSize, setBatchSize] = useState(1);
  const [contexts, setContexts] = useState<number[]>(BENCHMARK_PRESET_CONTEXTS);

  const { data: installed } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      rpcClient.runBenchmark({
        model: model || (form.CHAT_MODEL ?? "") || "local",
        genLength,
        batchSize,
        contexts,
      }),
  });

  const toggleContext = (c: number) => {
    setContexts((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c].sort((a, b) => a - b)));
  };

  const models = installed?.models ?? [];
  const modelOptions = Array.from(new Set(models.map((m) => m.fileName.replace(/\.gguf$/i, "")))).filter(Boolean);
  const effectiveModel = model || (form.CHAT_MODEL ?? "") || modelOptions[0] || "";

  const rows = runMutation.data?.rows ?? [];
  const maxTps = Math.max(...rows.map((r) => r.tps), 0.0001);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-3 text-xs text-muted-foreground">{t("settings.benchmark.desc")}</p>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="benchModel" className="mb-1 text-xs">{t("settings.benchmark.model")}</Label>
            <Input
              id="benchModel"
              placeholder={modelOptions[0] ?? "model name"}
              value={effectiveModel}
              onChange={(e) => setModel(e.target.value)}
              className="h-8 text-xs"
            />
            {modelOptions.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {modelOptions.slice(0, 8).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setModel(m)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                      effectiveModel === m
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </p>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="benchGen" className="mb-1 text-xs">{t("settings.benchmark.genLength")}</Label>
              <Input
                id="benchGen"
                type="text"
                inputMode="numeric"
                value={String(genLength)}
                onChange={(e) => setGenLength(parseInt(e.target.value || "0", 10) || 16)}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <Label htmlFor="benchBatch" className="mb-1 text-xs">{t("settings.benchmark.batchSize")}</Label>
              <Input
                id="benchBatch"
                type="text"
                inputMode="numeric"
                value={String(batchSize)}
                onChange={(e) => setBatchSize(parseInt(e.target.value || "0", 10) || 1)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div>
            <Label className="mb-1 block text-xs">{t("settings.benchmark.contexts")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {BENCHMARK_PRESET_CONTEXTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleContext(c)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    contexts.includes(c)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                  )}
                >
                  {c >= 1000 ? `${(c / 1000).toFixed(c % 1000 === 0 ? 0 : 1)}k` : c}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => runMutation.mutate()} disabled={runMutation.isPending || contexts.length === 0}>
              {runMutation.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ActivityIcon data-icon="inline-start" />
              )}
              {runMutation.isPending
                ? t("settings.benchmark.running")
                : runMutation.isSuccess
                  ? t("settings.benchmark.runDone")
                  : t("settings.benchmark.run")}
            </Button>
            {runMutation.isError && (
              <span className="flex items-center gap-1.5 text-xs text-destructive">
                <XCircleIcon className="size-3.5" /> {String(runMutation.error)}
              </span>
            )}
          </div>
        </div>
      </div>

      {runMutation.data?.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          {runMutation.data.error}
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.benchmark.results")}</h3>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
            {t("settings.benchmark.noResults")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-2 py-1.5 font-medium">{t("settings.benchmark.col.context")}</th>
                  <th className="px-2 py-1.5 font-medium">{t("settings.benchmark.col.batch")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.ttft")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.tpot")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.tps")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.tokens")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.total")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.contextLength} className="border-b border-muted/50">
                    <td className="px-2 py-1.5 tabular-nums">
                      {r.contextLength >= 1000 ? `${(r.contextLength / 1000).toFixed(0)}k` : r.contextLength}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{r.batchSize}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.ttftMs}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.tpotMs}</td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-primary">{r.tps}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.tokens}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.totalMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex flex-col gap-1.5">
              {rows.map((r) => (
                <div key={r.contextLength} className="flex items-center gap-2">
                  <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {r.contextLength >= 1000 ? `${(r.contextLength / 1000).toFixed(0)}k` : r.contextLength}
                  </span>
                  <div className="h-2.5 flex-1 rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${(r.tps / maxTps) * 100}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums">{r.tps} tps</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GeneralSettings({ form, updateField, saveMutation }: { form: SettingsFormState; updateField: (key: string, value: string) => void; saveMutation: SaveMutationLike }) {
  const t = useT();
  const queryClient = useQueryClient();

  const { data: about } = useQuery({
    queryKey: ["about-info"],
    queryFn: () => rpcClient.getAboutInfo(),
  });

  const clearLogsMutation = useMutation({
    mutationFn: () => rpcClient.clearServerLogs(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["server-status"] }),
  });

  const uptimeSeconds = about?.sessionStartedAt ? Math.floor(Date.now() / 1000 - about.sessionStartedAt / 1000) : 0;
  const uptime = (() => {
    const h = Math.floor(uptimeSeconds / 3600);
    const m = Math.floor((uptimeSeconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  })();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.updateChannel.title")}</h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.updateChannel.desc")}</p>
        <Select
          value={form.UPDATE_CHANNEL ?? "stable"}
          onValueChange={(v) => updateField("UPDATE_CHANNEL", v)}
        >
          <SelectTrigger className="h-8 w-full text-xs sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">{t("settings.updateChannel.stable")}</SelectItem>
            <SelectItem value="beta">{t("settings.updateChannel.beta")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.about.title")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("settings.about.version")}</p>
            <p className="font-mono text-xs">{about?.version ?? "—"}</p>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("settings.updateChannel.title")}</p>
            <p className="text-xs">{about?.channel === "beta" ? t("settings.updateChannel.beta") : t("settings.updateChannel.stable")}</p>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("settings.about.uptime")}</p>
            <p className="font-mono text-xs tabular-nums">{uptime}</p>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("settings.about.basePath")}</p>
            <p className="truncate font-mono text-xs">{about?.basePath ?? "—"}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => clearLogsMutation.mutate()}
          disabled={clearLogsMutation.isPending}
        >
          <Trash2Icon data-icon="inline-start" />
          {t("settings.about.clearLogs")}
        </Button>
      </div>

      <SaveRow mutation={saveMutation} />
    </div>
  );
}

function InterfaceSettings() {
  const t = useT();
  const lang = useUILang((s) => s.lang);
  const setLang = useUILang((s) => s.setLang);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (newLang: UILang) => rpcClient.updateSettings({ settings: { UI_LANG: newLang } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="mb-1 text-sm font-medium">{t("settings.interface")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.interface.languageDesc")}</p>
      </div>
      <div>
        <Label className="mb-1 text-xs">{t("settings.interface.language")}</Label>
        <div className="flex gap-2">
          {LANGS.map((l: { value: UILang; label: string }) => (
            <Button
              key={l.value}
              variant={lang === l.value ? "default" : "outline"}
              size="sm"
              className="h-8 min-w-[72px]"
              onClick={() => {
                setLang(l.value);
                saveMutation.mutate(l.value);
              }}
              disabled={saveMutation.isPending && lang !== l.value}
            >
              {l.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SettingsScreen() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<SettingsTab>("network");
  const [form, setForm] = useState<SettingsFormState>({});
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  const { data: modelDirs } = useQuery({
    queryKey: ["model-dirs"],
    queryFn: () => rpcClient.getModelDirs(),
  });

  useEffect(() => {
    if (data?.settings) {
      const s = { ...data.settings };
      if (s.VLLM_API_KEY === "EMPTY") s.VLLM_API_KEY = "";
      setForm(s);
    }
  }, [data]);

  const NETWORK_KEYS = [
    "SERVER_MODE",
    "INFERENCE_ENGINE",
    "SERVER_HOST",
    "SERVER_PORT",
    "AUTO_START_SERVER",
    ...REMOTE_FIELDS.map((f) => f.key),
    ...LLAMA_ADVANCED_FIELDS.map((f) => f.key),
    ...VLLM_FIELDS.map((f) => f.key),
    ...SGLANG_FIELDS.map((f) => f.key),
  ];
  const MODEL_KEYS = ["VLLM_MODEL_PROFILE", "CUSTOM_HF_MODEL", "MODEL_DIRS"];
  const PERFORMANCE_KEYS = [
    ...PERFORMANCE_FIELDS.map((f) => f.key),
    "SERVER_CACHE_TYPE_K",
    "SERVER_CACHE_TYPE_V",
    ...GENERATION_FIELDS.map((f) => f.key),
  ];
  const INTEGRATION_KEYS = [
    "LAUNCHER_CLAUDE_MODE",
    ...CLAUDE_TIERS.map((c) => c.key),
    ...LAUNCHER_TOOLS.map((x) => x.key),
  ];
  const GENERAL_KEYS = ["UPDATE_CHANNEL"];

  const pickKeys = (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) if (form[k] !== undefined) out[k] = form[k];
    return out;
  };

  const useTabSave = (keys: string[], opts?: { invalidateConnection?: boolean }) =>
    useMutation({
      mutationFn: () => {
        const settings = pickKeys(keys);
        if (!settings.VLLM_API_KEY) settings.VLLM_API_KEY = "EMPTY";
        return rpcClient.updateSettings({ settings });
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["settings"] });
        queryClient.invalidateQueries({ queryKey: ["model-dirs"] });
        if (opts?.invalidateConnection) {
          queryClient.invalidateQueries({ queryKey: ["connection-status"] });
        }
      },
    });

  const saveNetwork = useTabSave(NETWORK_KEYS, { invalidateConnection: true });
  const saveModel = useTabSave(MODEL_KEYS);
  const savePerformance = useTabSave(PERFORMANCE_KEYS, { invalidateConnection: true });
  const saveIntegrations = useTabSave(INTEGRATION_KEYS);
  const saveGeneral = useTabSave(GENERAL_KEYS);

  const testMutation = useMutation({
    mutationFn: () => {
      const isLocal = (form.SERVER_MODE ?? "local") === "local";
      const baseUrl = isLocal ? inferBaseUrl(form) : (form.VLLM_API_BASE ?? "");
      const apiKey = form.VLLM_API_KEY || "EMPTY";
      return rpcClient.checkConnection({ baseUrl, apiKey });
    },
  });

  const updateField = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left category nav */}
      <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3">
        <span className="mb-1 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {t("settings.category.title")}
        </span>
        {TAB_DEFS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors",
              activeTab === tab.key
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {tab.icon}
            <span className="truncate">{t(tab.labelKey)}</span>
          </button>
        ))}
      </div>

      {/* Right content */}
      {activeTab === "store" ? (
        <div className="min-w-0 flex-1">
          <ModelsScreen />
        </div>
      ) : activeTab === "stats" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ServerStatsScreen />
        </div>
      ) : activeTab === "logs" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ServerLogsScreen />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-2xl px-6 py-6">
            <div className="mb-6">
              <h2 className="text-lg font-semibold tracking-tight">{t("settings.title")}</h2>
              <p className="text-xs text-muted-foreground">{t("settings.subtitle")}</p>
            </div>

            {activeTab === "network" && (
              <NetworkSettings
                form={form}
                updateField={updateField}
                saveMutation={saveNetwork}
                testMutation={testMutation}
              />
            )}

            {activeTab === "model" && (
              <ModelSettings form={form} updateField={updateField} saveMutation={saveModel} modelDirs={modelDirs} />
            )}

            {activeTab === "performance" && (
              <PerformanceSettings form={form} updateField={updateField} saveMutation={savePerformance} />
            )}

            {activeTab === "integrations" && (
              <IntegrationsSettings form={form} updateField={updateField} saveMutation={saveIntegrations} />
            )}

            {activeTab === "benchmark" && <BenchmarkSettings form={form} />}

            {activeTab === "general" && (
              <GeneralSettings form={form} updateField={updateField} saveMutation={saveGeneral} />
            )}

            {activeTab === "interface" && <InterfaceSettings />}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}