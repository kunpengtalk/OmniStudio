/**
 * 画布节点的编辑面板：按节点类型渲染「提示词 / 模型 / 参数 + 生成按钮 + 结果」。
 *
 * 生成执行全部复用既有 RPC（generateImage / submitVideoGeneration / runTTS /
 * canvasRunText），节点上选的模型经各接口的 config 参数按次传入 —— 不改写
 * 用户在各功能页保存的默认配置（persistConfig: false）。
 *
 * 连线即上下文：上游文本并入提示词，上游图片成为生图参考 / 图生视频首帧。
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  Loader2Icon,
  PlayIcon,
  SquareIcon,
  ImageIcon,
  TypeIcon,
  ClapperboardIcon,
  AudioWaveformIcon,
  MusicIcon,
} from "lucide-react";

import { Button } from "@ui/button";
import { Textarea } from "@ui/textarea";
import { chatImageUrl } from "@/shared/server-info";
import { rpcClient } from "@lib/rpc";
import { cn } from "@/mainview/lib/utils";
import { upstreamNodesOf, useCanvasStore } from "./canvas-store";
import { CanvasModelSelect, type CanvasModelKind } from "./model-select";
import { ImageNodeParams, MusicNodeParams, TtsNodeParams, VideoNodeParams, withCloudAuthHint } from "./node-params";
import type { CanvasNodeData, CanvasNodeKind } from "@/shared/canvas";
import type { MusicOutputFormat } from "../../../bun/music-gen";
import { useT } from "@stores/ui-lang";

export function nodeKindIcon(kind: CanvasNodeKind) {
  const map = {
    text: TypeIcon,
    image: ImageIcon,
    video: ClapperboardIcon,
    music: MusicIcon,
    audio: AudioWaveformIcon,
  } as const;
  return map[kind];
}

export function NodePanel({ node }: { node: CanvasNodeData }) {
  const t = useT();
  const docId = useCanvasStore((s) => s.docId);
  const nodes = useCanvasStore((s) => s.nodes);
  const connections = useCanvasStore((s) => s.connections);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const setNodeStatus = useCanvasStore((s) => s.setNodeStatus);
  const queryClient = useQueryClient();
  const runningRef = useRef(false);

  const upstream = upstreamNodesOf(nodes, connections, node.id);
  const upstreamText = upstream
    .map((n) => (n.kind === "text" ? (n.resultText || n.prompt).trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  const upstreamImageRef = upstream.find((n) => n.kind === "image" && n.resultRef)?.resultRef;
  const upstreamRefCount = upstream.filter((n) => n.kind === "text" ? Boolean(n.resultText || n.prompt) : Boolean(n.resultRef)).length;

  const runText = async () => {
    if (!docId || runningRef.current) return;
    runningRef.current = true;
    setNodeStatus(node.id, "loading");
    updateNode(node.id, { resultText: "", error: undefined });
    try {
      const r = await rpcClient.canvasRunText({
        docId,
        nodeId: node.id,
        prompt: node.prompt,
        context: upstream
          .filter((n) => (n.resultText || n.prompt).trim())
          .map((n) => ({ nodeId: n.id, title: n.title, text: n.resultText || n.prompt })),
        model: node.model ?? undefined,
      });
      if (!r.ok && r.error) {
        setNodeStatus(node.id, "error", r.error);
      }
      // 成功路径的增量 / 终态走 canvasTextChunk 推送（见 lib/rpc.ts）。
    } catch (e) {
      setNodeStatus(node.id, "error", withCloudAuthHint(e instanceof Error ? e.message : String(e), t));
    } finally {
      runningRef.current = false;
    }
  };

  const stopText = async () => {
    try {
      await rpcClient.canvasStopText({ nodeId: node.id });
    } catch {}
    setNodeStatus(node.id, "idle");
  };

  const runImage = async () => {
    const choice = node.model;
    if (!choice) {
      setNodeStatus(node.id, "error", t("canvas.model.none"));
      return;
    }
    const prompt = [node.prompt.trim(), upstreamText].filter(Boolean).join("\n\n");
    if (!prompt) return;
    setNodeStatus(node.id, "loading");
    try {
      const backend = choice.backend ?? (choice.source === "cloud" ? "api" : "mlx");
      const config =
        backend === "api"
          ? { backend: "api" as const, providerId: choice.providerId, model: choice.model }
          : backend === "comfyui"
            ? { backend: "comfyui" as const, model: choice.model }
            : { backend: "mlx" as const, model: choice.model };
      const r = await rpcClient.generateImage({
        prompt,
        // 分辨率来自比例档位；没有就退回 1024×1024（生图页 1:1 档）。
        width: node.imgWidth ?? 1024,
        height: node.imgHeight ?? 1024,
        count: node.count ?? 1,
        steps: node.steps,
        seed: node.seed,
        negativePrompt: backend === "mlx" ? undefined : node.negativePrompt,
        quantize: backend === "mlx" ? node.quantize ?? 8 : undefined,
        // 连线来的上游图片优先，其次节点自己选的参考图（都只在云端 api 后端生效）。
        referenceImageRef: upstreamImageRef ?? (backend === "api" ? node.refImageRef : undefined),
        persistConfig: false,
        config,
      });
      const record = r.records?.[0];
      if (!record || record.status === "failed" || !record.imagePath) {
        throw new Error(record?.error || r.error || "生成失败");
      }
      updateNode(node.id, { resultRef: record.imagePath, error: undefined });
      setNodeStatus(node.id, "success");
      void queryClient.invalidateQueries({ queryKey: ["image-records"] });
    } catch (e) {
      setNodeStatus(node.id, "error", withCloudAuthHint(e instanceof Error ? e.message : String(e), t));
    }
  };

  const runVideo = async () => {
    const choice = node.model;
    if (!choice) {
      setNodeStatus(node.id, "error", t("canvas.model.none"));
      return;
    }
    const prompt = [node.prompt.trim(), upstreamText].filter(Boolean).join("\n\n");
    if (!prompt) return;
    setNodeStatus(node.id, "loading");
    try {
      const backend = choice.backend ?? (choice.source === "cloud" ? "cloud" : "comfyui");
      const config =
        backend === "cloud"
          ? { backend: "cloud" as const, providerId: choice.providerId, model: choice.model }
          : { backend: "comfyui" as const, comfyCkpt: choice.model };
      const r = await rpcClient.submitVideoGeneration({
        prompt,
        duration: node.duration ?? 5,
        ratio: node.ratio ?? "16:9",
        resolution: backend === "cloud" ? node.resolution : undefined,
        seed: node.seed,
        steps: backend === "comfyui" ? node.steps : undefined,
        cfg: backend === "comfyui" ? node.cfg : undefined,
        negativePrompt: backend === "comfyui" ? node.negativePrompt : undefined,
        watermark: backend === "cloud" ? node.watermark : undefined,
        firstFrameRef: backend === "cloud" ? upstreamImageRef ?? node.firstFrameRef : undefined,
        persistConfig: false,
        config,
      });
      if (!r.record) throw new Error(r.error || "提交失败");
      updateNode(node.id, { recordId: r.record.id, resultRef: undefined, error: undefined });
      if (r.record.status === "done" && r.record.videoPath) {
        updateNode(node.id, { resultRef: r.record.videoPath });
        setNodeStatus(node.id, "success");
      }
    } catch (e) {
      setNodeStatus(node.id, "error", withCloudAuthHint(e instanceof Error ? e.message : String(e), t));
    }
  };

  // 视频 / 音乐都是异步任务：节点 loading 且绑定了记录 id 时按 5s 轮询推进度。
  const recordId = node.recordId;
  useEffect(() => {
    if ((node.kind !== "video" && node.kind !== "music") || node.status !== "loading" || !recordId) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        if (node.kind === "video") {
          const r = await rpcClient.pollVideoRecords({ ids: [recordId] });
          const record = r.records?.[0];
          if (!alive || !record) return;
          if (record.status === "done" && record.videoPath) {
            updateNode(node.id, { resultRef: record.videoPath, recordId: undefined });
            setNodeStatus(node.id, "success");
            void queryClient.invalidateQueries({ queryKey: ["video-records"] });
          } else if (record.status === "failed") {
            updateNode(node.id, { recordId: undefined });
            setNodeStatus(node.id, "error", withCloudAuthHint(record.error || "生成失败", t));
          }
          return;
        }
        const r = await rpcClient.pollMusicRecords({ ids: [recordId] });
        const record = r.records?.[0];
        if (!alive || !record) return;
        if (record.status === "done" && record.audioPath) {
          updateNode(node.id, { resultRef: record.audioPath, recordId: undefined, title: record.title || node.title });
          setNodeStatus(node.id, "success");
          void queryClient.invalidateQueries({ queryKey: ["music-records"] });
        } else if (record.status === "failed") {
          updateNode(node.id, { recordId: undefined });
          setNodeStatus(node.id, "error", withCloudAuthHint(record.error || "生成失败", t));
        }
      } catch {}
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [node.kind, node.status, recordId, node.id, node.title, updateNode, setNodeStatus, queryClient, t]);

  const runMusic = async () => {
    const choice = node.model;
    const caption = node.prompt.trim();
    if (!caption) {
      setNodeStatus(node.id, "error", t("canvas.promptPlaceholder.music"));
      return;
    }
    setNodeStatus(node.id, "loading");
    try {
      const task = node.musicTask ?? "text_to_music";
      const r = await rpcClient.submitMusicGeneration({
        caption,
        // 自己写的歌词优先；没写就用上游文本节点（两者都与「纯器乐」互斥）。
        lyrics: node.instrumental ? undefined : (node.lyrics?.trim() || upstreamText || undefined),
        title: node.title || undefined,
        instrumental: node.instrumental || undefined,
        task,
        refAudioRef: node.refAudioRef,
        responseFormat: node.responseFormat as MusicOutputFormat | undefined,
        sampleRate: node.sampleRate,
        persistConfig: false,
        ...(choice?.source === "cloud"
          ? { config: { backend: "cloud" as const, providerId: choice.providerId, model: choice.model } }
          : {}),
      });
      if (!r.record) throw new Error(r.error || "提交失败");
      updateNode(node.id, { recordId: r.record.id, resultRef: undefined, error: undefined });
      if (r.record.status === "done" && r.record.audioPath) {
        updateNode(node.id, { resultRef: r.record.audioPath });
        setNodeStatus(node.id, "success");
      }
    } catch (e) {
      setNodeStatus(node.id, "error", withCloudAuthHint(e instanceof Error ? e.message : String(e), t));
    }
  };

  const runAudio = async () => {
    const text = (node.prompt.trim() || upstreamText).trim();
    if (!text) return;
    setNodeStatus(node.id, "loading");
    try {
      const source = node.ttsSource ?? "compat";
      const choice = node.model;
      let audioPath: string | null = null;
      let error: string | null = null;

      if (source === "edge") {
        const r = await rpcClient.runTTSEdge({ text, voice: node.voice || "" });
        audioPath = r.record.audioPath;
        error = r.record.error;
      } else if (source === "local") {
        const r = await rpcClient.runTTSLocal({
          text,
          model: node.localModelId,
          voice: node.voice || undefined,
          emotion: node.emotion || undefined,
          language: node.language || undefined,
          instruct: node.instruct || undefined,
        });
        audioPath = r.record.audioPath;
        error = r.record.error;
      } else {
        const r = await rpcClient.runTTS({
          text,
          voice: node.voice || undefined,
          model: choice?.source === "cloud" ? choice.model : undefined,
          providerId: choice?.source === "cloud" ? choice.providerId : undefined,
          // 音色克隆：参考音频在支持它的厂商上直接换音色（不传等价于用默认音色）。
          referenceAudioRef: node.referenceAudioRef,
        });
        audioPath = r.record.audioPath;
        error = r.record.error;
      }

      if (!audioPath) throw new Error(error || "生成失败");
      updateNode(node.id, { resultRef: audioPath, error: undefined });
      setNodeStatus(node.id, "success");
      void queryClient.invalidateQueries({ queryKey: ["voice-records"] });
    } catch (e) {
      setNodeStatus(node.id, "error", withCloudAuthHint(e instanceof Error ? e.message : String(e), t));
    }
  };

  const run = () => {
    if (node.status === "loading") return;
    if (node.kind === "text") void runText();
    else if (node.kind === "image") void runImage();
    else if (node.kind === "video") void runVideo();
    else if (node.kind === "music") void runMusic();
    else void runAudio();
  };

  const modelKind: CanvasModelKind = node.kind === "audio" ? "tts" : node.kind;
  const placeholder = t(`canvas.promptPlaceholder.${node.kind}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2" data-canvas-no-zoom>
      <Textarea
        value={node.prompt}
        onChange={(e) => updateNode(node.id, { prompt: e.target.value })}
        placeholder={placeholder}
        className="min-h-[60px] shrink-0 resize-none bg-transparent text-xs leading-relaxed"
        rows={3}
      />

      <div className="flex shrink-0 items-center gap-1.5">
        {/* Edge / 本地引擎的音色就是"模型"，不需要再选厂商模型（与语音页一致）。 */}
        {node.kind === "audio" && (node.ttsSource === "edge" || node.ttsSource === "local") ? null : (
          <CanvasModelSelect
            kind={modelKind}
            value={node.model ?? null}
            onChange={(choice) => updateNode(node.id, { model: choice ?? undefined })}
          />
        )}
        <Button
          size="icon"
          variant="secondary"
          className="size-7 shrink-0"
          disabled={node.status === "loading"}
          onClick={node.status === "loading" && node.kind === "text" ? stopText : run}
        >
          {node.status === "loading" ? (
            node.kind === "text" ? (
              <SquareIcon className="size-3.5" />
            ) : (
              <Loader2Icon className="size-3.5 animate-spin" />
            )
          ) : (
            <PlayIcon className="size-3.5" />
          )}
        </Button>
      </div>

      {node.kind === "image" ? <ImageNodeParams node={node} /> : null}
      {node.kind === "video" ? <VideoNodeParams node={node} /> : null}
      {node.kind === "music" ? <MusicNodeParams node={node} /> : null}
      {node.kind === "audio" ? <TtsNodeParams node={node} /> : null}

      {upstreamRefCount > 0 ? (
        <div className="shrink-0 text-[10px] text-muted-foreground">
          {t("canvas.contextFrom", { name: String(upstreamRefCount) })}
        </div>
      ) : null}

      <NodeResult node={node} />
    </div>
  );
}

