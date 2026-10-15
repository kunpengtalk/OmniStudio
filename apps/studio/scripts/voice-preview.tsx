/**
 * 语音页的静态预览：左侧记录列表 + 右侧「点开一条历史记录」后的样子。
 * 把**真的**组件服务端渲染成 HTML，配上构建产物里的那份 CSS —— 不起整个桌面应用就能看这块长什么样。
 *
 *   bun run --cwd apps/studio vite build       # 先出 CSS（新加的工具类才会在里面）
 *   bun run --cwd apps/studio scripts/voice-preview.tsx
 *
 * 数据写死：这里看的是**版式与密度**（一行记录多高、播放键多小、一屏能放几条、
 * 选中行与播放中的行区不区分得出来），不是数据链路 —— 那条由 `voice/record-list.test.tsx`
 * 与 `asr-result/index.test.tsx` 覆盖。左侧的引擎 / 模型面板要 rpc，SSR 期间没有数据，
 * 所以它在下半页里显示成空的（不影响要看的那两块）。
 *
 * 记录列表是 useQuery 拉的：SSR 不跑 effect，得先把数据**预填**进 query cache，
 * 否则渲染出来永远是 loading（列表空空的，看着像坏了）。
 */
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

// 组件链里有 `electrobun/view`（经 @lib/rpc）与 Radix：都要 window 才能 import。
const dom = new Window({ url: "http://localhost/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "Node",
  "matchMedia",
  "getComputedStyle",
] as const) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value !== undefined) (globalThis as unknown as Record<string, unknown>)[key] = value;
}

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../src/mainview/components/ui/tooltip");
const { SidebarProvider, Sidebar } = await import("../src/mainview/components/ui/sidebar");
const { Button } = await import("../src/mainview/components/ui/button");
const { ClipboardPasteIcon } = await import("lucide-react");
const { VoiceRecordList } = await import("../src/mainview/app/voice/record-list");
const { AsrResultPane } = await import("../src/mainview/app/voice/asr-result");
const { RecordHistoryBar, ResultPanel } = await import("../src/mainview/app/voice/parts");
const { useUILang } = await import("../src/mainview/stores/ui-lang");
// 中文界面（默认就是 zh，这里显式写出来，免得预览跟着系统语言变）。
useUILang.setState({ lang: "zh" });
type VoiceRecordRow = import("../src/bun/voice").VoiceRecordRow;

const AUDIO = "http://127.0.0.1:19782/audio/tts-demo.mp3";
const now = Date.now();

function record(overrides: Partial<VoiceRecordRow> & { id: number }): VoiceRecordRow {
  return {
    kind: "tts",
    status: "done",
    source: "manual",
    model: "edge-tts",
    voice: "zh-CN-XiaoxiaoNeural",
    text: "",
    audioUrl: AUDIO,
    audioPath: "audio/tts-demo.mp3",
    refAudioPath: null,
    durationMs: 3400,
    error: null,
    createdAt: now,
    ...overrides,
  };
}

/** 一屏里要看出来的几种行：选中 / 播放中 / 失败 / 没文字 / Agent 生成 / 长模型名。 */
const TTS_RECORDS: VoiceRecordRow[] = [
  record({
    id: 31,
    text: "大家好，这是公众号的第一段语音，用来做开场白。",
    durationMs: 3400,
    createdAt: now - 60_000,
  }),
  record({
    id: 30,
    voice: "cixingnansheng",
    model: "stepaudio-3-tts-max",
    text: "鲲鹏Talk 是一档把前沿 AI 讲成人话的栏目，这一期我们聊聊本地部署。",
    durationMs: 12_400,
    createdAt: now - 42 * 60_000,
    source: "agent",
  }),
  record({
    id: 29,
    model: "supertonic-3",
    voice: "默认",
    text: "默认",
    durationMs: 1000,
    createdAt: now - 90 * 60_000,
  }),
  record({
    id: 28,
    status: "failed",
    audioUrl: null,
    audioPath: null,
    error: "上游 429：当前并发已满，请稍后重试",
    createdAt: now - 3 * 3600_000,
  }),
  record({
    id: 27,
    model: "qwen3-tts-1.7b-customvoice",
    voice: "Jhon Wong",
    text: "让每一个应用都听得懂、看得见、说得出。OmniLabs 通过一个 API，统一接入语音。",
    durationMs: 9000,
    createdAt: now - 26 * 3600_000,
  }),
  record({
    id: 26,
    model: "QWen3-TTS-1.7B-Base",
    text: "",
    durationMs: 2100,
    createdAt: now - 30 * 3600_000,
  }),
  record({
    id: 25,
    model: "OmniVoice",
    text: "在古老的森林深处，住着一只会说话的小狐狸，它每天都有新的故事要讲。",
    durationMs: 7800,
    createdAt: now - 50 * 3600_000,
  }),
];

