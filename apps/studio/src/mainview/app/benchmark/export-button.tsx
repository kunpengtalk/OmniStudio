import { useEffect, useState } from "react";
import { FileDownIcon } from "lucide-react";
import { Button } from "@ui/button";
import { rpcClient } from "@lib/rpc";
import { useT, useUILang } from "@stores/ui-lang";
import { buildBenchmarkReportHtml, reportFileName } from "./export-html";
import type { DisplayResult } from "./parts";

type ExportState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; path: string }
  | { kind: "error"; message: string };

/** 路径太长会挤爆表头：只留最后两段（`Downloads/xxx.html`），完整路径挂在 title 上。 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

/**
 * 「导出 HTML」——把当前这份报告落成一个单文件 HTML，交给主进程写盘。
 *
 * 由 webview 生成 HTML（数据本来就在这儿）、主进程负责落盘与去重，
 * 见 RPC `exportBenchmarkReport`。导出结果就显示在按钮左边：文件到底落在哪
 * 是这一步唯一的悬念，不能只弹一个没有下文的"成功"。
 */
export function ReportExportButton({ result }: { result: DisplayResult }) {
  const t = useT();
  const lang = useUILang((s) => s.lang);
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  // 一句"已导出"留太久会跟下一次操作对不上：10 秒后自己收回去。
  useEffect(() => {
    if (state.kind !== "done" && state.kind !== "error") return;
    const timer = setTimeout(() => setState({ kind: "idle" }), 10_000);
    return () => clearTimeout(timer);
  }, [state.kind]);

  const exportNow = async () => {
    setState({ kind: "busy" });
    try {
      const html = buildBenchmarkReportHtml({ result, t, lang });
      const res = await rpcClient.exportBenchmarkReport({ filename: reportFileName(result), html });
      setState(
        res.ok && res.path
          ? { kind: "done", path: res.path }
          : { kind: "error", message: res.error ?? "export failed" },
      );
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="flex items-center gap-2">
      {state.kind === "done" && (
        <button
          type="button"
          title={state.path}
          onClick={() => void rpcClient.showInExplorer({ filePath: state.path })}
          className="max-w-56 cursor-pointer truncate text-[11px] text-emerald-600 hover:underline dark:text-emerald-400"
        >
          {t("benchmark.export.done", { path: shortPath(state.path) })}
        </button>
      )}
      {state.kind === "error" && (
        <span className="max-w-56 truncate text-[11px] text-destructive" title={state.message}>
          {t("benchmark.export.failed", { error: state.message })}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={state.kind === "busy"}
        title={t("benchmark.export.hint")}
        onClick={() => void exportNow()}
      >
        <FileDownIcon data-icon="inline-start" />
        {t(state.kind === "busy" ? "benchmark.export.busy" : "benchmark.export.html")}
      </Button>
    </div>
  );
}
