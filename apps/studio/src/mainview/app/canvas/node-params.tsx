/**
 * 画布节点的**生成参数面板**：把生图 / 生视频 / 生音乐 / 语音四个功能页的参数面
 * 原样搬进节点 —— 尺寸档位、数量、步数、随机种子、负向提示词、量化、参考图、
 * 首帧、歌词、格式 / 采样率、参考音频、TTS 引擎与男女音色，一个不少。
 *
 * 两个刻意的取舍：
 * 1. **预设与选择器一律从功能页 import**（`app/image/parts.tsx` 的 RATIOS、
 *    `app/video/parts.tsx` 的时长/分辨率档位、`app/music/parts.tsx` 的格式与任务、
 *    `app/voice/parts.tsx` 的 EdgeVoicePicker / LocalVoicePicker、
 *    组件 `VendorVoiceField`）—— 各抄一份必然与功能页漂移，用户会在两处看到不同档位。
 * 2. 只做参数本身：引擎安装 / 模型下载 / 启停仍归功能页与设置页（节点里给明确提示），
 *    否则画布会长成一个半吊子的引擎管理器。
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { AlertTriangleIcon, FileImageIcon, FileAudioIcon, ShuffleIcon, XIcon } from "lucide-react";

import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Switch } from "@ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { cn } from "@/mainview/lib/utils";
import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { useRouter } from "@stores/router";
import { chatImageUrl } from "@/shared/server-info";
import { audioVendorFor } from "@/shared/tts-voices";
import { detectReferenceAudioSupport } from "@/shared/tts-reference-audio";
import { RATIOS as IMAGE_RATIOS } from "../image/parts";
import { MLX_FALLBACKS } from "@lib/image-model";
import { DURATION_RANGE, RESOLUTIONS, DEFAULT_RESOLUTION, RATIOS as VIDEO_RATIOS, snapDuration } from "../video/parts";
import { FORMATS, TASK_LABELS as MUSIC_TASK_LABELS, LYRIC_TAGS } from "../music/parts";
import { EdgeVoicePicker, LocalVoicePicker, useClones } from "../voice/parts";
import { VendorVoiceField } from "@components/vendor-voice-select";
import { useCanvasStore } from "./canvas-store";
import type { CanvasNodeData } from "@/shared/canvas";

const SAMPLE_RATES = [0, 24000, 32000, 44100, 48000];
const MUSIC_TASKS = ["text_to_music", "music_cover", "vocal_to_music"] as const;

/** 当前云厂商行的协议（视频 minimax/seedance、音乐 stepfun/minimax），决定档位。 */
function useProviderProtocols(providerId: string | undefined) {
  const { data } = useQuery({
    queryKey: ["cloud-providers"],
    queryFn: () => rpcClient.cloudProviderList(undefined),
  });
  const provider = data?.providers.find((p) => p.id === providerId);
  return {
    provider,
    videoProtocol: (provider?.videoApi === "seedance" ? "seedance" : "minimax") as "minimax" | "seedance",
    musicProtocol: (provider?.musicApi === "minimax" ? "minimax" : "stepfun") as "stepfun" | "minimax",
  };
}

// ---------------------------------------------------------------------------
// 生图
// ---------------------------------------------------------------------------

