import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontalIcon, ChevronDownIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Input } from "@ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { type InferenceEngine } from "@/shared/modelscope";
import { cn } from "@/mainview/lib/utils";
import { LaunchPlanPreviewCard } from "./launch-preview";
import type { LaunchPlan } from "@/shared/launch-planner";


// ---------------------------------------------------------------------------
// 启动参数
// ---------------------------------------------------------------------------

type ParamFieldBase = { key: string; labelKey: string };
type ParamNumberField = ParamFieldBase & {
  step?: string;
  /**
   * 依赖字段的条件禁用：返回非空文案（i18n key）时该字段只读，并在输入框旁显示
   * 「实际生效值」（用户之前手动填的值保留，依赖关闭后恢复可编辑）。只用于 llama.cpp
   * 的自动启动参数：`SERVER_AUTO_TUNE === "1"` 时 ctx / batch / ubatch 被自动推算接管；
   * `SERVER_PARALLEL`、采样参数、KV 缓存类型不由显存推算接管，不设此项。
   */
  disabledWhen?: (settings: Record<string, string>) => string | null;
};
type ParamSelectOption = {
  value: string;
  /** 语言无关的技术值（`q8_0` / `mmap+mlock`），也是落库的值。 */
  label: string;
  /** 需要解释的选项给词条；纯技术值（q8_0）用它反而啰嗦，留 label 就够。 */
  labelKey?: string;
};
type ParamSelectField = ParamFieldBase & {
  /** 选项下面那行说明（有风险的参数写在这里，别让用户凭名字猜）。 */
  hintKey?: string;
  options: ParamSelectOption[];
};
type ParamField = ParamNumberField | ParamSelectField;

export const PARAM_FIELDS: Record<InferenceEngine, ParamField[]> = {
  "llama.cpp": [
    {
      key: "SERVER_AUTO_TUNE",
      labelKey: "models.params.autoTune",
      hintKey: "models.params.autoTuneHint",
      options: [
        { value: "0", label: "manual", labelKey: "models.params.autoTune.manual" },
        { value: "1", label: "auto", labelKey: "models.params.autoTune.auto" },
      ],
    },
    {
      key: "SERVER_FLASH_ATTN",
      labelKey: "models.params.flashAttn",
      hintKey: "models.params.flashAttnHint",
      options: [
        { value: "auto", label: "auto", labelKey: "models.params.flashAttn.auto" },
        { value: "on", label: "on", labelKey: "models.params.flashAttn.on" },
        { value: "off", label: "off", labelKey: "models.params.flashAttn.off" },
      ],
    },
    { key: "SERVER_CTX_SIZE", labelKey: "models.params.ctx", disabledWhen: autoTunedField },
    { key: "SERVER_PARALLEL", labelKey: "models.params.parallel" },
    {
      key: "SERVER_BATCH_SIZE",
      labelKey: "models.params.batch",
      disabledWhen: autoTunedField,
    },
    {
      key: "SERVER_UBATCH_SIZE",
      labelKey: "models.params.ubatch",
      disabledWhen: autoTunedField,
    },
    { key: "SERVER_TEMP", labelKey: "models.params.temp", step: "0.1" },
    { key: "SERVER_TOP_P", labelKey: "models.params.topP", step: "0.05" },
    { key: "SERVER_TOP_K", labelKey: "models.params.topK" },
    { key: "SERVER_REPEAT_PENALTY", labelKey: "models.params.repeatPenalty", step: "0.01" },
    { key: "SERVER_GPU_LAYERS", labelKey: "models.params.gpuLayers" },
    {
      key: "SERVER_CACHE_TYPE_K",
      labelKey: "models.params.cacheType",
      options: [
        { value: "q8_0", label: "q8_0" },
        { value: "f16", label: "f16" },
        { value: "q4_0", label: "q4_0" },
      ],
    },
    {
      key: "SERVER_LOAD_MODE",
      labelKey: "models.params.loadMode",
      hintKey: "models.params.loadModeHint",
      options: [
        { value: "auto", label: "auto", labelKey: "models.params.loadMode.auto" },
        { value: "mmap", label: "mmap", labelKey: "models.params.loadMode.mmap" },
        { value: "mlock", label: "mlock", labelKey: "models.params.loadMode.mlock" },
        {
          value: "mmap+mlock",
          label: "mmap+mlock",
          labelKey: "models.params.loadMode.mmapMlock",
        },
        { value: "none", label: "none", labelKey: "models.params.loadMode.none" },
        { value: "dio", label: "dio", labelKey: "models.params.loadMode.dio" },
      ],
    },
  ],
  vllm: [
    { key: "VLLM_MAX_MODEL_LEN", labelKey: "models.params.maxModelLen" },
    { key: "VLLM_TENSOR_PARALLEL_SIZE", labelKey: "models.params.tp" },
    { key: "VLLM_GPU_MEMORY_UTILIZATION", labelKey: "models.params.gpuMem", step: "0.05" },
    {
      key: "VLLM_DTYPE",
      labelKey: "models.params.dtype",
      options: [
        { value: "auto", label: "auto" },
        { value: "bfloat16", label: "bfloat16" },
        { value: "half", label: "half" },
        { value: "fp32", label: "fp32" },
      ],
    },
  ],
  sglang: [
    { key: "SGLANG_CONTEXT_LENGTH", labelKey: "models.params.ctx" },
    { key: "SGLANG_TP_SIZE", labelKey: "models.params.tp" },
    { key: "SGLANG_MEM_FRACTION_STATIC", labelKey: "models.params.memFraction", step: "0.02" },
    // 分块预填充（PERF-05）：设置键一直存在，但此前只能手改数据库 —— 长 prompt 场景
    // 要压住预填充的显存峰值就得改它。
    { key: "SGLANG_CHUNKED_PREFILL_SIZE", labelKey: "models.params.chunkedPrefill" },
  ],
  mlx: [{ key: "MLX_CACHE_SIZE_GB", labelKey: "models.params.mlxCacheGb", step: "1" }],
  omlx: [
    {
      key: "OMLX_MEMORY_GUARD",
      labelKey: "models.params.omlxGuard",
      hintKey: "models.params.omlxGuardHint",
      options: [
        { value: "safe", label: "safe" },
        { value: "balanced", label: "balanced" },
        { value: "aggressive", label: "aggressive" },
        { value: "off", label: "off" },
      ],
    },
    { key: "OMLX_MAX_CONCURRENT_REQUESTS", labelKey: "models.params.omlxMaxConcurrent", step: "1" },
  ],
};

