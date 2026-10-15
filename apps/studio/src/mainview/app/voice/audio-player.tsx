/**
 * 语音页共用的迷你播放器。
 *
 * 全页只有**一个** audio 元素（模块级单例）：左侧列表点播放、右侧详情再点播放，
 * 否则就是两条音轨同时响。一个元素天然保证"同时只响一个"，也免掉一屏几十行各自
 * 捏一个 `<audio controls>` —— 那正是左侧列表此前又高又笨的原因（每行一条浏览器原生
 * 播放条，一个大圆键加一条进度）。
 *
 * 对外只有两件东西：`controlAudio` / `seekAudio` / `releaseAudio` 三个动作，和
 * **按值订阅**的 hook。选择器返回的都是布尔 / 数字这类原始值，所以一行记录空闲时
 * 不会跟着播放进度重渲染，只有正在响的那一行会。
 */
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { fmtClock } from "./asr-result/transcript-utils";

type Snapshot = {
  /** 当前挂在这个元素上的音轨。 */
  url: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  /** 加载失败的音轨（文件被清理 / 目录被删）：对应那一条显示"音频不存在"，而不是死播放器。 */
  failed: string | null;
};

let el: HTMLAudioElement | null = null;
let snapshot: Snapshot = { url: null, playing: false, currentTime: 0, duration: 0, failed: null };
const listeners = new Set<() => void>();

function publish(patch: Partial<Snapshot>) {
  const next = { ...snapshot, ...patch };
  if (
    next.url === snapshot.url &&
    next.playing === snapshot.playing &&
    next.currentTime === snapshot.currentTime &&
    next.duration === snapshot.duration &&
    next.failed === snapshot.failed
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function audioEl(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  if (el) return el;
  const a = document.createElement("audio");
  a.preload = "metadata";
  a.addEventListener("timeupdate", () => publish({ currentTime: a.currentTime }));
  a.addEventListener("durationchange", () =>
    publish({ duration: Number.isFinite(a.duration) ? a.duration : 0 }),
  );
  a.addEventListener("play", () => publish({ playing: true }));
  a.addEventListener("pause", () => publish({ playing: false }));
  a.addEventListener("ended", () => publish({ playing: false, currentTime: 0 }));
  a.addEventListener("error", () => publish({ playing: false, failed: snapshot.url }));
  el = a;
  return a;
}

/**
 * 预挂音轨只取元数据（不播）：播放条一出现就能显示总时长、进度条也能点。
 * 只有完整播放条会调用它 —— 列表行那颗播放键不预挂，否则一屏十几行会各自去打一次
 * 元数据请求（真实应用里就是十几条音频的网络往返）。
 */
export function primeAudio(url: string): void {
  const a = audioEl();
  if (!a || snapshot.url === url) return;
  a.pause();
  a.src = url;
  publish({ url, currentTime: 0, duration: 0, playing: false, failed: null });
}

/** 播放 / 暂停这一条。换音轨时先把上一条停掉，不然旧的那条会接着响。 */
export function controlAudio(url: string): void {
  const a = audioEl();
  if (!a) return;
  if (snapshot.url !== url) {
    a.pause();
    a.src = url;
    a.currentTime = 0;
    publish({ url, currentTime: 0, duration: 0, playing: false, failed: null });
  }
  if (a.paused) {
    try {
      const started = a.play();
      if (started && typeof started.catch === "function") {
        void started.catch(() => publish({ playing: false }));
      }
    } catch {
      publish({ playing: false });
    }
  } else {
    a.pause();
  }
}

/** 跳到第 t 秒并继续播（逐句定位用）。 */
export function seekAudio(url: string, t: number): void {
  const a = audioEl();
  if (!a) return;
  if (snapshot.url !== url) {
    a.src = url;
    publish({ url, currentTime: 0, duration: 0, playing: false, failed: null });
  }
  a.currentTime = Math.max(0, t);
  publish({ currentTime: a.currentTime });
  try {
    void a.play().catch(() => publish({ playing: false }));
  } catch {
    publish({ playing: false });
  }
}

/** 播放器卸载时收声：这一条还在响就停掉（换页 / 换记录 / 收起列表）。 */
export function releaseAudio(url: string): void {
  if (snapshot.url !== url) return;
  el?.pause();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useAudioValue<T>(selector: () => T): T {
  return useSyncExternalStore(subscribe, selector, selector);
}

/** 一条记录行需要的那点状态：是不是我在响、响到哪了。 */
export function useAudioRow(url: string | undefined) {
  const current = useAudioValue(() => !!url && snapshot.url === url);
  const playing = useAudioValue(() => !!url && snapshot.url === url && snapshot.playing);
  const percent = useAudioValue(() => {
    if (!url || snapshot.url !== url || snapshot.duration <= 0) return 0;
    return Math.min(100, Math.round((snapshot.currentTime / snapshot.duration) * 100));
  });
  return { current, playing, percent };
}

/**
 * 完整播放条需要的那点状态（时间 / 总长 / 是否加载失败）。
 *
 * 挂载时顺手把这条音轨预挂上取元数据（总时长要立刻可见、进度条要能点），
 * 卸载时收声 —— 这样"谁显示播放条谁负责取数据"，不靠调用方记得调 `primeAudio`。
 */
export function useAudioBar(url: string | undefined) {
  const failed = useAudioValue(() => !!url && snapshot.failed === url);
  const playing = useAudioValue(() => !!url && snapshot.url === url && snapshot.playing);
  const currentTime = useAudioValue(() => (!!url && snapshot.url === url ? snapshot.currentTime : 0));
  const duration = useAudioValue(() => (!!url && snapshot.url === url ? snapshot.duration : 0));

  useEffect(() => {
    if (!url) return;
    primeAudio(url);
    return () => releaseAudio(url);
  }, [url]);

  return { failed, playing, currentTime, duration };
}

/** 播放 / 暂停一颗键（列表行 20px 与小播放条共用外观）。 */
export function AudioPlayButton({
  url,
  className,
  size = "sm",
}: {
  url: string;
  className?: string;
  /** `xs` 给侧栏列表行（20px），`sm` 给卡片与详情（28px）。 */
  size?: "xs" | "sm";
}) {
  const t = useT();
  const { playing } = useAudioRow(url);
  const label = playing ? t("voice.records.pause") : t("voice.records.play");
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        // 行本身可点（在右侧打开这条记录），别让播放顺手把选中也改掉。
        e.stopPropagation();
        controlAudio(url);
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border transition-colors",
        size === "xs" ? "size-5" : "size-7",
        playing
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:border-primary hover:text-primary",
        className,
      )}
    >
      {playing ? (
        <PauseIcon className={cn("fill-current", size === "xs" ? "size-2.5" : "size-3.5")} />
      ) : (
        <PlayIcon className={cn("fill-current", size === "xs" ? "size-2.5" : "size-3.5")} />
      )}
    </button>
  );
}

