/**
 * 转写稿区：播放头（音频 ↔ 文字联动）、时间轴、以及三种正文视图（整理稿 / 逐句 / 纯文）。
 *
 * 逐句视图按「时间戳 · 说话人 · 正文」压成一行行密排的行，而不是卡片：
 * 一小时会议是上千句，卡片一屏放不下几句，翻起来全是边框。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLinesIcon,
  CheckIcon,
  CopyIcon,
  FileAudioIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
} from "lucide-react";

import type { AsrSegment } from "../../../../bun/asr";
import { Markdown } from "@components/markdown";
import { SegmentedControl } from "@components/segmented-control";
import { Button } from "@ui/button";
import { buildMinutesMarkdown } from "@lib/minutes";
import { findActiveSegment } from "@lib/segments";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { controlAudio, seekAudio, useAudioBar } from "../audio-player";
import {
  buildSrt,
  fmtClock,
  searchSegments,
  speakerStyle,
  textScale,
  type TextScaleId,
} from "./transcript-utils";

export type TranscriptView = "minutes" | "segments" | "plain";

/** 复制一次给 1.6 秒的对勾反馈（三个复制按钮共用一份状态）。 */
function useCopyFeedback(): [string | null, (kind: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const copy = (kind: string, text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {});
    setCopied(kind);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1600) as unknown as number;
  };
  return [copied, copy];
}

function niceStep(total: number): number {
  if (total <= 15) return 5;
  if (total <= 60) return 10;
  if (total <= 180) return 30;
  if (total <= 600) return 60;
  return 120;
}

