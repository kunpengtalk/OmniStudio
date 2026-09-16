import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { ENGINE_PHASE_LABEL, isEngineInstallRunning, useEngineInstallStore } from "@stores/engine-install";
import type { EngineInstallSupport, InferenceEngine } from "@/shared/engines";

import { formatBytes } from "./constants";

/**
 * 「安装引擎」按钮 + 安装过程（阶段 / 百分比 / 实时日志）。
 *
 * 引导页的引擎步骤与启动步骤都用这一个组件：两处各写一份的话，"能装的按钮点不动"
 * 或"装完了界面没刷新"这类问题只会出现在其中一处。安装过程本身在主进程里跑，
 * 阶段与日志经 engineInstallPhase / engineInstallLog 推回 store —— 组件只读 store，
 * 卸载重挂（切步骤、切应用）都不会丢进度。
 */
export function EngineInstaller({
  engine,
  support,
  manualHint,
  onInstalled,
  managedInstalling = false,
}: {
  engine: InferenceEngine;
  support: EngineInstallSupport;
  /** 手动安装命令（`ENGINE_SPECS[id].installHint`），与按钮并排显示作为备选。 */
  manualHint: string;
  /** 装完（或检测到已装）时回调：父组件重新拉一次 setup-env。 */
  onInstalled: () => void;
  /**
   * 主进程说这个引擎正在装（`setup-env` 的 `installing`）。用于**重载之后**：
   * 推送过来的阶段已经随着页面卸载没了，但安装还在跑，不能显示成"没在装"
   * （用户会以为没反应又点一次）。
   */
  managedInstalling?: boolean;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const phase = useEngineInstallStore((s) => s.phase);
  const logs = useEngineInstallStore((s) => s.logs);
  const mine = phase?.engine === engine ? phase : null;
  const running = isEngineInstallRunning(phase, engine) || (!mine && managedInstalling);
  const failed = mine?.phase === "failed";

  const install = useMutation({
    mutationFn: () => rpcClient.installInferenceEngine({ engine }),
    onSuccess: (result) => {
      if (result.ok) onInstalled();
    },
  });

  const sizeLabel = support.approxBytes ? `约 ${formatBytes(support.approxBytes)}` : "";
  const started = install.isPending || running;
  const visibleLogs = logs.slice(-40);

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {!started && !failed && support.supported && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => install.mutate()}
            disabled={install.isPending}
          >
            <DownloadIcon data-icon="inline-start" className="size-3.5" />
            一键安装{sizeLabel ? `（${sizeLabel}）` : ""}
          </Button>
          {/* 手动安装永远留在旁边：网络受限的机器一键装不下来时，用户还有一条路 */}
          <span className="text-[11px] text-muted-foreground/70">
            或手动安装：<code className="rounded bg-muted px-1">{manualHint}</code>
          </span>
        </div>
      )}

      {started && (
        <div className="flex flex-col gap-1.5 rounded-md bg-muted/50 px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
            <span className="min-w-0 flex-1 truncate">
              {mine ? mine.message || ENGINE_PHASE_LABEL[mine.phase] : "正在安装…（进度见下方日志）"}
            </span>
            {mine?.percent != null && <span className="tabular-nums text-muted-foreground">{mine.percent}%</span>}
          </div>
          {mine?.percent != null && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${mine.percent}%` }}
              />
            </div>
          )}
          <button
            type="button"
            className="flex items-center gap-1 self-start text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowLogs((v) => !v)}
          >
            <ChevronDownIcon className={`size-3 transition-transform ${showLogs ? "" : "-rotate-90"}`} />
            {showLogs ? "收起日志" : `查看日志（${logs.length}）`}
          </button>
          {showLogs && (
            <pre className="max-h-40 overflow-auto rounded bg-background/80 p-2 text-[10px] leading-relaxed text-muted-foreground">
              {visibleLogs.join("") || "等待输出…"}
            </pre>
          )}
        </div>
      )}

      {failed && !started && (
        <div className="flex flex-col gap-1.5 rounded-md bg-destructive/10 px-3 py-2">
          <div className="flex items-start gap-2 text-xs text-destructive">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">
              {install.data?.error ?? mine?.message ?? "安装失败"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => install.mutate()}>
              <RefreshCwIcon data-icon="inline-start" className="size-3.5" />
              重试
            </Button>
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setShowLogs((v) => !v)}
            >
              {showLogs ? "收起日志" : "查看日志"}
            </button>
          </div>
          {showLogs && (
            <pre className="max-h-40 overflow-auto rounded bg-background/80 p-2 text-[10px] leading-relaxed text-muted-foreground">
              {visibleLogs.join("")}
            </pre>
          )}
        </div>
      )}

      {!support.supported && support.note && (
        <p className="text-[11px] text-muted-foreground/70">
          {support.note}
          {" · "}手动安装：<code className="rounded bg-muted px-1">{manualHint}</code>
        </p>
      )}

      {support.supported && support.requirement && !started && !failed && (
        <p className="text-[11px] text-muted-foreground/70">{support.requirement}</p>
      )}

      {install.data && !install.data.ok && !failed && !started && (
        <p className="text-[11px] text-destructive">{install.data.error}</p>
      )}
    </div>
  );
}

/** 「已安装」标记：托管安装的版本号（用户自己装的那份我们不猜版本）。 */
export function InstalledBadge({ version }: { version: string | null }) {
  if (!version) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
      <CheckCircle2Icon className="size-3" />
      已安装 {version}
    </span>
  );
}
