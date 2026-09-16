import { fmtCtx } from "@/shared/benchmark";
import { RELEASE_REPO_URL } from "@/shared/release";
import type { DisplayResult } from "./parts";
import {
  cacheRowsOf,
  engineLabelOf,
  evalReportStats,
  speedReportNotes,
  type ReportT,
} from "./report-data";

/**
 * 把一份基准报告导出成**单文件 HTML**。
 *
 * 产物要能直接发给别人：所以不引用任何外部资源（字体 / CSS / JS / 图片全无），
 * 图表用 CSS 画，数据与文案在生成时就写死进文档。样式跟应用里那一版同构，
 * 但走的是自己的一套 CSS 变量，不依赖 Tailwind。
 *
 * 放在 webview 侧生成的原因：报告数据（rows / summary / params）本来就在界面
 * 手里，主进程只负责把生成的文本落盘（见 RPC `exportBenchmarkReport`）。
 */

export type ReportLang = "zh" | "en";

/** 产品名（不翻译）：报告抬头的字标与 <title> 都用它，免得分享出去不知道出自哪儿。 */
const BRAND = "OmniStudio";

/**
 * 品牌标记：与应用图标同一个形状（圆角方环）。
 *
 * 内联 SVG 而不是引 `assets/omni-logo.png`（512² ≈ 350KB）：报告要能当一个文件
 * 发出去，塞一张图就白搭；这个几何形状几十个字节就能画完。
 */
const BRAND_MARK = `<svg class="mark" viewBox="0 0 100 100" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M26 0h48a26 26 0 0 1 26 26v48a26 26 0 0 1-26 26H26A26 26 0 0 1 0 74V26A26 26 0 0 1 26 0Zm13.5 25.5h21a14 14 0 0 1 14 14v21a14 14 0 0 1-14 14h-21a14 14 0 0 1-14-14v-21a14 14 0 0 1 14-14Z"/></svg>`;

/** HTML 转义：错误串、模型名、档位标签都来自服务端或历史数据，一律当不可信文本。 */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 报告里的时间戳（本地时区，补到分钟）。 */
export function fmtStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 导出文件名：`omni-benchmark-<模型名>-<年月日-时分>.html`。 */
export function reportFileName(result: DisplayResult, now: Date = new Date()): string {
  const slug =
    result.model
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 48) || "report";
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `omni-benchmark-${slug}-${stamp}.html`;
}

const STYLE = `
:root {
  --bg: #f7f8fa;
  --card: #ffffff;
  --fg: #14161a;
  --muted: #6b7280;
  --border: #e4e7ec;
  --primary: #2563eb;
  --warn: #b45309;
  --warn-bg: #fffbeb;
  --danger: #dc2626;
  --ok: #059669;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0e12;
    --card: #14171c;
    --fg: #e8eaee;
    --muted: #9aa2ae;
    --border: #262b33;
    --primary: #60a5fa;
    --warn: #fbbf24;
    --warn-bg: #2a2110;
    --danger: #f87171;
    --ok: #34d399;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.report { max-width: 1040px; margin: 0 auto; padding: 40px 28px 56px; }
.brand { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; }
.brand .mark { color: var(--fg); }
.brand .name { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
.brand .tagline { font-size: 11px; color: var(--muted); border-left: 1px solid var(--border); padding-left: 8px; }
.eyebrow { margin: 0; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
h1 { margin: 6px 0 10px; font-size: 22px; line-height: 1.3; word-break: break-word; }
h2 { margin: 0 0 10px; font-size: 14px; }
section { margin-top: 28px; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--card);
  font-size: 11px; color: var(--muted);
}
.badge.status { color: var(--fg); }
.badge.done { color: var(--ok); }
.badge.error { color: var(--danger); }
.time { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; }
.card { border: 1px solid var(--border); background: var(--card); border-radius: 10px; padding: 10px 12px; }
.card .label { font-size: 11px; color: var(--muted); margin: 0; }
.card .value { margin: 2px 0 0; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.hint { margin: 0 0 8px; font-size: 11px; color: var(--muted); }
.note-list { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--warn-bg); }
.note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--warn); }
.note.error { color: var(--danger); }
dl.kv { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 20px; }
dl.kv > div { display: flex; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
dl.kv dt { color: var(--muted); font-size: 12px; min-width: 92px; }
dl.kv dd { margin: 0; font-size: 12px; word-break: break-word; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { font-weight: 500; color: var(--muted); text-align: right; }
th.txt, td.txt { text-align: left; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.tps { font-weight: 600; color: var(--primary); }
.bad { color: var(--danger); }
.warn { color: var(--warn); }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
.bars { display: flex; flex-direction: column; gap: 7px; }
.bar-row { display: flex; align-items: center; gap: 10px; font-size: 11px; }
.bar-ctx { width: 46px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.bar-cache { width: 96px; color: var(--muted); }
.bar-label { width: 190px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { flex: 1; display: block; height: 9px; border-radius: 999px; background: var(--border); overflow: hidden; }
.bar-fill { display: block; height: 100%; border-radius: 999px; background: var(--primary); opacity: .75; }
.bar-value { width: 74px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar-value.wide { width: 118px; }
.cache-row { display: flex; flex-wrap: wrap; gap: 6px 14px; border: 1px solid var(--border); background: var(--card); border-radius: 10px; padding: 8px 12px; font-size: 12px; margin-bottom: 6px; }
.cache-row .ctx { width: 46px; color: var(--muted); font-variant-numeric: tabular-nums; }
.speedup { color: var(--ok); margin-left: 4px; }
.reuse { margin-left: auto; font-size: 11px; color: var(--muted); }
.err-banner { border: 1px solid var(--danger); border-radius: 10px; padding: 10px 12px; color: var(--danger); font-size: 12px; margin-top: 16px; }
footer {
  margin-top: 34px; padding-top: 14px; border-top: 1px solid var(--border);
  display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center;
  font-size: 11px; color: var(--muted);
}
footer .repo { margin-left: auto; color: var(--primary); text-decoration: none; font-variant-numeric: tabular-nums; }
footer .repo:hover { text-decoration: underline; }
.empty { border: 1px dashed var(--border); border-radius: 10px; padding: 24px; text-align: center; font-size: 12px; color: var(--muted); }
@media print {
  body { background: #fff; }
  .report { max-width: none; padding: 0; }
}
`;

