import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangleIcon, ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@ui/button";
import { useRouter } from "@stores/router";
import { useT } from "@stores/ui-lang";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * 兜底错误边界：路由页面在渲染/生命周期中抛出未捕获异常时，
 * 显示可恢复的错误页而不是整页白屏。切回其它路由或点「返回」即可恢复。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // 保留原样传给 console，便于主进程日志 / 调试挂钩捕获真实堆栈。
    console.error("[render error]", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  override render() {
    if (!this.state.error) return this.props.children;
    return <ErrorFallback error={this.state.error} onRetry={this.reset} />;
  }
}

function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useT();
  const setRoute = useRouter((s) => s.setRoute);

  const goBack = () => {
    onRetry();
    setRoute({ path: "settings", tab: "store" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 px-6">
      <div className="flex size-11 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangleIcon className="size-5 text-destructive" />
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-sm font-medium">{t("error.title")}</p>
        <p className="max-w-md text-xs leading-5 text-muted-foreground break-words">
          {error.message || String(error)}
        </p>
        {error.stack && (
          <details className="mt-1 w-full max-w-md rounded-lg border p-2 text-left">
            <summary className="cursor-pointer text-[10px] text-muted-foreground">
              {t("error.stack")}
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto font-mono text-[10px] leading-4 text-muted-foreground/80 whitespace-pre-wrap">
              {error.stack}
            </pre>
          </details>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={goBack}>
          <ArrowLeftIcon data-icon="inline-start" className="size-3.5" />
          {t("error.back")}
        </Button>
        <Button variant="default" size="sm" onClick={() => window.location.reload()}>
          <RefreshCwIcon data-icon="inline-start" className="size-3.5" />
          {t("error.reload")}
        </Button>
      </div>
    </div>
  );
}