/** 与引擎无关的生成 / 文档处理参数：vLLM 重试次数与页面并发（原来的「设置 → 性能」页）。 */
export const PIPELINE_FIELDS: ParamNumberField[] = [
  { key: "MAX_VLLM_RETRIES", labelKey: "models.params.retries" },
  { key: "MAX_VLLM_FAILURE_RETRIES", labelKey: "models.params.failureRetries" },
  { key: "PAGE_CONCURRENCY", labelKey: "models.params.pageConcurrency" },
];

/**
 * 服务生命周期参数（与引擎无关，四种本地引擎共用一条）。
 *
 * 放在这里而不是按引擎列，是因为它管的是「进程还要不要活着」，跟引擎怎么启动无关；
 * 塞进 vLLM / SGLang 那几列反而会说出一个假事实 —— 好像只有那个引擎会空闲卸载。
 */
export const LIFECYCLE_FIELDS: ParamNumberField[] = [
  { key: "SERVER_IDLE_UNLOAD_MINUTES", labelKey: "models.params.idleUnload" },
];

/** 数字参数输入：编辑中不写库，失焦 / Enter 时提交（下次启动生效）。 */
function ParamInput({
  label,
  value,
  step,
  onCommit,
  disabled,
  disabledNote,
}: {
  label: string;
  value: string;
  step?: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  /** 只读时的旁注（i18n key）；值本身保留，只挡编辑。 */
  disabledNote?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Input
        type="number"
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim() !== "" && draft !== value) onCommit(draft.trim());
          else setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-8 text-xs"
      />
      {disabled && disabledNote !== undefined && (
        <span className="text-[10px] leading-relaxed text-muted-foreground/70">{disabledNote}</span>
      )}
    </label>
  );
}

/**
 * 自动启动参数接管的那三个字段（ctx / batch / ubatch）：开启自动后只读。
 * 返回只读旁注的 i18n key（不是值本身）；返回 null = 可正常编辑。
 * `SERVER_PARALLEL`、采样参数、KV 缓存类型都不由显存推算接管，不列在这里。
 */
function autoTunedField(settings: Record<string, string>): string | null {
  return settings.SERVER_AUTO_TUNE === "1" ? "models.params.autoTuned" : null;
}

/**
 * 自动接管时输入框旁的实际生效值（i18n key 由 `autoTunedField` 提供，这里只给
 * `{ value }` 参数）：以 `plan`（计划预览）优先 —— 它才是「真正会用的那份」；
 * 没有计划（RPC 未返回 / 失败）时回落到设置里的值，避免用户对着空值发呆。
 * 返回 null = 不显示旁注（未接管或无值）。
 */
function autoTunedNoteParam(settings: Record<string, string>, key: string, plan?: LaunchPlan | null): { value: string } | null {
  if (settings.SERVER_AUTO_TUNE !== "1") return null;
  let value: string | undefined;
  if (plan) {
    value =
      key === "SERVER_CTX_SIZE"
        ? String(plan.ctxTokens)
        : key === "SERVER_BATCH_SIZE"
          ? String(plan.batch)
          : key === "SERVER_UBATCH_SIZE"
            ? String(plan.ubatch)
            : undefined;
  }
  if (value === undefined) value = settings[key];
  return value !== undefined && value !== "" ? { value } : null;
}

