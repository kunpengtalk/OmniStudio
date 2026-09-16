/**
 * 应用中心（卡片墙）的静态预览：把真的 `AppCenter` 组件服务端渲染成一张 HTML，
 * 配上构建产物里的那份 CSS —— 不用起整个桌面应用就能看这一页长什么样。
 *
 *   bun run scripts/miniapp-center-preview.tsx
 *
 * 数据是写死的（能力快照 / 最近使用），因为这里要看的是**布局与样式**，
 * 不是数据链路（那条路径由应用内的真宿主与 rpc 单测覆盖）。
 */
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { AppCenter } from "../src/mainview/app/apps/center";
import type { MiniAppCapabilitySnapshot } from "../src/shared/miniapps";

const READY: MiniAppCapabilitySnapshot = {
  image: { ready: true, label: "云端 · flux-schnell" },
  imageEdit: { ready: true, label: "云端 · flux-schnell" },
  chat: { ready: true, label: "本地 · qwen3-8b" },
  asr: { ready: false, label: "" },
  bgRemove: { ready: true, label: "本地 · silueta" },
  local: { ready: true, label: "仅本机处理" },
};

const CSS_DIR = join(import.meta.dir, "..", "dist", "assets");
const cssFile = readdirSync(CSS_DIR).find((name) => name.endsWith(".css"));
if (!cssFile) {
  console.error("[preview] 没找到构建产物 CSS：先跑 `bun run build`（或 vite build）");
  process.exit(1);
}

function page(theme: "light" | "dark"): string {
  const body = renderToStaticMarkup(
    createElement(AppCenter, {
      caps: READY,
      recent: ["id-photo", "bg-remove"],
      query: "",
      category: "all",
      onQuery: () => {},
      onCategory: () => {},
      onOpen: () => {},
    }),
  );
  return `<!doctype html>
<html lang="zh"${theme === "dark" ? ' class="dark"' : ""}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="./assets/${cssFile}" />
<style>body{margin:0}</style>
</head>
<body class="bg-background text-foreground">
  <div style="height:100vh;display:flex;flex-direction:column">${body}</div>
</body>
</html>`;
}

const out = join(tmpdir(), "omni-miniapp-preview-center");
mkdirSync(join(out, "assets"), { recursive: true });
// 把构建产物里的 CSS 拷过来：预览页与它同目录，`./assets/...` 才解析得到。
copyFileSync(join(CSS_DIR, cssFile), join(out, "assets", cssFile));
for (const theme of ["dark", "light"] as const) {
  writeFileSync(join(out, `center.${theme}.html`), page(theme));
}
console.log(`[preview] ${out}/center.dark.html 与 center.light.html（CSS: ${cssFile}）`);
