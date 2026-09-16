import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontalIcon, ChevronDownIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Input } from "@ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { type InferenceEngine } from "@/shared/modelscope";
import { cn } from "@/mainview/lib/utils";

// ---------------------------------------------------------------------------
// 启动参数
// ---------------------------------------------------------------------------

export type ParamNumberField = { key: string; labelKey: string; step?: string };
type ParamSelectField = { key: string; labelKey: string; options: { value: string; label: string }[] };
type ParamField = (ParamNumberField & { options?: undefined }) | (ParamSelectField & { step?: undefined });

export const PARAM_FIELDS: Record<InferenceEngine, ParamField[]> = {
  "llama.cpp": [
    { key: "SERVER_CTX_SIZE", labelKey: "models.params.ctx" },
    { key: "SERVER_PARALLEL", labelKey: "models.params.parallel" },
    { key: "SERVER_BATCH_SIZE", labelKey: "models.params.batch" },
    { key: "SERVER_UBATCH_SIZE", labelKey: "models.params.ubatch" },
    { key: "SERVER_TEMP", labelKey: "models.params.temp", step: "0.1" },
    { key: "SERVER_TOP_P", labelKey: "models.params.topP", step: "0.05" },
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
  ],
  mlx: [{ key: "MLX_CACHE_SIZE_GB", labelKey: "models.params.mlxCacheGb", step: "1" }],
};

/** 与引擎无关的生成 / 文档处理参数：vLLM 重试次数与页面并发（原来的「设置 → 性能」页）。 */
export const PIPELINE_FIELDS: ParamNumberField[] = [
  { key: "MAX_VLLM_RETRIES", labelKey: "models.params.retries" },
  { key: "MAX_VLLM_FAILURE_RETRIES", labelKey: "models.params.failureRetries" },
  { key: "PAGE_CONCURRENCY", labelKey: "models.params.pageConcurrency" },
];

/** 数字参数输入：编辑中不写库，失焦 / Enter 时提交（下次启动生效）。 */
function ParamInput({
  label,
  value,
  step,
  onCommit,
}: {
  label: string;
  value: string;
  step?: string;
  onCommit: (value: string) => void;
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
    </label>
  );
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

  const saveMutation = useMutation({
    mutationFn: (patch: Record<string, string>) => rpcClient.updateSettings({ settings: patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const commit = (patch: Record<string, string>) => saveMutation.mutate(patch);

  return (
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
            {fields.map((f) =>
              f.options ? (
                <label key={f.key} className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">{t(f.labelKey)}</span>
                  <Select
                    value={settings[f.key] ?? f.options[0]?.value}
                    onValueChange={(v) =>
                      commit(
                        f.key === "SERVER_CACHE_TYPE_K" ? { SERVER_CACHE_TYPE_K: v, SERVER_CACHE_TYPE_V: v } : { [f.key]: v },
                      )
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {f.options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ) : (
                <ParamInput
                  key={f.key}
                  label={t(f.labelKey)}
                  value={settings[f.key] ?? ""}
                  step={f.step}
                  onCommit={(v) => commit({ [f.key]: v })}
                />
              ),
            )}
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
        </div>
      )}
    </div>
  );
}
