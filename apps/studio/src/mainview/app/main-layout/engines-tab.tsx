import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpCircleIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  RefreshCwIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Spinner } from "@ui/spinner";
import { PageHeader, SettingsSection } from "@components/setting-ui";
import { ENGINE_PHASE_LABEL, isEngineInstallRunning, useEngineInstallStore } from "@stores/engine-install";
import { useT } from "@stores/ui-lang";
import { useAppStore } from "@stores/app";
import { useRouter } from "@stores/router";
import { cn } from "@lib/utils";
import {
  LOCAL_ENGINE_CATEGORIES,
  LOCAL_ENGINE_CATEGORY_KEYS,
  enginesInCategory,
  type LocalEngineSpec,
  type LocalEngineStatus,
} from "@/shared/local-engines";

/** 字节 → 人读的尺寸（引擎与模型都是几十 MB 到几 GB，只到 GB 一位小数）。 */
function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/**
 * 设置 → 模型引擎：本地引擎的统一管理。
 *
 * 一页看全所有本地运行时（文本推理 / 语音 / OCR / 图像 / 网络工具），每行一个引擎：
 * 状态、版本、路径、占用，以及安装 / 升级 / 卸载。安装过程复用引导页那条推送链路
 * （`engineInstallPhase` / `engineInstallLog` → `useEngineInstallStore`），
 * 所以切走再回来进度还在，也不需要在页面里再挂一套日志通道。
 *
 * 三种状态对应三种可做的操作，不要混：
 *  - 未安装 → 「安装」；
 *  - 应用自己装的（managed）→ 「升级 / 重新下载」+「卸载」（卸载删的就是它，模型保留）；
 *  - 系统里那份（system，PATH / brew / conda）→ 给「安装托管版」而不是「升级」，
 *    也没有卸载（应用不碰系统里那份）；引擎本身没有托管形态的（Tesseract）只给命令。
 */
export function EnginesTab({ onOpenModelsTab }: { onOpenModelsTab?: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["local-engines"],
    queryFn: () => rpcClient.listLocalEngines(undefined),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["local-engines"] });

  const byId = new Map((data?.engines ?? []).map((e) => [e.id, e] as const));
  // 主进程正在装卸载哪个引擎：界面重载之后推送过来的阶段已经没了，但活还在跑 ——
  // 不读这一条，用户会看到一行"什么都没发生"的按钮，然后再点一次。
  const busy = data?.busy ?? null;

  return (
    // 容器与宽度由设置页的 PageShell 统一给（与备份 / 联网检索等页同规矩），
    // 这里只排自己的标题与卡片。
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <PageHeader title={t("settings.engines.title")} description={t("settings.engines.subtitle")} />
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 text-xs"
          onClick={refresh}
          disabled={isFetching}
        >
          <RefreshCwIcon data-icon="inline-start" className={cn("size-3.5", isFetching && "animate-spin")} />
          {t("engines.action.refresh")}
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          {t("engines.loading")}
        </div>
      )}

      {!isLoading &&
        LOCAL_ENGINE_CATEGORIES.map((category) => {
          const specs = enginesInCategory(category);
          if (specs.length === 0) return null;
          const keys = LOCAL_ENGINE_CATEGORY_KEYS[category];
          return (
            <SettingsSection key={category} title={t(keys.titleKey)} description={t(keys.descriptionKey)}>
              {specs.map((spec) => (
                <EngineRow
                  key={spec.id}
                  spec={spec}
                  status={byId.get(spec.id) ?? null}
                  managedBusy={busy?.id === spec.id ? busy.op : null}
                  onChanged={refresh}
                  onOpenModelsTab={onOpenModelsTab}
                />
              ))}
            </SettingsSection>
          );
        })}

      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">{t("engines.footnote")}</p>
    </div>
  );
}

function StateBadge({ status }: { status: LocalEngineStatus | null }) {
  const t = useT();
  if (!status) return null;
  if (status.state === "managed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
        <CheckCircle2Icon className="size-3" />
        {t("engines.state.managed")}
        {status.version ? ` ${status.version}` : ""}
      </span>
    );
  }
  if (status.state === "system") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-500">
        <TerminalIcon className="size-3" />
        {t("engines.state.system")}
        {/* 系统安装的那份现在也带版本（如 oMLX 的 `omlx --version`、tesseract）：
            应用不接管升级，但「装的是哪个版本」是排障时最该看到的一项。 */}
        {status.version ? ` ${status.version}` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {t("engines.state.missing")}
    </span>
  );
}

