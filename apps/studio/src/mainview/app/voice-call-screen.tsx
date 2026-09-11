import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  CloudIcon,
  CpuIcon,
  Loader2Icon,
  MicIcon,
  PhoneIcon,
  PhoneOffIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Markdown } from "@components/markdown";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import type { ChatMessage } from "../../bun/chat";
import { useChatStore } from "@stores/chat";
import { useAppStore } from "@stores/app";
import { useRouter } from "@stores/router";
import { useVoiceCallStore, type CallPhase } from "@stores/voice-call";
import { useVoiceCallEngine } from "@hooks/use-voice-call";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/** 云端实时模型（qwen-audio-agent 默认即 plus 档）。 */
const REALTIME_MODEL_OPTIONS = [
  "qwen-audio-3.0-realtime-plus",
  "qwen-audio-3.0-realtime-flash",
  "qwen3.5-omni-flash-realtime",
  "qwen3.5-omni-plus-realtime",
];

/**
 * 实时语音通话（电话式协作）：
 * 左侧通话记录（复用 conversations.app = "voicecall"），右侧通话面板。
 * 未通话/新会话 → 拨号面板（含三件套就绪检测）；通话中 → 消息区 + 实时字幕 + 挂断控制。
 */

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** 通话中的状态指示：说话时跳动的频谱条，聆听时话筒图标。 */
function CallStatusChip({ phase, elapsed }: { phase: CallPhase; elapsed: number }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 text-sm">
      {phase === "speaking" ? (
        <span className="flex h-4 items-end gap-0.5">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="tts-eq w-1 rounded-sm bg-primary"
              style={{ height: `${11 + (i % 3) * 7}px`, animationDelay: `${i * 0.12}s` }}
            />
          ))}
        </span>
      ) : phase === "listening" ? (
        <MicIcon className="size-4 text-primary" />
      ) : (
        <Loader2Icon className="size-4 animate-spin text-primary" />
      )}
      <span className="font-medium">{t(`voicecall.status.${phase}`)}</span>
      {elapsed > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">{formatDuration(elapsed)}</span>
      )}
    </div>
  );
}

/** 麦克风电平条：中间高两边低，高度随电平伸缩。 */
function MicLevelBar({ level }: { level: number }) {
  const BARS = 13;
  return (
    <div className="flex h-6 items-end gap-[3px]" aria-hidden>
      {Array.from({ length: BARS }).map((_, i) => {
        const weight = Math.sin((i / (BARS - 1)) * Math.PI);
        const h = Math.max(3, Math.round(Math.max(0.1, level) * weight * 24));
        return (
          <span
            key={i}
            className="w-[3px] rounded-sm bg-primary/70 transition-all duration-100"
            style={{ height: h }}
          />
        );
      })}
    </div>
  );
}

/** 实时语音球：GPT-4o 风格，随输入电平缩放，说话（AI 回复）时亮起。 */
function VoiceOrb({ level, speaking }: { level: number; speaking: boolean }) {
  const lvl = Math.max(0, Math.min(1, level));
  const scale = 1 + lvl * 0.16;
  return (
    <div className="relative flex size-64 items-center justify-center" aria-hidden>
      {/* 双层呼吸光环 */}
      <span className="orb-halo absolute inset-3 rounded-full border-2 border-sky-400/50" />
      <span
        className="orb-halo absolute inset-3 rounded-full border-2 border-sky-300/40"
        style={{ animationDelay: "1.3s" }}
      />
      {/* 外部光晕 */}
      <div
        className="absolute inset-0 rounded-full bg-sky-400/25 blur-2xl transition-transform duration-150"
        style={{ transform: `scale(${scale * 1.15})` }}
      />
      {/* 主体球 */}
      <div
        className={cn("relative size-44 rounded-full", speaking && "orb-speaking")}
        style={{
          background:
            "radial-gradient(circle at 35% 28%, #bae6fd 0%, #38bdf8 42%, #2563eb 78%, #1d4ed8 100%)",
          boxShadow:
            "0 0 70px rgba(56,189,248,.55), 0 0 140px rgba(56,189,248,.22), inset -18px -24px 48px rgba(29,78,216,.6)",
          transform: `scale(${scale})`,
          transition: "transform 110ms ease-out",
        }}
      >
        {/* 顶部受光高光 */}
        <div className="absolute left-1/2 top-[16%] size-16 -translate-x-1/2 rounded-full bg-white/30 blur-lg" />
      </div>
    </div>
  );
}

