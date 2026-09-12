import { join } from "path";
import type { ParsedArgs } from "../args";
import { optString } from "../args";
import { controlRequest, isAppRunning } from "../client";
import { printTable } from "../format";
import { pickNumbered } from "../tui";
import { resolveDataDir } from "../data-dir";
import type {
  BenchmarkRecordRow,
  BenchmarkRunState,
  SpeedBenchRow,
} from "../../bun/benchmark";

/**
 * `omi benchmark` — 终端跑基准测速（本地引擎 / 云端 API 直连）。
 *
 * 应用在运行时走控制 socket（与应用内 UI 共用同一任务单例与历史表，UI 会
 * 实时显示进度）；应用未运行时进程内直连同一份 SQLite 兜底执行。
 */

type ProviderLite = { id: string; name: string; models: string[] };

type RunHandle = {
  runId: string;
  poll: () => Promise<BenchmarkRunState | null>;
  cancel: () => Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTTY = process.stdout.isTTY === true;

function fmtCtx(c: number): string {
  return c >= 1000 ? `${(c / 1000).toFixed(c % 1000 === 0 ? 0 : 1)}k` : String(c);
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? "" : `${d.getFullYear()}-`}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function targetLabel(r: { serverMode?: string | null; engine?: string | null }): string {
  if (r.serverMode === "cloud") return `云端·${r.engine ?? "?"}`;
  if (r.serverMode === "remote") return "云端 API";
  return `本地 ${r.engine ?? "llama.cpp"}`;
}

/** 进程内兜底：与 CLI db.ts 同款 env-first 动态 import，指向同一份 SQLite。 */
async function appModules() {
  const dataDir = resolveDataDir();
  process.env.OMNI_DATA_DIR = dataDir;
  process.env.OMNI_DB_PATH = join(dataDir, "omni-studio.db");
  const [benchmark, cloudProviders] = await Promise.all([
    import("../../bun/benchmark"),
    import("../../bun/cloud-providers"),
  ]);
  return { benchmark, cloudProviders };
}

async function listProviders(): Promise<{ providers: ProviderLite[]; activeId: string | null }> {
  const r = await controlRequest("cloudProviders", undefined, 5000);
  if (r.connected && r.ok) {
    const data = r.data as { providers?: { id: string; name: string; models?: { id: string }[] }[]; activeId?: string | null };
    return {
      providers: (data.providers ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        models: (p.models ?? []).map((m) => m.id),
      })),
      activeId: data.activeId ?? null,
    };
  }
  const { cloudProviders } = await appModules();
  const listed = cloudProviders.listCloudProviders();
  return {
    providers: listed.providers.map((p) => ({ id: p.id, name: p.name, models: p.models.map((m) => m.id) })),
    activeId: listed.activeId,
  };
}

/** --cloud 参数解析：id 精确 → 名称精确 → 名称/id 子串；无值时交互选择。 */
async function resolveProvider(arg: string | boolean): Promise<ProviderLite | null> {
  const { providers, activeId } = await listProviders();
  if (providers.length === 0) {
    console.error("还没有云服务商，请先在应用「设置 → 网络」里添加。");
    return null;
  }

  if (arg === true) {
    if (!isTTY) {
      const fallback = providers.find((p) => p.id === activeId) ?? providers[0]!;
      return fallback;
    }
    const picked = await pickNumbered(
      "选择云服务商",
      providers.map((p) => ({
        label: p.name,
        value: p.id,
        dim: `${p.models.length} 个模型${p.id === activeId ? " · 当前激活" : ""}`,
      })),
    );
    return picked ? (providers.find((p) => p.id === picked) ?? null) : null;
  }

  const needle = (typeof arg === "string" ? arg : "").trim().toLowerCase();
  const exact = providers.find((p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle);
  if (exact) return exact;
  const fuzzy = providers.filter((p) => p.id.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle));
  if (fuzzy.length === 1) return fuzzy[0]!;
  console.error(
    fuzzy.length === 0
      ? `没有匹配「${arg}」的云服务商。可用：${providers.map((p) => p.name).join(" / ")}`
      : `「${arg}」匹配到多个服务商，请用完整名称：${fuzzy.map((p) => p.name).join(" / ")}`,
  );
  return null;
}