/** 一行里的数字单元格（失败档位标红）。 */
function numCell(value: string | number, cls = ""): string {
  return `<td class="num${cls ? ` ${cls}` : ""}">${esc(value)}</td>`;
}

function summaryCards(result: DisplayResult, t: ReportT): string {
  const s = result.summary;
  if (!s || result.kind === "eval") return "";
  const cards: { label: string; value: string }[] = [
    { label: t("benchmark.summary.avgTps"), value: String(s.avgTps) },
    { label: t("benchmark.summary.peakTps"), value: String(s.peakTps) },
    { label: t("benchmark.summary.bestTtft"), value: `${s.bestTtftMs} ms` },
    { label: t("benchmark.summary.peakAgg"), value: String(s.peakAggTps) },
    { label: t("benchmark.summary.peakPrefill"), value: String(s.peakPrefillTps) },
    { label: t("benchmark.summary.tokens"), value: s.totalTokens.toLocaleString() },
  ];
  const basis = s.basis
    ? `<p class="hint">${esc(t("benchmark.summaryBasis", { basis: t(`benchmark.cache.${s.basis}`) }))}</p>`
    : "";
  return `<section>
  <h2>${esc(t("benchmark.export.summary"))}</h2>
  ${basis}
  <div class="grid">
    ${cards
      .map(
        (c) =>
          `<div class="card"><p class="label">${esc(c.label)}</p><p class="value">${esc(c.value)}</p></div>`,
      )
      .join("\n    ")}
  </div>
</section>`;
}

function configSection(result: DisplayResult, t: ReportT): string {
  const p = (result.params ?? {}) as {
    genLength?: number;
    batchSize?: number;
    contexts?: number[];
    cacheModes?: string[];
    suite?: string;
    sampleSize?: number;
  };
  const rows: { label: string; value: string }[] = [
    { label: t("benchmark.tab"), value: t(`benchmark.tab.${result.kind}`) },
    { label: t("benchmark.model"), value: result.model },
  ];
  if (result.kind === "speed") {
    if (p.genLength != null) {
      rows.push({
        label: t("benchmark.genLength"),
        value: `${p.genLength} tok × ${p.batchSize ?? 1}`,
      });
    }
    if (p.contexts?.length) {
      rows.push({ label: t("benchmark.contexts"), value: p.contexts.map(fmtCtx).join(" / ") });
    }
    if (p.cacheModes?.length) {
      rows.push({
        label: t("benchmark.cache"),
        value: p.cacheModes.map((m) => t(`benchmark.cache.${m}`)).join(" / "),
      });
    }
  } else {
    if (p.suite) rows.push({ label: t("benchmark.eval.suite"), value: t(`benchmark.suite.${p.suite}`) });
    if (p.sampleSize) rows.push({ label: t("benchmark.eval.sampleSize"), value: String(p.sampleSize) });
  }
  return `<section>
  <h2>${esc(t("benchmark.export.config"))}</h2>
  <dl class="kv">
    ${rows
      .map((r) => `<div><dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd></div>`)
      .join("\n    ")}
  </dl>
</section>`;
}

