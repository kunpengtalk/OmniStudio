import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, EraserIcon, ChevronDownIcon, CircleIcon, Wand2Icon, ImagePlusIcon, XIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Textarea } from "@ui/textarea";
import { Badge } from "@ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/collapsible";
import { useT } from "@stores/ui-lang";
import { CloudModelSelect } from "@components/cloud-model-select";
import { ResultError } from "@components/media-result";
import { useImageStore } from "@stores/image";
import type { ImageGenBackend, ImageRecordRow } from "../../../bun/image-gen";
import { cn } from "@/mainview/lib/utils";
import { RATIOS, ImageCard, GenLoading, RecentStrip } from "./parts";

export function EditTab() {
  const t = useT();
  const queryClient = useQueryClient();

  const [reference, setReference] = useState<{ ref: string; url: string }>();
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [ratioIdx, setRatioIdx] = useState(3); // 1:1
  const [count, setCount] = useState(1);
  const [steps, setSteps] = useState(25);
  const [seed, setSeed] = useState("");
  const [model, setModel] = useState("");
  const [results, setResults] = useState<ImageRecordRow[]>();

  // ---------- 后端配置（与生图页共用同一套配置与落盘） ----------
  const [backend, setBackend] = useState<ImageGenBackend>("api");
  const [providerId, setProviderId] = useState("");
  const [comfyBase, setComfyBase] = useState("");
  const [configError, setConfigError] = useState<string>();
  const hydrated = useRef(false);

  const { data: configData } = useQuery({
    queryKey: ["image-gen-config"],
    queryFn: () => rpcClient.getImageGenConfig(),
  });
  const config = configData?.config;

  useEffect(() => {
    if (!config || hydrated.current) return;
    hydrated.current = true;
    setBackend(config.backend);
    setProviderId(config.providerId);
    setComfyBase(config.comfyBase);
    setModel(config.model);
  }, [config]);

  // patch 用于「选完即存」：选择器刚回传的新值还没进 state，直接读 state 会存下旧厂商。
  const saveConfig = useMutation({
    mutationFn: (patch: { providerId?: string; model?: string } = {}) =>
      rpcClient.saveImageGenConfig({
        backend,
        providerId: (patch.providerId ?? providerId).trim(),
        comfyBase: comfyBase.trim(),
        model: (patch.model ?? model).trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["image-gen-config"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    },
  });

  // 修图只用云端后端（见 image.edit.backendNote），模型清单来自厂商的选择器。

  // ---------- 参考图选择 ----------
  const pickReference = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "png,jpg,jpeg,webp",
      });
      if (paths.length === 0) return undefined;
      const { files } = await rpcClient.stageEditImage({ paths });
      return files[0];
    },
    onSuccess: (file) => {
      if (file) setReference(file);
    },
    onError: (e) => setConfigError(String(e)),
  });

  // ---------- 以图改图 ----------
  const generate = useMutation({
    mutationFn: () => {
      const ratio = RATIOS[ratioIdx]!;
      const parsedSeed = Number.parseInt(seed, 10);
      return rpcClient.generateImage({
        prompt,
        negativePrompt: negative.trim() || undefined,
        width: ratio.w,
        height: ratio.h,
        count,
        steps,
        seed: Number.isFinite(parsedSeed) && parsedSeed >= 0 ? parsedSeed : undefined,
        model: model.trim() || undefined,
        referenceImageRef: reference?.ref,
        // 页面上的实时配置一并带上，后端优先使用它们并落盘（同生图页）。
        config: {
          backend,
          providerId: providerId.trim(),
          model: model.trim(),
          comfyBase: comfyBase.trim(),
        },
      });
    },
    onSuccess: (r) => {
      if (r.error) {
        setConfigError(r.error);
        return;
      }
      setConfigError(undefined);
      if (r.records.length > 0) setResults(r.records);
      queryClient.invalidateQueries({ queryKey: ["image-records"] });
      queryClient.invalidateQueries({ queryKey: ["image-gen-config"] });
    },
    onError: (e) => setConfigError(String(e)),
  });

  const { data: recordsData } = useQuery({
    queryKey: ["image-records"],
    queryFn: () => rpcClient.listImageRecords(undefined),
  });

  // 参考图修图必须：选了图 + 填了提示词 + 云端后端（MLX/ComfyUI 不支持）+ 选好厂商。
  const canGenerate =
    !!reference &&
    !!prompt.trim() &&
    backend === "api" &&
    !!providerId.trim() &&
    !!model.trim() &&
    !generate.isPending;
  const ratio = RATIOS[ratioIdx]!;
  /** 当前后端的显示名（修图页只读展示；生图页的三档切换另有开关）。 */
  const backendLabel = t(
    backend === "api"
      ? "image.backend.cloud"
      : backend === "mlx"
        ? "image.backend.mlx"
        : "image.backend.comfyui",
  );

  return (
    <div className="flex h-full min-h-0">
      {/* 中间：参数面板 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 后端是只读展示，不是三档切换 —— 修图固定走云端（canGenerate 要求 api），
              而这里的三档切换改的是**全局** IMG_BACKEND：在修图页点一下 MLX，
              生图页的后端就被悄悄换掉了，用户回到生图页只会觉得"设置自己变了"。 */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("image.backend")}</Label>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[11px]">
                {backendLabel}
              </Badge>
              {backend !== "api" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setBackend("api");
                    void rpcClient.saveImageGenConfig({ backend: "api" });
                  }}
                >
                  {t("image.edit.switchToCloud")}
                </Button>
              )}
            </div>
            {backend !== "api" && (
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                {t("image.edit.backendIs", { backend: backendLabel })}
              </p>
            )}
          </div>

          {backend === "api" ? (
            // 云端修图：与生图页相同 —— 只选厂商 + 模型，不做地址 / 密钥输入。
            <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
              <div>
                <Label className="mb-1 block text-xs">{t("image.config.cloudProvider")}</Label>
                <CloudModelSelect
                  kind="image"
                  providerId={providerId}
                  model={model}
                  size="sm"
                  onChange={(choice) => {
                    setProviderId(choice.providerId);
                    setModel(choice.model);
                    saveConfig.mutate(choice);
                  }}
                />
                <p className="mt-1.5 text-[10px] text-muted-foreground">{t("cloud.where")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => saveConfig.mutate({})}
                  disabled={saveConfig.isPending || !providerId.trim()}
                >
                  {saveConfig.isPending ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : null}
                  {t("image.config.save")}
                </Button>
                {providerId.trim() && (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <CircleIcon className="size-2.5 fill-current text-emerald-500" />
                    {t("image.config.configured")}
                  </Badge>
                )}
              </div>
              {configError && <ResultError error={configError} />}
            </div>
          ) : (
            <div className="rounded-lg border bg-card p-3 text-[11px] leading-relaxed text-muted-foreground">
              {t("image.edit.backendNote")}
            </div>
          )}

          {/* 参考图：修图页与生图页唯一的区别 */}
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              <Wand2Icon className="size-4 shrink-0 text-primary" />
              <p className="text-xs font-medium">{t("image.edit.reference")}</p>
            </div>
            {reference ? (
              <div className="flex items-center gap-3">
                <img
                  src={reference.url}
                  alt=""
                  className="size-16 shrink-0 rounded-lg border object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] text-muted-foreground">
                    {t("image.edit.referenceReady")}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1.5 h-7 gap-1 text-[11px]"
                    disabled={pickReference.isPending}
                    onClick={() => pickReference.mutate()}
                  >
                    <ImagePlusIcon className="size-3.5" />
                    {t("image.edit.repick")}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  tooltip={t("image.edit.remove")}
                  onClick={() => setReference(undefined)}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="h-24 w-full flex-col gap-2 border-dashed"
                disabled={pickReference.isPending}
                onClick={() => pickReference.mutate()}
              >
                {pickReference.isPending ? (
                  <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
                ) : (
                  <ImagePlusIcon className="size-5 text-muted-foreground" />
                )}
                <span className="text-xs">{t("image.edit.select")}</span>
              </Button>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("image.edit.hint")}
            </p>
          </div>

          {/* 修改提示词 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="edit-prompt" className="text-xs">
                {t("image.prompt")}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                onClick={() => setPrompt("")}
              >
                <EraserIcon className="size-3" />
                {t("image.prompt.clear")}
              </Button>
            </div>
            <Textarea
              id="edit-prompt"
              rows={7}
              placeholder={t("image.edit.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="resize-none text-xs"
            />
          </div>

          {/* 参数（与生图页一致） */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <p className="text-xs font-medium">{t("image.params")}</p>

            <div>
              <Label className="mb-1.5 block text-[11px] text-muted-foreground">
                {t("image.params.ratio")}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {RATIOS.map((r, i) => (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => setRatioIdx(i)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] tabular-nums transition-colors",
                      ratioIdx === i
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="edit-width" className="mb-1 block text-[11px] text-muted-foreground">
                  {t("image.params.width")}
                </Label>
                <Input id="edit-width" type="number" value={ratio.w} disabled className="h-8 text-xs tabular-nums" />
              </div>
              <div>
                <Label htmlFor="edit-height" className="mb-1 block text-[11px] text-muted-foreground">
                  {t("image.params.height")}
                </Label>
                <Input id="edit-height" type="number" value={ratio.h} disabled className="h-8 text-xs tabular-nums" />
              </div>
            </div>

            <div>
              <Label htmlFor="edit-count" className="mb-1 block text-[11px] text-muted-foreground">
                {t("image.params.count")}
              </Label>
              <Input
                id="edit-count"
                type="number"
                min={1}
                max={8}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                className="h-8 text-xs tabular-nums"
              />
            </div>

            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                {t("image.params.advanced")}
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-3 pt-3">
                <div>
                  <Label htmlFor="edit-negative" className="mb-1 block text-[11px] text-muted-foreground">
                    {t("image.params.negative")}
                  </Label>
                  <Textarea
                    id="edit-negative"
                    rows={2}
                    placeholder={t("image.params.negativePlaceholder")}
                    value={negative}
                    onChange={(e) => setNegative(e.target.value)}
                    className="resize-none text-xs"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="edit-steps" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.steps")}
                    </Label>
                    <Input
                      id="edit-steps"
                      type="number"
                      min={1}
                      max={100}
                      value={steps}
                      onChange={(e) => setSteps(Math.max(1, Math.min(100, Number(e.target.value) || 25)))}
                      className="h-8 text-xs tabular-nums"
                    />
                  </div>
                  <div>
                    <Label htmlFor="edit-seed" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.seed")}
                    </Label>
                    <Input
                      id="edit-seed"
                      type="number"
                      min={-1}
                      placeholder="-1"
                      value={seed}
                      onChange={(e) => setSeed(e.target.value)}
                      className="h-8 text-xs tabular-nums"
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <Button size="lg" onClick={() => generate.mutate()} disabled={!canGenerate} className="w-full">
            {generate.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <Wand2Icon data-icon="inline-start" />
            )}
            {generate.isPending ? t("image.editing") : t("image.edit")}
          </Button>
          {!reference && backend === "api" ? (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("image.edit.needReference")}
            </p>
          ) : reference && backend !== "api" ? (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("image.edit.backendNote")}
            </p>
          ) : null}
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 右上角：参考图悬浮预览卡 */}
        {reference && (
          <div className="absolute right-5 top-5 z-20 w-44 overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur">
            <div className="relative aspect-video overflow-hidden bg-muted">
              <img src={reference.url} alt="" className="size-full object-cover" />
              <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white">
                {t("image.edit.reference")}
              </span>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 items-center justify-center p-8 pt-16">
          {generate.isPending ? (
            <GenLoading prompt={prompt} />
          ) : results?.length ? (
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-5">
              {results.map((r) => (
                <ImageCard key={r.id} record={r} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
                <Wand2Icon className="size-9 text-primary" />
              </div>
              <p className="text-lg font-medium">{t("image.edit.title")}</p>
              <p className="max-w-xs text-sm text-muted-foreground">{t("image.edit.emptyHint")}</p>
            </div>
          )}
        </div>

        <RecentStrip
          records={recordsData?.records ?? []}
          onOpenHistory={() => useImageStore.getState().setView("history")}
        />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面入口：按左侧边栏工具菜单切换；历史记录在左侧主侧边栏查看
// ---------------------------------------------------------------------------

