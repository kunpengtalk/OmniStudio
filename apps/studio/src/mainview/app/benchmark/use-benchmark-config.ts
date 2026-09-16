import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { rpcClient } from "@lib/rpc";
import { type InferenceEngine, classifyModelName, filterModelIds, isChatModelCategory, modelNameFromRef, MODEL_CATEGORY_SETS } from "@/shared/modelscope";
import { type BenchmarkCacheMode, BENCHMARK_DEFAULT_CACHE_MODES, BENCHMARK_DEFAULT_CONTEXTS, BENCHMARK_MAX_CONTEXT, BENCHMARK_MIN_CONTEXT, BENCHMARK_PRESET_CONTEXTS, fmtCtx, normalizeCacheModes, normalizeContexts, parseContext, serverContextWindow } from "@/shared/benchmark";
import { useT } from "@stores/ui-lang";
import { useBenchmarkStore } from "@stores/benchmark";
import { useRouter } from "@stores/router";
import type { SpeedBenchRow } from "../../../bun/benchmark";
import type { EvalCategoryRow, EvalSuiteId, EvalSuiteInfo } from "../../../bun/eval";
import { WEIGHT_EXT_RE, type DisplayResult } from "./parts";

/** 基准测试的全部状态与数据逻辑（从 BenchmarkScreen 抽出，视图只负责渲染）。 */
export function useBenchmarkConfig() {
  const t = useT();
  const queryClient = useQueryClient();
  const setRoute = useRouter((s) => s.setRoute);
  const runId = useBenchmarkStore((s) => s.runId);
  const setRunId = useBenchmarkStore((s) => s.setRunId);
  const selectedRecordId = useBenchmarkStore((s) => s.selectedRecordId);
  const setSelectedRecordId = useBenchmarkStore((s) => s.setSelectedRecordId);

  const [mode, setMode] = useState<"speed" | "eval">("speed");
  const [source, setSource] = useState<"local" | "cloud">("local");
  const [model, setModel] = useState("");
  const [cloudModel, setCloudModel] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [genLength, setGenLength] = useState(128);
  const [batchSize, setBatchSize] = useState(1);
  const [contexts, setContexts] = useState<number[]>(BENCHMARK_DEFAULT_CONTEXTS);
  const [cacheModes, setCacheModes] = useState<BenchmarkCacheMode[]>(BENCHMARK_DEFAULT_CACHE_MODES);
  const [customCtx, setCustomCtx] = useState("");
  const [customCtxError, setCustomCtxError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // 能力评测参数：套件 + 抽样题数（0 = 全量）+ 并发跑题数。
  const [suite, setSuite] = useState<EvalSuiteId>("mmlu");
  const [sampleSize, setSampleSize] = useState(0);
  const [evalConcurrency, setEvalConcurrency] = useState(4);

  const { data: settingsData } = useQuery({ queryKey: ["settings"], queryFn: () => rpcClient.getSettings(undefined) });
  const { data: installed } = useQuery({ queryKey: ["installed-models"], queryFn: () => rpcClient.listInstalledModels() });
  const providersQuery = useQuery({
    queryKey: ["cloud-providers"],
    queryFn: () => rpcClient.cloudProviderList(undefined),
  });
  const recordsQuery = useQuery({
    queryKey: ["benchmark-records"],
    queryFn: () => rpcClient.listBenchmarkRecords(undefined),
  });
  const evalSuitesQuery = useQuery({
    queryKey: ["eval-suites"],
    queryFn: () => rpcClient.getEvalSuites(undefined),
  });

  const runQuery = useQuery({
    queryKey: ["benchmark-run", runId],
    queryFn: () => rpcClient.getBenchmarkRun({ runId: runId! }),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.run?.status === "running" ? 800 : false),
  });
  const run = runQuery.data?.run ?? null;

  // 运行结束：刷新历史并自动选中新记录。
  const runStatus = run?.status;
  useEffect(() => {
    if (!run || runStatus === "running") return;
    queryClient.invalidateQueries({ queryKey: ["benchmark-records"] });
    if (run.recordId) {
      setSelectedRecordId(run.recordId);
      setRunId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus]);

  const records = recordsQuery.data?.records ?? [];

  // 历史列表只带轻量元数据（id / model / status…），结果页要回放 rows + summary，
  // 因此只针对「当前要展示的那一条」取完整正文，而不是把全部记录的大 JSON 拉一遍。
  const detailId = run ? null : (selectedRecordId ?? records[0]?.id ?? null);
  const recordDetailQuery = useQuery({
    queryKey: ["benchmark-record", detailId],
    queryFn: () => rpcClient.getBenchmarkRecord({ id: detailId! }),
    enabled: detailId != null,
  });
  const recordDetail = recordDetailQuery.data?.record ?? null;
  // 测速 / 评测跑的是 LLM：本机模型的嵌入 / 语音 / 生图条目不进候选。
  const modelOptions = useMemo(
    () =>
      Array.from(
        new Set(
          (installed?.models ?? [])
            .filter((m) => isChatModelCategory(m.category ?? classifyModelName(m.fileName)))
            .map((m) => m.fileName.replace(WEIGHT_EXT_RE, "")),
        ),
      ).filter(Boolean),
    [installed],
  );
  /**
   * 本地模型一律显示「模型名」（模型库里的下载名 / 网关的服务名），**不放路径**：
   * 设置里的 `LOCAL_MODEL_PATH` / MLX 那种路径型 `CHAT_MODEL` 先对回已装条目，
   * 对不上再收敛成最后一段。请求该用什么 id 是后端的事（见 localBenchmarkModelId）。
   */
  const defaultLocalModel = useMemo(() => {
    const sm = settingsData?.settings;
    const activeRef = sm?.LOCAL_MODEL_PATH || sm?.LOCAL_MODEL_NAME || "";
    const active = (installed?.models ?? []).find(
      (m) =>
        activeRef !== "" &&
        (m.path === activeRef || m.runtimeTarget === activeRef || m.fileName === activeRef),
    );
    if (active) return active.fileName.replace(WEIGHT_EXT_RE, "");
    return modelNameFromRef(activeRef);
  }, [installed, settingsData]);
  const effectiveModel = model || defaultLocalModel || modelOptions[0] || "";

  // 云端：cloud_providers 表直连，与全局激活状态无关。
  const providers = providersQuery.data?.providers ?? [];
  const cloudActiveId = providersQuery.data?.activeId ?? null;
  useEffect(() => {
    if (providers.length === 0) {
      setProviderId(null);
      return;
    }
    if (!providerId || !providers.some((p) => p.id === providerId)) {
      setProviderId(cloudActiveId ?? providers[0]!.id);
    }
  }, [providers, cloudActiveId, providerId]);
  const selectedProvider = providers.find((p) => p.id === providerId) ?? null;
  // 服务商清单里混着嵌入 / 语音 / 生图模型，测速只列对话模型（认不出的保留）。
  const cloudModelOptions = useMemo(
    () =>
      filterModelIds(
        Array.from(new Set((selectedProvider?.models ?? []).map((m) => m.id).filter(Boolean))),
        MODEL_CATEGORY_SETS.chat,
        { keepOther: true },
      ).ids,
    [selectedProvider],
  );
  // 换服务商后上一个厂商的模型就失效了：对不上当前清单时回落到本厂商的第一条
  // （不然下拉框会拿别家的模型名去跑这个厂商的接口）。
  const effectiveCloudModel = cloudModelOptions.includes(cloudModel)
    ? cloudModel
    : (cloudModelOptions[0] ?? "");
  const providerIncomplete = !selectedProvider || !selectedProvider.baseUrl.trim();
  const providerKeyMissing = !!selectedProvider && !selectedProvider.apiKey.trim();

  const selectedSuiteInfo: EvalSuiteInfo | undefined = evalSuitesQuery.data?.suites.find((s) => s.id === suite);

  const startRun = async () => {
    setStartError(null);
    const res = await rpcClient.startBenchmark({
      model: source === "cloud" ? effectiveCloudModel : effectiveModel,
      providerId: source === "cloud" && providerId ? providerId : undefined,
      mode,
      suite: mode === "eval" ? suite : undefined,
      sampleSize: mode === "eval" ? sampleSize : undefined,
      concurrency: mode === "eval" ? evalConcurrency : undefined,
      genLength: mode === "speed" ? genLength : undefined,
      batchSize: mode === "speed" ? batchSize : undefined,
      contexts: mode === "speed" ? contexts : undefined,
      cacheModes: mode === "speed" ? cacheModes : undefined,
    });
    if ("error" in res) {
      setStartError(
        res.error === "benchmark_already_running" ? t("benchmark.alreadyRunning") : res.error,
      );
      return;
    }
    setSelectedRecordId(null);
    setRunId(res.runId);
  };

  const display: DisplayResult | null = useMemo(() => {
    if (selectedRecordId != null) {
      // 元数据来自轻量列表，正文（rows/summary/params）来自按需拉取的完整记录。
      const rec = recordDetail?.id === selectedRecordId ? recordDetail : records.find((r) => r.id === selectedRecordId);
      if (rec) {
        return {
          source: "record",
          kind: rec.kind,
          // 老记录里可能存着 MLX 的路径型请求 id：展示前收敛成模型名。
          model: modelNameFromRef(rec.model),
          engine: rec.engine,
          serverMode: rec.serverMode ?? "local",
          status: rec.status,
          rows: rec.kind === "speed" ? ((rec.rows ?? []) as SpeedBenchRow[]) : [],
          evalRows: rec.kind === "eval" ? ((rec.rows ?? []) as EvalCategoryRow[]) : undefined,
          summary: rec.summary,
          params: rec.params,
          createdAt: rec.createdAt,
          durationMs: rec.durationMs,
          error: rec.error,
        };
      }
    }
    if (run) {
      return {
        source: "run",
        kind: run.kind,
        model: modelNameFromRef(run.model),
        engine: run.engine,
        serverMode: run.serverMode,
        status: run.status,
        rows: run.rows,
        evalRows: run.evalRows,
        eval: run.eval,
        summary: run.summary,
        params: run.params,
        createdAt: run.startedAt,
        durationMs: run.durationMs,
        error: run.error,
        progress: run.progress,
      };
    }
    const latestMeta = records[0];
    const latest = recordDetail?.id === latestMeta?.id ? recordDetail : latestMeta;
    if (latest) {
      return {
        source: "record",
        kind: latest.kind,
        model: modelNameFromRef(latest.model),
        engine: latest.engine,
        serverMode: latest.serverMode ?? "local",
        status: latest.status,
        rows: latest.kind === "speed" ? ((latest.rows ?? []) as SpeedBenchRow[]) : [],
        evalRows: latest.kind === "eval" ? ((latest.rows ?? []) as EvalCategoryRow[]) : undefined,
        summary: latest.summary,
        params: latest.params,
        createdAt: latest.createdAt,
        durationMs: latest.durationMs,
        error: latest.error,
      };
    }
    return null;
  }, [records, recordDetail, run, selectedRecordId]);

  const isRunning = run?.status === "running";
  const maxTps = Math.max(...(display?.rows ?? []).map((r) => r.tps), 0.0001);

  const toggleContext = (c: number) => {
    setContexts((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : normalizeContexts([...prev, c])));
  };

  const toggleCacheMode = (m: BenchmarkCacheMode) => {
    setCacheModes((prev) =>
      // 至少留一种：空集会被主进程回落到"三种全测"，界面却显示一个都没勾
      prev.includes(m) ? (prev.length > 1 ? prev.filter((x) => x !== m) : prev) : normalizeCacheModes([...prev, m]),
    );
  };

  const addCustomContext = () => {
    const parsed = parseContext(customCtx);
    if (parsed === null) {
      setCustomCtxError(t("benchmark.contexts.invalid"));
      return;
    }
    // 超范围不静默夹紧：把用户填的 2m 悄悄改成 1m，跑出来的结果对不上他填的数。
    if (parsed < BENCHMARK_MIN_CONTEXT || parsed > BENCHMARK_MAX_CONTEXT) {
      setCustomCtxError(
        t("benchmark.contexts.outOfRange", {
          min: String(BENCHMARK_MIN_CONTEXT),
          max: fmtCtx(BENCHMARK_MAX_CONTEXT),
        }),
      );
      return;
    }
    setCustomCtxError(null);
    setCustomCtx("");
    setContexts((prev) => normalizeContexts([...prev, parsed]));
  };

  // 可点选的档位 = 预设 + 用户自定义（自定义的用虚线边框区分，位置按大小排在中间）
  const chipContexts = useMemo(() => normalizeContexts([...BENCHMARK_PRESET_CONTEXTS, ...contexts]), [contexts]);
  const isPresetCtx = (c: number) => BENCHMARK_PRESET_CONTEXTS.includes(c);

  /**
   * 推理服务器的单请求窗口（本地目标才读得到）——在勾档位之前就把"哪些档位必然被拒"
   * 说清楚。1M 档一跑就是几十分钟，等跑完再看失败太贵了。
   */
  const serverWindow = useMemo(() => {
    if (source !== "local") return null;
    const settings = settingsData?.settings ?? {};
    const engine = (settings.INFERENCE_ENGINE ?? "llama.cpp") as InferenceEngine;
    return serverContextWindow(engine, settings);
  }, [source, settingsData]);
  const overWindow = serverWindow !== null ? contexts.filter((c) => c > serverWindow) : [];

  return {
    t,
    mode, setMode, source, setSource, isRunning,
    modelOptions, effectiveModel, setModel,
    providers, providerId, setProviderId, providerIncomplete, providerKeyMissing,
    cloudModelOptions, effectiveCloudModel, setCloudModel,
    genLength, setGenLength, batchSize, setBatchSize,
    contexts, toggleContext, chipContexts, isPresetCtx,
    customCtx, setCustomCtx, customCtxError, setCustomCtxError, addCustomContext,
    overWindow, serverWindow,
    cacheModes, toggleCacheMode,
    evalSuitesQuery, suite, setSuite, sampleSize, setSampleSize,
    evalConcurrency, setEvalConcurrency, selectedSuiteInfo,
    startRun, startError, run, display, maxTps, setRoute,
  };
}

export type BenchmarkConfig = ReturnType<typeof useBenchmarkConfig>;