function notesSection(result: DisplayResult, t: ReportT): string {
  const notes = result.kind === "speed" ? speedReportNotes(result, t) : [];
  if (notes.length === 0) return "";
  return `<section>
  <h2>${esc(t("benchmark.notes"))}</h2>
  <div class="note-list">
    ${notes
      .map((n) => `<p class="note ${n.tone === "error" ? "error" : ""}">${esc(n.text)}</p>`)
      .join("\n    ")}
  </div>
</section>`;
}

function cacheSection(result: DisplayResult, t: ReportT): string {
  const rows = cacheRowsOf(result);
  if (rows.length === 0) return "";
  const speedup = (v: number | null) => (v != null ? `<span class="speedup">×${esc(v)}</span>` : "");
  return `<section>
  <h2>${esc(t("benchmark.cacheCompare"))}</h2>
  ${rows
    .map((c) => {
      const parts = [`<span class="ctx">${esc(fmtCtx(c.contextLength))}</span>`];
      if (c.cold) parts.push(`<span>${esc(t("benchmark.cache.cold"))} ${esc(c.cold.ttftMs)} ms</span>`);
      if (c.partial) {
        parts.push(
          `<span>${esc(t("benchmark.cache.partial"))} ${esc(c.partial.ttftMs)} ms${speedup(c.partialSpeedup)}</span>`,
        );
      }
      if (c.warm) {
        parts.push(
          `<span>${esc(t("benchmark.cache.warm"))} ${esc(c.warm.ttftMs)} ms${speedup(c.warmSpeedup)}</span>`,
        );
      }
      if (c.warmReuseRatio != null) {
        parts.push(
          `<span class="reuse">${esc(
            t("benchmark.cacheCompare.reuse", { percent: String(Math.round(c.warmReuseRatio * 100)) }),
          )}</span>`,
        );
      }
      return `<div class="cache-row">${parts.join("")}</div>`;
    })
    .join("\n  ")}
  <p class="hint">${esc(t("benchmark.cacheCompare.hint"))}</p>
</section>`;
}