/** 带时间刻度的分段条带：每段按起止时间与说话人着色，点击跳到对应句子。 */
function SegmentTimeline({
  segments,
  speakerMode,
  hasSpeakers,
  onJump,
  currentTime,
}: {
  segments: AsrSegment[];
  speakerMode: boolean;
  hasSpeakers: boolean;
  onJump: (index: number) => void;
  /** 播放位置（秒）；有值时显示红色播放游标。 */
  currentTime?: number;
}) {
  const total = Math.max(segments[segments.length - 1]?.end ?? 0, 1);
  const step = niceStep(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += step) ticks.push(t);
  if (ticks[ticks.length - 1]! < total - 0.5) ticks.push(total);

  return (
    <div className="select-none">
      <div className="relative h-6 w-full overflow-hidden rounded-md bg-muted/60">
        {segments.map((s, i) => {
          const spk = speakerMode && hasSpeakers && s.speaker != null ? s.speaker : 0;
          const st = speakerStyle(spk);
          const left = Math.max(0, (s.start / total) * 100);
          const width = Math.max(((s.end - s.start) / total) * 100, 1.2);
          return (
            <button
              key={`${i}-${s.start.toFixed(2)}`}
              type="button"
              onClick={() => onJump(i)}
              title={`${fmtClock(s.start)} – ${fmtClock(s.end)} · ${s.text.slice(0, 40)}`}
              className={cn(
                "absolute inset-y-1.5 rounded-[3px] opacity-70 transition-opacity hover:opacity-100",
                st.bar,
              )}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
        {currentTime != null && currentTime > 0 && (
          <span
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.8)]"
            style={{ left: `${Math.min((currentTime / total) * 100, 100)}%` }}
          />
        )}
      </div>
      <div className="relative mt-0.5 h-3.5 text-[9px] text-muted-foreground tabular-nums">
        {ticks.map((tick) => (
          <span
            key={tick}
            className="absolute -translate-x-1/2 first:translate-x-0 last:translate-x-[-100%]"
            style={{ left: `${(tick / total) * 100}%` }}
          >
            {fmtClock(tick)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * 音频 ↔ 文字对齐的播放状态：音轨挂在**全页共用**的那一个 audio 元素上（`../audio-player`），
 * 播放头（进度 + 时间轴游标）与逐句列表的高亮共用同一份 playCur。
 * 共用的好处：左侧列表里那颗小播放键与这里的播放条是同一条音轨，不会两条一起响。
 */
function useAudioPlayback(url: string | undefined) {
  const { playing, currentTime, duration } = useAudioBar(url);
  return {
    playCur: currentTime,
    playing,
    audioDur: duration,
    seekTo: (t: number) => {
      if (url) seekAudio(url, t);
    },
    toggle: () => {
      if (url) controlAudio(url);
    },
  };
}

/** 播放头：播放 / 暂停 + 可点进度条，下方是时间轴轨道。 */
function AudioHeader({
  playing,
  playCur,
  duration,
  total,
  onToggle,
  onSeek,
  segments,
  speakerMode,
  hasSpeakers,
  onJumpSegment,
}: {
  playing: boolean;
  playCur: number;
  duration: number;
  total: number;
  onToggle: () => void;
  onSeek: (t: number) => void;
  segments: AsrSegment[];
  speakerMode: boolean;
  hasSpeakers: boolean;
  onJumpSegment: (index: number) => void;
}) {
  const t = useT();
  const barRef = useRef<HTMLDivElement>(null);
  const dur = duration > 0 ? duration : total;
  const pct = dur > 0 ? Math.min((playCur / dur) * 100, 100) : 0;

  const seekFromEvent = (e: React.MouseEvent) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    onSeek(((e.clientX - rect.left) / rect.width) * dur);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-3">
        <Button size="icon-sm" onClick={onToggle} tooltip={playing ? t("voice.asr.pause") : t("voice.asr.play")}>
          {playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </Button>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{fmtClock(playCur)}</span>
        <div
          ref={barRef}
          onClick={seekFromEvent}
          className="group relative h-4 flex-1 cursor-pointer"
          role="slider"
          aria-valuemin={0}
          aria-valuemax={dur}
          aria-valuenow={Math.round(playCur)}
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary/70 transition-[width] duration-100" style={{ width: `${pct}%` }} />
          </div>
          <span
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow transition-[left] duration-100 group-hover:size-3.5"
            style={{ left: `${pct}%` }}
          />
        </div>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{fmtClock(dur)}</span>
      </div>
      {/* 时间轴只有在有分段时才画：整段文字（历史记录）没有段落可标，空轨道看着像坏了 */}
      {segments.length > 0 && (
        <SegmentTimeline
          segments={segments}
          speakerMode={speakerMode}
          hasSpeakers={hasSpeakers}
          onJump={onJumpSegment}
          currentTime={playCur}
        />
      )}
    </div>
  );
}

/** 逐句行：时间戳 · 说话人 · 正文，一行一句。紧凑模式下只剩正文。 */
function SegmentRow({
  seg,
  index,
  speakerMode,
  hasSpeakers,
  compact,
  scale,
  active,
  onJump,
  clickable,
}: {
  seg: AsrSegment;
  index: number;
  speakerMode: boolean;
  hasSpeakers: boolean;
  compact: boolean;
  scale: TextScaleId;
  active: boolean;
  onJump: (index: number) => void;
  clickable: boolean;
}) {
  const t = useT();
  const size = textScale(scale);
  const showSpeaker = speakerMode && hasSpeakers && seg.speaker != null;
  const st = speakerStyle(showSpeaker ? seg.speaker! : 0);

  return (
    <div
      data-seg={index}
      onClick={() => onJump(index)}
      role={clickable ? "button" : undefined}
      title={clickable ? t("voice.asr.jumpHint") : undefined}
      className={cn(
        "flex items-baseline gap-2.5 rounded-md px-2 py-1 transition-colors",
        active ? "bg-primary/10 ring-1 ring-primary/30" : "hover:bg-muted/40",
        clickable && "cursor-pointer",
      )}
    >
      {!compact && (
        <span className={cn("w-11 shrink-0 text-right font-mono text-muted-foreground tabular-nums", size.meta)}>
          {fmtClock(seg.start)}
        </span>
      )}
      {!compact && showSpeaker && (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={cn("size-2 rounded-full", st.dot)} />
          <span className={cn("font-medium text-muted-foreground", size.meta)}>
            {t("voice.spk")} {seg.speaker! + 1}
          </span>
        </span>
      )}
      <p className={cn("min-w-0 flex-1 leading-relaxed break-words", size.className)}>{seg.text}</p>
    </div>
  );
}

export function TranscriptSection({
  segments,
  text,
  hasSpeakers,
  speakerMode,
  streaming,
  audioUrl,
  view,
  onView,
  scale,
  compact,
  query,
  jumpIndex,
  onJump,
  source,
  interim,
  dictating,
  speaking,
}: {
  segments: AsrSegment[];
  text: string;
  hasSpeakers: boolean;
  speakerMode: boolean;
  streaming: boolean;
  audioUrl?: string;
  /** 正在说的这一句的中间识别结果（灰色预览行）。 */
  interim?: string | null;
  /** 自动听写中（一直在听）。 */
  dictating?: boolean;
  /** 本地判定这一段有说话（还没等到识别结果）。 */
  speaking?: boolean;
  view: TranscriptView;
  onView: (v: TranscriptView) => void;
  scale: TextScaleId;
  compact: boolean;
  /** 稿内查找关键字（空串 = 不过滤）。 */
  query: string;
  jumpIndex: number | null;
  onJump: (index: number) => void;
  /** 稿件来源：麦克风录音 or 音频文件。 */
  source: "mic" | "file";
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const hasSegs = segments.length > 0;
  const total = hasSegs ? segments[segments.length - 1]!.end : 0;
  const { playCur, playing, audioDur, seekTo, toggle } = useAudioPlayback(audioUrl);
  const activeSeg = useMemo(
    () => (audioUrl && playing ? findActiveSegment(segments, playCur) : -1),
    [audioUrl, playing, segments, playCur],
  );
  const size = textScale(scale);

  const visible = useMemo(() => searchSegments(segments, query), [segments, query]);
  const filtered = query.trim().length > 0;

  // 播放跟随：当前句变化时把它滚进视野（仅播放中；用户暂停浏览时不抢滚动条）。
  useEffect(() => {
    if (!playing || activeSeg < 0 || view !== "segments") return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-seg="${activeSeg}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeSeg, playing, view]);

  // 听写中始终跟着最新一行走：说话的人关心的是"我刚说的出来没有"。
  // 有音频在播时让位给播放跟随（两个都抢滚动条只会来回跳）。
  useEffect(() => {
    if (!dictating || playing) return;
    let node = listRef.current?.parentElement ?? null;
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
    node?.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [dictating, playing, visible.length, interim]);

  const jump = (index: number) => {
    onJump(index);
    if (audioUrl && segments[index]) seekTo(segments[index]!.start);
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-seg="${index}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const minutes = useMemo(
    () => (hasSegs ? buildMinutesMarkdown(segments, speakerMode && hasSpeakers, t("voice.spk")) : ""),
    [segments, hasSpeakers, speakerMode, t, hasSegs],
  );

  const fullText = text || segments.map((s) => s.text).join("");
  // 有音频就配一个播放头：分段稿能点句定位，整段文字（历史记录）也能听/下载。
  const hasBody = hasSegs || fullText.trim().length > 0;
  const srt = useMemo(
    () => (hasSegs ? buildSrt(segments, speakerMode && hasSpeakers, t("voice.spk")) : ""),
    [segments, speakerMode, hasSpeakers, t, hasSegs],
  );
  const [copied, copy] = useCopyFeedback();

  return (
    <section className="rounded-xl border bg-card">
      {/* 区头：标题 + 来源 + 视图切换（一行的控件，不上下堆叠） */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <AudioLinesIcon className="size-4 shrink-0 text-primary" />
          <span className="text-xs font-medium">{t("voice.asr.sectionTranscript")}</span>
          <span className="truncate text-[11px] text-muted-foreground">{t("voice.asr.thread")}</span>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-[10px] text-muted-foreground">
            {source === "mic" ? <MicIcon className="size-3" /> : <FileAudioIcon className="size-3" />}
            {source === "mic" ? t("voice.asr.sourceMic") : t("voice.asr.sourceFile")}
          </span>
          {dictating && (
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary",
              )}
            >
              <span className={cn("size-1.5 rounded-full bg-primary", speaking && "animate-pulse")} />
              {speaking ? t("voice.asr.speaking") : t("voice.asr.dictating")}
            </span>
          )}
          {filtered && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary tabular-nums">
              <SearchIcon className="size-3" />
              {t("voice.asr.matchCount", { n: String(visible.length) })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {hasSegs && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              tooltip={t("voice.asr.copyMd")}
              onClick={() => copy("md", minutes)}
            >
              {copied === "md" ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
              {copied === "md" ? t("voice.copied") : t("voice.asr.copyMd")}
            </Button>
          )}
          {fullText && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              tooltip={t("voice.asr.copyText")}
              onClick={() => copy("text", fullText)}
            >
              {copied === "text" ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
              {t("voice.asr.copyText")}
            </Button>
          )}
          {hasSegs && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              tooltip={t("voice.asr.copySrt")}
              onClick={() => copy("srt", srt)}
            >
              {copied === "srt" ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
              {t("voice.asr.copySrt")}
            </Button>
          )}
          {/* 三种视图是按分段切出来的（整理稿 / 逐句）；只有整段文字时只剩「纯文」可看，
              给一排点了没反应的按钮不如收起来。 */}
          {hasSegs && (
            <SegmentedControl
              value={view}
              onChange={onView}
              options={[
                { value: "minutes", label: t("voice.asr.viewMinutes") },
                { value: "segments", label: t("voice.asr.viewSegments") },
                { value: "plain", label: t("voice.asr.viewPlain") },
              ]}
            />
          )}
        </div>
      </div>

      <div ref={listRef} className="flex flex-col gap-3 p-4">
        {/* 音频来源（本地文件 / 历史记录）时有播放头：进度 + 时间轴，点句即定位 */}
        {audioUrl && hasBody && (
          <AudioHeader
            playing={playing}
            playCur={playCur}
            duration={audioDur}
            total={total}
            onToggle={toggle}
            onSeek={seekTo}
            segments={segments}
            speakerMode={speakerMode}
            hasSpeakers={hasSpeakers}
            onJumpSegment={jump}
          />
        )}

        {(!hasSegs || view === "plain") && fullText && (
          <p className={cn("rounded-lg bg-muted/50 px-3 py-2 leading-relaxed whitespace-pre-wrap", size.className)}>
            {fullText}
            {streaming && <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-primary align-middle" />}
          </p>
        )}

        {view === "minutes" && hasSegs && (
          <div className="rounded-lg border bg-background/60 px-5 py-4">
            <Markdown content={minutes} mode="static" />
          </div>
        )}

        {view === "segments" && hasSegs && (
          <div className="flex flex-col gap-0.5">
            {visible.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t("voice.asr.noMatch")}</p>
            ) : (
              visible.map(({ index, seg }) => (
                <SegmentRow
                  key={`${index}-${seg.start.toFixed(2)}`}
                  seg={seg}
                  index={index}
                  speakerMode={speakerMode}
                  hasSpeakers={hasSpeakers}
                  compact={compact}
                  scale={scale}
                  active={jumpIndex === index || activeSeg === index}
                  onJump={jump}
                  clickable={!!audioUrl}
                />
              ))
            )}
          </div>
        )}

        {/* 中间结果：人还在说的时候先把大致内容显示出来，收句后被正式的那句替换掉 */}
        {interim && (
          <div className="flex items-baseline gap-2.5 rounded-md border border-dashed border-primary/40 bg-primary/5 px-2 py-1">
            <span className="w-11 shrink-0 text-right font-mono text-[10px] text-muted-foreground/60">·</span>
            {/* 未定稿的这一句也按正常字号显示：它就是要让人看见"我这句话已经进去了" */}
            <p className={cn("min-w-0 flex-1 leading-relaxed", size.className)}>
              {interim}
              <span className="ml-1.5 align-middle text-[10px] whitespace-nowrap text-primary/80">
                {t("voice.asr.interim")}
              </span>
            </p>
          </div>
        )}

        {streaming && (
          <div className="flex items-center gap-2 px-2 text-[11px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            {t("voice.asr.liveStreaming")}
          </div>
        )}

        {hasSegs && speakerMode && !hasSpeakers && (
          <p className="text-[11px] text-muted-foreground/80">{t("voice.asr.noSpkInfo")}</p>
        )}
      </div>
    </section>
  );
}