/** 云端 Realtime 通话场景：语音球居中，下方实时字幕（GPT-4o 风格）。 */
function RealtimeScene({
  phase,
  liveText,
  micLevel,
}: {
  phase: CallPhase;
  liveText: string;
  micLevel: number;
}) {
  const t = useT();
  const listening = phase === "listening";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6">
      <VoiceOrb level={micLevel} speaking={phase === "speaking"} />
      <div className="text-center">
        <p className="text-sm font-medium">
          {listening ? t("voicecall.talkToStart") : t(`voicecall.status.${phase}`)}
        </p>
        {liveText ? (
          <p className="mx-auto mt-2 max-w-md break-words text-sm leading-6 text-muted-foreground">
            {liveText}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">{t("voicecall.interruptHint")}</p>
        )}
      </div>
    </div>
  );
}

function PreflightRow({
  ok,
  label,
  detail,
  onClick,
}: {
  ok: boolean;
  label: string;
  detail: string;
  /** 未就绪时点击跳去配置。 */
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-md text-left transition-colors",
        onClick && ok ? "cursor-default" : "",
        onClick && !ok ? "hover:bg-muted" : "",
      )}
    >
      <span
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          ok ? "bg-emerald-500" : "bg-amber-500",
        )}
      />
      <div className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="ml-1.5 break-words text-muted-foreground">{detail}</span>
        {!ok && onClick && (
          <span className="mt-0.5 block text-[11px] font-medium text-primary">去配置 →</span>
        )}
      </div>
    </button>
  );
}