function speedTable(result: DisplayResult, t: ReportT): string {
  if (result.rows.length === 0) {
    return `<section><h2>${esc(t("benchmark.results"))}</h2><p class="empty">${esc(t("benchmark.noRows"))}</p></section>`;
  }
  const head = [
    t("benchmark.col.context"),
    t("benchmark.col.cache"),
    t("benchmark.col.prompt"),
    t("benchmark.col.batch"),
    t("benchmark.col.ttft"),
    t("benchmark.col.tpot"),
    t("benchmark.col.tps"),
    t("benchmark.col.aggTps"),
    t("benchmark.col.prefill"),
    t("benchmark.col.tokens"),
    t("benchmark.col.ok"),
    t("benchmark.col.total"),
  ];
  const body = result.rows
    .map((r) => {
      const ctxCls = r.error ? " bad" : r.truncated ? " warn" : "";
      const okCell =
        r.fails > 0
          ? `<td class="num"><span class="bad">${esc(`${r.ok}/${r.fails}`)}</span></td>`
          : numCell(r.ok);
      return `<tr>
      <td class="txt${ctxCls}">${esc(fmtCtx(r.contextLength))}</td>
      <td class="txt">${esc(t(`benchmark.cache.${r.cache ?? "warm"}`))}</td>
      ${numCell(r.promptTokens)}
      ${numCell(r.batchSize)}
      ${numCell(r.ttftMs)}
      ${numCell(r.tpotMs)}
      ${numCell(r.tps, "tps")}
      ${numCell(r.aggTps)}
      ${numCell(r.prefillTps)}
      ${numCell(r.tokens)}
      ${okCell}
      ${numCell(r.totalMs)}
    </tr>`;
    })
    .join("\n    ");
  return `<section>
  <h2>${esc(t("benchmark.results"))}</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="txt">${esc(head[0])}</th><th class="txt">${esc(head[1])}</th>
          ${head.slice(2).map((h) => `<th class="num">${esc(h)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
    ${body}
      </tbody>
    </table>
  </div>
</section>`;
}

function speedChart(result: DisplayResult, t: ReportT): string {
  if (result.rows.length === 0) return "";
  const max = Math.max(...result.rows.map((r) => r.tps), 0.0001);
  return `<section>
  <h2>${esc(t("benchmark.chart"))}</h2>
  <div class="bars">
    ${result.rows
      .map((r) => {
        const width = r.ok > 0 ? Math.max((r.tps / max) * 100, 1) : 0;
        const value = r.ok === 0 ? "—" : `${r.tps} tps`;
        return `<div class="bar-row">
      <span class="bar-ctx">${esc(fmtCtx(r.contextLength))}</span>
      <span class="bar-cache">${esc(t(`benchmark.cache.${r.cache ?? "warm"}`))}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${width.toFixed(2)}%"></span></span>
      <span class="bar-value${r.ok === 0 ? " bad" : ""}">${esc(value)}</span>
    </div>`;
      })
      .join("\n    ")}
  </div>
</section>`;
}

function evalBody(result: DisplayResult, t: ReportT): string {
  const evalParams = result.params as { suite?: string; sampleSize?: number } | undefined;
  const stats = evalReportStats(result, evalParams);
  const categories = result.evalRows ?? [];
  const questions =
    stats.sampleSize > 0 ? stats.sampleSize.toLocaleString() : (stats.datasetTotal || stats.answered).toLocaleString();
  const tiles = [
    { label: t("benchmark.eval.correct"), value: `${stats.correct} / ${stats.answered}` },
    {
      label: t("benchmark.eval.questions"),
      value: stats.datasetTotal > 0 ? `${questions} / ${stats.datasetTotal.toLocaleString()}` : questions,
    },
    { label: t("benchmark.eval.failures"), value: String(stats.failures) },
    {
      label: t("benchmark.eval.duration"),
      value: result.durationMs != null ? `${Math.round(result.durationMs / 1000)}s` : "—",
    },
  ];
  const bars = categories
    .map(
      (c) => `<div class="bar-row">
      <span class="bar-label" title="${esc(c.category)}">${esc(c.category)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.min(Math.max(c.accuracy, 0), 100).toFixed(2)}%"></span></span>
      <span class="bar-value wide">${esc(c.accuracy)}% (${esc(c.correct)}/${esc(c.total)})</span>
    </div>`,
    )
    .join("\n    ");
  return `<section>
  <h2>${esc(t("benchmark.eval.score"))}</h2>
  <div class="grid">
    <div class="card"><p class="label">${esc(t("benchmark.eval.score"))}</p><p class="value" style="font-size:26px">${esc(stats.accuracy)}%</p></div>
    ${tiles
      .map((c) => `<div class="card"><p class="label">${esc(c.label)}</p><p class="value">${esc(c.value)}</p></div>`)
      .join("\n    ")}
  </div>
</section>
<section>
  <h2>${esc(t("benchmark.eval.categories"))}</h2>
  ${bars || `<p class="empty">${esc(t("benchmark.eval.noCategories"))}</p>`}
</section>`;
}

/**
 * 生成完整的报告文档。
 *
 * `now` 只用于"导出时间"与文件名（测试里注入固定值，避免断言跟着时钟跑）。
 */
export function buildBenchmarkReportHtml(opts: {
  result: DisplayResult;
  t: ReportT;
  lang?: ReportLang;
  now?: Date;
}): string {
  const { result, t, lang = "zh", now = new Date() } = opts;
  const title = t("benchmark.export.title");
  const engineLabel = engineLabelOf(result, t);
  const statusLabel =
    result.status === "running" ? t("benchmark.status.running") : t(`benchmark.status.${result.status}`);
  const kindLabel = t(`benchmark.tab.${result.kind}`);
  const body = result.kind === "eval" ? evalBody(result, t) : summaryCards(result, t);
  return `<!doctype html>
<html lang="${esc(lang === "zh" ? "zh-CN" : "en")}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(`${BRAND} · ${title} · ${result.model}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="report">
  <header>
    <div class="brand">
      ${BRAND_MARK}
      <span class="name">${esc(BRAND)}</span>
      <span class="tagline">${esc(t("benchmark.export.tagline"))}</span>
    </div>
    <p class="eyebrow">${esc(title)}</p>
    <h1>${esc(result.model)}</h1>
    <div class="badges">
      <span class="badge">${esc(kindLabel)}</span>
      <span class="badge">${esc(engineLabel)}</span>
      <span class="badge status ${esc(result.status)}">${esc(statusLabel)}</span>
      <span class="time">${esc(fmtStamp(result.createdAt))}</span>
    </div>
  </header>
  ${result.error ? `<div class="err-banner">${esc(result.error)}</div>` : ""}
  ${configSection(result, t)}
  ${body}
  ${notesSection(result, t)}
  ${result.kind === "speed" ? cacheSection(result, t) : ""}
  ${result.kind === "speed" ? speedTable(result, t) : ""}
  ${result.kind === "speed" ? speedChart(result, t) : ""}
  <footer>
    <span>${esc(t("benchmark.export.footer"))} · ${esc(t("benchmark.export.generatedAt"))} ${esc(fmtStamp(now.getTime()))}</span>
    <a class="repo" href="${esc(RELEASE_REPO_URL)}">${esc(RELEASE_REPO_URL.replace(/^https?:\/\//, ""))}</a>
  </footer>
</main>
</body>
</html>
`;
}