const ASR_TEXT = `那我们把今天这一版过一下，先看落地节奏。这周的进展是账号体系接完了，登录、找回密码都能跑通；共享提示词库也做完了，现在的问题是四十几个人一起用的时候怎么分层。分层我想的是先按团队分，团队内部再按角色，不要一上来就搞权限矩阵。

支撑这块走一个共享的支持频道，工作日一天内响应，第一个季度再加一次月度对齐。细节我写在 onboarding-guide.pdf 第三页了，等下我把链接贴群里。另外那个 Qwen3 的本地部署测试别忘了，周五要出结论。`;

const ASR_RECORDS: VoiceRecordRow[] = [
  record({
    id: 41,
    kind: "asr",
    model: "whisper.cpp · large-v3-turbo",
    voice: null,
    text: ASR_TEXT,
    durationMs: 51_500,
    createdAt: now - 120_000,
    audioPath: "audio/in/rec-demo.wav",
  }),
  record({
    id: 40,
    kind: "asr",
    model: "Confucius4-R2T2",
    voice: null,
    text: "大家好，欢迎关注鲲鹏Talk。今天告诉大家一个好消息，obseek v4.1 正式发布。",
    durationMs: 10_380,
    createdAt: now - 35 * 60_000,
    audioPath: "audio/in/rec-demo-2.wav",
  }),
  record({
    id: 39,
    kind: "asr",
    model: "whisper-small",
    voice: null,
    text: "在古老的森林深处，住着一只会说话的小狐狸，它每天都有新的故事要讲。",
    durationMs: 8200,
    createdAt: now - 4 * 3600_000,
    source: "agent",
    audioPath: "audio/in/rec-demo-3.wav",
  }),
];

const CSS_DIR = join(import.meta.dir, "..", "dist", "assets");
const cssFile = readdirSync(CSS_DIR).find((name) => name.endsWith(".css"));
if (!cssFile) {
  console.error("[preview] 没找到构建产物 CSS：先跑 `bun run vite build`");
  process.exit(1);
}

const out = join(tmpdir(), "omni-voice-preview");
mkdirSync(join(out, "assets"), { recursive: true });
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
  /* 预览用：真应用里左侧栏是 SidebarProvider 的 flex 子项，这里给个固定宽度示意。 */
  /* SidebarProvider 自带 w-full（100%）：不覆盖掉的话它会把右侧那一栏挤出可视区
     （TTS 那页第一次跑就是这样）。width:auto 写在它后面，同样权重、后写的生效。 */
  .preview-shell{display:flex;height:100%;width:auto}
  .preview-sidebar{flex:none;border-right:1px solid var(--border)}
</style>
</head>
<body class="bg-background text-foreground">
  <div id="root">${body}</div>
  <div style="position:fixed;left:12px;bottom:8px;font:11px/1.4 system-ui;opacity:.45">${title}</div>
