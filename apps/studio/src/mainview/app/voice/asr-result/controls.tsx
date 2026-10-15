/**
 * 转写工作台的运行控制与识别参数（都在页面上方，不再有底部控制条）。
 *
 * 为什么从底部挪到顶部：跑一次的主操作（开始听写）原来贴在窗口最下沿，
 * 既容易被忽略，也不好一眼看出"到底在不在听"——状态、电平、按钮挤在一条里还要折行。
 * 现在按**一件事一行**分成两条：
 *   运行条  怎么听：模式 / 状态与计时 / 电平 / 开始-停止-暂停 / 目标
 *   参数条  按什么识别：场景 / 人声分离 / 切句参数
 * 页面底部留给稿件本身（多出来的高度全给内容）。
 */
import {
  CircleIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareIcon,
  TimerIcon,
} from "lucide-react";

import { Button } from "@ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/popover";
import { useT } from "@stores/ui-lang";
import { ASR_SCENES, asrScene, type AsrSceneId } from "@/shared/asr-insights";
import type { VadSensitivity } from "@/shared/asr-vad";
import { cn } from "@/mainview/lib/utils";
import { fmtClock } from "./transcript-utils";

export type AsrMode = "auto" | "manual";

/**
 * 电平表（rAF 每帧驱动，纯展示）：中间高、两端低，以中线为轴上下对称。
 *
 * 四条尺寸上的讲究，都是为了别让它变成一根虚线：
 * **柱少而宽** —— 32 根挤在 100 多像素里，每根只有 2~3px，整排看过去就是一串点；
 * 16 根 + 2px 缝 + 120px 宽，每根约 5px，才读得出"柱子"；
 * **不套框** —— 带边框和底色的长条会被当成一条分隔线（正是它上一版的样子）；
 * **可压缩** —— `flex-1` 让它在窗口变窄时自己先变短，而不是把主操作挤到下一行去；
 * **空闲画包络** —— 未开始时画静止的包络（有轮廓、无跳动）：等高的矮柱会被读成一串点，
 * 有起伏的轮廓才一眼看出"这是个还没开始动的电平表"。
 */
