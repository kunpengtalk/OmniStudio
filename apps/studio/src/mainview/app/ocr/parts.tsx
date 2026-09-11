import { useState, type ReactNode } from "react";
import {
  CheckIcon,
  CopyIcon,
  ImagePlusIcon,
  ScanTextIcon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/** 已暂存（复制到应用数据目录）的待识别图片。 */
export type StagedImage = { ref: string; url: string };

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

/** 统一的错误提示条。 */
export function ErrorNote({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] leading-relaxed text-destructive">
      {error}
    </div>
  );
}

/** 左侧面板的一个配置分组。 */
export function PanelSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-5 items-center gap-2">
        <h3 className="text-xs font-semibold text-foreground/80">{title}</h3>
        {action ? <div className="ml-auto shrink-0">{action}</div> : null}
      </div>
      {hint ? <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p> : null}
      {children}
    </section>
  );
}

/** 分段切换控件（引擎 / 来源等互斥选项）。 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
}) {
  return (
    <div className="flex gap-0.5 rounded-lg border bg-background p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {o.icon}
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** 状态展示行（引擎 / 服务器 / 远程服务）。 */
export function StatusCard({
  icon,
  title,
  detail,
  action,
  tone = "neutral",
}: {
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "ok" | "warn";
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border bg-card p-2.5">
      <span
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md",
          tone === "ok" && "bg-emerald-500/10 text-emerald-600",
          tone === "warn" && "bg-amber-500/10 text-amber-600",
          tone === "neutral" && "bg-muted text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{title}</p>
        {detail ? (
          <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{detail}</div>
        ) : null}
        {action ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{action}</div> : null}
      </div>
    </div>
  );
}

/** 待识别图片选择器（点击选择 / 更换 / 移除）。 */
export function ImagePicker({
  image,
  onPick,
  onClear,
}: {
  image: StagedImage | null;
  onPick: (f: StagedImage) => void;
  onClear: () => void;
}) {
  const t = useT();

  const pick = async () => {
    const { paths } = await rpcClient.openFileDialog({
      allowedFileTypes: "png,jpg,jpeg,webp,bmp,tiff,tif,gif,heic,heif,pdf",
    });
    if (paths.length === 0) return;
    const { files } = await rpcClient.stageOcrImage({ paths });
    if (files[0]) onPick(files[0]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {!image ? (
        <button
          type="button"
          onClick={() => void pick()}
          className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border bg-background px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-accent/40"
        >
          <ImagePlusIcon className="size-5 text-muted-foreground" />
          <span className="flex flex-col gap-0.5">
            <span className="text-xs font-medium">{t("ocr.image.pick")}</span>
            <span className="text-[11px] text-muted-foreground">{t("ocr.image.pickHint")}</span>
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-3 rounded-xl border bg-card p-2.5">
          <img
            src={image.url}
            alt=""
            className="size-14 shrink-0 rounded-lg border object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] text-muted-foreground">{t("ocr.image.label")}</p>
            <p className="truncate font-mono text-[11px]">{image.ref.split("/").pop()}</p>
            <div className="mt-1.5 flex items-center gap-1">
              <Button size="xs" variant="outline" onClick={() => void pick()}>
                {t("ocr.image.pick")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={onClear}
              >
                <XIcon data-icon="inline-start" />
                {t("ocr.image.remove")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 复制按钮（webview 下 clipboard 可能不可用，失败静默）。 */
export function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!text}
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <CheckIcon data-icon="inline-start" className="text-emerald-500" />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {copied ? t("ocr.copied") : t("ocr.copy")}
    </Button>
  );
}

/** 左参数面板 + 右结果区的统一外壳（与生图页同款规格）。 */
export function Workbench({
  panel,
  footer,
  resultHeader,
  result,
}: {
  panel: ReactNode;
  footer: ReactNode;
  resultHeader: ReactNode;
  result: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {panel}
          {footer}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {resultHeader}
        <div className="min-h-0 flex-1 overflow-y-auto">{result}</div>
      </section>
    </div>
  );
}

/** 结果区顶部固定标题条。 */
export function ResultHeader({ meta, children }: { meta?: ReactNode; children?: ReactNode }) {
  const t = useT();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <ScanTextIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-sm font-medium">{t("ocr.result")}</span>
      {meta ? <span className="min-w-0 truncate text-xs text-muted-foreground">{meta}</span> : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">{children}</div>
    </header>
  );
}

/** 结果区空态。 */
export function EmptyResult({ icon, hint }: { icon: ReactNode; hint: string }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-muted">
        {icon}
      </div>
      <p className="text-sm font-medium">{t("ocr.result")}</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}

/** 结果区顶部的原图预览条。 */
export function ImagePreview({ image }: { image: StagedImage }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-2.5">
      <img src={image.url} alt="" className="size-14 shrink-0 rounded-lg border object-cover" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground">{t("ocr.image.label")}</p>
        <p className="truncate font-mono text-[11px]">{image.ref.split("/").pop()}</p>
      </div>
    </div>
  );
}

/** 只读文本块：由外层容器统一滚动，避免嵌套滚动条。 */
export function ResultText({ text }: { text: string }) {
  return (
    <pre className="min-h-32 rounded-xl border bg-card p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words select-text">
      {text}
    </pre>
  );
}
