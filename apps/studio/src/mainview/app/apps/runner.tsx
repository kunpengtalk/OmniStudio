/**
 * 小应用运行容器：沙箱 iframe + 宿主工具条。
 *
 * 小应用页面本身不参与主前端构建，宿主与它之间只有 postMessage 一条通道：
 *   - 注入 `lib/miniapp-bridge.ts` 的运行时（`window.omni`），页面加载完推一次
 *     `ready`（语言 + 能力快照），之后能力变化再推 `capabilities`；
 *   - 收到的每条请求都过 `dispatchMiniAppRequest`：动作白名单 + 参数夹取，
 *     认不出来的动作直接拒绝（见那个文件顶部的说明）。
 *
 * 沙箱故意**不给** `allow-same-origin`：小应用拿不到宿主的 origin，也就读不到
 * localStorage / store / 任何宿主 DOM。它要存东西得走 `omni.files.save`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLinesIcon,
  ChevronLeftIcon,
  FolderOpenIcon,
  Grid3x3Icon,
  IdCardIcon,
  NotebookPenIcon,
  PenLineIcon,
  RotateCwIcon,
  ScissorsIcon,
  SparklesIcon,
  UserRoundIcon,
} from "lucide-react";

import { Button } from "@ui/button";
import { useT, useUILang } from "@stores/ui-lang";
import { useRouter } from "@stores/router";
import { rpcClient } from "@lib/rpc";
import { dispatchMiniAppRequest, injectMiniAppRuntime } from "@lib/miniapp-bridge";
import { cancelHostRecording, startHostRecording, stopHostRecording } from "@lib/mic-record";
import { cn } from "@/mainview/lib/utils";
import {
  MINIAPP_CAPABILITY_LABEL_KEY,
  MINIAPP_CHANNEL,
  isMiniAppChannelMessage,
  type MiniAppCapability,
  type MiniAppCapabilitySnapshot,
  type MiniAppIcon,
  type MiniAppSpec,
} from "../../../shared/miniapps";
import { MINIAPP_HTML } from "./pages";
import { missingCapabilities } from "./center";
import { accentClass } from "./accents";

const ICONS: Record<MiniAppIcon, React.ReactNode> = {
  scissors: <ScissorsIcon className="size-4" />,
  idCard: <IdCardIcon className="size-4" />,
  userRound: <UserRoundIcon className="size-4" />,
  audioLines: <AudioLinesIcon className="size-4" />,
  penLine: <PenLineIcon className="size-4" />,
  grid: <Grid3x3Icon className="size-4" />,
  notebook: <NotebookPenIcon className="size-4" />,
};

/** 能力缺口的文案：`图像修图（未配置）`。 */
function capabilityGapText(
  t: (key: string, params?: Record<string, string>) => string,
  caps: MiniAppCapability[],
): string {
  return caps
    .map((cap) => t("miniapps.cap.missing", { name: t(MINIAPP_CAPABILITY_LABEL_KEY[cap]) }))
    .join("、");
}

/** 缺哪个能力就去设置页的哪一栏（都是"模型云服务"，与 CloudModelSelect 的跳转一致）。 */
const CAPABILITY_SETTINGS_TAB: Record<MiniAppCapability, string> = {
  image: "network",
  imageEdit: "network",
  chat: "network",
  asr: "network",
  // 本地抠图的权重在小应用里就能下，本来不该走到"去设置"这一步；真要走也送它去
  // 模型云服务页（那里能配云端修图当替代路径）。类型要求每个 key 都在，别删。
  bgRemove: "network",
  // 纯本机能力（马赛克）永远就绪，不会出现在 missing 里；留着 key 只为满足类型。
  local: "network",
};

