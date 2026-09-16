import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, CheckIcon, FolderOpenIcon, ChevronDownIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { MODEL_PROFILES } from "@/shared/model-profiles";
import { MODEL_QUANTS } from "../setup-screen/constants";
import { cn } from "@/mainview/lib/utils";
import { formatBytes } from "./parts";
import { ModelDirsManager } from "./model-dirs";

// ---------------------------------------------------------------------------
// 默认模型与目录（从设置页迁入）
// ---------------------------------------------------------------------------

export function DefaultModelConfig() {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data?.settings) setForm((prev) => ({ ...prev, ...data.settings }));
  }, [data]);

  const updateField = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const saveMutation = useMutation({
    mutationFn: () => {
      const keys = ["VLLM_MODEL_PROFILE", "CUSTOM_HF_MODEL"] as const;
      const patch: Record<string, string> = {};
      for (const k of keys) if (form[k] !== undefined) patch[k] = form[k];
      return rpcClient.updateSettings({ settings: patch });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["model-dirs"] });
    },
  });

  const currentProfileId = form.VLLM_MODEL_PROFILE ?? "chandra";
  const isCustomLocal = !MODEL_PROFILES.some((p) => p.id === currentProfileId);
  const quantInfo = MODEL_QUANTS[currentProfileId];
  const currentQuant = (() => {
    const custom = form.CUSTOM_HF_MODEL;
    if (custom && quantInfo) {
      const suffix = custom.split(":")[1];
      if (suffix && quantInfo.quants.some((q) => q.name === suffix)) return suffix;
    }
    return quantInfo?.defaultQuant ?? "";
  })();

  const ALL_PROFILES = [
    ...MODEL_PROFILES.map((p) => ({ id: p.id, label: p.label })),
    { id: "none" as const, label: "None (raw output)" },
  ];

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-xs font-medium text-muted-foreground"
      >
        <FolderOpenIcon className="size-3.5" />
        {t("settings.defaultModel")}
        <ChevronDownIcon className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="flex flex-col gap-4 pt-1">
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

          <ModelDirsManager />

          <div className="flex items-center gap-3 border-t pt-3">
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : saveMutation.isSuccess ? (
                <CheckIcon data-icon="inline-start" />
              ) : null}
              {saveMutation.isSuccess ? t("common.saved") : t("common.save")}
            </Button>
            <p className="text-[11px] text-muted-foreground">{t("settings.restartHint")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
