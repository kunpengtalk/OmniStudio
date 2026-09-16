import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AudioLinesIcon,
  FolderIcon,
  ImageIcon,
  LanguagesIcon,
  MicIcon,
  MessageSquareIcon,
  PhoneCallIcon,
  RefreshCwIcon,
  ScanTextIcon,
  SparklesIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { CloudModelSelect } from "@components/cloud-model-select";
import { useServedModelsSync } from "@components/served-models-panel";
import { useServedStore } from "@stores/served";
import { KbModelSelect, useKbModelCandidates } from "@/mainview/app/kb/model-select";
import { ENGINE_SHORT_NAMES } from "@/shared/engines";
import { modelNameFromRef } from "@/shared/modelscope";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";

/**
 * 「默认模型」面板：按使用场景的卡片网格（对话 / 语音通话 / TTS / ASR / 生图 / OCR），
 * 每张卡片直连对应的设置键，改动即时保存。语言模型卡片与对话页模型选择器联动
 * （selectChatModel），模态卡片读写各自的 *_MODEL 键。
 */

/** 可搜索 + 可刷新的模型选择卡片（模态场景通用）。 */
function ModelCard({
  title,
  desc,
  icon,
  value,
  settingsKey,
  fetchModels,
  children,
}: {
  title: string;
  desc: string;
  icon: ReactNode;
  value: string;
  settingsKey: string;
  /** 点击「获取列表」时拉取候选模型（不传则显示 children 自定义控件）。 */
  fetchModels?: () => Promise<{ models: string[]; relaxed?: boolean; error?: string }>;
  children?: ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [options, setOptions] = useState<string[]>([]);
  const [relaxed, setRelaxed] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const fetchMutation = useMutation({
    mutationFn: () => fetchModels!(),
    onSuccess: (res) => {
      setOptions(res.models ?? []);
      setRelaxed(res.relaxed === true);
    },
  });

  const saveMutation = useMutation({
    mutationFn: (model: string) => rpcClient.updateSettings({ settings: { [settingsKey]: model } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const needle = query.trim().toLowerCase();
  const shown = options.filter((o) => !needle || o.toLowerCase().includes(needle));
  const known = options.includes(value);

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{desc}</p>
        </div>
      </div>

      {fetchModels ? (
        <div className="flex items-center gap-2">
          <Select
            value={value || undefined}
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) setQuery("");
            }}
            onValueChange={(v) => saveMutation.mutate(v)}
          >
            <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 text-xs">
              <SelectValue placeholder={t("defaults.notSet")} />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={6} className="max-w-72">
              <div className="sticky top-0 z-10 bg-popover p-1.5 pb-1" onKeyDown={(e) => e.stopPropagation()}>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setOpen(false);
                    }
                  }}
                  placeholder={t("chat.modelSearch")}
                  autoFocus
                  className="h-7 text-xs"
                />
              </div>
              {value && !known && (
                <SelectGroup>
                  <SelectItem value={value}>
                    <span className="truncate">{value}</span>
                    <span className="truncate text-[10px] text-muted-foreground/70">
                      {t("defaults.current")}
                    </span>
                  </SelectItem>
                </SelectGroup>
              )}
              {shown.length > 0 && (
                <SelectGroup>
                  <SelectLabel>{t("chat.modelApi")}</SelectLabel>
                  {shown.map((o) => (
                    <SelectItem key={o} value={o}>
                      <span className="truncate font-mono">{o}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {options.length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("defaults.fetchHint")}
                </div>
              )}
              {options.length > 0 && shown.length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("chat.modelNoMatch")}
                </div>
              )}
              {/* 服务端清单里没认出该场景的模型，列的是全量：说明一句，避免误以为都能用。 */}
              {relaxed && shown.length > 0 && (
                <div className="border-t px-2 py-2 text-[11px] leading-4 text-muted-foreground">
                  {t("models.filter.relaxed")}
                </div>
              )}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon-sm"
            className="size-8 shrink-0"
            tooltip={t("defaults.fetch")}
            disabled={fetchMutation.isPending}
            onClick={() => fetchMutation.mutate()}
          >
            {fetchMutation.isPending ? (
              <Spinner className="size-3.5" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
          </Button>
        </div>
      ) : (
        children
      )}

      {fetchMutation.data?.error && (
        <p className="text-[11px] text-destructive">{fetchMutation.data.error}</p>
      )}
      {saveMutation.isSuccess && (
        <p className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
          {t("common.saved")}
        </p>
      )}
    </div>
  );
}

/** 语言模型卡片：与对话页选择器联动（本地 / API 分组，selectChatModel）。 */
function ChatModelCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const modelsQuery = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(undefined),
  });

  const settings = settingsData?.settings;
  const mode = settings?.SERVER_MODE ?? "local";
  const chatModel = settings?.CHAT_MODEL ?? "";
  const apiModel = settings?.VLLM_MODEL_NAME ?? "";
  const activePath = settings?.LOCAL_MODEL_PATH ?? "";

  const options = modelsQuery.data?.models ?? [];
  // 本地先认「正在用的那个实例」：值对上了下拉框才显示模型名，而不是把
  // LOCAL_MODEL_PATH / MLX 的请求 id（绝对路径）当名字摆出来。
  const currentLocal = options.find((o) => o.type === "local" && o.isActive);
  const current =
    mode === "remote" ? apiModel || chatModel : (currentLocal?.value ?? (activePath || chatModel));
  const currentOption = options.find((o) => o.value === current);
  // 清单里没有的当前值（老数据 / 厂商那边删掉的模型）：本地同样收敛成模型名再展示。
  const currentLabel = currentOption?.label ?? modelNameFromRef(current);

  const selectMutation = useMutation({
    // providerId 要一路带下去：换了厂商时一并把默认厂商切过去（网关只认默认厂商）。
    mutationFn: (opt: { type: "local" | "api"; value: string; providerId?: string }) =>
      rpcClient.selectChatModel(opt),
    onSettled: () => setPending(false),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
  });

  const needle = query.trim().toLowerCase();
  const matches = (label: string, detail?: string) =>
    !needle || label.toLowerCase().includes(needle) || (detail ?? "").toLowerCase().includes(needle);
  const localOptions = options.filter((o) => o.type === "local" && matches(o.label, o.detail));
  const apiOptions = options.filter((o) => o.type === "api" && matches(o.label, o.detail));

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground">
          <MessageSquareIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("defaults.chat")}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{t("defaults.chatDesc")}</p>
        </div>
      </div>

      <Select
        value={current || undefined}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        onValueChange={(value) => {
          const option = options.find((o) => o.value === value);
          if (!option || option.value === current) return;
          setPending(true);
          selectMutation.mutate(option);
          setOpen(false);
        }}
      >
        <SelectTrigger size="sm" className="h-9 min-w-0 flex-1 text-xs">
          <SelectValue placeholder={t("defaults.notSet")} />
        </SelectTrigger>
        <SelectContent position="popper" sideOffset={6} className="w-[30rem] max-w-[min(30rem,90vw)]">
          <div className="sticky top-0 z-10 bg-popover p-1.5 pb-1" onKeyDown={(e) => e.stopPropagation()}>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
              placeholder={t("chat.modelSearch")}
              autoFocus
              className="h-7 text-xs"
            />
          </div>
          {current && !currentOption && (
            <SelectGroup>
              <SelectItem value={current}>
                <span className="truncate">{currentLabel}</span>
                <span className="truncate text-[10px] text-muted-foreground/70">
                  {t("defaults.current")}
                </span>
              </SelectItem>
            </SelectGroup>
          )}
          {localOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelLocal")}</SelectLabel>
              {localOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    {o.isDir && (
                      <FolderIcon className="size-3 shrink-0 text-muted-foreground/60" />
                    )}
                    <span className="truncate">{o.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {o.state === "stopped" && (
                      <span className="rounded-full bg-muted px-1.5 text-[9px] leading-4 text-muted-foreground">
                        {t("models.notStarted")}
                      </span>
                    )}
                    {o.engine && (
                      <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
                        {ENGINE_SHORT_NAMES[o.engine]}
                      </span>
                    )}
                    {o.detail && (
                      <span className="max-w-44 truncate text-[10px] text-muted-foreground/70">
                        {o.detail}
                      </span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {apiOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelApi")}</SelectLabel>
              {apiOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.detail && (
                    <span className="max-w-44 shrink-0 truncate text-[10px] text-muted-foreground/70">
                      {o.detail}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {options.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t("chat.modelEmpty")}</div>
          )}
          {options.length > 0 && localOptions.length === 0 && apiOptions.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("chat.modelNoMatch")}
            </div>
          )}
        </SelectContent>
      </Select>

      {pending && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Spinner className="size-3" /> {t("defaults.switching")}
        </p>
      )}
      {selectMutation.isError && (
        <p className="text-[11px] text-destructive">{String(selectMutation.error)}</p>
      )}
    </div>
  );
}

/**
 * 云模型默认值卡片（TTS / ASR / 生图 / OCR）：与功能页同一套选择器 ——
 * 先选已启用的云厂商，再选该用途下的模型；地址与密钥来自厂商，卡片里不出现。
 */
function CloudModelCard({
  title,
  desc,
  icon,
  kind,
  providerKey,
  modelKey,
}: {
  title: string;
  desc: string;
  icon: ReactNode;
  kind: "image" | "tts" | "asr" | "chat";
  providerKey: string;
  modelKey: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const s = data?.settings;
  const savedProviderId = (s?.[providerKey as keyof typeof s] as string | undefined) ?? "";
  const savedModel = (s?.[modelKey as keyof typeof s] as string | undefined) ?? "";

  const [providerId, setProviderId] = useState(savedProviderId);
  const [model, setModel] = useState(savedModel);
  useEffect(() => setProviderId(savedProviderId), [savedProviderId]);
  useEffect(() => setModel(savedModel), [savedModel]);

  const save = useMutation({
    mutationFn: (next: { providerId: string; model: string }) =>
      rpcClient.updateSettings({
        settings: { [providerKey]: next.providerId, [modelKey]: next.model },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    },
  });

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{desc}</p>
        </div>
      </div>
      <CloudModelSelect
        kind={kind}
        providerId={providerId}
        model={model}
        size="sm"
        onChange={(choice) => {
          setProviderId(choice.providerId);
          setModel(choice.model);
          save.mutate(choice);
        }}
      />
      {save.isError && <p className="text-[11px] text-destructive">{String(save.error)}</p>}
      <p className="text-[10px] leading-snug text-muted-foreground">{t("cloud.where")}</p>
    </div>
  );
}

/**
 * 从「选中的模型」算出要写入的设置补丁 —— 含**空 base 陷阱防护**（步骤 9b）。
 *
 * 模型候选来自运行中的嵌入实例、而服务地址为空时，把该实例地址一起写进 `EMBEDDING_BASE`。
 * 否则快照进 KB 行的 base 会是空 —— 实例一停，`resolveEmbeddingBase` 就落回**聊天**活动
 * 端口，那里没有嵌入服务，该库的检索会以维度 / 连接错误失败且不易定位。
 * host 固定 127.0.0.1：served 快照里的 endpoint 主机名来自 SERVER_HOST，可能是 0.0.0.0。
 *
 * 抽成纯函数是为了让这条规则可以被直接断言（组件里只有这一处判断）。
 */
export function embeddingDefaultsPatch(input: {
  model: string;
  /** 当前已填的服务地址（已保存值或用户正在编辑的值）。 */
  base: string;
  /** 该模型是不是运行中嵌入实例提供的（候选列表的本地组）。 */
  fromRunningInstance: boolean;
  /** 运行中最后一个嵌入实例的端口（与 getActiveEmbeddingPort 同源）。 */
  instancePort?: number;
}): Record<string, string> {
  const patch: Record<string, string> = { EMBEDDING_MODEL: input.model };
  if (input.model && input.fromRunningInstance && !input.base.trim() && input.instancePort) {
    patch.EMBEDDING_BASE = `http://127.0.0.1:${input.instancePort}/v1`;
  }
  return patch;
}

/**
 * 全局默认嵌入模型卡片（②-1）：写入 `EMBEDDING_MODEL` / `EMBEDDING_BASE` / `EMBEDDING_API_KEY`。
 *
 * 三键由 bun 侧唯一读取点 `globalEmbeddingDefaults()` 消费，且只在**写入时**快照进知识库行
 * （新建 KB 预填、KB 设置页「启用向量检索」），对既有 KB 没有追溯效果；共享记忆在解析时
 * 读它作为显式值的兜底。文案必须讲清这两点，否则用户会以为既有 KB 已经切换了。
 *
 * 模型候选复用知识库那套 `kbEmbeddingModels`（只列运行中嵌入实例提供的模型 + 云端候选，
 * 并按来源标注），地址 / 密钥可选；空态引导与 KB 选择器同源。选择器开 `allowCustom`：
 * 候选之外的服务（自建 / 代理）可直接手填模型名，回车或点「使用」项保存。
 */
export function EmbeddingModelCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const s = data?.settings;
  const savedModel = s?.EMBEDDING_MODEL ?? "";
  const savedBase = s?.EMBEDDING_BASE ?? "";
  const savedKey = s?.EMBEDDING_API_KEY ?? "";

  const [base, setBase] = useState(savedBase);
  const [apiKey, setApiKey] = useState(savedKey);
  useEffect(() => setBase(savedBase), [savedBase]);
  useEffect(() => setApiKey(savedKey), [savedKey]);

  // 运行中的嵌入实例（served 快照，推送 + 轮询兜底）：既决定候选从哪来，
  // 也决定「从实例选模型时要不要把实例地址预填进服务地址」。
  useServedModelsSync();
  const served = useServedStore((st) => st.models);
  const runningEmbed = served.filter((m) => m.purpose === "embedding" && m.status === "running");
  // 最后一个运行中的实例胜出：与主进程 getActiveEmbeddingPort() 的选取规则同源。
  const lastEmbed = runningEmbed[runningEmbed.length - 1];

  const candidates = useKbModelCandidates("embedding", base, apiKey);

  const save = useMutation({
    mutationFn: (next: Record<string, string>) => rpcClient.updateSettings({ settings: next }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  /** 选模型即保存；来自运行实例且还没填地址时，顺带把实例地址快照进去（9b）。 */
  const pickModel = (model: string) => {
    const fromRunningInstance =
      candidates.data?.service.kind === "local" && (candidates.data?.local ?? []).includes(model);
    save.mutate(
      embeddingDefaultsPatch({
        model,
        base,
        fromRunningInstance,
        instancePort: lastEmbed?.port,
      }),
    );
  };

  /** 地址 / 密钥失焦保存：与既有「即时保存」的卡片一致，值没变就不发请求。 */
  const saveOnBlur = (key: "EMBEDDING_BASE" | "EMBEDDING_API_KEY") => {
    const value = (key === "EMBEDDING_BASE" ? base : apiKey).trim();
    const saved = key === "EMBEDDING_BASE" ? savedBase.trim() : savedKey.trim();
    if (value === saved) return;
    save.mutate({ [key]: value });
  };

  const hasBackend = runningEmbed.length > 0 || Boolean(base.trim());
  const emptyHint =
    !hasBackend && candidates.isSuccess ? t("kb.settings.noEmbeddingServer") : null;

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground">
          <SparklesIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("defaults.embedding")}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {t("defaults.embeddingDesc")}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <KbModelSelect
          ariaLabel={t("defaults.embedding")}
          value={savedModel}
          onChange={pickModel}
          candidates={candidates.data}
          loading={candidates.isLoading}
          allowCustom
          className="flex-1"
        />
        <Button
          variant="outline"
          size="icon-sm"
          className="size-8 shrink-0"
          tooltip={t("defaults.fetch")}
          disabled={candidates.isFetching}
          onClick={() => candidates.refetch()}
        >
          {candidates.isFetching ? (
            <Spinner className="size-3.5" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input
          value={base}
          onChange={(e) => setBase(e.target.value)}
          onBlur={() => saveOnBlur("EMBEDDING_BASE")}
          aria-label={t("defaults.embeddingBase")}
          placeholder={t("kb.settings.embeddingBasePlaceholder")}
          className="h-8 font-mono text-xs"
        />
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onBlur={() => saveOnBlur("EMBEDDING_API_KEY")}
          aria-label={t("defaults.embeddingKey")}
          placeholder={t("kb.settings.keyPlaceholder")}
          className="h-8 font-mono text-xs"
        />
      </div>

      <p className="text-[10px] leading-snug text-muted-foreground/80">{t("defaults.embeddingNote")}</p>
      <p className="text-[10px] leading-snug text-muted-foreground/80">
        {t("defaults.embeddingExistingKb")}
      </p>
      {emptyHint && <p className="text-[10px] leading-snug text-muted-foreground">{emptyHint}</p>}
      {save.isError && <p className="text-[11px] text-destructive">{String(save.error)}</p>}
      {save.isSuccess && (
        <p className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
          {t("common.saved")}
        </p>
      )}
    </div>
  );
}

export function DefaultModelsPanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const s = data?.settings;

  // 语音通话模型：无列表接口，文本输入 + 失焦保存
  const [callModel, setCallModel] = useState("");
  useEffect(() => setCallModel(s?.VOICE_CALL_REALTIME_MODEL ?? ""), [s?.VOICE_CALL_REALTIME_MODEL]);
  const saveCallModel = () => {
    if (callModel.trim() !== (s?.VOICE_CALL_REALTIME_MODEL ?? "")) {
      void rpcClient
        .updateSettings({ settings: { VOICE_CALL_REALTIME_MODEL: callModel.trim() } })
        .then(() => queryClient.invalidateQueries({ queryKey: ["settings"] }));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{t("defaults.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("defaults.desc")}</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChatModelCard />

        <EmbeddingModelCard />

        <ModelCard
          title={t("defaults.voiceCall")}
          desc={t("defaults.voiceCallDesc")}
          icon={<PhoneCallIcon className="size-4" />}
          value={s?.VOICE_CALL_REALTIME_MODEL ?? ""}
          settingsKey="VOICE_CALL_REALTIME_MODEL"
        >
          <Input
            placeholder="qwen-audio-3.0-realtime-plus"
            value={callModel}
            onChange={(e) => setCallModel(e.target.value)}
            onBlur={saveCallModel}
            className="h-8 font-mono text-xs"
          />
        </ModelCard>

        <CloudModelCard
          title={t("defaults.tts")}
          desc={t("defaults.ttsDesc")}
          icon={<AudioLinesIcon className="size-4" />}
          kind="tts"
          providerKey="TTS_PROVIDER_ID"
          modelKey="TTS_PROVIDER_MODEL"
        />

        <CloudModelCard
          title={t("defaults.asr")}
          desc={t("defaults.asrDesc")}
          icon={<MicIcon className="size-4" />}
          kind="asr"
          providerKey="ASR_PROVIDER_ID"
          modelKey="ASR_PROVIDER_MODEL"
        />

        <CloudModelCard
          title={t("defaults.image")}
          desc={t("defaults.imageDesc")}
          icon={<ImageIcon className="size-4" />}
          kind="image"
          providerKey="IMG_PROVIDER_ID"
          modelKey="IMG_MODEL"
        />

        <CloudModelCard
          title={t("defaults.ocr")}
          desc={t("defaults.ocrDesc")}
          icon={<ScanTextIcon className="size-4" />}
          kind="chat"
          providerKey="OCR_PROVIDER_ID"
          modelKey="OCR_PROVIDER_MODEL"
        />
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <LanguagesIcon className="size-3.5 shrink-0" />
        {t("defaults.hint")}
      </p>
    </div>
  );
}
