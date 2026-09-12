import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AudioLinesIcon,
  ImageIcon,
  LanguagesIcon,
  MicIcon,
  MessageSquareIcon,
  PhoneCallIcon,
  RefreshCwIcon,
  ScanTextIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
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
  fetchModels?: () => Promise<{ models: string[]; error?: string }>;
  children?: ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [options, setOptions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const fetchMutation = useMutation({
    mutationFn: () => fetchModels!(),
    onSuccess: (res) => setOptions(res.models ?? []),
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
  const current = mode === "remote" ? apiModel || chatModel : activePath || chatModel;

  const options = modelsQuery.data?.models ?? [];
  const currentOption = options.find((o) => o.value === current);

  const selectMutation = useMutation({
    mutationFn: (opt: { type: "local" | "api"; value: string }) => rpcClient.selectChatModel(opt),
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
        <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 text-xs">
          <SelectValue placeholder={t("defaults.notSet")} />
        </SelectTrigger>
        <SelectContent position="popper" sideOffset={6} className="max-w-80">
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
                <span className="truncate">{current}</span>
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
                  <span className="truncate">{o.label}</span>
                  {o.detail && (
                    <span className="truncate text-[10px] text-muted-foreground/70">{o.detail}</span>
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {apiOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelApi")}</SelectLabel>
              {apiOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="truncate">{o.label}</span>
                  {o.detail && (
                    <span className="truncate text-[10px] text-muted-foreground/70">{o.detail}</span>
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

        <ModelCard
          title={t("defaults.tts")}
          desc={t("defaults.ttsDesc")}
          icon={<AudioLinesIcon className="size-4" />}
          value={s?.TTS_PROVIDER_MODEL ?? ""}
          settingsKey="TTS_PROVIDER_MODEL"
          fetchModels={() =>
            rpcClient.listProviderModels({
              base: s?.TTS_PROVIDER_BASE,
              apiKey: s?.TTS_PROVIDER_API_KEY,
            })
          }
        />

        <ModelCard
          title={t("defaults.asr")}
          desc={t("defaults.asrDesc")}
          icon={<MicIcon className="size-4" />}
          value={s?.ASR_PROVIDER_MODEL ?? ""}
          settingsKey="ASR_PROVIDER_MODEL"
          fetchModels={() =>
            rpcClient.listProviderModels({
              base: s?.ASR_PROVIDER_BASE,
              apiKey: s?.ASR_PROVIDER_API_KEY,
            })
          }
        />

        <ModelCard
          title={t("defaults.image")}
          desc={t("defaults.imageDesc")}
          icon={<ImageIcon className="size-4" />}
          value={s?.IMG_MODEL ?? ""}
          settingsKey="IMG_MODEL"
          fetchModels={() =>
            rpcClient.listImageGenModels({
              backend: "api",
              base: s?.IMG_API_BASE,
              apiKey: s?.IMG_API_KEY,
            })
          }
        />

        <ModelCard
          title={t("defaults.ocr")}
          desc={t("defaults.ocrDesc")}
          icon={<ScanTextIcon className="size-4" />}
          value={s?.OCR_PROVIDER_MODEL ?? ""}
          settingsKey="OCR_PROVIDER_MODEL"
          fetchModels={() =>
            rpcClient.listOcrProviderModels({
              base: s?.OCR_PROVIDER_BASE,
              apiKey: s?.OCR_PROVIDER_API_KEY,
            })
          }
        />
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <LanguagesIcon className="size-3.5 shrink-0" />
        {t("defaults.hint")}
      </p>
    </div>
  );
}
