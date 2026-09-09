import { useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  ListIcon,
  SpellCheckIcon,
  TimerIcon,
  UsersIcon,
} from "lucide-react";
import type { AsrSegment } from "../../bun/asr";
import { useT } from "@stores/ui-lang";
import { Button } from "@ui/button";
import { cn } from "@/mainview/lib/utils";

/**
 * 每句话说话人的配色（静态 tailwind 类，保证 JIT 能拾取）。
 * 说话人 id 对数组长度取模，保证任意人数都有可用配色。
 */
const SPEAKER_STYLES = [
  { bar: "bg-sky-500", dot: "bg-sky-500", chip: "border-sky-500/30 bg-sky-500/10 text-sky-600", edge: "border-sky-400/60" },
  { bar: "bg-rose-500", dot: "bg-rose-500", chip: "border-rose-500/30 bg-rose-500/10 text-rose-600", edge: "border-rose-400/60" },
  { bar: "bg-amber-500", dot: "bg-amber-500", chip: "border-amber-500/30 bg-amber-500/10 text-amber-600", edge: "border-amber-400/60" },
  { bar: "bg-emerald-500", dot: "bg-emerald-500", chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600", edge: "border-emerald-400/60" },
  { bar: "bg-violet-500", dot: "bg-violet-500", chip: "border-violet-500/30 bg-violet-500/10 text-violet-600", edge: "border-violet-400/60" },
  { bar: "bg-cyan-500", dot: "bg-cyan-500", chip: "border-cyan-500/30 bg-cyan-500/10 text-cyan-600", edge: "border-cyan-400/60" },
  { bar: "bg-orange-500", dot: "bg-orange-500", chip: "border-orange-500/30 bg-orange-500/10 text-orange-600", edge: "border-orange-400/60" },
  { bar: "bg-fuchsia-500", dot: "bg-fuchsia-500", chip: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-600", edge: "border-fuchsia-400/60" },
];

export function speakerStyle(speaker: number) {
  return SPEAKER_STYLES[speaker % SPEAKER_STYLES.length]!;
}

/**
 * 合并两次实时轮询的分段：按开始时间相近去重，后到的（更完整、更精确的）
 * 结果替换旧片段，保持按时间排序。实时转写每次都会重转整段已录音频，因此
 * 之前已展示的片段可能被修正，这里用时间相似度做锚点去重。
 */
export function mergeSegments(prev: AsrSegment[], next: AsrSegment[]): AsrSegment[] {
  if (prev.length === 0) return [...next];
  const out = [...prev];
  for (const seg of next) {
    const idx = out.findIndex((p) => Math.abs(p.start - seg.start) < 1.2);
    if (idx >= 0) out[idx] = seg;
    else out.push(seg);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 媒体时间轴时钟：m:ss 或 h:mm:ss。 */
export function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function buildSrt(segments: AsrSegment[], hasSpeakers: boolean, speakerLabel: string): string {
  return segments
    .map((s, i) => {
      const label =
        hasSpeakers && s.speaker != null ? `[${speakerLabel} ${s.speaker + 1}] ` : "";
      return `${i + 1}\n${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}\n${label}${s.text}`;
    })
    .join("\n\n");
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
}: {
  segments: AsrSegment[];
  speakerMode: boolean;
  hasSpeakers: boolean;
  onJump: (index: number) => void;
}) {
  const total = Math.max(segments[segments.length - 1]?.end ?? 0, 1);
  const step = niceStep(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += step) ticks.push(t);
  if (ticks[ticks.length - 1]! < total - 0.5) ticks.push(total);

  return (
    <div className="select-none">
      <div className="relative h-9 w-full overflow-hidden rounded-lg bg-muted/60">
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
              className={cn("absolute inset-y-1 rounded-md transition-[filter] hover:brightness-110", st.bar, "opacity-90")}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
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

export function TranscriptViewer({
  segments,
  text,
  engine,
  hasSpeakers,
  speakerMode,
  streaming,
  onJump,
  jumpIndex,
}: {
  segments: AsrSegment[];
  text: string;
  engine?: string;
  hasSpeakers?: boolean;
  speakerMode: boolean;
  streaming?: boolean;
  onJump?: (index: number) => void;
  jumpIndex?: number | null;
}) {
  const t = useT();
  const [view, setView] = useState<"segments" | "plain">("segments");
  const [copied, copy] = useCopyFeedback();
  const listRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const hasSegs = segments.length > 0;
  const total = hasSegs ? segments[segments.length - 1]!.end : 0;
  const speakerCount = useMemo(() => {
    if (!hasSegs) return 1;
    return speakerMode && hasSpeakers
      ? new Set(segments.map((s) => s.speaker ?? 0)).size
      : 1;
  }, [segments, hasSpeakers, speakerMode, hasSegs]);

  const jump = (index: number) => {
    onJump?.(index);
    // Always scroll the clicked segment into view inside the list.
    requestAnimationFrame(() => {
      const el = cardRef.current?.querySelector<HTMLElement>(`[data-seg="${index}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const fullText = text || segments.map((s) => s.text).join("");
  const srt = buildSrt(segments, speakerMode && !!hasSpeakers, t("voice.spk"));

  if (!fullText && !hasSegs && !streaming) return null;

  return (
    <div ref={cardRef} className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
      {/* Header: stats + actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <SpellCheckIcon className="size-3.5 text-primary" />
            {t("voice.asr.result")}
          </span>
          {engine && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {engine}
            </span>
          )}
          {hasSegs && (
            <>
              <span className="flex items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                <ListIcon className="size-3" />
                {segments.length} {t("voice.asr.count")}
              </span>
              <span className="flex items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                <TimerIcon className="size-3" />
                {fmtClock(total)}
              </span>
              <span className="flex items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                <UsersIcon className="size-3" />
                {speakerCount} {t("voice.asr.speakers")}
              </span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {hasSegs && (
            <>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => copy("text", fullText)}>
                {copied === "text" ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
                {copied === "text" ? t("voice.copied") : t("voice.asr.copyText")}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => copy("srt", srt)}>
                {copied === "srt" ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
                {copied === "srt" ? t("voice.asr.srtCopied") : t("voice.asr.copySrt")}
              </Button>
              <div className="ml-1 flex items-center rounded-full bg-muted p-0.5">
                <button
                  type="button"
                  onClick={() => setView("segments")}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] transition-colors",
                    view === "segments" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t("voice.asr.viewSegments")}
                </button>
                <button
                  type="button"
                  onClick={() => setView("plain")}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] transition-colors",
                    view === "plain" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t("voice.asr.viewPlain")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Speaker legend */}
      {hasSegs && speakerMode && hasSpeakers && speakerCount > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          {Array.from(new Set(segments.map((s) => s.speaker ?? 0)))
            .sort((a, b) => a - b)
            .map((spk) => (
              <span key={spk} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn("size-2 rounded-full", speakerStyle(spk).dot)} />
                {t("voice.spk")} {spk + 1}
              </span>
            ))}
        </div>
      )}

      {/* Timeline strip */}
      {hasSegs && view === "segments" && <SegmentTimeline segments={segments} speakerMode={speakerMode} hasSpeakers={!!hasSpeakers} onJump={jump} />}

      {/* No-speaker hint */}
      {hasSegs && speakerMode && !hasSpeakers && (
        <p className="text-[11px] text-muted-foreground/80">{t("voice.asr.noSpkInfo")}</p>
      )}

      {/* Body */}
      {view === "plain" || !hasSegs ? (
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-[13px] leading-relaxed">
          {fullText}
          {streaming && <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-primary align-middle" />}
        </p>
      ) : (
        <div ref={listRef} className="max-h-80 overflow-y-auto rounded-lg">
          <div className="flex flex-col gap-0.5">
            {segments.map((s, i) => {
              const spk = speakerMode && hasSpeakers && s.speaker != null ? s.speaker : 0;
              const st = speakerStyle(spk);
              const active = jumpIndex === i;
              return (
                <div
                  key={`${i}-${s.start.toFixed(2)}`}
                  data-seg={i}
                  className={cn(
                    "flex gap-3 rounded-lg border-l-2 px-3 py-2 transition-colors",
                    st.edge,
                    active ? "bg-primary/5" : "hover:bg-muted/40",
                  )}
                >
                  <div className="mt-0.5 flex w-[6.5rem] shrink-0 flex-col items-start gap-1">
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      {fmtClock(s.start)} – {fmtClock(s.end)}
                    </span>
                    <span className={cn("rounded-full border px-1.5 py-px text-[9px] font-medium", st.chip)}>
                      {t("voice.spk")} {(spk + 1).toString()}
                    </span>
                  </div>
                  <p className="min-w-0 flex-1 text-[13px] leading-relaxed">{s.text}</p>
                </div>
              );
            })}
            {streaming && (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                {t("voice.asr.liveStreaming")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