/** 通话模式二选一卡片（首次进入时主打展示）。 */
function ProviderCards({
  value,
  onChange,
}: {
  value: "local" | "cloud" | "";
  onChange: (v: "local" | "cloud") => void;
}) {
  const t = useT();
  const options = [
    {
      id: "local" as const,
      icon: CpuIcon,
      label: t("voicecall.providerLocal"),
      desc: t("voicecall.providerLocalDesc"),
    },
    {
      id: "cloud" as const,
      icon: CloudIcon,
      label: t("voicecall.providerCloud"),
      desc: t("voicecall.providerCloudDesc"),
    },
  ];
  return (
    <div className="grid w-full grid-cols-2 gap-3">
      {options.map((o) => {
        const Icon = o.icon;
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={cn(
              "flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors",
              active
                ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                : "border-border hover:bg-muted/50",
            )}
          >
            <div className="flex items-center gap-2">
              <Icon className={cn("size-4", active ? "text-primary" : "text-muted-foreground")} />
              <span className="text-sm font-medium">{o.label}</span>
              {active && <CheckIcon className="ml-auto size-4 text-primary" />}
            </div>
            <span className="text-[11px] leading-5 text-muted-foreground">{o.desc}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 云端模式配置引导：步骤化引导 + 保存并测试连接（未配置时全量展开，已就绪后收成一行）。 */
function CloudSetupGuide({ configured }: { configured: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["voicecall-provider-config"],
    queryFn: () => rpcClient.voicecallGetProviderConfig(undefined),
  });
  const cfg = data?.config;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [showForm, setShowForm] = useState(false);
  useEffect(() => {
    if (!cfg) return;
    setApiKey(cfg.apiKey);
    setBaseUrl(cfg.baseUrl);
    setModel(cfg.model);
    setVoice(cfg.voice);
    // 注意：不要在这里按 cfg 变更改 showForm —— 重查（如测试后 invalidate）时会
    // 把用户正在编辑的表单意外收起。是否展开只由用户操作决定。
  }, [cfg]);
  const saveMutation = useMutation({
    mutationFn: (c: { apiKey?: string; baseUrl?: string; model?: string; voice?: string }) =>
      rpcClient.voicecallSaveProviderConfig({ provider: "cloud", ...c }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["voicecall-provider-config"] });
      queryClient.invalidateQueries({ queryKey: ["voicecall-preflight"] });
    },
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string;
    latencyMs?: number;
  } | null>(null);

  const saveAndTest = async () => {
    setTestResult(null);
    try {
      await saveMutation.mutateAsync({ apiKey, baseUrl, model, voice });
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    setTesting(true);
    try {
      const res = await rpcClient.voicecallTestRealtime({ apiKey, baseUrl, model, voice });
      setTestResult(res);
      if (res.ok) setShowForm(false);
    } finally {
      setTesting(false);
    }
  };

  const saving = saveMutation.isPending;
  const busy = saving || testing;
  const editing = !configured || showForm;

  return (
    <div className="w-full space-y-2.5 rounded-xl border bg-card p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CloudIcon className="size-4 text-primary" />
          <span className="text-sm font-medium">{t("voicecall.cloudConfig")}</span>
        </div>
        <div className="flex items-center gap-2">
          {configured && !editing && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-600">
              <CheckIcon className="size-3.5" />
              {t("voicecall.cloudReady")}
            </span>
          )}
          {configured && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              onClick={() => setShowForm((v) => !v)}
            >
              {editing ? t("common.cancel") : t("voicecall.cloudEdit")}
            </Button>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-5 text-muted-foreground">
            <li>{t("voicecall.guideStep1")}</li>
            <li>{t("voicecall.guideStep2")}</li>
            <li>{t("voicecall.guideStep3")}</li>
          </ol>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t("voicecall.cloudApiKey")}</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-8 text-xs"
              placeholder="sk-…"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t("voicecall.cloudModel")}</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger size="sm" className="h-8 text-xs">
                  <SelectValue placeholder={t("voicecall.cloudModel")} />
                </SelectTrigger>
                <SelectContent position="popper" align="start" sideOffset={4}>
                  {REALTIME_MODEL_OPTIONS.map((m) => (
                    <SelectItem key={m} value={m}>
                      <span className="truncate">{m}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t("voicecall.cloudVoice")}</Label>
              <Input
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                className="h-8 text-xs"
                placeholder="longanqian"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t("voicecall.cloudBaseUrl")}</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="h-8 text-xs"
              placeholder="wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={busy}
              onClick={() => void saveAndTest()}
            >
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <ZapIcon className="size-3.5" />}
              {testing ? t("voicecall.cloudTesting") : t("voicecall.cloudSaveAndTest")}
            </Button>
            {testResult && (
              <span
                className={cn(
                  "min-w-0 flex-1 break-words text-[11px] leading-5",
                  testResult.ok ? "text-emerald-600" : "text-destructive",
                )}
              >
                {testResult.ok
                  ? `${t("voicecall.cloudTestOk")}（${testResult.latencyMs ?? "?"}ms）`
                  : `${t("voicecall.cloudTestFail")}：${testResult.error ?? ""}`}
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="text-[11px] leading-5 text-muted-foreground">
          {cfg && cfg.model ? `${cfg.model}（${t("voicecall.cloudVoice")} ${cfg.voice}）` : t("voicecall.cloudReady")}
        </p>
      )}
    </div>
  );
}

type Preflight = {
  model: { available: boolean; detail: string };
  asr: { available: boolean; detail: string };
  tts: { available: boolean; detail: string };
  provider: { mode: "local" | "cloud"; cloudConfigured: boolean; detail: string };
};

type ConfigureTarget = "model" | "asr" | "tts";

/** 未通话时的拨号面板：模式选择 + 就绪检测 + 音色 + 大拨号键。 */
function DialPanel({
  preflight,
  starting,
  error,
  onStart,
  onConfigure,
  provider,
  onProviderChange,
}: {
  preflight?: Preflight;
  starting: boolean;
  error: string | null;
  onStart: () => void;
  onConfigure: (target: ConfigureTarget) => void;
  provider: "local" | "cloud" | "";
  onProviderChange: (v: "local" | "cloud") => void;
}) {
  const t = useT();
  // 云端被选中但还没保存可用的 API Key：禁用拨号键，先引导完成配置。
  const cloudUnready = provider === "cloud" && preflight?.provider.cloudConfigured !== true;
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-5 px-6">
      <div className="flex size-20 items-center justify-center rounded-full bg-primary/10">
        <PhoneIcon className="size-9 text-primary" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold">{t("voicecall.title")}</h2>
        <p className="mt-1 text-sm leading-6 whitespace-pre-line text-muted-foreground">
          {t("voicecall.hint")}
        </p>
      </div>

      {/* 通话模式：首次进入用醒目二选一卡片；选定后变紧凑切换条。 */}
      {provider === "" ? (
        <div className="w-full space-y-2">
          <p className="text-center text-xs text-muted-foreground">{t("voicecall.providerFirstHint")}</p>
          <ProviderCards value={provider} onChange={onProviderChange} />
        </div>
      ) : (
        <div className="flex w-full items-center justify-center gap-2">
          <span className="text-xs text-muted-foreground">{t("voicecall.provider")}：</span>
          <div className="flex rounded-lg border bg-card p-0.5">
            {(["local", "cloud"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onProviderChange(m)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  provider === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {m === "local" ? t("voicecall.providerLocal") : t("voicecall.providerCloud")}
              </button>
            ))}
          </div>
        </div>
      )}

      {provider === "cloud" && <CloudSetupGuide configured={preflight?.provider.cloudConfigured === true} />}

      {preflight && (
        <div className="w-full space-y-1.5 rounded-xl border bg-card p-3 text-xs">
          <PreflightRow
            ok={provider === "cloud" ? preflight.provider.cloudConfigured : true}
            label={t("voicecall.pfProvider")}
            detail={preflight.provider.detail}
          />
          {/* 云端 Realtime 是端到端语音到语音，不依赖本地聊天模型 / ASR / TTS，只显示云端配置状态。 */}
          {provider !== "cloud" && (
            <>
              <PreflightRow
                ok={preflight.model.available}
                label={t("voicecall.pfModel")}
                detail={preflight.model.detail}
                onClick={() => onConfigure("model")}
              />
              <PreflightRow
                ok={preflight.asr.available}
                label={t("voicecall.pfAsr")}
                detail={preflight.asr.detail}
                onClick={() => onConfigure("asr")}
              />
              <PreflightRow
                ok={preflight.tts.available}
                label={t("voicecall.pfTts")}
                detail={preflight.tts.detail}
                onClick={() => onConfigure("tts")}
              />
            </>
          )}
        </div>
      )}
      {error && (
        <p className="flex w-full items-start gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
      <div className="flex flex-col items-center gap-2">
        <Button
          size="icon"
          disabled={starting || cloudUnready}
          onClick={onStart}
          className="flex size-16 items-center justify-center rounded-full"
          tooltip={cloudUnready ? t("voicecall.cloudNeedSetup") : t("voicecall.start")}
        >
          {starting ? <Loader2Icon className="size-6 animate-spin" /> : <PhoneIcon className="size-6" />}
        </Button>
        {cloudUnready ? (
          <span className="text-xs text-muted-foreground">{t("voicecall.cloudNeedSetup")}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{t("voicecall.tapToCall")}</span>
        )}
        {provider === "cloud" && cloudUnready && (
          <button
            type="button"
            onClick={() => onProviderChange("local")}
            className="text-[11px] font-medium text-primary hover:underline"
          >
            {t("voicecall.backToLocal")}
          </button>
        )}
      </div>
    </div>
  );
}

function CallMessageBubble({
  message,
  isStreamingMessage,
  masked,
}: {
  message: ChatMessage;
  isStreamingMessage: boolean;
  /** 思考/合成阶段先不把文字摆出来，开口说话时才显示。 */
  masked?: boolean;
}) {
  const t = useT();
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <BotIcon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 max-w-[85%] flex-1">
        <div className="rounded-2xl rounded-tl-md border bg-card px-4 py-2.5">
          {masked ? null : message.content ? (
            <Markdown content={message.content} />
          ) : isStreamingMessage ? (
            <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              {t("chat.generating")}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function VoiceCallWindow() {
  const t = useT();
  const queryClient = useQueryClient();
  const { start, hangup } = useVoiceCallEngine();

  const phase = useVoiceCallStore((s) => s.phase);
  const callConversationId = useVoiceCallStore((s) => s.callConversationId);
  const callProvider = useVoiceCallStore((s) => s.provider);
  const liveText = useVoiceCallStore((s) => s.liveText);
  const liveActive = useVoiceCallStore((s) => s.liveActive);
  const micLevel = useVoiceCallStore((s) => s.micLevel);
  const error = useVoiceCallStore((s) => s.error);

  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const activeMessages = useChatStore((s) => s.activeMessages);
  const streaming = useChatStore((s) => s.streaming);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);

  // 通话模式：设置里未存（""）→ 首次进入，展示二选一卡片。
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const providerSetting = (settingsQuery.data?.settings?.VOICE_CALL_PROVIDER ?? "") as
    | "local"
    | "cloud"
    | "";
  const provider = providerSetting === "cloud" ? "cloud" : "local";
  const providerMutation = useMutation({
    mutationFn: (v: "local" | "cloud") =>
      rpcClient.updateSettings({ settings: { VOICE_CALL_PROVIDER: v } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const inCall = callConversationId != null && phase !== "idle" && phase !== "error";
  const conversationId = callConversationId ?? activeConversationId;

  // 通话时长
  useEffect(() => {
    if (!inCall) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [inCall]);

  // 会话消息（当前通话 / 历史通话记录）
  const convQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => rpcClient.getConversation({ id: conversationId! }),
    enabled: conversationId != null,
  });

  useEffect(() => {
    useChatStore.getState().setStreaming(false);
    if (convQuery.data) {
      useChatStore.getState().setActiveMessages(convQuery.data.messages);
    }
  }, [conversationId, convQuery.data]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeMessages.length, activeMessages[activeMessages.length - 1]?.content]);

  const preflightQuery = useQuery({
    queryKey: ["voicecall-preflight"],
    queryFn: () => rpcClient.voicecallPreflight(),
  });

  // 未在通话且没有可展示的内容（新通话 / 全新会话）→ 拨号面板
  const showDial =
    !inCall && (activeConversationId == null || activeMessages.length === 0);

  const lastMessageId = activeMessages[activeMessages.length - 1]?.id;

  // 就绪检测缺项时跳去配置：模型 → 设置页；ASR/TTS → 语音页。
  const handleConfigure = (target: ConfigureTarget) => {
    const { setRoute } = useRouter.getState();
    if (target === "model") {
      setRoute({ path: "settings" });
      return;
    }
    useChatStore.getState().setActiveConversation(null);
    useChatStore.getState().setActiveMessages([]);
    useAppStore.getState().setActiveApp("voice");
    setRoute({ path: "index" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <header className="electrobun-webkit-app-region-drag shrink-0 border-b px-4 py-2.5">
        {inCall ? (
          <div className="flex items-center gap-2.5">
            <CallStatusChip phase={phase} elapsed={elapsed} />
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {callProvider === "cloud" ? t("voicecall.providerCloud") : t("voicecall.providerLocal")}
            </span>
          </div>
        ) : (
          <span className="text-sm font-medium">{t("voicecall.title")}</span>
        )}
      </header>

      {/* 消息区 / 拨号面板 */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        {/* 云端拨号中：先亮起语音球等待接通（GPT-4o 风格） */}
        {phase === "starting" && callProvider === "cloud" ? (
          <RealtimeScene phase={phase} liveText={liveText} micLevel={micLevel} />
        ) : showDial ? (
          <DialPanel
            preflight={preflightQuery.data}
            starting={phase === "starting"}
            error={phase === "error" ? error : null}
            onStart={() => void start(activeConversationId, provider)}
            onConfigure={handleConfigure}
            provider={providerSetting}
            onProviderChange={(v) => providerMutation.mutate(v)}
          />
        ) : inCall && callProvider === "cloud" ? (
          <RealtimeScene phase={phase} liveText={liveText} micLevel={micLevel} />
        ) : convQuery.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6"
          >
            {activeMessages.map((m) => {
              const isLastStreaming = streaming && m.id === lastMessageId;
              return (
                <CallMessageBubble
                  key={m.id}
                  message={m}
                  isStreamingMessage={isLastStreaming}
                  masked={isLastStreaming && phase === "thinking"}
                />
              );
            })}
            {inCall && activeMessages.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
                <SparklesIcon className="size-5" />
                <span>{t("voicecall.talkToStart")}</span>
                <span className="text-xs">{t("voicecall.interruptHint")}</span>
              </div>
            )}
          </div>
        )}
      </main>

      {/* 实时字幕：正在说的话，随 ASR 增量更新（云端模式由 RealtimeScene 展示） */}
      {inCall && callProvider !== "cloud" && liveActive && (
        <div className="shrink-0 border-t bg-muted/30 px-6 py-2.5">
          <div className="mx-auto flex max-w-3xl items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              {t("voicecall.live")}
            </span>
            <span className="min-w-0 flex-1 text-muted-foreground">
              {liveText || "…"}
              <span className="animate-pulse">▍</span>
            </span>
          </div>
        </div>
      )}

      {/* 底部控制条 */}
      <footer className="shrink-0 border-t bg-gradient-to-t from-muted/40 to-transparent p-4">
        <div className="mx-auto flex max-w-3xl items-center justify-center gap-4">
          {inCall ? (
            <>
              <div className="flex w-40 items-center justify-end gap-3">
                <span className="text-xs text-muted-foreground">{t(`voicecall.status.${phase}`)}</span>
                <MicLevelBar level={micLevel} />
              </div>
              <Button
                size="icon"
                variant="destructive"
                onClick={() => void hangup()}
                className="flex size-14 items-center justify-center rounded-full"
                tooltip={t("voicecall.hangup")}
              >
                <PhoneOffIcon className="size-5" />
              </Button>
              <div className="w-40" />
            </>
          ) : (
            activeConversationId != null &&
            activeMessages.length > 0 && (
              <Button
                size="lg"
                className="gap-2 rounded-full px-6"
                onClick={() => void start(activeConversationId, provider)}
              >
                <PhoneIcon className="size-4" />
                {t("voicecall.resume")}
              </Button>
            )
          )}
        </div>
      </footer>
    </div>
  );
}