/**
 * 播放条：一颗播放键 + 可点进度 + 时间。
 * `trailing` 放这条音轨自己的附加动作（下载等），跟着播放条右端对齐。
 */
export function AudioBar({
  url,
  className,
  trailing,
}: {
  url: string;
  className?: string;
  trailing?: ReactNode;
}) {
  const t = useT();
  // playing 由 AudioPlayButton 自己订阅（它要在图标上反映状态），这里只要位置与总长。
  // 预挂 / 收声都在 useAudioBar 里（见那里的注释）。
  const { failed, currentTime, duration } = useAudioBar(url);

  if (failed) {
    // 文件不在了（旧记录被清理 / 目录被删）：说清楚，而不是给一个点不动的播放器。
    return (
      <p className={cn("rounded bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground", className)}>
        {t("voice.records.missing")}
      </p>
    );
  }

  const pct = duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0;

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <AudioPlayButton url={url} />
      <div
        role="slider"
        aria-label={t("voice.records.seek")}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (rect.width <= 0 || duration <= 0) return;
          seekAudio(url, ((e.clientX - rect.left) / rect.width) * duration);
        }}
        className="group relative h-4 min-w-0 flex-1 cursor-pointer"
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary/70 transition-[width] duration-100" style={{ width: `${pct}%` }} />
        </div>
        <span
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow transition-[left] duration-100 group-hover:size-3.5"
          style={{ left: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
        {fmtClock(currentTime)}
        {duration > 0 ? ` / ${fmtClock(duration)}` : ""}
      </span>
      {trailing}
    </div>
  );
}