/** 当前引擎的启动参数（上下文长度等），改完即写入设置，下一次启动/重启推理服务器时生效。 */
export function ServerParamsPanel({ engine }: { engine: InferenceEngine }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const settings = data?.settings ?? {};
  const fields = PARAM_FIELDS[engine];

  // 自动启动参数开启 + llama.cpp + 已有选中模型时，参数面板上方展示一张计划预览卡。
  // 模型路径取「当前聊天模型」设置（LOCAL_MODEL_PATH），与启动条同源。
  const autoTuneOn = engine === "llama.cpp" && settings.SERVER_AUTO_TUNE === "1";
  const activePath = (settings.LOCAL_MODEL_PATH ?? "").trim();

  // 被自动接管的三个字段（ctx / batch / ubatch）需要「真正会用的那份」值做旁注；
  // 与预览卡共用同一个 RPC 结果，避免重复请求（query key 相同 → TanStack 去重）。
  const planQuery = useQuery({
    queryKey: [
      "launch-plan-preview",
      activePath,
      settings.SERVER_AUTO_TUNE,
      settings.SERVER_PARALLEL,
      settings.SERVER_BATCH_SIZE,
      settings.SERVER_UBATCH_SIZE,
      settings.SERVER_CACHE_TYPE_K,
      settings.SERVER_CACHE_TYPE_V,
      settings.SERVER_FLASH_ATTN,
      settings.SERVER_FLASH_ATTN_EFFECTIVE,
      settings.SERVER_AUTO_TUNE_MIN_CTX,
    ],
    queryFn: () => rpcClient.getLaunchPlanPreview({ path: activePath }),
    enabled: autoTuneOn && activePath !== "",
  });
  const plan = planQuery.data?.ok ? planQuery.data.plan : undefined;

  const saveMutation = useMutation({
    mutationFn: (patch: Record<string, string>) => rpcClient.updateSettings({ settings: patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const commit = (patch: Record<string, string>) => saveMutation.mutate(patch);

  return (
    <div className="flex flex-col gap-2">
      {autoTuneOn && activePath !== "" && <LaunchPlanPreviewCard modelPath={activePath} settings={settings} />}
      <div className="flex flex-col gap-2 rounded-lg border p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-xs font-medium text-muted-foreground"
      >
        <SlidersHorizontalIcon className="size-3.5" />
        {t("models.params")}
        <span className="text-[10px] font-normal text-muted-foreground/60">{t("models.paramsHint")}</span>
        <ChevronDownIcon className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {fields.map((f) => {
              const dw = "disabledWhen" in f ? f.disabledWhen : undefined;
              const noteKey = typeof dw === "function" ? dw(settings) : null;
              const disabled = noteKey !== null;
              return "options" in f ? (
                <label key={f.key} className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">{t(f.labelKey)}</span>
                  <Select
                    value={settings[f.key] ?? f.options[0]?.value}
                    onValueChange={(v) => {
                      if (disabled) return;
                      commit(
                        f.key === "SERVER_CACHE_TYPE_K" ? { SERVER_CACHE_TYPE_K: v, SERVER_CACHE_TYPE_V: v } : { [f.key]: v },
                      );
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs" disabled={disabled}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {f.options.map((o) => (
                        <SelectItem key={o.value} value={o.value} disabled={disabled}>
                          {o.labelKey ? t(o.labelKey) : o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {f.hintKey && (
                    <span className="text-[10px] leading-relaxed text-muted-foreground/70">
                      {t(f.hintKey)}
                    </span>
                  )}
                </label>
                ) : (
                <ParamInput
                  key={f.key}
                  label={t(f.labelKey)}
                  value={settings[f.key] ?? ""}
                  step={"step" in f ? f.step : undefined}
                  disabled={disabled}
                  disabledNote={
                    disabled && noteKey !== null
                      ? (() => {
                          const param = autoTunedNoteParam(settings, f.key, plan);
                          return param === null ? t(noteKey) : t(noteKey, param);
                        })()
                      : undefined
                  }
                  onCommit={(v) => {
                    if (disabled) return;
                    commit({ [f.key]: v });
                  }}
                />
              );
            })}
          </div>

          <div className="flex flex-col gap-2 border-t pt-3">
            <span className="text-[11px] text-muted-foreground">{t("models.params.pipeline")}</span>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {PIPELINE_FIELDS.map((f) => (
                <ParamInput
                  key={f.key}
                  label={t(f.labelKey)}
                  value={settings[f.key] ?? ""}
                  onCommit={(v) => commit({ [f.key]: v })}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t pt-3">
            <span className="text-[11px] text-muted-foreground">{t("models.params.lifecycle")}</span>
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">
              {t("models.params.idleUnloadHint")}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {LIFECYCLE_FIELDS.map((f) => (
                <ParamInput
                  key={f.key}
                  label={t(f.labelKey)}
                  value={settings[f.key] ?? ""}
                  onCommit={(v) => commit({ [f.key]: v })}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
