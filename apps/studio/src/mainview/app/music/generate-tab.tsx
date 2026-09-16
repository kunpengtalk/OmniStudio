import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SparklesIcon,
  Loader2Icon,
  EraserIcon,
  MusicIcon,
  XIcon,
  AudioLinesIcon,
  InfoIcon,
} from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { CloudModelSelect } from "@components/cloud-model-select";
import { SegmentedControl } from "@components/segmented-control";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Textarea } from "@ui/textarea";
import { Badge } from "@ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Switch } from "@ui/switch";
import { useT } from "@stores/ui-lang";
import { ResultError } from "@components/media-result";
import { useMusicStore } from "@stores/music";
import type { MusicGenBackend, MusicTask } from "../../../bun/music-gen";
import {
  BACKEND_ITEMS,
  DEFAULT_FORMAT,
  FORMATS,
  LYRIC_TAGS,
  MusicFailedCard,
  MusicPlayerCard,
  MusicTaskCard,
  RecentStrip,
} from "./parts";

/** 采样率档位：两家都接受这几个（StepFun 默认 48k，MiniMax 默认 44.1k）。 */
const SAMPLE_RATES = [0, 24000, 32000, 44100, 48000];

/** 任务类型默认值：歌曲创作（最常用的一档）。 */
const TASK_ITEMS: { key: MusicTask; label: string }[] = [
  { key: "text_to_music", label: "music.task.song" },
  { key: "music_cover", label: "music.task.cover" },
  { key: "vocal_to_music", label: "music.task.vocal" },
];

