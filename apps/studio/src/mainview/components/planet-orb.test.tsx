import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { Window } from "happy-dom";

import { loadOrbSkin, PlanetOrb, saveOrbSkin } from "./planet-orb";

/**
 * 通话星球球体的渲染兜底。
 *
 * happy-dom 没有 WebGL —— 这正是它最该测的路径：拿不到上下文时**必须**退回
 * CSS 渐变球而不是整块空白（真机上 GPU 重置 / 远程桌面的 webglcontextlost
 * 走的是同一条兜底）。顺带钉住皮肤的 localStorage 读写：换肤刷新后不能复位。
 */
const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "HTMLElement",
  "HTMLCanvasElement",
  "HTMLDivElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
] as const;
const saved = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  saved.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
  dom.happyDOM.cancelAsync();
});

test("无 WebGL 时退回 CSS 球（不空白、不崩）", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<PlanetOrb level={0.5} speaking={false} muted={false} busy={false} skin="moss" size={200} />);
  });
  // canvas 不显示（没有上下文），兜底球带着径向渐变可见。
  const canvas = host.querySelector("canvas");
  const fallback = Array.from(host.querySelectorAll("div")).find((d) =>
    (d.getAttribute("style") ?? "").includes("radial-gradient"),
  );
  expect(canvas?.classList.contains("hidden")).toBe(true);
  expect(fallback).toBeDefined();
  await act(async () => {
    root.unmount();
  });
});

test("皮肤存 localStorage，坏值回落到默认", () => {
  localStorage.removeItem("omni.voicecall.orbSkin");
  expect(loadOrbSkin()).toBe("moss");
  saveOrbSkin("ink");
  expect(loadOrbSkin()).toBe("ink");
  localStorage.setItem("omni.voicecall.orbSkin", "bogus");
  expect(loadOrbSkin()).toBe("moss");
});
