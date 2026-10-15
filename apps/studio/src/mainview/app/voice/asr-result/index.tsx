/**
 * 语音识别的右侧工作台。
 *
 * 布局（自上而下）：工作台头（统计 + 查找 + 阅读偏好）→ 场景 → 稿件与整理（滚动）→
 * 控制台。三段的职责分得很清楚：**上面看东西、中间读东西、下面做事**。
 * 跑一次识别（录音 / 转写文件 / 暂停）只在底部控制台，参数（引擎、模型、语言）只在左栏 ——
 * 同一个选择器在两个地方出现就是漂移的开始。
 *
 * 稿件与「智能整理」是两块独立的面板，而不是两个标签页：整理结果要能一边看着稿件
 * 一边读，切来切去看不了对照。
 *
 * 左侧历史点进来的一刻，`history` 有值：顶栏从"跑一次识别"的控制台换成那条记录的
 * 说明条（时间 / 模型 / 下载 / 返回当前）。面板本身不认识"历史"——它只认一份稿子，
 * 传进来的是哪份就显示哪份；能这样合流是因为记录存的也是一份稿子。
 */
import { useEffect, useMemo, useState } from "react";
import {
  EraserIcon,
  FileAudioIcon,
  LayoutListIcon,
  MaximizeIcon,
  SearchIcon,
  SpellCheckIcon,
  XIcon,
} from "lucide-react";

import type { AsrSegment } from "../../../../bun/asr";
import type { VoiceRecordRow } from "../../../../bun/voice";
import type { VadSensitivity } from "@/shared/asr-vad";
import type { AsrSceneId } from "@/shared/asr-insights";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { ResultEmpty, ResultError } from "@components/media-result";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { RecordHistoryBar } from "../parts";
import { RecognitionBar, RunBar, type AsrMode } from "./controls";
import { InsightsSection } from "./insights";
import { TranscriptSection, type TranscriptView } from "./transcript";
import { fmtClock, TEXT_SCALES, type TextScaleId } from "./transcript-utils";

// 逐句合并与时间格式化被左侧栏（实时转写回调）用，从这里统一出口，避免两条 import 路径。
export { buildSrt, fmtClock, mergeSegments, searchSegments } from "./transcript-utils";

export type AsrResultPaneProps = {
  segments: AsrSegment[];
  text: string;
  engine?: string;
  hasSpeakers: boolean;
  streaming: boolean;
  audioUrl?: string;
  /** 这份稿子的来源：麦克风录音 or 音频文件。 */
  source: "mic" | "file";
  /** 采集模式：自动听写（按静音切句）或手动录一段。 */
  mode: AsrMode;
  onMode: (m: AsrMode) => void;
  /** 自动听写：采集已开、一直在听。 */
  listening: boolean;
  /** 本地判定这一段有说话（还没等到识别结果）。 */
  speaking: boolean;
  /** 正在说的这一句的中间识别结果。 */
  interim?: string | null;
  vadSensitivity: VadSensitivity;
  silenceMs: number;
  onVadSensitivity: (v: VadSensitivity) => void;
  onVadSilence: (v: number) => void;
  error?: string;
  /** 场景：决定整理的默认动作与人声分离默认值。 */
  scene: AsrSceneId;
  onScene: (s: AsrSceneId) => void;
  speakerMode: boolean;
  onSpeakerMode: (v: boolean) => void;
  /** 当前识别目标（引擎 · 模型）的展示文本。 */
  target: string;
  /**
   * 正在看的是一条历史记录：顶栏换成记录说明条，采集类的控件（运行条 / 清空）让位。
   * 传进来的 `segments` / `text` / `audioUrl` 就是那条记录的内容。
   */
  history?: { record: VoiceRecordRow; onClose: () => void };
  /** 初始视图（预览与测试用；默认整理稿）。 */
  initialView?: TranscriptView;
  onClear: () => void;
  // ---- 底部控制台 ----
  recording: boolean;
  paused: boolean;
  level: number;
  elapsed: number;
  onStart: () => void;
  onStop: () => void;
  onTogglePause: () => void;
  onTranscribeFile: () => void;
  fileBusy: boolean;
  fileReady: boolean;
  fileName?: string;
};

