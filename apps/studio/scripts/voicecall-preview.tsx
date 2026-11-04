/**
 * 通话页的静态预览：把 CloudSetupGuide（云端配置）与挂断控制条渲染成 HTML。
 *
 *   bun run --cwd apps/studio vite build
 *   bun run --cwd apps/studio scripts/voicecall-preview.tsx
 *
 * 看的是**版式与显隐**：MOSS 选中后音色字段消失、模型下拉里只有 moss-live-1.0、
 * 通话底栏出现摄像头 / 屏幕按钮。数据写死，不走 rpc。
 */
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node"] as const) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value !== undefined) (globalThis as unknown as Record<string, unknown>)[key] = value;
}

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../src/mainview/components/ui/tooltip");
const { useUILang } = await import("../src/mainview/stores/ui-lang");
const { CLOUD_PRESETS } = await import("../src/shared/cloud-providers");
const {
  realtimeDialectFor,
  realtimeDefaultModel,
  realtimeDefaultVoice,
  realtimeDialectHasVoice,
  realtimeModelsFor,
  isRealtimeModelId,
} = await import("../src/shared/realtime-voice");

useUILang.setState({ lang: "zh" });

const CSS_DIR = join(import.meta.dir, "..", "dist", "assets");
const cssFile = readdirSync(CSS_DIR).find((name) => name.endsWith(".css"));
if (!cssFile) {
  console.error("[preview] 没找到构建产物 CSS：先跑 `bun run vite build`");
  process.exit(1);
}

const out = join(tmpdir(), "omni-voicecall-preview");
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
  #root{height:100%}
</style>
</head>
<body class="bg-background text-foreground">
  <div id="root">${body}</div>
  <div style="position:fixed;left:12px;bottom:8px;font:11px/1.4 system-ui;opacity:.45">${title}</div>
</body>
</html>`;
}

/** 复刻 CloudSetupGuide 编辑态里与方言有关的那几个字段（MOSS vs 阶跃对照）。 */
function providerForm(providerId: string): ReactNode {
  const preset = CLOUD_PRESETS.find((p) => p.id === providerId);
  const baseUrl = preset?.baseUrl ?? "";
  const model = realtimeDefaultModel(realtimeDialectFor({ baseUrl }));
  const dialect = realtimeDialectFor({ baseUrl, model });
  const models = [
    ...new Set([
      ...(preset?.models.filter(isRealtimeModelId) ?? []),
      ...realtimeModelsFor(dialect),
    ]),
  ];
  return createElement(
    "div",
    { className: "w-full max-w-md space-y-3 rounded-xl border bg-card p-4 text-xs" },
    createElement("div", { className: "text-sm font-medium" }, `云端配置 · ${preset?.name ?? providerId}`),
    createElement("div", { className: "space-y-1" }, [
      createElement("div", { key: "l", className: "text-[11px] text-muted-foreground" }, "云厂商"),
      createElement("div", { key: "v", className: "rounded-md border px-2 py-1.5" }, preset?.name ?? ""),
    ]),
    createElement("div", { className: "space-y-1" }, [
      createElement("div", { key: "l", className: "text-[11px] text-muted-foreground" }, "模型"),
      createElement(
        "div",
        { key: "v", className: "rounded-md border px-2 py-1.5 font-mono text-[11px]" },
        models.join(" · "),
      ),
    ]),
    // 音色：MOSS 没有这个参数，界面上应该是说明文字；阶跃是正常的音色控件。
    realtimeDialectHasVoice(dialect)
      ? createElement("div", { className: "space-y-1" }, [
          createElement("div", { key: "l", className: "text-[11px] text-muted-foreground" }, "音色"),
          createElement(
            "div",
            { key: "v", className: "rounded-md border px-2 py-1.5 font-mono text-[11px]" },
            realtimeDefaultVoice(dialect),
          ),
        ])
      : createElement(
          "p",
          { className: "text-[10px] leading-4 text-muted-foreground" },
          "MOSS-Live 的音色由人格（persona）决定，没有单独的 voice 参数，这里不用填音色。",
        ),
    createElement("div", { className: "space-y-1" }, [
      createElement("div", { key: "l", className: "text-[11px] text-muted-foreground" }, "WebSocket 地址"),
      createElement("div", { key: "v", className: "rounded-md border px-2 py-1.5 font-mono text-[11px]" }, `wss · ${dialect}`),
    ]),
  );
}

/** 通话底栏：MOSS 下多出摄像头 / 屏幕两个按钮（其它渠道没有）。 */
function controlBar(withVideo: boolean): ReactNode {
  const mic = createElement(
    "div",
    { key: "mic", className: "flex w-40 items-center justify-end gap-3" },
    createElement("span", { className: "text-xs text-muted-foreground" }, "正在聆听…"),
    createElement("div", {
      className: "h-4 w-16 rounded bg-primary/40",
    }),
  );
  const hangup = createElement(
    "div",
    {
      key: "h",
      className:
        "flex size-14 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs",
    },
    "挂断",
  );
  const right = createElement(
    "div",
    { key: "r", className: "flex w-40 items-center gap-2" },
    withVideo
      ? [
          createElement(
            "div",
            { key: "c", className: "flex size-9 items-center justify-center rounded-full border text-[10px]" },
            "📷",
          ),
          createElement(
            "div",
            { key: "s", className: "flex size-9 items-center justify-center rounded-full border text-[10px]" },
            "🖥",
          ),
        ]
      : [],
  );
  return createElement(
    "div",
    { className: "flex items-center justify-center gap-4 border-t bg-gradient-to-t from-muted/40 to-transparent p-4" },
    mic,
    hangup,
    right,
  );
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const render = (node: ReactNode) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, node)),
  );

const body = createElement(
  "div",
  { className: "flex h-full flex-col gap-6 p-6" },
  createElement(
    "div",
    { className: "flex flex-wrap gap-6" },
    providerForm("moss"),
    providerForm("stepfun"),
  ),
  createElement("div", { className: "text-xs text-muted-foreground" }, "通话底栏 · MOSS（有画面按钮）"),
  controlBar(true),
  createElement("div", { className: "text-xs text-muted-foreground" }, "通话底栏 · 百炼 / 阶跃（无画面按钮）"),
  controlBar(false),
);

for (const theme of ["light", "dark"] as const) {
  writeFileSync(
    join(out, `voicecall.${theme}.html`),
    page("通话 · 云端配置与画面按钮（MOSS vs 阶跃）", render(body), theme),
  );
}
console.log(`[preview] ${out}/voicecall.{light,dark}.html（CSS: ${cssFile}）`);
