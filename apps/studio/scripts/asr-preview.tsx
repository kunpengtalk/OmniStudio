/**
 * ASR 工作台右侧的静态预览：把**真的**组件服务端渲染成 HTML，配上构建产物里的那份 CSS
 * —— 不起整个桌面应用就能看这块长什么样（浅色 / 深色各一份）。
 *
 *   bun run --cwd apps/studio vite build       # 先出 CSS（新加的工具类才会在里面）
 *   bun run --cwd apps/studio scripts/asr-preview.tsx
 *
 * 数据写死：这里要看的是**版式与密度**（一行能放几句、时间戳列多宽、动作条会不会换行、
 * 控制台会不会挤掉正文），不是数据链路 —— 那条由 asr-result/index.test.tsx 覆盖。
 * 左栏（引擎 / 模型，要 rpc）不在预览范围内，用一块占位表示它占的宽度。
 *
 * 要看像素：`serve` 出来用浏览器截图，或用现成的无头 Chromium 直接出图 ——
 * 比在真机上量更省事，真机窗口一旦进了 macOS 全屏（native fullscreen），
 * `screencapture -l <windowid>` 会直接报 "could not create image from window"：
 *   ~/Library/Caches/ms-playwright/chromium_headless_shell-<ver>/chrome-headless-shell-mac-arm64/chrome-headless-shell
 *     --headless --disable-gpu --hide-scrollbars --window-size=1400,900
 *     --screenshot=/tmp/pane.png "file://$TMPDIR/omni-asr-preview/listening.light.html"
 */
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

// 组件链里有 `electrobun/view`（经 @lib/rpc）与 Radix：都要 window 才能 import。
// 与 mainview 的单测同一套做法 —— SSR 期间不跑 effect，所以不会真的发 rpc。
const dom = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value !== undefined) (globalThis as unknown as Record<string, unknown>)[key] = value;
}

const { AsrResultPane } = await import("../src/mainview/app/voice/asr-result");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../src/mainview/components/ui/tooltip");
const { useUILang } = await import("../src/mainview/stores/ui-lang");
// 中文界面（默认就是 zh，这里显式写出来，免得预览跟着系统语言变）。
useUILang.setState({ lang: "zh" });

/** 一段真实的会议片段：短句、两人交替、带一处中英混排与技术词。 */
const SEGMENTS = [
  { start: 0, end: 3.2, text: "那我们把今天这一版过一下，先看落地节奏。", speaker: 0 },
  { start: 3.6, end: 8.1, text: "好，这周的进展是账号体系接完了，登录、找回密码都能跑通。", speaker: 1 },
  { start: 8.6, end: 13.4, text: "共享提示词库也做完了，现在的问题是四十几个人一起用的时候怎么分层。", speaker: 1 },
  { start: 14, end: 18.7, text: "分层我想的是先按团队分，团队内部再按角色，不要一上来就搞权限矩阵。", speaker: 0 },
  { start: 19.2, end: 24.8, text: "同意。那下周是不是先找两个团队试运行？IT 和内容两个组比较典型。", speaker: 1 },
  { start: 25.3, end: 31.6, text: "可以，我周三把账号和共享提示词配好，你们周四周五跑，周五下班前对一次。", speaker: 0 },
  { start: 32.1, end: 37.4, text: "支撑这块怎么走？上线之后总得有人接。", speaker: 1 },
  { start: 38, end: 45.2, text: "走一个共享的支持频道，工作日一天内响应，第一个季度再加一次月度对齐。", speaker: 0 },
  { start: 45.8, end: 51.5, text: "细节我写在 onboarding-guide.pdf 第三页了，等下我把链接贴群里。", speaker: 0 },
  { start: 52.1, end: 58.9, text: "行。另外那个 Qwen3 的本地部署测试别忘了，周五要出结论。", speaker: 1 },
];

const TARGET = "whisper.cpp · large-v3-turbo";

function paneProps(overrides: Record<string, unknown> = {}) {
  return {
    segments: SEGMENTS,
    text: "",
    engine: "whisper-server",
    hasSpeakers: true,
    streaming: false,
    audioUrl: "about:blank",
    source: "mic" as const,
    mode: "auto" as const,
    onMode: () => {},
    listening: false,
    speaking: false,
    interim: null as string | null,
    vadSensitivity: "medium" as const,
    silenceMs: 1000,
    onVadSensitivity: () => {},
    onVadSilence: () => {},
    scene: "meeting" as const,
    onScene: () => {},
    speakerMode: true,
    onSpeakerMode: () => {},
    target: TARGET,
    onClear: () => {},
    recording: false,
    paused: false,
    level: 0,
    elapsed: 0,
    onStart: () => {},
    onStop: () => {},
    onTogglePause: () => {},
    onTranscribeFile: () => {},
    fileBusy: false,
    fileReady: false,
    ...overrides,
  };
}

