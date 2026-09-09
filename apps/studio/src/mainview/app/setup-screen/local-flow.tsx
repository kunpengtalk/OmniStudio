import { useEffect, useState } from "react";
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
  AlertTriangleIcon,
  RefreshCwIcon,
  CpuIcon,
  DownloadIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useServerStore } from "@stores/server";
import { useModelDownloadStore } from "@stores/model-download";
import { matchQuant, safeRepoId, type InferenceEngine } from "@/shared/modelscope";
import type { SetupEnvironment } from "../../../bun/setup-env";

import { SETUP_MODELS, formatBytes } from "./constants";
import { SetupHeader, ModeCard, LocalStartStep } from "./shared";

type LocalStep = "mode" | "engine" | "model" | "start";

const ENGINE_LABEL: Record<InferenceEngine, string> = {
  "llama.cpp": "llama-server",
  vllm: "vLLM",
  sglang: "SGLang",
};

type EngineChoice = {
  id: InferenceEngine;
  label: string;
  sub: string;
  desc: (env: SetupEnvironment) => string;
  installHint: (env: SetupEnvironment) => string;
  recommended?: boolean;
};

/** 引擎介绍根据当前环境动态生成：Apple 芯片侧重 Metal，NVIDIA GPU 才推荐 vLLM/SGLang。 */
const ENGINE_CHOICES: EngineChoice[] = [
  {
    id: "llama.cpp",
    label: "llama.cpp",
    sub: "llama-server",
    desc: (env) =>
      env.appleSilicon
        ? "GGUF 格式，兼容性最好，Apple 芯片上由 Metal 加速，无需独显"
        : "GGUF 格式，兼容性最好，CPU / GPU 均可运行",
    installHint: (env) =>
      env.platform === "darwin"
        ? "brew install llama.cpp（或从 GitHub 下载 llama-server）"
        : "下载 llama.cpp 的 llama-server 可执行文件并加入 PATH",
    recommended: true,
  },
  {
    id: "vllm",
    label: "vLLM",
    sub: "NVIDIA GPU",
    desc: (env) =>
      env.hasNvidiaGpu
        ? "NVIDIA GPU 上高吞吐、高并发，适合较大模型"
        : "需要 NVIDIA GPU（CUDA）；当前未检测到，暂不推荐",
    installHint: () => "pip install vllm",
  },
  {
    id: "sglang",
    label: "SGLang",
    sub: "NVIDIA GPU",
    desc: (env) =>
      env.hasNvidiaGpu
        ? "NVIDIA GPU 上的高性能选项，vLLM 的替代方案"
        : "需要 NVIDIA GPU（CUDA）；当前未检测到，暂不推荐",
    installHint: () => "pip install sglang",
  },
];

function engineReady(engine: InferenceEngine, env?: SetupEnvironment): boolean {
  if (!env) return false;
  if (engine === "llama.cpp") return env.llama.found;
  if (engine === "vllm") return env.vllm.found;
  return env.sglang.found;
}

/** 引导每一步都可跳过，直接完成设置进入应用（服务器起不来也不卡住）。 */
function SkipSetupButton({ onComplete }: { onComplete: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="self-center" onClick={onComplete}>
      Skip — enter the app
    </Button>
  );
}

/** 启动前需要先下载到本地的目标文件（llama.cpp 单个 GGUF；vLLM/SGLang 整个仓库）。 */
type DownloadPlan = {
  repo: string;
  quant?: string;
  files: { name: string; size: number }[];
};

function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

