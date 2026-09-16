import { useBenchmarkConfig } from "./use-benchmark-config";
import { BenchmarkConfigPanel } from "./config-panel";
import { ResultView } from "./result-view";

/**
 * 基准测试页：左栏配置（`BenchmarkConfigPanel`），右栏结果（`ResultView`）。
 *
 * 全部状态与数据逻辑都在 `useBenchmarkConfig` 里 —— 本组件只做布局与分发，
 * 方便后续单独测试配置表单或结果视图。
 */
export function BenchmarkScreen() {
  const cfg = useBenchmarkConfig();
  const { t, display, isRunning, maxTps } = cfg;
  return (
    <div className="flex h-full min-h-0">
      <BenchmarkConfigPanel cfg={cfg} />
      {/* 右：结果区 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-5">
        {!display ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="rounded-lg border border-dashed px-6 py-10 text-center text-xs text-muted-foreground">
              {t("benchmark.empty")}
            </p>
          </div>
        ) : (
          <ResultView result={display} isRunning={isRunning} maxTps={maxTps} />
        )}
      </div>
    </div>
  );
}