export function MiniAppRunner({
  app,
  caps,
  theme,
  capsRefreshing,
  onExit,
  onRefreshCaps,
}: {
  app: MiniAppSpec;
  caps: MiniAppCapabilitySnapshot | undefined;
  theme: "light" | "dark";
  capsRefreshing: boolean;
  onExit: () => void;
  onRefreshCaps: () => void;
}) {
  const t = useT();
  const lang = useUILang((s) => s.lang);
  const setRoute = useRouter((s) => s.setRoute);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saved, setSaved] = useState<{ name: string; path: string } | null>(null);

  const html = MINIAPP_HTML[app.id] ?? "";
  const missing = missingCapabilities(app, caps);

  // 能力快照走 ref：postMessage 的处理器只挂一次，不能每次能力变化都重挂
  // （重挂的空档里小应用发来的请求会石沉大海）。
  const capsRef = useRef(caps);
  capsRef.current = caps;
  const langRef = useRef(lang);
  langRef.current = lang;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const srcDoc = useMemo(
    () =>
      html
        ? injectMiniAppRuntime(html, {
            appId: app.id,
            lang,
            theme,
            capabilities: caps ?? ({} as MiniAppCapabilitySnapshot),
          })
        : "",
    // caps 与 theme 只影响首屏初值：改了它们重建 srcdoc 等于把小应用重开一次
    // （用户刚填的表单会没），两者之后都由下面的 capabilities 事件增量更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, app.id, lang],
  );

  const post = useCallback((payload: unknown) => {
    frameRef.current?.contentWindow?.postMessage(payload, "*");
  }, []);

  const sendCapabilities = useCallback(
    (capsPayload: MiniAppCapabilitySnapshot | undefined) => {
      if (!capsPayload) return;
      post({
        channel: MINIAPP_CHANNEL,
        kind: "event",
        event: "capabilities",
        payload: {
          appId: app.id,
          lang: langRef.current,
          theme: themeRef.current,
          capabilities: capsPayload,
        },
      });
    },
    [app.id, post],
  );

  // 用户可能在设置里刚配好模型又切回来，或切了深浅色：都靠这一条事件增量推给小应用
  // （重载整个页面会把它填到一半的内容清掉）。
  useEffect(() => {
    sendCapabilities(caps);
  }, [caps, theme, sendCapabilities]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // 只认这个 iframe 自己发来的消息：同一页面里还有别的 iframe（产出物预览等），
      // 不校验来源就等于任何人都能借这台"宿主"调 RPC。
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!isMiniAppChannelMessage(event.data)) return;
      const data = event.data;
      if (data.kind !== "request") return;
      void dispatchMiniAppRequest(data, {
        appId: app.id,
        call: <T,>(method: string, params?: unknown) =>
          (rpcClient as unknown as Record<string, (p?: unknown) => Promise<T>>)[method]!(params),
        lang: () => langRef.current,
        theme: () => themeRef.current,
        capabilities: async () => {
          const result = await rpcClient.getMiniAppCapabilities(undefined);
          return result.capabilities;
        },
        openSettings: (tab) => setRoute({ path: "settings", tab: tab ?? "network" }),
        onSaved: (info) => setSaved(info),
        // 录音只有宿主能做到（iframe 是不透明源，navigator.mediaDevices 不存在）：
        // 小应用只说 start / stop，音频在宿主采集完再交回去。
        record: (op) => {
          if (op === "start") return startHostRecording();
          if (op === "cancel") {
            cancelHostRecording();
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve(stopHostRecording());
        },
      }).then((response) => post(response));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app.id, post, setRoute]);

  // 离开容器 / 重新加载小应用时收掉麦克风：小应用里没有"录音还在继续"的可见状态，
  // 让它开着就是一支看不见的热麦。
  useEffect(() => () => cancelHostRecording(), [app.id, reloadKey]);

  const onFrameLoad = useCallback(() => {
    // 等页面里的运行时挂好 `omni` 再推 ready：iframe 的 onLoad 早于页面内脚本执行，
    // 抢跑的话首个 ready 会丢，小应用的 `omni.ready` 永远不 resolve。
    const payload = {
      appId: app.id,
      lang: langRef.current,
      theme: themeRef.current,
      capabilities: capsRef.current ?? ({} as MiniAppCapabilitySnapshot),
    };
    setTimeout(() => post({ channel: MINIAPP_CHANNEL, kind: "event", event: "ready", payload }), 0);
  }, [app.id, post]);

  const openSettings = () => setRoute({ path: "settings", tab: CAPABILITY_SETTINGS_TAB[missing[0]!] });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="sm" className="gap-1 px-2" onClick={onExit}>
          <ChevronLeftIcon className="size-4" />
          {t("miniapps.title")}
        </Button>
        <span className="h-4 w-px bg-border" />
        <span className={cn("flex size-6 items-center justify-center rounded-lg", accentClass(app.accent))}>
          {ICONS[app.icon]}
        </span>
        <span className="truncate text-sm font-semibold">{t(app.nameKey)}</span>

        <div className="ml-auto flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1.5 rounded-full border bg-muted/60 py-1 pr-1 pl-2.5 text-[11px]">
              <span className="max-w-[22ch] truncate" title={saved.path}>
                {t("miniapps.saved", { path: saved.path.split("/").pop() ?? saved.path })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[11px]"
                onClick={() => void rpcClient.showInExplorer({ filePath: saved.path })}
              >
                <FolderOpenIcon className="size-3" />
                {t("miniapps.reveal")}
              </Button>
            </span>
          )}
          {missing.length > 0 && (
            <button
              type="button"
              onClick={openSettings}
              className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
            >
              {t("miniapps.needSetup")}
            </button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 px-2 text-xs"
            disabled={capsRefreshing}
            onClick={onRefreshCaps}
            title={t("miniapps.recheck")}
          >
            <SparklesIcon className={cn("size-3.5", capsRefreshing && "animate-pulse")} />
            {t("miniapps.recheck")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 px-2 text-xs"
            onClick={() => {
              setSaved(null);
              setReloadKey((n) => n + 1);
            }}
            title={t("miniapps.reload")}
          >
            <RotateCwIcon className="size-3.5" />
            {t("miniapps.reload")}
          </Button>
        </div>
      </div>

      {missing.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-300">
          <span>
            {t("miniapps.gate.desc", {
              name: t(app.nameKey),
              caps: capabilityGapText(t, missing),
            })}
          </span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={openSettings}>
            {t("miniapps.toSettings")}
          </Button>
        </div>
      )}

      {html ? (
        <iframe
          key={reloadKey}
          ref={frameRef}
          title={t(app.nameKey)}
          srcDoc={srcDoc}
          onLoad={onFrameLoad}
          // 不给 allow-same-origin：小应用与宿主必须跨源，否则它能直接摸到宿主的 DOM 与存储。
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("miniapps.missingPage", { id: app.id })}
        </div>
      )}
    </div>
  );
}