function printRowLine(r: SpeedBenchRow) {
  const fails = r.fails > 0 ? ` \x1b[31m失败 ${r.fails}\x1b[0m` : "";
  console.log(
    `  ✓ ${fmtCtx(r.contextLength)}  ttft ${r.ttftMs}ms  tpot ${r.tpotMs}ms  tps \x1b[36m${r.tps}\x1b[0m  聚合 ${r.aggTps}  prefill ${r.prefillTps}${fails}`,
  );
}

function printResult(state: BenchmarkRunState) {
  const statusText =
    state.status === "done" ? "\x1b[32m完成\x1b[0m" : state.status === "cancelled" ? "已取消" : `\x1b[31m失败\x1b[0m`;
  console.log(`\n${statusText}  ${state.model}  [${targetLabel(state)}]  ${state.params.genLength} tok × 并发 ${state.params.batchSize}`);
  if (state.error) console.log(`错误：${state.error}`);

  const s = state.summary;
  if (s) {
    console.log(
      `平均 ${s.avgTps} tok/s · 峰值 ${s.peakTps} · 最佳 TTFT ${s.bestTtftMs}ms · 峰值并发 ${s.peakAggTps} · 峰值 prefill ${s.peakPrefillTps} · 共 ${s.totalTokens.toLocaleString()} tok`,
    );
  }
  if (state.rows.length > 0) {
    printTable(
      ["上下文", "输入tok", "TTFT(ms)", "TPOT(ms)", "TPS", "聚合TPS", "Prefill", "输出tok", "成功"],
      state.rows.map((r) => [
        fmtCtx(r.contextLength),
        String(r.promptTokens),
        String(r.ttftMs),
        String(r.tpotMs),
        String(r.tps),
        String(r.aggTps),
        String(r.prefillTps),
        String(r.tokens),
        r.fails > 0 ? `${r.ok}/${r.fails}` : String(r.ok),
      ]),
    );
  }
  const durS = state.durationMs ? (state.durationMs / 1000).toFixed(1) : "?";
  console.log(`耗时 ${durS}s${state.recordId ? ` · 已存历史记录 #${state.recordId}` : ""}`);
}

function printRecords(records: BenchmarkRecordRow[]) {
  if (records.length === 0) {
    console.log("还没有测试记录。");
    return;
  }
  printTable(
    ["ID", "时间", "模型", "目标", "状态", "平均TPS", "耗时(s)"],
    records.map((r) => [
      String(r.id),
      fmtTime(r.createdAt),
      r.model,
      targetLabel(r),
      r.status === "done" ? "完成" : r.status === "cancelled" ? "取消" : "失败",
      r.summary ? String(r.summary.avgTps) : "-",
      r.durationMs ? String(Math.round(r.durationMs / 1000)) : "-",
    ]),
  );
}

async function listRecords(): Promise<BenchmarkRecordRow[]> {
  const r = await controlRequest("benchmarkRecords", undefined, 5000);
  if (r.connected && r.ok) return ((r.data as { records?: BenchmarkRecordRow[] }).records ?? []);
  const { benchmark } = await appModules();
  return benchmark.listBenchmarkRecords();
}

async function startRun(params: {
  model: string;
  providerId?: string;
  genLength?: number;
  batchSize?: number;
  contexts?: number[];
}): Promise<RunHandle | { error: string }> {
  // 应用在运行：走 socket（UI 同步显示；全局只允许一个运行中任务）。
  if (await isAppRunning()) {
    const r = await controlRequest("benchmark", params, 10_000);
    if (!r.connected) return { error: `控制通道失联：${r.error ?? ""}` };
    if (!r.ok || !r.data) return { error: r.error ?? "启动失败" };
    const runId = String((r.data as { runId: string }).runId);
    return {
      runId,
      poll: async () => {
        const p = await controlRequest("benchmarkRun", { runId }, 10_000);
        return (p.data as { run?: BenchmarkRunState | null })?.run ?? null;
      },
      cancel: async () => {
        await controlRequest("benchmarkCancel", { runId }, 5000);
      },
    };
  }
  // 应用未运行：进程内直连执行（记录写同一份 SQLite）。
  const { benchmark } = await appModules();
  const result = benchmark.startBenchmark(params);
  if ("error" in result) return { error: result.error };
  return {
    runId: result.runId,
    poll: async () => benchmark.getBenchmarkRun(result.runId),
    cancel: async () => {
      benchmark.cancelBenchmark(result.runId);
    },
  };
}

export async function cmdBenchmark(parsed: ParsedArgs): Promise<void> {
  const list = parsed.options.list === true;
  const json = parsed.options.json === true;
  const open = parsed.options.open === true;
  const modelArg = parsed.positionals[0];
  const cloudArg = parsed.options.cloud;

  if (list) {
    printRecords((await listRecords()).slice(0, 20));
    return;
  }

  // --cloud [provider]：云端直连目标
  let provider: ProviderLite | null = null;
  if (cloudArg !== undefined) {
    provider = await resolveProvider(cloudArg);
    if (!provider) return;
  }

  let model = modelArg ?? "";
  if (provider && !model) {
    if (isTTY && provider.models.length > 0) {
      const picked = await pickNumbered(
        `选择 ${provider.name} 的模型`,
        provider.models.map((m) => ({ label: m, value: m })),
      );
      if (!picked) return;
      model = picked;
    } else {
      model = provider.models[0] ?? "";
    }
  }

  const genLength = Number(optString(parsed.options, "gen")) || undefined;
  const batchSize = Number(optString(parsed.options, "batch")) || undefined;
  const contexts = optString(parsed.options, "contexts")
    ?.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const target = provider ? `${provider.name} · ${model || "默认模型"}` : model || "当前活动模型";
  console.log(`基准测速 → ${target}${contexts ? `（${contexts.map(fmtCtx).join(" / ")}）` : ""}`);

  const started = await startRun({
    model,
    providerId: provider?.id,
    genLength,
    batchSize,
    contexts,
  });
  if ("error" in started) {
    console.error(started.error === "benchmark_already_running" ? "已有基准测试在进行中（应用内或另一个 omi benchmark）。" : started.error);
    return;
  }
  const handle = started;

  let printedRows = 0;
  let cancelled = false;
  const onSigint = () => {
    if (cancelled) process.exit(130);
    cancelled = true;
    process.stdout.write("\n");
    console.log("正在取消（已完成的档位会保留）… 再按一次强制退出");
    void handle.cancel();
  };
  process.on("SIGINT", onSigint);

  let state: BenchmarkRunState | null = null;
  let progressShown = false;
  try {
    for (;;) {
      state = await handle.poll();
      if (!state) {
        console.error("任务状态丢失（应用可能已退出）。");
        return;
      }
      // 新结果行落定前先清掉未换行的进度行，避免拼在同一行。
      if (progressShown && printedRows < state.rows.length) {
        process.stdout.write("\r\x1b[2K");
        progressShown = false;
      }
      for (; printedRows < state.rows.length; printedRows++) printRowLine(state.rows[printedRows]!);
      if (state.status !== "running") break;
      if (isTTY) {
        const { done, total, phase, currentContext } = state.progress;
        const phaseText = phase === "warmup" ? "预热" : "测量";
        process.stdout.write(`\r\x1b[2m[${done}/${total}] ${currentContext ? fmtCtx(currentContext) : ""} ${phaseText}…\x1b[0m   `);
        progressShown = true;
      }
      await sleep(800);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (progressShown) process.stdout.write("\r\x1b[2K");
  if (json) {
    console.log(JSON.stringify(state));
  } else {
    printResult(state);
  }

  if (open) {
    if (await isAppRunning()) {
      await controlRequest("navigate", { path: "benchmark" }, 5000);
    } else {
      console.log("（应用未运行，--open 已跳过）");
    }
  }

  if (state.status === "error") process.exitCode = 1;
}