function NodeResult({ node }: { node: CanvasNodeData }) {
  const t = useT();
  if (node.status === "error") {
    return (
      <div className="shrink-0 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
        {node.error || t("canvas.status.empty")}
      </div>
    );
  }
  if (node.status === "loading" && node.kind !== "text" && !node.resultRef) {
    return (
      <div className="flex shrink-0 items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" />
        {t("canvas.status.loading")}
      </div>
    );
  }
  if (node.kind === "text") {
    if (!node.resultText) {
      return <div className="shrink-0 px-1 text-[11px] text-muted-foreground">{t("canvas.status.empty")}</div>;
    }
    return (
      <div className="min-h-0 shrink-0 whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-xs leading-relaxed">
        {node.resultText}
      </div>
    );
  }
  if (!node.resultRef) {
    return <div className="shrink-0 px-1 text-[11px] text-muted-foreground">{t("canvas.status.empty")}</div>;
  }
  if (node.kind === "image") {
    return (
      <img
        src={chatImageUrl(node.resultRef)}
        alt={node.title}
        className="w-full shrink-0 rounded-md border object-contain"
        draggable={false}
      />
    );
  }
  if (node.kind === "video") {
    return (
      <video src={chatImageUrl(node.resultRef)} controls className="w-full shrink-0 rounded-md border" />
    );
  }
  if (node.kind === "music") {
    return (
      <div className="shrink-0 rounded-md border bg-muted/30 p-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <MusicIcon className="size-3" />
          <span className="truncate">{node.prompt || node.title}</span>
        </div>
        <audio src={chatImageUrl(node.resultRef)} controls className="w-full" />
      </div>
    );
  }
  return <audio src={chatImageUrl(node.resultRef)} controls className="w-full shrink-0" />;
}

/** 画布空状态（节点数为 0 时盖在画布中央的提示）。 */
export function CanvasEmptyHint({ visible }: { visible: boolean }) {
  const t = useT();
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className={cn("rounded-xl border bg-background/80 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur")}>
        {t("canvas.empty")}
      </div>
    </div>
  );
}