export function Waveform({
  level,
  active,
  className,
}: {
  level: number;
  active: boolean;
  className?: string;
}) {
  const BARS = 16;
  const center = (BARS - 1) / 2;
  return (
    <div
      className={cn("flex h-7 min-w-10 flex-1 items-center gap-[2px] overflow-hidden", className)}
      aria-hidden
    >
      {Array.from({ length: BARS }).map((_, i) => {
        // 包络：中间高、两端低；再叠一个固定相位，避免整排同步闪。
        const envelope = 0.35 + 0.65 * (1 - Math.abs(i - center) / center);
        const phase = 0.65 + 0.35 * Math.abs(Math.sin(i * 12.9898));
        const h = active
          ? Math.max(10, Math.min(100, level * 100 * envelope * phase + 10))
          : 14 + envelope * 64;
        return (
          <span
            key={i}
            className={cn(
              "min-w-[3px] flex-1 rounded-[2px] transition-[height] duration-75",
              active ? "bg-primary/80" : "bg-muted-foreground/30",
            )}
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
}

/** 人声分离开关（轻量开关，不占一整行）。 */
function MiniSwitch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      title={label}
      className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:border-muted-foreground/50"
    >
      <span
        className={cn(
          "relative inline-flex h-3.5 w-6 items-center rounded-full border transition-colors",
          on ? "border-primary bg-primary" : "border-border bg-muted",
        )}
      >
        <span
          className={cn(
            "inline-block size-2.5 transform rounded-full bg-background shadow-sm transition-transform",
            on ? "translate-x-[12px]" : "translate-x-[1px]",
          )}
        />
      </span>
      <span className={on ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </button>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * 切句参数（自动听写用）：灵敏度与"停顿多久算说完"。
 *
 * 收在一个齿轮气泡里：这两项调一次就不动了，摊在参数条上要占掉半行、还比主操作显眼。
 */
function VadTuning({
  sensitivity,
  silenceMs,
  onSensitivity,
  onSilenceMs,
}: {
  sensitivity: VadSensitivity;
  silenceMs: number;
  onSensitivity: (v: VadSensitivity) => void;
  onSilenceMs: (v: number) => void;
}) {
  const t = useT();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" tooltip={t("voice.asr.vad.title")}>
          <SlidersHorizontalIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-64 space-y-2.5">
        <p className="text-xs font-medium">{t("voice.asr.vad.title")}</p>
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">{t("voice.asr.vad.sensitivity")}</p>
          <div className="flex items-center gap-1">
            {(["low", "medium", "high"] as const).map((level) => (
              <Chip key={level} active={sensitivity === level} onClick={() => onSensitivity(level)}>
                {t(`voice.asr.vad.sens.${level}`)}
              </Chip>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">{t("voice.asr.vad.silence")}</p>
          <div className="flex items-center gap-1">
            {[600, 1000, 1500].map((ms) => (
              <Chip key={ms} active={silenceMs === ms} onClick={() => onSilenceMs(ms)}>
                {ms / 1000}s
              </Chip>
            ))}
          </div>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground/80">{t("voice.asr.vad.hint")}</p>
      </PopoverContent>
    </Popover>
  );
}

/** 运行条：怎么听 + 一次识别的开始/停止。主操作在这里，不进底部。 */
export function RunBar({
  mode,
  onMode,
  recording,
  listening,
  speaking,
  paused,
  level,
  elapsed,
  target,
  onStart,
  onStop,
  onTogglePause,
  onTranscribeFile,
  fileReady,
  fileBusy,
}: {
  mode: AsrMode;
  onMode: (m: AsrMode) => void;
  recording: boolean;
  listening: boolean;
  speaking: boolean;
  paused: boolean;
  level: number;
  elapsed: number;
  target: string;
  onStart: () => void;
  onStop: () => void;
  onTogglePause: () => void;
  onTranscribeFile: () => void;
  fileReady: boolean;
  fileBusy: boolean;
}) {
  const t = useT();
  const active = mode === "auto" ? listening : recording;
  const state = !active
    ? t("voice.asr.idle")
    : paused
      ? t("voice.asr.paused")
      : mode === "auto"
        ? speaking
          ? t("voice.asr.speaking")
          : t("voice.asr.dictating")
        : t("voice.asr.recording");

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      {/* 采集方式：自动听写（按停顿时自动切句）/ 手动（按开始-停止录一整段） */}
      <div className="flex shrink-0 items-center rounded-lg border p-0.5">
        {(
          [
            { id: "auto" as const, label: t("voice.asr.mode.auto"), icon: SparklesIcon },
            { id: "manual" as const, label: t("voice.asr.mode.manual"), icon: MicIcon },
          ] as const
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={active}
            title={option.id === "auto" ? t("voice.asr.mode.autoHint") : t("voice.asr.mode.manualHint")}
            onClick={() => onMode(option.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-50",
              mode === option.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <option.icon className="size-3.5" />
            {option.label}
          </button>
        ))}
      </div>

      {/* 状态 + 计时 + 电平：一眼看出"在不在听、听到多大声音" */}
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-xs",
          active && !paused ? (mode === "auto" ? "text-primary" : "text-destructive") : "text-muted-foreground",
        )}
      >
        <CircleIcon
          className={cn("size-2.5 fill-current", active && !paused && (mode === "manual" || speaking) && "animate-pulse")}
        />
        {state}
        {active && (
          <span className="flex items-center gap-1 font-mono text-muted-foreground tabular-nums">
            <TimerIcon className="size-3.5" />
            {fmtClock(elapsed)}
          </span>
        )}
      </span>

      {/* 电平表限宽：它只是"在不在听"的指示，窗口变窄时先压缩它，别把主操作顶到下一行 */}
      <Waveform level={level} active={active && !paused} className="max-w-28" />

      {/* 主操作：只此一处，不在底部再放一份 */}
      {active ? (
        <>
          <Button size="sm" variant="destructive" onClick={onStop}>
            <SquareIcon data-icon="inline-start" />
            {mode === "auto" ? t("voice.asr.dictationStop") : t("voice.asr.recordStop")}
          </Button>
          <Button size="sm" variant="outline" onClick={onTogglePause}>
            {paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
            {paused ? t("voice.asr.resumeLive") : t("voice.asr.pauseLive")}
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={onStart}>
          {mode === "auto" ? (
            <SparklesIcon data-icon="inline-start" />
          ) : (
            <MicIcon data-icon="inline-start" />
          )}
          {mode === "auto" ? t("voice.asr.dictationStart") : t("voice.asr.recordStart")}
        </Button>
      )}

      {fileReady && (
        <Button size="sm" variant="outline" disabled={fileBusy || active} onClick={onTranscribeFile}>
          {t("voice.asr.transcribeFile")}
        </Button>
      )}

      {/* 目标：这一轮实际会用到的引擎与模型（换引擎在左栏，这里只显示）。
          标签收进 title，省下的横向空间留给主操作；窄窗口（<1280）干脆不显示 ——
          它只是"会用哪个引擎"的说明，左栏的引擎卡就在说同一件事，不值得为它折行。 */}
      <span
        className="ml-auto hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground xl:flex"
        title={`${t("voice.asr.target")}：${target}`}
      >
        <span className="max-w-72 truncate font-mono">{target}</span>
      </span>
    </div>
  );
}

/** 参数条：按什么识别 —— 场景 / 人声分离 / 切句参数。 */
export function RecognitionBar({
  scene,
  onScene,
  speakerMode,
  onSpeakerMode,
  mode,
  vadSensitivity,
  silenceMs,
  onVadSensitivity,
  onVadSilence,
}: {
  scene: AsrSceneId;
  onScene: (s: AsrSceneId) => void;
  speakerMode: boolean;
  onSpeakerMode: (v: boolean) => void;
  mode: AsrMode;
  vadSensitivity: VadSensitivity;
  silenceMs: number;
  onVadSensitivity: (v: VadSensitivity) => void;
  onVadSilence: (v: number) => void;
}) {
  const t = useT();
  const activeScene = asrScene(scene);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{t("voice.asr.scene")}</span>
      {ASR_SCENES.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => {
            onScene(s.id);
            // 场景决定人声分离的默认值（会议/访谈要分人，字幕不要），用户随时可再改。
            onSpeakerMode(s.preferDiarize);
          }}
          title={t(s.hintKey)}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
            s.id === scene
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
          )}
        >
          {t(s.labelKey)}
        </button>
      ))}
      <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80 lg:block">
        {t(activeScene.hintKey)}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <MiniSwitch on={speakerMode} onChange={onSpeakerMode} label={t("voice.asr.spkSeparate")} />
        {mode === "auto" && (
          <VadTuning
            sensitivity={vadSensitivity}
            silenceMs={silenceMs}
            onSensitivity={onVadSensitivity}
            onSilenceMs={onVadSilence}
          />
        )}
      </div>
    </div>
  );
}
