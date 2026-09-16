import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { safeBaseName } from "./path-safety";

/**
 * 导出的报告落盘。
 *
 * 文件名与正文都来自 webview，一律当不可信输入：目录由调用方给死（下载目录），
 * 文件名只取 basename 并清掉路径分隔符，正文限长。
 *
 * 不 import electrobun：目标目录由 RPC 处理器解析后传进来（`Utils.paths.downloads`），
 * 这样这个模块可以在测试里直接跑，不会拉起 dev server。
 */

/** 报告体积上限：几 MB 的"报告"只会是事故，不是数据。 */
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

export type ReportExportResult = { ok: true; path: string } | { ok: false; error: string };

/** 清洗文件名：去目录、去非法字符、补 `.html`；全被清空时返回 null。 */
export function reportFileName(raw: string): string | null {
  const base = safeBaseName(raw ?? "");
  if (!base) return null;
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) return null;
  return /\.html?$/i.test(cleaned) ? cleaned : `${cleaned}.html`;
}

/**
 * 把报告写进 `dir`，重名自动加序号（`xxx (1).html`）。
 *
 * 落盘失败一律返回 error 而不是抛错：调用方是 RPC 处理器，错误要能带着原因
 * 回到界面上（"导出失败"三个字没法排查）。
 */
export function exportHtmlReport(opts: { dir: string; filename: string; html: string }): ReportExportResult {
  const { dir, filename, html } = opts;
  if (typeof html !== "string" || !html.trim()) return { ok: false, error: "报告内容为空" };
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_REPORT_BYTES) {
    return { ok: false, error: `报告过大（${Math.round(bytes / 1024 / 1024)} MB > ${MAX_REPORT_BYTES / 1024 / 1024} MB）` };
  }
  const name = reportFileName(filename);
  if (!name) return { ok: false, error: "文件名不合法" };

  try {
    mkdirSync(dir, { recursive: true });
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let dest = path.join(dir, name);
    for (let i = 1; existsSync(dest) && i < 1000; i++) {
      dest = path.join(dir, `${stem} (${i})${ext}`);
    }
    writeFileSync(dest, html, "utf8");
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