function EngineRow({
  spec,
  status,
  managedBusy,
  onChanged,
  onOpenModelsTab,
}: {
  spec: LocalEngineSpec;
  status: LocalEngineStatus | null;
  /** 主进程说这个引擎正在装卸载（重载之后的兜底，见 EnginesTab）。 */
  managedBusy: "install" | "uninstall" | null;
  onChanged: () => void;
  onOpenModelsTab?: () => void;
}) {
  const t = useT();
  const setActiveApp = useAppStore((s) => s.setActiveApp);
  const [showLogs, setShowLogs] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const phase = useEngineInstallStore((s) => s.phase);
  const logs = useEngineInstallStore((s) => s.logs);
  const mine = phase && phase.engine === spec.id ? phase : null;

  const install = useMutation({
    mutationFn: (upgrade: boolean) => rpcClient.installLocalEngine({ engine: spec.id, upgrade }),
    onSettled: onChanged,
  });
  const uninstall = useMutation({
    mutationFn: () => rpcClient.uninstallLocalEngine({ engine: spec.id }),
    onSettled: onChanged,
  });

  const working =
    install.isPending ||
    uninstall.isPending ||
    isEngineInstallRunning(phase, spec.id) ||
    (mine === null && managedBusy !== null);
  const failed = uninstall.data?.ok === false || install.data?.ok === false || mine?.phase === "failed";
  const errorText =
    uninstall.data?.ok === false
      ? uninstall.data.error
      : install.data?.ok === false
        ? install.data.error
        : mine?.phase === "failed"
          ? mine.message
          : null;

  const managed = status?.state === "managed";
  const installed = status != null && status.state !== "missing";
  const sizeLabel = status?.approxBytes ? `（${t("engines.approx", { size: formatSize(status.approxBytes) })}）` : "";
  const upgradeKind = status?.upgradeKind ?? "repair";
  /** 能不能给「安装 / 升级」按钮：平台支持，且这个引擎有应用托管的形态
   *  （Tesseract 例外：装进的是用户的 Homebrew，装了就别再给一个只会重跑 brew 的按钮）。 */
  const canOfferInstall = status?.canInstall === true && (spec.managedSupported || !installed);

  /** 按钮文案：未装是「安装」，托管的是「升级 / 重新下载」，系统那份是「安装托管版」。 */
  const installLabel = () => {
    if (!installed) return t("engines.action.install");
    if (!managed) return t("engines.action.installManaged");
    return t(upgradeKind === "latest" ? "engines.action.upgrade" : "engines.action.redownload");
  };

  const openModels = () => {
    if (!spec.modelsTarget) return;
    if (spec.modelsTarget === "local-models") {
      onOpenModelsTab?.();
      return;
    }
    /*
     * 必须先离开设置页：内容区是按 `route.path` 分发的，停在 settings 上时只改
     * activeApp 什么都不会发生 —— 按钮写着「管理模型」，点下去页面一动不动。
     * （这条对语音 / OCR / 图像 / JEV 四个目标都一样；返回值由 app-rail 那套同款调用对齐。）
     */
    useRouter.getState().setRoute({ path: "index" });
    setActiveApp(spec.modelsTarget);
  };

  return (
    <div className="flex items-start justify-between gap-4 border-b px-4 py-3 last:border-b-0">
      {/* 引擎行比 `SettingRow` 的一行式布局多好几层（版本 / 路径 / 进度 / 日志），
          这里自己排，别为了复用把一堆 div 塞进 `SettingRow` 的 <p> 里。 */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-medium">{spec.name}</span>
          <StateBadge status={status} />
          {status?.running && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600">
              <span className="size-1.5 rounded-full bg-amber-500" />
              {t("engines.state.running")}
            </span>
          )}
        </div>

        <p className="text-xs text-muted-foreground">{t(spec.roleKey)}</p>
        <p className="text-[11px] text-muted-foreground/70">{t(spec.usedByKey)}</p>

        {(status?.path || status?.sizeBytes != null) && (
          <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground/70">
            {status?.path && (
              <div className="flex gap-1">
                <span className="shrink-0">{t("engines.field.path")}</span>
                <code className="break-all">{status.path}</code>
              </div>
            )}
            {status?.sizeBytes != null && (
              <div>
                {t("engines.field.size")} {formatSize(status.sizeBytes)}
              </div>
            )}
          </div>
        )}

        {status?.state === "system" && (
          <p className="text-[11px] text-muted-foreground/70">
            {t("engines.note.systemInstall")}
            {/* 托管副本只有部分引擎提供（Tesseract 装进的是用户的 Homebrew）：没有托管
                副本就不做这个承诺，按钮也不给 —— 那只会再跑一次同样的 brew 命令。 */}
            {spec.managedSupported && ` ${t("engines.note.installManagedCopy")}`}
          </p>
        )}

        {/* 给不了按钮（平台没有预编译包 / 应用不提供托管副本）时，把命令行那条路写全：
            装与卸两条命令都给，用户不必再去别处找。 */}
        {!canOfferInstall && (spec.installHint || spec.uninstallHint) && (
          <p className="text-[11px] text-muted-foreground/70">
            {t("engines.note.manualInstall")}
            {spec.installHint && <code className="rounded bg-muted px-1">{spec.installHint}</code>}
            {spec.installHint && spec.uninstallHint && " · "}
            {spec.uninstallHint && <code className="rounded bg-muted px-1">{spec.uninstallHint}</code>}
          </p>
        )}

        {status?.requirement && !managed && (
          <p className="text-[11px] text-muted-foreground/70">{status.requirement}</p>
        )}

        {status?.installNote && <p className="text-[11px] text-amber-600">{status.installNote}</p>}

        <div className="flex flex-wrap items-center gap-3">
          {(working || failed) && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setShowLogs((v) => !v)}
            >
              {showLogs ? t("engines.action.hideLog") : t("engines.action.showLog")}
            </button>
          )}
          {spec.modelsTarget && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={openModels}
            >
              {t("engines.action.manageModels")}
            </button>
          )}
        </div>

        {working && (
          <div className="mt-0.5 flex flex-col gap-1 rounded-md bg-muted/50 px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
              <span className="min-w-0 flex-1">
                {mine
                  ? mine.message || ENGINE_PHASE_LABEL[mine.phase]
                  : managedBusy === "uninstall"
                    ? t("engines.working.uninstall")
                    : managedBusy === "install"
                      ? t("engines.working.install")
                      : t("engines.working")}
              </span>
              {mine?.percent != null && (
                <span className="tabular-nums text-muted-foreground">{mine.percent}%</span>
              )}
            </div>
            {mine?.percent != null && (
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${mine.percent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {errorText && !working && (
          <div className="flex items-start gap-1.5 text-[11px] text-destructive">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{errorText}</span>
          </div>
        )}

        {showLogs && (
          <pre className="max-h-40 overflow-auto rounded bg-background/80 p-2 text-[10px] leading-relaxed text-muted-foreground">
            {logs.slice(-40).join("") || t("engines.logEmpty")}
          </pre>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {canOfferInstall && (
          <Button
            size="sm"
            variant={installed ? "outline" : "default"}
            className="h-7 text-xs"
            disabled={working}
            onClick={() => install.mutate(managed || status!.state === "system")}
          >
            {installed ? (
              <ArrowUpCircleIcon data-icon="inline-start" className="size-3.5" />
            ) : (
              <DownloadIcon data-icon="inline-start" className="size-3.5" />
            )}
            {installLabel()}
            {!installed && sizeLabel}
          </Button>
        )}

        {status?.managedDir && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs text-destructive hover:text-destructive"
              disabled={working}
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2Icon data-icon="inline-start" className="size-3.5" />
              {t("engines.action.uninstall")}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title={t("engines.action.reveal")}
              onClick={() => rpcClient.openPath({ path: status.managedDir! })}
            >
              <FolderOpenIcon className="size-3.5" />
            </Button>
          </>
        )}
      </div>

      <UninstallDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        spec={spec}
        status={status}
        pending={uninstall.isPending}
        onConfirm={() => {
          setConfirmOpen(false);
          uninstall.mutate();
        }}
      />
    </div>
  );
}

/** 卸载确认：把"删哪个目录、多大、会不会停服务、模型还在不在"一次说清。 */
function UninstallDialog({
  open,
  onOpenChange,
  spec,
  status,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spec: LocalEngineSpec;
  status: LocalEngineStatus | null;
  pending: boolean;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("engines.uninstall.title", { name: spec.name })}</DialogTitle>
          <DialogDescription>{t("engines.uninstall.hint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-xs">
          {status?.managedDir && (
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">{t("engines.field.path")}</span>
              <code className="break-all rounded bg-muted px-2 py-1 text-[11px]">{status.managedDir}</code>
            </div>
          )}
          {status?.sizeBytes != null && (
            <div className="text-muted-foreground">
              {t("engines.field.size")} {formatSize(status.sizeBytes)}
            </div>
          )}
          {status?.running && (
            <p className="text-amber-600">{t("engines.uninstall.stopsRunning")}</p>
          )}
          <p className="text-muted-foreground">{t("engines.uninstall.keepModels")}</p>
          <p className="text-muted-foreground">{t("engines.uninstall.systemUntouched")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending && <Loader2Icon data-icon="inline-start" className="size-3.5 animate-spin" />}
            {t("engines.action.uninstall")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