export function ImageNodeParams({ node }: { node: CanvasNodeData }) {
  const t = useT();
  const update = (patch: Partial<CanvasNodeData>) => useCanvasStore.getState().updateNode(node.id, patch);
  const backend = node.model?.backend ?? "api";
  // 本地后端要把"引擎装没装 / 权重下没下"提前摆出来：否则用户点生成才拿到
  // "引擎未安装"，还得自己找去哪儿装（这是真实踩过的坑）。
  const mlxStatus = useQuery({
    queryKey: ["mlx-gen-status"],
    queryFn: () => rpcClient.getMlxGenStatus(undefined),
    enabled: backend === "mlx",
  });
  const mlxDownloaded = useQuery({
    queryKey: ["mlx-downloaded-models"],
    queryFn: () => rpcClient.getDownloadedMlxModels(undefined),
    enabled: backend === "mlx",
  });
  const ratioIdx = Math.max(
    0,
    IMAGE_RATIOS.findIndex((r) => r.w === node.imgWidth && r.h === node.imgHeight),
  );
  const ratio = IMAGE_RATIOS[ratioIdx] ?? IMAGE_RATIOS[3]!;
  const mlxDefaultSteps = node.model ? MLX_FALLBACKS.find((m) => m.id === node.model!.model)?.defaultSteps : undefined;

  // 首次落到"比例"上：老节点没有 imgWidth/imgHeight。
  // 用 transient 写入 —— 这只是补默认值，不该在撤销栈里留一条"什么都没做"的记录。
  useEffect(() => {
    if (node.kind === "image" && (node.imgWidth === undefined || node.imgHeight === undefined)) {
      useCanvasStore.getState().updateNodeTransient(node.id, { imgWidth: ratio.w, imgHeight: ratio.h });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const mlxMissing = backend === "mlx" && mlxStatus.data && !mlxStatus.data.engineInstalled;
  const mlxModelMissing =
    backend === "mlx" &&
    !mlxMissing &&
    Boolean(node.model?.model) &&
    mlxDownloaded.data !== undefined &&
    !mlxDownloaded.data.downloaded.includes(node.model!.model);

  return (
    <div className="flex flex-col gap-2">
      {mlxMissing || mlxModelMissing ? (
        <ReadinessBanner
          kind={mlxMissing ? "engine" : "model"}
          onGo={() => useRouter.getState().setRoute({ path: "settings", tab: "engines" })}
        />
      ) : null}

      <Field label={`${t("image.params.ratio")} · ${ratio.w}×${ratio.h}`}>
        <ChipRow
          items={IMAGE_RATIOS.map((r) => ({ key: r.label, label: r.label }))}
          value={ratio.label}
          onSelect={(key) => {
            const picked = IMAGE_RATIOS.find((r) => r.label === key);
            if (picked) update({ imgWidth: picked.w, imgHeight: picked.h });
          }}
        />
      </Field>

      <div className="grid grid-cols-2 gap-1.5">
        <Field label={t("image.params.count")}>
          <NumInput value={node.count ?? 1} min={1} max={8} onChange={(v) => update({ count: v })} />
        </Field>
        <Field label={t("image.params.steps")}>
          <NumInput
            value={node.steps ?? mlxDefaultSteps ?? 25}
            min={1}
            max={100}
            onChange={(v) => update({ steps: v })}
            placeholder={mlxDefaultSteps ? String(mlxDefaultSteps) : "25"}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <Field label={t("image.params.seed")}>
          <div className="flex items-center gap-1">
            <Input
              value={node.seed === undefined ? "" : String(node.seed)}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const n = Number(raw);
                update({ seed: raw === "" || !Number.isFinite(n) || n < 0 ? undefined : Math.floor(n) });
              }}
              placeholder="随机"
              className="h-7 text-xs"
            />
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              title={t("image.params.seed")}
              onClick={() => update({ seed: Math.floor(Math.random() * 2 ** 31) })}
            >
              <ShuffleIcon className="size-3.5" />
            </Button>
          </div>
        </Field>
        {backend === "mlx" ? (
          <Field label={t("image.mlx.quantize")}>
            <Select value={String(node.quantize ?? 8)} onValueChange={(v) => update({ quantize: Number(v) })}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[8, 6, 4, 0].map((q) => (
                  <SelectItem key={q} value={String(q)}>
                    {q === 0 ? t("image.mlx.quantizeOff") : `${q} bit`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </div>

      {backend !== "mlx" ? (
        <Field label={t("image.params.negative")}>
          <Input
            value={node.negativePrompt ?? ""}
            onChange={(e) => update({ negativePrompt: e.target.value })}
            placeholder={t("image.params.negativePlaceholder")}
            className="h-7 text-xs"
          />
        </Field>
      ) : null}

      {backend === "api" ? (
        <RefField
          icon={<FileImageIcon className="size-3.5" />}
          label={t("image.edit.reference")}
          hint={t("image.edit.referenceReady")}
          kind="image"
          value={node.refImageRef}
          onChange={(ref) => update({ refImageRef: ref })}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 生视频
// ---------------------------------------------------------------------------

export function VideoNodeParams({ node }: { node: CanvasNodeData }) {
  const t = useT();
  const update = (patch: Partial<CanvasNodeData>) => useCanvasStore.getState().updateNode(node.id, patch);
  const backend = node.model?.backend ?? "cloud";
  const { videoProtocol } = useProviderProtocols(node.model?.providerId);
  const isComfy = backend === "comfyui";
  const range = DURATION_RANGE[isComfy ? ("comfyui" as const) : videoProtocol];
  const resolutions = isComfy ? [] : RESOLUTIONS[videoProtocol];
  const ratio = node.ratio ?? "16:9";
  const duration = node.duration ?? range.min;
  const resolution = node.resolution ?? DEFAULT_RESOLUTION[videoProtocol] ?? "";

  return (
    <div className="flex flex-col gap-2">
      <Field label={t("video.params.ratio")}>
        <ChipRow
          items={VIDEO_RATIOS.map((r) => ({ key: r, label: r }))}
          value={ratio}
          onSelect={(key) => update({ ratio: key })}
        />
      </Field>

      <Field label={`${t("video.params.duration")} · ${duration}s`}>
        <input
          type="range"
          min={range.min}
          max={range.max}
          step={1}
          value={duration}
          onChange={(e) => update({ duration: snapDuration(isComfy ? "comfyui" : videoProtocol, Number(e.target.value)) })}
          className="h-7 w-full accent-primary"
        />
      </Field>

      {!isComfy ? (
        <Field label={t("video.params.resolution")}>
          <ChipRow
            items={resolutions.map((r) => ({ key: r, label: r }))}
            value={resolution}
            onSelect={(key) => update({ resolution: key })}
          />
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-1.5">
        <Field label={t("video.params.seed")}>
          <Input
            value={node.seed === undefined ? "" : String(node.seed)}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const n = Number(raw);
              update({ seed: raw === "" || !Number.isFinite(n) || n <= 0 ? undefined : Math.floor(n) });
            }}
            placeholder="随机"
            className="h-7 text-xs"
          />
        </Field>
        {isComfy ? (
          <Field label={t("video.params.steps")}>
            <NumInput value={node.steps ?? 20} min={1} max={100} onChange={(v) => update({ steps: v })} />
          </Field>
        ) : (
          <Field label={t("video.params.watermark")}>
            <div className="flex h-7 items-center">
              <Switch checked={node.watermark === true} onCheckedChange={(v) => update({ watermark: v })} />
            </div>
          </Field>
        )}
      </div>

      {isComfy ? (
        <div className="grid grid-cols-2 gap-1.5">
          <Field label={t("video.params.cfg")}>
            <NumInput value={node.cfg ?? 5} min={1} max={20} onChange={(v) => update({ cfg: v })} />
          </Field>
          <Field label={t("video.params.negative")}>
            <Input
              value={node.negativePrompt ?? ""}
              onChange={(e) => update({ negativePrompt: e.target.value })}
              placeholder={t("video.params.negativePlaceholder")}
              className="h-7 text-xs"
            />
          </Field>
        </div>
      ) : null}

      {!isComfy ? (
        <RefField
          icon={<FileImageIcon className="size-3.5" />}
          label={t("video.firstFrame")}
          hint={t("video.firstFrame.hint")}
          kind="image"
          value={node.firstFrameRef}
          onChange={(ref) => update({ firstFrameRef: ref })}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 生音乐
// ---------------------------------------------------------------------------

export function MusicNodeParams({ node }: { node: CanvasNodeData }) {
  const t = useT();
  const update = (patch: Partial<CanvasNodeData>) => useCanvasStore.getState().updateNode(node.id, patch);
  const { musicProtocol } = useProviderProtocols(node.model?.providerId);
  const task = node.musicTask ?? "text_to_music";
  const needsRefAudio = task !== "text_to_music";
  const formats = FORMATS[musicProtocol] ?? ["mp3"];
  const format = node.responseFormat ?? "mp3";

  return (
    <div className="flex flex-col gap-2">
      <Field label={t("music.taskType")}>
        <ChipRow
          items={MUSIC_TASKS.map((k) => ({ key: k, label: MUSIC_TASK_LABELS[k] }))}
          value={task}
          onSelect={(key) => {
            const next = key as CanvasNodeData["musicTask"];
            update({ musicTask: next, instrumental: next === "text_to_music" ? node.instrumental : false });
          }}
        />
      </Field>

      {needsRefAudio ? (
        <RefField
          icon={<FileAudioIcon className="size-3.5" />}
          label={task === "music_cover" ? t("music.refAudio.chooseSong") : t("music.refAudio.chooseVocal")}
          hint={t("music.refAudio.required")}
          kind="audio"
          value={node.refAudioRef}
          onChange={(ref) => update({ refAudioRef: ref })}
        />
      ) : null}

      <Field label={t("music.lyrics")}>
        <textarea
          value={node.lyrics ?? ""}
          onChange={(e) => update({ lyrics: e.target.value })}
          placeholder={t("music.lyricsPlaceholder")}
          disabled={node.instrumental === true}
          rows={2}
          className="w-full resize-none rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none disabled:opacity-50"
        />
      </Field>

      <div className="flex flex-wrap gap-1">
        {LYRIC_TAGS.slice(0, 6).map((tag) => (
          <button
            key={tag}
            type="button"
            className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
            onClick={() => update({ lyrics: `${node.lyrics ?? ""}${node.lyrics ? "\n" : ""}${tag}` })}
          >
            {tag}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <Field label={t("music.instrumentalShort")}>
          <div className="flex h-7 items-center gap-2">
            <Switch
              checked={node.instrumental === true}
              disabled={needsRefAudio}
              onCheckedChange={(v) => update({ instrumental: v, lyrics: v ? undefined : node.lyrics })}
            />
          </div>
        </Field>
        <Field label={t("music.output.format")}>
          <Select value={format} onValueChange={(v) => update({ responseFormat: v })}>
            <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {formats.map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label={t("music.output.sampleRate")}>
        <Select value={String(node.sampleRate ?? 44100)} onValueChange={(v) => update({ sampleRate: Number(v) })}>
          <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SAMPLE_RATES.map((r) => (
              <SelectItem key={r} value={String(r)}>{r === 0 ? t("voice.local.autoVoice") : `${r} Hz`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 语音（TTS）：Edge（免费在线）/ 兼容（云端厂商或本地兼容服务）/ 本地 audio.cpp
// ---------------------------------------------------------------------------

export function TtsNodeParams({ node }: { node: CanvasNodeData }) {
  const t = useT();
  const update = (patch: Partial<CanvasNodeData>) => useCanvasStore.getState().updateNode(node.id, patch);
  const source = node.ttsSource ?? "compat";
  const { provider } = useProviderProtocols(node.model?.providerId);
  const vendor = audioVendorFor({ providerId: node.model?.providerId, baseUrl: provider?.baseUrl });
  const supportsRef = detectReferenceAudioSupport(node.model?.model ?? "", provider?.baseUrl ?? "");
  const clones = useClones();
  const locals = useQuery({ queryKey: ["tts-local-models"], queryFn: () => rpcClient.listTtsLocalModels(undefined), enabled: source === "local" });
  const localStatus = useQuery({ queryKey: ["tts-local-status"], queryFn: () => rpcClient.getTtsLocalStatus(undefined), enabled: source === "local" });
  const localModels = (locals.data?.models ?? []).filter((m) => m.downloaded);
  const localModel = localModels.find((m) => m.id === (node.localModelId ?? localStatus.data?.activeModelId)) ?? localModels[0];

  return (
    <div className="flex flex-col gap-2">
      <Field label={t("voice.tts.source")}>
        <ChipRow
          items={[
            { key: "edge", label: t("voice.tts.sourceEdge") },
            { key: "compat", label: t("voice.tts.sourceCompat") },
            { key: "local", label: t("voice.tts.sourceLocal") },
          ]}
          value={source}
          onSelect={(key) => update({ ttsSource: key as CanvasNodeData["ttsSource"] })}
        />
      </Field>

      {source === "edge" ? (
        <Field label={t("voice.tts.edgeVoice")}>
          <EdgeVoicePicker
            value={node.voice ?? ""}
            onChange={(v) => update({ voice: v })}
            placeholder={t("voice.tts.edgeVoice")}
          />
        </Field>
      ) : null}

      {source === "compat" ? (
        <>
          <Field label={t("voice.tts.voice")}>
            <VendorVoiceField
              vendor={vendor}
              value={node.voice ?? ""}
              onChange={(v) => update({ voice: v })}
              label=""
              placeholder={t("voice.vendorVoice.customPlaceholder")}
            />
          </Field>
          {supportsRef ? (
            <RefField
              icon={<FileAudioIcon className="size-3.5" />}
              label={t("voice.tts.refAudio")}
              hint={t("voice.tts.refAudioHint")}
              kind="audio"
              value={node.referenceAudioRef}
              onChange={(ref) => update({ referenceAudioRef: ref })}
            />
          ) : null}
        </>
      ) : null}

      {source === "local" ? (
        <>
          <Field label={t("voice.local.models")}>
            <Select
              value={localModel?.id ?? ""}
              onValueChange={(v) => update({ localModelId: v })}
            >
              <SelectTrigger size="sm" className="w-full"><SelectValue placeholder={t("voice.local.select")} /></SelectTrigger>
              <SelectContent>
                {localModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {!localStatus.data?.active || !localModel ? (
            <p className="text-[10px] leading-relaxed text-amber-600 dark:text-amber-500">
              {t("voice.local.notStarted")}
            </p>
          ) : (
            <LocalVoicePicker
              model={localModels.find((m) => m.id === localModel.id)}
              clones={clones}
              voice={node.voice ?? ""}
              emotion={node.emotion ?? ""}
              instruct={node.instruct ?? ""}
              onVoice={(v) => update({ voice: v })}
              onEmotion={(v) => update({ emotion: v })}
              onInstruct={(v) => update({ instruct: v })}
            />
          )}
          <Field label={t("voice.local.language")}>
            <ChipRow
              items={[
                { key: "", label: t("voice.asr.langAuto") },
                { key: "zh", label: "中文" },
                { key: "en", label: "English" },
                { key: "ja", label: "日本語" },
              ]}
              value={node.language ?? ""}
              onSelect={(key) => update({ language: key || undefined })}
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 小控件（画布内共用）
// ---------------------------------------------------------------------------

/** 本地后端缺引擎 / 缺权重时的一句话提示 +「去模型引擎」直达。 */
function ReadinessBanner({ kind, onGo }: { kind: "engine" | "model"; onGo: () => void }) {
  const t = useT();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
      <div className="min-w-0 flex-1 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400">
        {kind === "engine" ? t("canvas.ready.engineMissing") : t("canvas.ready.modelMissing")}
      </div>
      <Button size="sm" variant="outline" className="h-6 shrink-0 text-[10px]" onClick={onGo}>
        {t("canvas.ready.goEngines")}
      </Button>
    </div>
  );
}

/**
 * 上游报鉴权类错误时补一句"去哪儿改"。
 * 密钥失效是最难自查的一类失败：上游只会说 Invalid API key，用户看不出是
 * 自己那行密钥过期了，还是画布/接口写错了。
 */
export function withCloudAuthHint(message: string, t: (key: string) => string): string {
  if (/401|403|invalid api key|api[_ -]?key|unauthorized|认证|鉴权|密钥/i.test(message)) {
    return `${message}\n${t("canvas.err.checkProviderKey")}`;
  }
  return message;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ChipRow({
  items,
  value,
  onSelect,
}: {
  items: { key: string; label: string }[];
  value: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <button
          key={item.key || "auto"}
          type="button"
          className={cn(
            "rounded-md border px-1.5 py-0.5 text-[10px] transition-colors",
            item.key === value
              ? "border-primary/60 bg-primary/10 text-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
          onClick={() => onSelect(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function NumInput({
  value,
  min,
  max,
  onChange,
  placeholder,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  placeholder?: string;
}) {
  return (
    <Input
      value={String(value)}
      onChange={(e) => {
        const n = Number(e.target.value.trim());
        if (!Number.isFinite(n)) return;
        onChange(Math.min(Math.max(Math.round(n), min), max));
      }}
      placeholder={placeholder}
      className="h-7 text-xs"
    />
  );
}

/** 参考图 / 参考音频 / 首帧：调系统文件对话框 → 由主进程暂存成 images 内的 ref。 */
function RefField({
  icon,
  label,
  hint,
  kind,
  value,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  kind: "image" | "audio";
  value: string | undefined;
  onChange: (ref: string | undefined) => void;
}) {
  const t = useT();
  const pick = async () => {
    const allowedFileTypes =
      kind === "image" ? "png,jpg,jpeg,webp" : "mp3,wav,m4a,aac,flac,ogg,opus,webm,mp4,wma";
    const r = await rpcClient.openFileDialog({ allowedFileTypes, canChooseFiles: true });
    const path = r.paths?.[0];
    if (!path) return;
    const staged = kind === "image" ? await rpcClient.stageEditImage({ paths: [path] }) : await rpcClient.stageAudio({ paths: [path] });
    const ref = staged.files?.[0]?.ref;
    if (ref) onChange(ref);
  };

  return (
    <Field label={label}>
      {value ? (
        <div className="flex items-center gap-1.5 rounded-lg border p-1">
          {kind === "image" ? (
            <img src={chatImageUrl(value)} alt="" className="size-9 shrink-0 rounded object-cover" draggable={false} />
          ) : (
            <span className="grid size-9 shrink-0 place-items-center rounded bg-muted">{icon}</span>
          )}
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{hint}</span>
          <button type="button" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => onChange(undefined)}>
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="h-7 w-full justify-start gap-1.5 text-[11px]" onClick={() => void pick()}>
          {icon}
          {t("canvas.menu.upload")}
        </Button>
      )}
    </Field>
  );
}
