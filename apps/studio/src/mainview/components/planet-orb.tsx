import { useEffect, useRef, useState } from "react";

import { createOrbRenderer, hex2rgb, type OrbSkin } from "@lib/orb-gl";
import { cn } from "@lib/utils";

/**
 * 通话星球球体：WebGL 实时渲染（lib/orb-gl.ts），无 GL 时退回 CSS 渐变球。
 *
 * 皮肤（`ORB_SKINS`）是"浅底 / 主体 / 强调"三色组合，球体 shader 与 CSS 兜底
 * 共用同一组色值 —— 两条渲染路径切换时颜色不会跳。选择记在 localStorage
 * （纯外观，不进 settings 表，跟通话行为无关）。
 */

export type OrbSkinId = "moss" | "tide" | "clay" | "ink";

export const ORB_SKINS: {
  id: OrbSkinId;
  /** i18n 键（voicecall.skin.<id>）。 */
  labelKey: string;
  colors: { a: string; b: string; c: string };
}[] = [
  { id: "moss", labelKey: "voicecall.skin.moss", colors: { a: "#dcefe2", b: "#4c9b7a", c: "#2f6b52" } },
  { id: "tide", labelKey: "voicecall.skin.tide", colors: { a: "#d7e8f7", b: "#4f8fc9", c: "#2d5f96" } },
  { id: "clay", labelKey: "voicecall.skin.clay", colors: { a: "#f6e6d8", b: "#cf8f63", c: "#a15a38" } },
  { id: "ink", labelKey: "voicecall.skin.ink", colors: { a: "#e6e0f2", b: "#7c6cae", c: "#4b3f7a" } },
];

const SKIN_STORAGE_KEY = "omni.voicecall.orbSkin";

export function loadOrbSkin(): OrbSkinId {
  try {
    const v = localStorage.getItem(SKIN_STORAGE_KEY);
    if (v === "moss" || v === "tide" || v === "clay" || v === "ink") return v;
  } catch {
    // 隐私模式读不到就算了，用默认
  }
  return "moss";
}

export function saveOrbSkin(id: OrbSkinId): void {
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, id);
  } catch {
    // ignore
  }
}

export function orbSkinColors(id: OrbSkinId): OrbSkin {
  const s = ORB_SKINS.find((x) => x.id === id) ?? ORB_SKINS[0]!;
  return { a: hex2rgb(s.colors.a), b: hex2rgb(s.colors.b), c: hex2rgb(s.colors.c) };
}

function fallbackGradient(id: OrbSkinId): string {
  const s = ORB_SKINS.find((x) => x.id === id) ?? ORB_SKINS[0]!;
  return `radial-gradient(circle at 34% 28%, ${s.colors.a} 0%, ${s.colors.b} 55%, ${s.colors.c} 100%)`;
}

export function PlanetOrb({
  level,
  speaking,
  muted,
  busy,
  skin,
  size = 232,
  className,
}: {
  /** 麦克风电平 0..1（未静音时）。 */
  level: number;
  /** 助手正在朗读。 */
  speaking: boolean;
  /** 用户已静音。 */
  muted: boolean;
  /** 拨号 / 思考：表面流动加速。 */
  busy: boolean;
  skin: OrbSkinId;
  size?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ReturnType<typeof createOrbRenderer> | null>(null);
  const [glReady, setGlReady] = useState(false);

  // 建一次渲染器；尺寸跟着 size 走。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setGlReady(false);
      return;
    }
    let renderer: ReturnType<typeof createOrbRenderer> | null = null;
    try {
      renderer = createOrbRenderer(canvas);
    } catch {
      renderer = null;
    }
    rendererRef.current = renderer;
    if (!renderer) {
      setGlReady(false);
      return;
    }
    renderer.resize(size, size);
    setGlReady(true);
    return () => {
      rendererRef.current = null;
      renderer?.dispose();
    };
  }, [size]);

  useEffect(() => {
    rendererRef.current?.setTargetEnergy(Math.max(0, Math.min(1, level)));
  }, [level]);
  useEffect(() => {
    rendererRef.current?.setSpeaking(speaking);
  }, [speaking]);
  useEffect(() => {
    rendererRef.current?.setMuted(muted);
  }, [muted]);
  useEffect(() => {
    rendererRef.current?.setBusy(busy);
  }, [busy]);
  useEffect(() => {
    rendererRef.current?.setSkin(orbSkinColors(skin));
  }, [skin]);

  const s = ORB_SKINS.find((x) => x.id === skin) ?? ORB_SKINS[0]!;
  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* CSS 兜底球：无 WebGL / reduced-motion / 上下文丢失时可见。 */}
      <div
        className={cn(
          "absolute inset-0 rounded-full transition-transform duration-150",
          glReady && "hidden",
        )}
        style={{
          background: fallbackGradient(s.id),
          boxShadow: `0 0 ${size * 0.3}px ${s.colors.c}55, inset -14px -18px ${size * 0.22}px ${s.colors.c}99`,
          transform: `scale(${1 + Math.min(1, Math.max(0, muted ? 0 : level)) * 0.1})`,
          filter: muted ? "saturate(.45) brightness(.92)" : undefined,
        }}
      />
      {/* canvas 必须**始终**在 DOM 里：渲染器要拿它的上下文才能建，
          按 glReady 条件挂载会永远建不起来（先有鸡还是先有蛋）。 */}
      <canvas
        ref={canvasRef}
        className={cn("absolute inset-0", !glReady && "hidden")}
        style={{ width: size, height: size }}
      />
      {/* 外圈呼吸光：CSS 层，WebGL 球与兜底球都用它补"氛围"。 */}
      <span
        className="orb-halo pointer-events-none absolute inset-1 rounded-full border-2"
        style={{ borderColor: `${s.colors.c}55` }}
      />
    </div>
  );
}