</body>
</html>`;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
// 预填缓存：SSR 不跑 effect，不预填的话 useQuery 永远是 loading。
for (const [tab, records] of [
  ["tts", TTS_RECORDS],
  ["asr", ASR_RECORDS],
] as const) {
  await client.prefetchQuery({ queryKey: ["voice-records", tab], queryFn: async () => ({ records }) });
}

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, node)),
  );

/** 左侧记录列表（真的组件，含工具菜单与计数）。 */
function SidebarPreview(): ReactNode {
  return createElement(
    SidebarProvider,
    { className: "preview-shell" },
    createElement(
      Sidebar,
      { collapsible: "none", className: "preview-sidebar" },
      createElement("div", { className: "electrobun-webkit-app-region-drag h-8 w-full shrink-0" }),
      createElement("div", { className: "px-2 py-1.5 text-sm font-semibold" }, "OmniStudio"),
      createElement(VoiceRecordList),
    ),
  );
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

/**
 * ASR 面板在"看历史记录"时的全部 props。
 *
 * 左侧列表的选中状态走 zustand，而 zustand 在服务端渲染时只认**初始状态**
 * （`useSyncExternalStore` 的 server snapshot 是 `getInitialState`），预览里没法把某一行
 * 设成选中 —— 所以右侧这块按 `history` 传参渲染，选中链路由 `voice/voice-tabs.test.tsx` 覆盖。
 */
function asrPaneHistory(rec: VoiceRecordRow): ReactNode {
  return createElement(AsrResultPane, {
    segments: [],
    text: rec.text ?? "",
    engine: rec.model ?? undefined,
    hasSpeakers: false,
    streaming: false,
    audioUrl: rec.audioUrl ?? undefined,
    source: "mic" as const,
    mode: "auto" as const,
    onMode: () => {},
    listening: false,
    speaking: false,
    interim: null,
    vadSensitivity: "medium" as const,
    silenceMs: 1000,
    onVadSensitivity: () => {},
    onVadSilence: () => {},
    scene: "meeting" as const,
    onScene: () => {},
    speakerMode: true,
    onSpeakerMode: () => {},
    target: "whisper.cpp · large-v3-turbo",
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
    history: { record: rec, onClose: () => {} },
  });
}

/**
 * 每个预览页。选中态渲染不出（见 `asrPaneHistory` 的说明），所以右侧按显式 props 渲染，
 * 左侧列表按默认状态渲染 —— 两侧各自把"看得见的东西"展示完整。
 */
const pages: Record<string, { title: string; body: ReactNode }> = {
  // 1. 只看左侧列表
  list: { title: "语音 · 左侧记录列表（TTS 记录）", body: SidebarPreview() },

  // 2. 点开一条 TTS 记录：右侧是那次合成的音频 + 说明条
  "tts-history": {
    title: "语音合成 · 点开一条历史记录",
    body: createElement(
      "div",
      { className: "flex h-full w-full" },
      createElement(SidebarPreview),
      createElement(
        "main",
        { className: "flex min-w-0 flex-1 flex-col overflow-hidden" },
        createElement(
          RecordHistoryBar,
          { record: TTS_RECORDS[1]!, onClose: () => {}, className: "shrink-0" },
          createElement(
            Button,
            { variant: "outline", size: "sm", className: "h-7 text-xs" },
            createElement(ClipboardPasteIcon, { className: "size-3.5" }),
            "填入文案",
          ),
        ),
        createElement(
          "div",
          { className: "flex min-h-0 flex-1 items-center justify-center p-8" },
          createElement(
            "div",
            { className: "w-full max-w-md" },
            createElement(ResultPanel, { record: TTS_RECORDS[1]!, label: "生成的音频将显示在这里" }),
          ),
        ),
      ),
    ),
  },

  // 3. 点开一条 ASR 记录：右侧是那次转写的稿子（整段文字 + 播放头 + 智能整理）
  "asr-history": {
    title: "语音识别 · 点开一条历史记录",
    body: createElement(
      "div",
      { className: "flex h-full min-h-0 w-full" },
      createElement(AsidePlaceholder),
      createElement(
        "main",
        { className: "flex min-w-0 flex-1 flex-col overflow-hidden" },
        asrPaneHistory(ASR_RECORDS[0]!),
      ),
    ),
  },
};

for (const theme of ["light", "dark"] as const) {
  for (const [name, { title, body }] of Object.entries(pages)) {
    writeFileSync(join(out, `${name}.${theme}.html`), page(title, render(body), theme));
  }
}
console.log(`[preview] 已生成：${out}`);