export function LocalFlow({
  onComplete,
  onSwitchToRemote,
}: {
  onComplete: () => void;
  onSwitchToRemote: () => void;
}) {
  const [step, setStep] = useState<LocalStep>("mode");
  const [engine, setEngine] = useState<InferenceEngine>("llama.cpp");
  const [modelId, setModelId] = useState<string>(SETUP_MODELS[0]!.id);
  const [customHfModel, setCustomHfModel] = useState("");
  const [quants, setQuants] = useState<Record<string, string>>(
    Object.fromEntries(SETUP_MODELS.map((m) => [m.id, m.defaultQuant])),
  );
  const isCustom = modelId === "custom";
  const activeQuant = quants[modelId] ?? "";

  const serverStatus = useServerStore((s) => s.status);
  const serverLogs = useServerStore((s) => s.logs);

  const envQuery = useQuery({
    queryKey: ["setup-env"],
    queryFn: () => rpcClient.getSetupEnvironment(),
  });
  const env = envQuery.data;

  const downloadTasks = useModelDownloadStore((s) => s.tasks);
  const installedQuery = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedModels = installedQuery.data?.models ?? [];

  const [plan, setPlan] = useState<DownloadPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planNonce, setPlanNonce] = useState(0);

  // 进入「启动」步骤：重新检测引擎二进制 + 同步下载任务列表。
  useEffect(() => {
    if (step !== "start") return;
    void envQuery.refetch();
    if (!isCustom) {
      void rpcClient
        .listDownloads()
        .then(({ tasks }) => useModelDownloadStore.getState().setTasks(tasks));
    }
  }, [step]);

  // 解析下载计划：llama.cpp 选匹配量化的单个 GGUF；vLLM/SGLang 下载整个仓库。
  useEffect(() => {
    if (step !== "start" || !env || isCustom) return;
    let cancelled = false;
    const model = SETUP_MODELS.find((m) => m.id === modelId);
    if (!model) return;
    const repo = engine === "llama.cpp" ? model.ggufRepo : model.hfRepo;
    setPlanLoading(true);
    (async () => {
      try {
        const { files } = await rpcClient.listModelScopeFiles({ repo });
        if (cancelled) return;
        const picked =
          engine === "llama.cpp"
            ? files.filter((f) => f.kind === "gguf" && f.isWeight && matchQuant(f.name, activeQuant))
            : files.filter((f) => !/\.(md|png|jpe?g|webp|gitignore|txt)$/i.test(f.name));
        setPlan({
          repo,
          quant: engine === "llama.cpp" ? activeQuant : undefined,
          files: picked.map((f) => ({ name: f.name, size: f.size })),
        });
      } catch {
        if (!cancelled) setPlan(null);
      } finally {
        if (!cancelled) setPlanLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, env, isCustom, engine, modelId, activeQuant, planNonce]);

  const planRepoDir = plan ? safeRepoId(plan.repo) : "";
  const downloaded =
    !isCustom && plan
      ? installedModels.some(
          (m) =>
            m.repo === planRepoDir &&
            (engine === "llama.cpp" ? matchQuant(m.fileName, plan.quant ?? "") : true),
        )
      : false;

  // 下载全部完成后刷新已安装列表 → downloaded 变 true → 展示启动按钮。
  useEffect(() => {
    if (!plan || isCustom) return;
    const ours = downloadTasks.filter((t) => t.repo === plan.repo && t.status !== "canceled");
    if (ours.length > 0 && ours.every((t) => t.status === "completed")) {
      void installedQuery.refetch();
    }
  }, [downloadTasks, plan, isCustom]);

  const startServerMutation = useMutation({
    mutationFn: () => rpcClient.startServer(),
  });

  const handleDownload = async () => {
    if (!plan) return;
    // 国内用户为主：默认走 hf-mirror.com（HF 镜像）下载。
    for (const f of plan.files) {
      await rpcClient.startModelDownload({
        repo: plan.repo,
        fileName: f.name,
        category: "chat",
        source: "huggingface",
      });
    }
  };

  const handleStartLocal = async () => {
    const model = SETUP_MODELS.find((m) => m.id === modelId);
    let localPath = "";
    if (!isCustom && plan) {
      const installed = installedModels.find(
        (m) =>
          m.repo === planRepoDir &&
          (engine === "llama.cpp" ? matchQuant(m.fileName, plan.quant ?? "") : true),
      );
      if (installed) {
        // llama.cpp 指向单个 GGUF 文件；vLLM/SGLang 指向仓库目录。
        const target = engine === "llama.cpp" ? installed.path : dirName(installed.path);
        const act = await rpcClient.setActiveModel({ path: target });
        if (act.ok) localPath = target;
      }
    }
    const modelRef = isCustom
      ? customHfModel.trim()
      : engine === "llama.cpp"
        ? `${model!.ggufRepo}:${activeQuant}`
        : model!.hfRepo;
    const settings: Record<string, string> = {
      SERVER_MODE: "local",
      INFERENCE_ENGINE: engine,
      VLLM_MODEL_PROFILE: "none",
      CUSTOM_HF_MODEL: modelRef,
      LOCAL_MODEL_PATH: localPath,
    };
    await rpcClient.updateSettings({ settings });
    startServerMutation.mutate();
  };

  const ready = engineReady(engine, env);
  const canPickModelNext = !isCustom || customHfModel.trim().length > 0;

  const planTasks = plan ? downloadTasks.filter((t) => t.repo === plan.repo) : [];
  const planTotals = planTasks.reduce((s, t) => s + (t.total ?? 0), 0);
  const planReceived = planTasks.reduce((s, t) => s + (t.received ?? 0), 0);
  const planPercent = planTotals > 0 ? Math.floor((planReceived / planTotals) * 100) : null;
  const planBusy = planTasks.some((t) =>
    ["queued", "downloading", "paused"].includes(t.status),
  );
  const planFailed = planTasks.some((t) => t.status === "failed");
  const planSize = plan ? plan.files.reduce((s, f) => s + f.size, 0) : 0;

  const header = (title: string, subtitle: string) => (
    <SetupHeader
      title={title}
      subtitle={subtitle}
      steps={["mode", "engine", "model", "start"] as LocalStep[]}
      currentStep={step}
    />
  );

  return (
    <>
      {step === "mode" &&
        header(
          "Local mode",
          "在本机运行推理服务。选择要使用的推理引擎，再安装一个 Qwen 对话模型。",
        )}
      {step === "engine" &&
        header(
          "Choose an inference engine",
          "根据你的机器环境推荐，默认 llama.cpp；以后随时可在设置中切换。",
        )}
      {step === "model" &&
        header(
          "Choose a model",
          "安装一个 Qwen 对话模型即可开始使用；选择后会自动下载部署。",
        )}
      {step === "start" &&
        header("Start server", `正在准备启动 ${ENGINE_LABEL[engine]}。`)}

      {step === "mode" && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <ModeCard
              icon={<MonitorIcon className="size-4" />}
              label="Local"
              description="Run a local inference server"
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
          <Button onClick={() => setStep("engine")}>
            Next
            <ArrowRightIcon />
          </Button>
          <SkipSetupButton onComplete={onComplete} />
        </div>
      )}

      {step === "engine" && (
        <div className="flex flex-col gap-3">
          {!env ? (
            envQuery.isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-8 text-center">
                <AlertTriangleIcon className="size-5 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">无法检测运行环境</p>
                <Button variant="outline" size="sm" onClick={() => envQuery.refetch()}>
                  <RefreshCwIcon data-icon="inline-start" />
                  重试
                </Button>
              </div>
            )
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {ENGINE_CHOICES.map((choice) => {
                  const selected = engine === choice.id;
                  const isReady = engineReady(choice.id, env);
                  return (
                    <div
                      key={choice.id}
                      role="button"
                      tabIndex={0}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-muted-foreground/40"
                      }`}
                      onClick={() => setEngine(choice.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") setEngine(choice.id);
                      }}
                    >
                      <div
                        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${
                          selected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {choice.id === "llama.cpp" ? (
                          <TerminalSquareIcon className="size-4" />
                        ) : (
                          <CpuIcon className="size-4" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{choice.label}</span>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {choice.sub}
                          </span>
                          {choice.recommended && (
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                              推荐
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {choice.desc(env)}
                        </p>
                        {!isReady && (
                          <p className="mt-1 text-[11px] text-muted-foreground/70">
                            未就绪 · 安装：<code className="rounded bg-muted px-1">{choice.installHint(env)}</code>
                          </p>
                        )}
                      </div>
                      {isReady ? (
                        <CheckCircle2Icon className="mt-1 size-4 shrink-0 text-primary" />
                      ) : (
                        <XCircleIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setStep("mode")}>
                  <ArrowLeftIcon data-icon="inline-start" />
                  Back
                </Button>
                <Button className="flex-1" size="sm" onClick={() => setStep("model")}>
                  Next
                  <ArrowRightIcon />
                </Button>
              </div>
            </>
          )}
          <SkipSetupButton onComplete={onComplete} />
        </div>
      )}

      {step === "model" && (
        <div className="flex flex-col gap-3">
          {SETUP_MODELS.map((model) => {
            const selected = modelId === model.id;
            const repo =
              engine === "llama.cpp"
                ? `${model.ggufRepo}:${quants[model.id]}`
                : model.hfRepo;
            const sizeBytes =
              engine === "llama.cpp"
                ? model.quants.find((q) => q.name === quants[model.id])?.size
                : model.hfSizeBytes;
            return (
              <div
                key={model.id}
                role="button"
                tabIndex={0}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground/40"
                }`}
                onClick={() => setModelId(model.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setModelId(model.id);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{model.label}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {model.params}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{model.description}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
                    {repo} · {formatBytes(sizeBytes ?? model.hfSizeBytes)}
                  </p>
                </div>
                {engine === "llama.cpp" && model.quants.length > 1 && (
                  <Select
                    value={quants[model.id]}
                    onValueChange={(v) => {
                      setModelId(model.id);
                      setQuants((prev) => ({ ...prev, [model.id]: v }));
                    }}
                  >
                    <SelectTrigger
                      className="h-7 w-[132px] shrink-0 text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {model.quants.map((q) => (
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
            onClick={() => setModelId("custom")}
          >
            <span className="text-sm font-medium">Custom model</span>
            <span className="text-xs text-muted-foreground">
              {engine === "llama.cpp"
                ? "Enter a HuggingFace GGUF model, e.g. user/Model-GGUF:Q4_K_M"
                : "Enter a HuggingFace safetensors model, e.g. Qwen/Qwen3.5-4B"}
            </span>
          </button>
          {isCustom && (
            <Input
              placeholder={
                engine === "llama.cpp" ? "user/Model-GGUF:Q4_K_M" : "Qwen/Qwen3.5-4B"
              }
              value={customHfModel}
              onChange={(e) => setCustomHfModel(e.target.value)}
              className="h-8 text-sm"
              autoFocus
            />
          )}

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep("engine")}>
              <ArrowLeftIcon data-icon="inline-start" />
              Back
            </Button>
            <Button
              className="flex-1"
              size="sm"
              disabled={!canPickModelNext}
              onClick={() => setStep("start")}
            >
              Next
              <ArrowRightIcon />
            </Button>
          </div>
          <SkipSetupButton onComplete={onComplete} />
        </div>
      )}

      {step === "start" && (
        <div className="flex flex-col gap-3">
          {!env && (envQuery.isLoading || envQuery.isFetching) && (
            <>
              <div className="flex justify-center py-6">
                <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              </div>
              <SkipSetupButton onComplete={onComplete} />
            </>
          )}

          {env && !ready && (
            <>
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-3 rounded-lg border px-4 py-3">
                  <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-amber-500" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">
                      {ENGINE_LABEL[engine]} 未就绪
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      安装：{" "}
                      <code className="rounded bg-muted px-1 text-[11px]">
                        {ENGINE_CHOICES.find((c) => c.id === engine)!.installHint(env)}
                      </code>
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      安装完成后点击「重新检测」；也可以返回上一步选择其他引擎。
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setStep("model")}>
                    <ArrowLeftIcon data-icon="inline-start" />
                    Back
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => envQuery.refetch()}
                  >
                    {envQuery.isFetching ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <RefreshCwIcon data-icon="inline-start" />
                    )}
                    重新检测
                  </Button>
                </div>
              </div>
              <SkipSetupButton onComplete={onComplete} />
            </>
          )}

          {env && ready && !isCustom && planLoading && (
            <div className="flex flex-col gap-3">
              <div className="flex justify-center py-6">
                <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              </div>
              <SkipSetupButton onComplete={onComplete} />
            </div>
          )}

          {env && ready && !isCustom && !planLoading && !plan && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-8 text-center">
              <AlertTriangleIcon className="size-5 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">无法获取模型文件信息</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setStep("model")}>
                  <ArrowLeftIcon data-icon="inline-start" />
                  Back
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPlanNonce((n) => n + 1)}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  重试
                </Button>
              </div>
              <SkipSetupButton onComplete={onComplete} />
            </div>
          )}

          {env && ready && !isCustom && plan && !downloaded && (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3 rounded-lg border px-4 py-3">
                <DownloadIcon className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{plan.repo}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {plan.files.length > 1 ? `${plan.files.length} 个文件 · ` : ""}
                    {formatBytes(planSize)}（{ENGINE_LABEL[engine]}）
                  </p>
                  {plan.files[0] && (
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
                      {plan.files[0].name}
                    </p>
                  )}
                </div>
              </div>

              {planFailed ? (
                <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <XCircleIcon className="size-3.5 shrink-0" />
                  下载失败，请检查网络后重试。
                </div>
              ) : planBusy || planPercent != null ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      {planFailed
                        ? "下载失败"
                        : planBusy
                          ? "下载中…"
                          : "等待下载…"}
                    </span>
                    <span className="tabular-nums">{planPercent != null ? `${planPercent}%` : ""}</span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${planPercent ?? 0}%` }}
                    />
                  </div>
                </div>
              ) : plan.files.length === 0 ? (
                <p className="text-xs text-destructive">未在该仓库找到可用的模型文件。</p>
              ) : (
                <Button onClick={() => void handleDownload()}>
                  <DownloadIcon data-icon="inline-start" />
                  下载模型（{formatBytes(planSize)}）
                </Button>
              )}

              <p className="text-center text-[11px] text-muted-foreground">
                模型未下载，下载完成后才能启动服务器。
              </p>

              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setStep("model")}>
                  <ArrowLeftIcon data-icon="inline-start" />
                  Back
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => envQuery.refetch()}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  重新检测
                </Button>
              </div>
              <SkipSetupButton onComplete={onComplete} />
            </div>
          )}

          {env && ready && (isCustom || (plan !== null && downloaded)) && (
            <LocalStartStep
              onBack={() => setStep("model")}
              onStart={handleStartLocal}
              onComplete={onComplete}
              serverStatus={serverStatus}
              serverLogs={serverLogs}
              startError={startServerMutation.data?.error}
              title={ENGINE_LABEL[engine]}
            />
          )}
        </div>
      )}
    </>
  );
}