export function GenerateTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const focusRecordId = useMusicStore((s) => s.focusRecordId);
  const setFocusRecordId = useMusicStore((s) => s.setFocusRecordId);
  const setView = useMusicStore((s) => s.setView);

  const [task, setTask] = useState<MusicTask>("text_to_music");
  const [caption, setCaption] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [title, setTitle] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [format, setFormat] = useState("mp3");
  const [sampleRate, setSampleRate] = useState(44100);
  const [refAudio, setRefAudio] = useState<{ ref: string; url: string }>();

  const lyricsRef = useRef<HTMLTextAreaElement>(null);

  // ---------- 后端配置 ----------
  const [backend, setBackend] = useState<MusicGenBackend>("cloud");
  // 云端只记厂商 + 模型：地址 / 密钥 / 接口协议都在「设置 → 模型云服务」里。
  const [providerId, setProviderId] = useState("");
  const [cloudModel, setCloudModel] = useState("");
  const [localApi, setLocalApi] = useState("");
  const [localBase, setLocalBase] = useState("");
  const [localModel, setLocalModel] = useState("");
  const [configError, setConfigError] = useState<string>();
  const hydrated = useRef(false);

  const { data: configData } = useQuery({
    queryKey: ["music-gen-config"],
    queryFn: () => rpcClient.getMusicGenConfig(undefined),
  });
  const config = configData?.config;

  // 当前厂商的生音乐协议（决定输出格式档位）；没选厂商时按 StepFun 显示。
  const providersQuery = useQuery({
    queryKey: ["cloud-providers"],
    queryFn: () => rpcClient.cloudProviderList(undefined),
  });
  const selectedProvider =
    (providersQuery.data?.providers ?? []).find((p) => p.id === providerId) ?? null;
  const protocol: "stepfun" | "minimax" =
    selectedProvider?.musicApi === "minimax" ? "minimax" : "stepfun";

  useEffect(() => {
    if (!config || hydrated.current) return;
    hydrated.current = true;
    setBackend(config.backend);
    setProviderId(config.providerId);
    setCloudModel(config.model);
    setLocalApi(config.localApi);
    setLocalBase(config.localBase);
    setLocalModel(config.localModel);
  }, [config]);

  // 档位按**协议**分，换厂商等于换协议：StepFun 五种格式与 MiniMax 三种互不认，
  // 不跟着收敛就会把上一个厂商的档位原样发给上游。
  useEffect(() => {
    const allowed = FORMATS[protocol];
    setFormat((f) => (allowed.includes(f) ? f : DEFAULT_FORMAT[protocol]));
  }, [protocol]);

  // 切到翻唱 / 配乐时，纯器乐必然不成立（那两档要的就是人声）。
  useEffect(() => {
    if (task !== "text_to_music") setInstrumental(false);
  }, [task]);

  const switchBackend = (key: MusicGenBackend) => {
    setBackend(key);
    void rpcClient.saveMusicGenConfig({ backend: key });
  };

  const saveConfig = useMutation({
    mutationFn: () =>
      rpcClient.saveMusicGenConfig({
        backend,
        providerId: providerId.trim(),
        model: cloudModel.trim(),
        localApi: localApi.trim(),
        localBase: localBase.trim(),
        localModel: localModel.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["music-gen-config"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    },
    onError: (e) => setConfigError(String(e)),
  });

  const configured = backend === "cloud" ? !!providerId.trim() && !!cloudModel.trim() : false;

  // ---------- 参考音频（翻唱 / 配乐） ----------
  const pickRefAudio = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "mp3,wav,m4a,aac,flac,ogg,opus,webm,mp4,wma",
      });
      if (paths.length === 0) return undefined;
      const { files } = await rpcClient.stageAudio({ paths });
      return files[0];
    },
    onSuccess: (file) => {
      if (file) setRefAudio(file);
    },
    onError: (e) => setConfigError(String(e)),
  });

  // ---------- 记录与轮询 ----------
  // 轮询本身挂在 MusicScreen 上（见 useMusicRecordsPolling）：切到历史视图时这里会卸载，
  // 在途任务的进度不能跟着停。
  const { data: recordsData } = useQuery({
    queryKey: ["music-records"],
    queryFn: () => rpcClient.listMusicRecords(undefined),
  });
  const records = recordsData?.records ?? [];

  const del = useMutation({
    mutationFn: (id: number) => rpcClient.deleteMusicRecord({ id }),
    onSuccess: (_r, id) => {
      queryClient.invalidateQueries({ queryKey: ["music-records"] });
      if (focusRecordId === id) setFocusRecordId(null);
    },
  });

  // ---------- 生成 ----------
  const generate = useMutation({
    mutationFn: () =>
      rpcClient.submitMusicGeneration({
        caption,
        // 器乐场景不把歌词发出去（两家都禁止 / 无意义），后端也会再挡一次。
        lyrics: instrumental ? undefined : lyrics.trim() || undefined,
        title: title.trim() || undefined,
        instrumental: task === "text_to_music" ? instrumental : undefined,
        task,
        refAudioRef: task === "text_to_music" ? undefined : refAudio?.ref,
        responseFormat: format as "mp3",
        sampleRate: sampleRate > 0 ? sampleRate : undefined,
        // 页面上的实时配置一并带上，后端优先使用它们并落盘（连接信息来自厂商行）。
        config: {
          backend,
          providerId: providerId.trim(),
          model: cloudModel.trim(),
          localApi: localApi.trim(),
          localBase: localBase.trim(),
          localModel: localModel.trim(),
        },
      }),
    onSuccess: (r) => {
      if (r.error || !r.record) {
        setConfigError(r.error ?? t("music.submitFailed"));
        return;
      }
      setConfigError(undefined);
      setFocusRecordId(r.record.id);
      queryClient.invalidateQueries({ queryKey: ["music-records"] });
    },
    onError: (e) => setConfigError(String(e)),
  });

  /** 歌词里插入结构标签：文档要求标签独占一行，所以自动补换行。 */
  const insertTag = (tag: string) => {
    const el = lyricsRef.current;
    const at = el?.selectionStart ?? lyrics.length;
    const before = lyrics.slice(0, at);
    const after = lyrics.slice(at);
    const nl = before && !before.endsWith("\n") ? "\n" : "";
    const next = `${before}${nl}${tag}\n${after}`;
    setLyrics(next);
    // 光标落到标签后面那一行开头，接着写正文。
    const caret = at + nl.length + tag.length + 1;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const needsRefAudio = task !== "text_to_music";
  // 本地后端是预留位，生成按钮直接禁用：让用户点了才看到"未接入"是白费一次操作，
  // 也会在创作记录里留下一条注定失败的条目。
  const canGenerate =
    !!caption.trim() &&
    !generate.isPending &&
    backend === "cloud" &&
    configured &&
    (!needsRefAudio || !!refAudio);

  // 展示的记录：聚焦的记录，否则最新一条。
  const display = records.find((r) => r.id === focusRecordId) ?? records[0];

  return (
    <div className="flex h-full min-h-0">
      {/* 中间：参数面板 */}
      <aside className="w-[360px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 任务类型（对应上游的 task 取值） */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("music.taskType")}</Label>
            <SegmentedControl
              variant="attached"
              value={task}
              onChange={setTask}
              options={TASK_ITEMS.map((x) => ({ value: x.key, label: t(x.label) }))}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(
                task === "text_to_music"
                  ? "music.task.songDesc"
                  : task === "music_cover"
                    ? "music.task.coverDesc"
                    : "music.task.vocalDesc",
              )}
            </p>
          </div>

          {/* 后端切换 */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("music.backend")}</Label>
            <SegmentedControl
              variant="attached"
              value={backend}
              onChange={switchBackend}
              options={BACKEND_ITEMS.map((b) => ({ value: b.key, label: t(b.label) }))}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(backend === "local" ? "music.backend.localDesc" : "music.backend.cloudDesc")}
            </p>
          </div>

          {/* 服务配置 */}
          <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
            {backend === "cloud" ? (
              // 云端生音乐：只选厂商 + 模型。厂商要在设置里选好生音乐接口
              // （StepFun / MiniMax），否则这里选不到它。
              <div>
                <Label className="mb-1 block text-xs">{t("music.config.cloudProvider")}</Label>
                <CloudModelSelect
                  kind="music"
                  requireMusicApi
                  providerId={providerId}
                  model={cloudModel}
                  size="sm"
                  onChange={(choice) => {
                    setProviderId(choice.providerId);
                    if (choice.model) setCloudModel(choice.model);
                  }}
                />
                <p className="mt-1.5 text-[10px] text-muted-foreground">{t("cloud.where")}</p>
              </div>
            ) : (
              // 本地引擎：**预留位**。三个输入框先摆在这里（协议 / 地址 / 模型），
              // 但引擎还没接，所以禁用并说明 —— 让人知道这块在计划里，而不是坏了。
              <div className="flex flex-col gap-2.5">
                <div className="flex items-start gap-2 rounded-md border border-dashed bg-muted/30 px-2.5 py-2">
                  <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    {t("music.local.reserved")}
                  </p>
                </div>
                <div>
                  <Label htmlFor="music-local-api" className="mb-1 block text-xs">
                    {t("music.config.localApi")}
                  </Label>
                  <Input
                    id="music-local-api"
                    placeholder="ace-step / diffrhythm…"
                    value={localApi}
                    onChange={(e) => setLocalApi(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="music-local-base" className="mb-1 block text-xs">
                    {t("music.config.localBase")}
                  </Label>
                  <Input
                    id="music-local-base"
                    placeholder="http://127.0.0.1:8188"
                    value={localBase}
                    onChange={(e) => setLocalBase(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="music-local-model" className="mb-1 block text-xs">
                    {t("music.config.localModel")}
                  </Label>
                  <Input
                    id="music-local-model"
                    placeholder={t("music.config.localModelPlaceholder")}
                    value={localModel}
                    onChange={(e) => setLocalModel(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => saveConfig.mutate()} disabled={saveConfig.isPending}>
                {saveConfig.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : null}
                {t("music.config.save")}
              </Button>
              {backend === "cloud" && configured && (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  {t("music.config.configured")}
                </Badge>
              )}
            </div>
            {configError && <ResultError error={configError} />}
          </div>

          {/* 参考音频（翻唱 / 配乐） */}
          {needsRefAudio &&
            (refAudio ? (
              <div className="flex items-center gap-3 rounded-lg border bg-card p-2.5">
                <audio src={refAudio.url} controls className="h-8 min-w-0 flex-1" />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  tooltip={t("music.refAudio.remove")}
                  onClick={() => setRefAudio(undefined)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => pickRefAudio.mutate()}
                className="flex items-center gap-2 rounded-lg border border-dashed bg-card/50 px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground"
              >
                {pickRefAudio.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <AudioLinesIcon className="size-3.5" />
                )}
                {t(task === "music_cover" ? "music.refAudio.chooseSong" : "music.refAudio.chooseVocal")}
                <span className="text-[10px]">（{t("music.refAudio.required")}）</span>
              </button>
            ))}

          {/* 音乐描述（两家的必填项） */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="music-caption" className="text-xs">
                {t("music.caption")}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                onClick={() => setCaption("")}
              >
                <EraserIcon className="size-3" />
                {t("music.caption.clear")}
              </Button>
            </div>
            <Textarea
              id="music-caption"
              rows={3}
              maxLength={2000}
              placeholder={t("music.captionPlaceholder")}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              className="resize-none text-xs"
            />
            <p className="mt-1 text-right text-[10px] tabular-nums text-muted-foreground">
              {caption.length}/2000
            </p>
          </div>

          {/* 纯器乐（仅歌曲创作支持） */}
          {task === "text_to_music" && (
            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <Label htmlFor="music-instrumental" className="text-xs">
                    {t("music.instrumental")}
                  </Label>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                    {t("music.instrumentalHint")}
                  </p>
                </div>
                <Switch
                  id="music-instrumental"
                  checked={instrumental}
                  onCheckedChange={(v) => {
                    setInstrumental(v);
                    // 文档明确禁止同时传：开了器乐就把歌词清掉，别让用户提交后才被打回。
                    if (v) setLyrics("");
                  }}
                />
              </div>
            </div>
          )}

          {/* 歌名与歌词 */}
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="music-title" className="mb-1 block text-xs">
                {t("music.title")}
              </Label>
              <Input
                id="music-title"
                placeholder={t("music.titlePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-8 text-xs"
              />
              {/* 说清楚它去哪儿：两家的生成接口都没有歌名参数，光给个输入框会让人
                  以为歌名会影响生成结果。 */}
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                {t("music.titleHint")}
              </p>
            </div>

            {!instrumental && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <Label htmlFor="music-lyrics" className="text-xs">
                    {t("music.lyrics")}
                  </Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                    onClick={() => setLyrics("")}
                  >
                    <EraserIcon className="size-3" />
                    {t("music.lyrics.clear")}
                  </Button>
                </div>
                <Textarea
                  id="music-lyrics"
                  ref={lyricsRef}
                  rows={8}
                  maxLength={3500}
                  placeholder={t(
                    needsRefAudio ? "music.lyricsPlaceholderRequired" : "music.lyricsPlaceholder",
                  )}
                  value={lyrics}
                  onChange={(e) => setLyrics(e.target.value)}
                  className="resize-none text-xs"
                />
                {/* 结构标签：点一下插到光标处，标签独占一行（文档要求）。 */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {LYRIC_TAGS.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => insertTag(tag)}
                      className="rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-right text-[10px] tabular-nums text-muted-foreground">
                  {lyrics.length}/3500
                </p>
              </div>
            )}
          </div>

          {/* 输出参数 */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <p className="text-xs font-medium">{t("music.output")}</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="mb-1 block text-[11px] text-muted-foreground">
                  {t("music.output.format")}
                </Label>
                <Select value={format} onValueChange={setFormat}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMATS[protocol].map((f) => (
                      <SelectItem key={f} value={f} className="text-xs">
                        {f}
                        {f === "pcm" ? ` · ${t("music.output.pcmHint")}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-1 block text-[11px] text-muted-foreground">
                  {t("music.output.sampleRate")}
                </Label>
                <Select
                  value={String(sampleRate)}
                  onValueChange={(v) => setSampleRate(Number(v))}
                >
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SAMPLE_RATES.map((r) => (
                      <SelectItem key={r} value={String(r)} className="text-xs">
                        {r === 0 ? t("music.output.nativeRate") : `${r} Hz`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {t("music.output.hint")}
            </p>
          </div>

          <Button
            size="lg"
            onClick={() => generate.mutate()}
            disabled={!canGenerate}
            className="w-full"
          >
            {generate.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            {generate.isPending ? t("music.submitting") : t("music.generate")}
          </Button>
          {backend === "cloud" && !configured && (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("music.needProvider")}
            </p>
          )}
          {backend === "local" && (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("music.local.reservedShort")}
            </p>
          )}
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {focusRecordId != null && display && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-5 top-5 z-20 h-7 gap-1 text-[11px] text-muted-foreground"
            onClick={() => setFocusRecordId(null)}
          >
            <XIcon className="size-3.5" />
            {t("common.cancel")}
          </Button>
        )}

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
          {!display ? (
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
                <MusicIcon className="size-9 text-primary" />
              </div>
              <p className="text-lg font-medium">{t("music.result.empty")}</p>
              <p className="max-w-xs text-sm text-muted-foreground">{t("music.result.emptyHint")}</p>
            </div>
          ) : display.status === "processing" ? (
            <MusicTaskCard record={display} onDelete={(id) => del.mutate(id)} />
          ) : display.status === "failed" ? (
            <MusicFailedCard record={display} onDelete={(id) => del.mutate(id)} />
          ) : (
            <MusicPlayerCard record={display} onDelete={(id) => del.mutate(id)} />
          )}
        </div>

        {/* 底部：最近成功生成的音乐 + 更多（全部历史） */}
        <RecentStrip records={records} onOpenHistory={() => setView("history")} />
      </main>
    </div>
  );
}