export function AsrResultPane(props: AsrResultPaneProps) {
  const {
    segments,
    text,
    engine,
    hasSpeakers,
    streaming,
    audioUrl,
    source,
    error,
    scene,
    onScene,
    speakerMode,
    onSpeakerMode,
    target,
    onClear,
    recording,
    mode,
    onMode,
    listening,
    speaking,
    interim,
    vadSensitivity,
    silenceMs,
    onVadSensitivity,
    onVadSilence,
    fileName,
    // 必须解构出来用：漏掉的话下面 `history ? …` 读到的是全局 window.history（永远为真），
    // 历史条会一直显示、运行条再也出不来。
    history,
  } = props;
  const t = useT();

  const [view, setView] = useState<TranscriptView>(props.initialView ?? "minutes");
  // 用户手动切过视图就别再替他做主（下面录音开始时只在"没动过"的情况下切到逐句）。
  const [viewPicked, setViewPicked] = useState(false);
  // 默认 L（15px）：13px 在 2560 的屏上看转写稿偏小，读稿是这个页面的主要动作。
  const [scale, setScale] = useState<TextScaleId>("l");
  const [compact, setCompact] = useState(false);
  // 默认铺满：转写稿是要"看宽度"的东西，768px 的居中窄栏在宽屏上会白掉两边一大半
  // （2560 的屏上右侧面板约 1740px，窄栏只占 44%）。窄栏留给想看居中一列的读者，
  // 按上面的「全宽显示」随时切回去。
  const [fullWidth, setFullWidth] = useState(true);
  const [query, setQuery] = useState("");
  const [jumpIndex, setJumpIndex] = useState<number | null>(null);
  // 清空时加一：整理结果跟着清掉（在 InsightsSection 内部监听）。
  const [resetSignal, setResetSignal] = useState(0);

  const total = segments.length ? segments[segments.length - 1]!.end : 0;
  const speakerCount = useMemo(() => {
    if (!segments.length) return 1;
    return speakerMode && hasSpeakers ? new Set(segments.map((s) => s.speaker ?? 0)).size : 1;
  }, [segments, hasSpeakers, speakerMode]);
  const hasContent = segments.length > 0 || text.trim().length > 0;

  // 一开始采集就切到逐句：听写要看的是"一句话一句话地出来"，
  // 整理稿是转完之后的成品视图（一小时的稿子在整理稿里要滚很久才能看到最新那句）。
  // 注意自动听写没有"录音中"这个状态（recording 只在手动模式下为真），所以两个都要看 ——
  // 只看 recording 的话，自动听写期间界面一直停在整理稿上，看起来像"说话没有反应"。
  const capturing = recording || listening;
  useEffect(() => {
    if (capturing && !viewPicked && view === "minutes") setView("segments");
  }, [capturing, viewPicked, view]);

  const jump = (index: number) => setJumpIndex(index);

  const clearAll = () => {
    onClear();
    setJumpIndex(null);
    setQuery("");
    setResetSignal((v) => v + 1);
  };

  return (
    // @container：下面按"这块面板自己的宽度"分栏，而不是按窗口宽度 —— 左侧还有应用栏 +
    // 记录栏 + 参数栏占掉近 1000px，用视口断点会在 1800 的窗口上把正文挤成 700px。
    <div className="@container flex h-full min-h-0 flex-col">
      {/* 运行条：模式 / 状态与计时 / 电平 / 开始-停止-暂停 / 目标。
          看历史记录时这里换成那条记录的说明条 —— 采集按钮此刻没有意义（按下去是另起一份稿子）。 */}
      {history ? (
        <RecordHistoryBar record={history.record} onClose={history.onClose} />
      ) : (
        <RunBar
          mode={mode}
          onMode={onMode}
          recording={recording}
          listening={listening}
          speaking={speaking}
          paused={props.paused}
          level={props.level}
          elapsed={props.elapsed}
          target={target}
          onStart={props.onStart}
          onStop={props.onStop}
          onTogglePause={props.onTogglePause}
          onTranscribeFile={props.onTranscribeFile}
          fileReady={props.fileReady}
          fileBusy={props.fileBusy}
        />
      )}

      {/* 稿件条：这份稿子是什么 + 怎么读它（查找 / 字号 / 紧凑 / 全宽 / 清空） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2">
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
          <SpellCheckIcon className="size-3.5 text-primary" />
          {t("voice.asr.result")}
        </span>
        {engine && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {engine}
          </span>
        )}
        {/* 统计压成一行文字而不是四个胶囊：这块是"说明"，不该比主操作还抢眼 */}
        {hasContent && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {segments.length > 0
              ? `${segments.length} ${t("voice.asr.count")} · ${fmtClock(total)}`
              : `${text.trim().length} ${t("voice.asr.chars")}`}
            {speakerCount > 1 ? ` · ${speakerCount} ${t("voice.asr.speakers")}` : ""}
          </span>
        )}
        {fileName && (
          <span className="flex min-w-0 shrink items-center gap-1 text-[11px] text-muted-foreground">
            <FileAudioIcon className="size-3 shrink-0" />
            <span className="truncate">{fileName}</span>
          </span>
        )}

        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5">
          {/* 查找框常驻并占满余下的宽度：藏进图标里再给个两百来像素的窄框，
              长稿要查一个词就没法用了。 */}
          <span className="relative flex min-w-48 max-w-lg flex-1 items-center">
            <SearchIcon className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
            <Input
              value={query}
              // 查找读的是分段（命中位置对得上原文），历史记录只有整段文字，没得分段可查。
              disabled={!hasContent || !!history}
              onChange={(e) => {
                setQuery(e.target.value);
                // 查找只作用于逐句视图（整理稿是按规则改写过的，命中位置对不上原文）。
                if (e.target.value) setView((v) => (v === "segments" ? v : "segments"));
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder={t("voice.asr.searchPlaceholder")}
              className="h-7 pl-7 pr-7 text-xs"
            />
            {query && (
              <button
                type="button"
                title={t("voice.asr.searchClose")}
                onClick={() => setQuery("")}
                className="absolute right-1.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </span>

          {/* 字号：S / M / L / XL */}
          <div className="flex shrink-0 items-center rounded-full bg-muted p-0.5" title={t("voice.asr.fontSize")}>
            {TEXT_SCALES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setScale(s.id)}
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase transition-colors",
                  scale === s.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s.id}
              </button>
            ))}
          </div>

          <Button
            variant={compact ? "secondary" : "ghost"}
            size="icon-sm"
            tooltip={t("voice.asr.compact")}
            onClick={() => setCompact((v) => !v)}
          >
            <LayoutListIcon className="size-4" />
          </Button>
          <Button
            variant={fullWidth ? "secondary" : "ghost"}
            size="icon-sm"
            tooltip={t("voice.asr.fullWidth")}
            onClick={() => setFullWidth((v) => !v)}
          >
            <MaximizeIcon className="size-4" />
          </Button>
          {/* 清空清的是"正在做的这一份"：看历史记录时它只会清掉看不见的草稿 */}
          {!history && (
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("voice.asr.clear")}
              disabled={!hasContent}
              onClick={clearAll}
            >
              <EraserIcon className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {/* 参数条：场景 / 人声分离 / 切句 */}
      <RecognitionBar
        scene={scene}
        onScene={onScene}
        speakerMode={speakerMode}
        onSpeakerMode={onSpeakerMode}
        mode={mode}
        vadSensitivity={vadSensitivity}
        silenceMs={silenceMs}
        onVadSensitivity={onVadSensitivity}
        onVadSilence={onVadSilence}
      />

      {/* 稿件 + 整理（整区滚动，内容不截断） */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex w-full flex-1 flex-col gap-3 px-3 py-3",
            // 铺满时再往上加一档：极宽屏（≥1536）正文和整理面板并排，而不是把整理压在稿件下面 ——
            // 2560 的屏上正文能铺到 1700px，一栏长条读起来散，右栏才把宽度真的用上。
            fullWidth ? "max-w-none @6xl:flex-row @6xl:items-start" : "max-w-3xl",
            // 空稿件时整列居中：空状态 + 停用的整理面板贴在顶上会留一大块死区
            !hasContent && "justify-center @6xl:justify-start",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 flex-col gap-3",
              fullWidth && "@6xl:flex-1 @6xl:self-stretch",
              !hasContent && "justify-center",
            )}
          >
            {error && <ResultError error={error} />}

            {hasContent ? (
              <TranscriptSection
                segments={segments}
                text={text}
                hasSpeakers={hasSpeakers}
                speakerMode={speakerMode}
                streaming={streaming}
                audioUrl={audioUrl}
                view={view}
                onView={(v) => {
                  setViewPicked(true);
                  setView(v);
                }}
                scale={scale}
                compact={compact}
                query={view === "segments" ? query : ""}
                jumpIndex={jumpIndex}
                onJump={jump}
                source={source}
                interim={interim}
                dictating={mode === "auto" && listening}
                speaking={speaking}
              />
            ) : (
              <div className="flex items-center justify-center py-12">
                <ResultEmpty
                  icon={<SpellCheckIcon className="size-9 text-primary" />}
                  title={t("voice.asr.emptyTitle")}
                  hint={t("voice.asr.emptyHint")}
                />
              </div>
            )}
          </div>

          {/* 整理面板在空稿件时也留着：动作停用 + 一句说明，把"转出来能干什么"讲清楚 */}
          <div className={cn(fullWidth && "@6xl:w-[400px] @6xl:shrink-0")}>
            <InsightsSection
              segments={segments}
              text={text}
              hasSpeakers={hasSpeakers}
              scene={scene}
              resetSignal={resetSignal}
            />
          </div>
        </div>
      </div>

    </div>
  );
}
