/**
 * 网页端外壳：只跑**对话**与 **Agent** 两个窗口，其余一律不加载。
 *
 * 这两个窗口就是桌面端的那两个组件（`app/chat`、`app/agent`），连侧栏、消息气泡、
 * 时间轴、授权卡片都是同一份实现 —— 所以外观与行为跟应用里完全一致，不存在"抄一遍
 * 然后慢慢跑偏"。这里只补两件桌面端由原生外壳负责的事：
 *   1. 顶部一条细栏：两个入口（/chat、/agent）与当前状态；
 *   2. API Key 闸门：浏览器里没有桌面端的本机信任，必须先证明自己是网关的所有者/被授权人。
 */
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BotIcon, KeyRoundIcon, MessageSquareIcon } from "lucide-react";

import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { SidebarInset, SidebarProvider } from "@ui/sidebar";
import { rpcClient } from "@lib/rpc";
import { useAppStore } from "@stores/app";
import { useUILang, useT } from "@stores/ui-lang";
import { setMediaBaseOverride } from "@/shared/server-info";
import { AppSidebar } from "./app/main-layout/app-sidebar";
import { applyTheme } from "./app/main-layout/prefs-tabs";
import { ChatWindow } from "./app/chat";
import { AgentWindow } from "./app/agent";
import { getApiKey, isRemoteClient, setApiKey, UNAUTHORIZED_EVENT } from "./lib/remote";
import { cn } from "./lib/utils";

// 媒体（聊天图片、产出物预览、语音）在浏览器里必须走网关的 /media 代理：
// 宿主回环端口对浏览器没有意义。
if (isRemoteClient()) {
  setMediaBaseOverride(`${window.location.origin}/media`);
}

export type RemoteApp = "chat" | "agent";

export function remoteAppFromPath(pathname: string): RemoteApp {
  return pathname.startsWith("/agent") ? "agent" : "chat";
}

export function RemoteShell() {
  const t = useT();
  const app = remoteAppFromPath(window.location.pathname);
  /**
   * 两个状态必须分开：`saved` 决定"进不进主界面"，`draft` 只是输入框里的暂存值。
   *
   * 曾经共用一个 state，后果是往输入框**粘第一个字符**就等于"已登录"：闸门当场卸载、
   * 主界面挂起来（此时 localStorage 里还没有 Key），于是所有请求 401 → 触发下面的
   * "密钥失效"分支把输入清空 —— 用户看到的就是"粘贴没反应 / 粘了就报错"。
   */
  const [saved, setSaved] = useState(getApiKey());
  const [draft, setDraft] = useState("");
  const [rejected, setRejected] = useState(false);
  const setLang = useUILang((s) => s.setLang);

  // 语言与主题跟随设置，和 MainLayout 一致 —— 否则网页端的观感会跟应用里不一样。
  // 必须等 Key 就位再发：闸门阶段还没密钥，提前发只会拿到 401，而 react-query 会把
  // 失败结果缓存住（填完 Key 也不会自动重来），界面的语言与主题就一直不生效。
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
    enabled: Boolean(saved),
  });
  useEffect(() => {
    const lang = data?.settings?.UI_LANG;
    if (lang === "zh" || lang === "en") setLang(lang);
  }, [data, setLang]);
  useEffect(() => {
    const theme = data?.settings?.UI_THEME;
    applyTheme(theme ?? "system");
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme ?? "system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [data]);

  // 主进程说"没授权"（401）：清掉本地 Key，退回闸门，别让界面停在"点了没反应"。
  useEffect(() => {
    const onUnauthorized = () => {
      setApiKey("");
      setSaved("");
      setDraft("");
      setRejected(true);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  useEffect(() => {
    useAppStore.getState().setActiveApp(app);
  }, [app]);

  /** 落地：写进 localStorage 再挂主界面 —— 顺序不能反，主界面一挂就会带着它发请求。 */
  const submit = useCallback(() => {
    const value = draft.trim();
    if (!value) return;
    setApiKey(value);
    setSaved(value);
    setRejected(false);
  }, [draft]);

  if (!saved) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm rounded-xl border bg-card p-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <KeyRoundIcon className="size-4" />
            {t("remote.keyTitle")}
          </div>
          <p className="mb-3 text-xs text-muted-foreground">{t("remote.keyHint")}</p>
          <Input
            autoFocus
            type="password"
            value={draft}
            spellCheck={false}
            placeholder={t("remote.keyPlaceholder")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            className="mb-3 h-8 font-mono text-xs"
          />
          {rejected && <p className="mb-2 text-[11px] text-destructive">{t("remote.keyRejected")}</p>}
          <Button size="sm" className="h-8 w-full text-xs" disabled={!draft.trim()} onClick={submit}>
            {t("remote.enter")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    // 结构与 MainLayout **逐层对齐**：SidebarProvider 里放侧栏 + SidebarInset，
    // 顶栏作为 inset 里的 header。别用自制的 flex 容器 —— 对话窗口的 flex 链条
    // （ChatWindow 的 flex-1 / 消息区滚动 / 输入框贴底）依赖 SidebarInset 是
    // flex 列容器，换成普通 div 就会"消息浮在顶部、输入框悬在中间"。
    <SidebarProvider className="h-full h-svh! min-h-0!">
      {app === "chat" && <AppSidebar />}
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
          <span className="px-1.5 text-xs font-semibold tracking-tight">OmniStudio</span>
          <RemoteTab href="/chat" active={app === "chat"} icon={<MessageSquareIcon className="size-3.5" />}>
            {t("apps.chat")}
          </RemoteTab>
          <RemoteTab href="/agent" active={app === "agent"} icon={<BotIcon className="size-3.5" />}>
            {t("apps.agent")}
          </RemoteTab>
          <span className="flex-1" />
          {/* 换密钥的出口：没有它就只能去清浏览器存储，等于把人锁在外面。 */}
          <button
            type="button"
            title={t("remote.changeKey")}
            aria-label={t("remote.changeKey")}
            className="rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent"
            onClick={() => {
              setApiKey("");
              setSaved("");
              setDraft("");
              setRejected(false);
            }}
          >
            <KeyRoundIcon className="size-3.5" />
          </button>
        </header>
        {/* Agent 窗口自带会话侧栏（与桌面端同一个组件），所以它不需要 AppSidebar。 */}
        {app === "agent" ? <AgentWindow /> : <ChatWindow />}
      </SidebarInset>
    </SidebarProvider>
  );
}

function RemoteTab({
  href,
  active,
  icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
      )}
    >
      {icon}
      {children}
    </a>
  );
}