/** 占位左栏：只表示它占的宽度（真左栏要 rpc 拉引擎与模型列表）。 */
function AsidePlaceholder(): ReactNode {
  return createElement(
    "aside",
    {
      className:
        "flex w-[340px] shrink-0 flex-col items-center justify-center gap-2 border-r bg-muted/20 p-4 text-center",
    },
    createElement("p", { className: "text-xs font-medium text-muted-foreground" }, "左侧参数面板"),
    createElement(
      "p",
      { className: "text-[11px] leading-relaxed text-muted-foreground/70" },
      "引擎 / 模型 / 识别语言 / 上传音频（预览未包含：内容需要 rpc）",
    ),
  );
}

const CSS_DIR = join(import.meta.dir, "..", "dist", "assets");
const cssFile = readdirSync(CSS_DIR).find((name) => name.endsWith(".css"));
if (!cssFile) {
  console.error("[preview] 没找到构建产物 CSS：先跑 `bun run vite build`");
  process.exit(1);
}

const out = join(tmpdir(), "omni-asr-preview");
mkdirSync(join(out, "assets"), { recursive: true });
// 整个 assets 目录拷过来：CSS 里的字体是相对路径，只拷 CSS 会掉回系统字体。
cpSync(CSS_DIR, join(out, "assets"), { recursive: true });

function page(title: string, body: string, theme: "light" | "dark"): string {
  return `<!doctype html>
<html lang="zh"${theme === "dark" ? ' class="dark"' : ""}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="./assets/${cssFile}" />
<style>
  html,body{margin:0;height:100%}
  body{overflow:hidden}
  #root{display:flex;height:100%}
</style>
</head>
<body class="bg-background text-foreground">
  <div id="root">${body}</div>
  <div style="position:fixed;left:12px;bottom:8px;font:11px/1.4 system-ui;opacity:.45">${title}</div>
</body>
</html>`;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const render = (node: ReactNode) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, node)),
  );

/** 工作台整体（默认视图：整理稿）。 */
const workspace = createElement(
  "div",
  { className: "flex h-full min-h-0 w-full" },
  createElement(AsidePlaceholder),
  createElement(
    "main",
    { className: "flex min-w-0 flex-1 flex-col overflow-hidden" },
    createElement(AsrResultPane, paneProps()),
  ),
);

/**
 * 自动听写中 + 逐句视图：密排行、当前句高亮、中间结果行、上方运行条的状态与电平。
 * 逐句视图是面板的内部状态（采集一开始会自动切过去），预览里用 initialView 钉住。
 */
const listening = createElement(
  "div",
  { className: "flex h-full min-h-0 w-full" },
  createElement(AsidePlaceholder),
  createElement(
    "main",
    { className: "flex min-w-0 flex-1 flex-col overflow-hidden" },
    createElement(
      AsrResultPane,
      paneProps({
        listening: true,
        speaking: true,
        streaming: true,
        level: 0.5,
        elapsed: 65,
        interim: "那这个权限矩阵是不是先不做，等两个团队跑一轮再说",
        initialView: "segments" as const,
      }),
    ),
  ),
);

/** 空稿件：空状态 + 停用的动作条，看的是一句话有没有把"转出来能干什么"讲清楚。 */
const empty = createElement(
  "div",
  { className: "flex h-full min-h-0 w-full" },
  createElement(AsidePlaceholder),
  createElement(
    "main",
    { className: "flex min-w-0 flex-1 flex-col overflow-hidden" },
    createElement(AsrResultPane, paneProps({ segments: [], audioUrl: undefined, engine: undefined })),
  ),
);

for (const theme of ["light", "dark"] as const) {
  writeFileSync(join(out, `workspace.${theme}.html`), page("ASR 工作台 · 会议稿（整理稿视图）", render(workspace), theme));
  writeFileSync(join(out, `listening.${theme}.html`), page("ASR 工作台 · 自动听写（逐句视图 + 中间结果）", render(listening), theme));
  writeFileSync(join(out, `empty.${theme}.html`), page("ASR 工作台 · 空稿件", render(empty), theme));
}
console.log(`[preview] 已生成：${out}`);

// happy-dom 的 Window 会把事件循环顶住，进程写完文件也不会自己退 —— 显式退，
// 否则每次跑都留一个僵尸，下一次复制 assets 还要跟它抢同一个目标目录。
process.exit(0);
