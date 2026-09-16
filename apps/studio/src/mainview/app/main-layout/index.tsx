import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon } from "lucide-react";
import { DocumentView } from "./document-view";

import { AppRail } from "./app-rail";
import { AppSidebar } from "./app-sidebar";
import { SidebarInset, SidebarProvider } from "@ui/sidebar";
import { rpcClient } from "@lib/rpc";
import { useRouter } from "@stores/router";
import { SettingsScreen } from "./settings";
import { ChatWindow } from "../chat";
import { AgentWindow } from "../agent";
import { VoiceCallWindow } from "../voice-call-screen";
import { VoiceScreen } from "../voice";
import { ImageScreen } from "../image";
import { VideoScreen } from "../video";
import { MusicScreen } from "../music";
import { OcrScreen } from "../ocr";
import { TranslateScreen } from "../translate";
import { PromptScreen } from "../prompt";
import { SkillsScreen } from "../skills";
import { MemoryScreen } from "../memory";
import { KbScreen } from "../kb";
import { BenchmarkScreen } from "../benchmark";
import { AppsScreen } from "../apps";
import { ModelDetailScreen } from "../model-detail";
import { DownloadsButton } from "@components/download-panel";
import { NotificationBell } from "../agent/notification-bell";
import { useViewStateReport } from "../../hooks/use-view-state-report";
import { MediaSetupDialog } from "@components/media-setup-dialog";
import { StatusPill } from "@components/status-pill";
import { ErrorBoundary } from "@components/error-boundary";
import { useAppStore, type AppId } from "@stores/app";
import { useUILang } from "@stores/ui-lang";
import { applyTheme } from "./prefs-tabs";

const renderActiveApp = (activeApp: AppId): ReactNode => {
  switch (activeApp) {
    case "agent":
      return <AgentWindow />;
    case "voicecall":
      return <VoiceCallWindow />;
    case "ocr":
      return <OcrScreen />;
    case "voice":
      return <VoiceScreen />;
    case "image":
      return <ImageScreen />;
    case "video":
      return <VideoScreen />;
    case "music":
      return <MusicScreen />;
    case "translate":
      return <TranslateScreen />;
    case "prompt":
      return <PromptScreen />;
    case "skills":
      return <SkillsScreen />;
    case "memory":
      return <MemoryScreen />;
    case "kb":
      return <KbScreen />;
    case "benchmark":
      return <BenchmarkScreen />;
    case "apps":
      return <AppsScreen />;
    default:
      return <ChatWindow />;
  }
};

const Outlet = () => {
  const route = useRouter((s) => s.route);
  const activeApp = useAppStore((s) => s.activeApp);

  let content: ReactNode;
  if (route.path === "model-detail") {
    content = <ModelDetailScreen />;
  } else if (route.path === "settings") {
    content = <SettingsScreen />;
  } else if (route.path === "document") {
    content = <DocumentView id={route.id} />;
  } else if (route.path === "chat" || route.path === "index") {
    content = renderActiveApp(activeApp);
  } else {
    content = renderActiveApp(activeApp);
  }

  // key by route so navigating to a different screen remounts the boundary
  // (clearing any previous render error instead of trapping the user on it).
  const detailId = "id" in route ? route.id : "";
  return <ErrorBoundary key={`${route.path}:${detailId}`}>{content}</ErrorBoundary>;
};

export function MainLayout() {
  const setLang = useUILang((s) => s.setLang);
  const route = useRouter((s) => s.route);
  const setRoute = useRouter((s) => s.setRoute);
  const activeApp = useAppStore((s) => s.activeApp);

  // 设置页是全新的一级页面，不显示左侧对话菜单；
  // Agent 页自带会话侧栏（置顶 / 归档 / 工作区分组），全局侧栏会重复列出同一批会话；
  // 应用中心是"小应用自己的入口"，侧栏里的会话列表在这里没有对应物。
  const showSidebar =
    route.path !== "settings" && activeApp !== "agent" && activeApp !== "apps";

  // 回报「用户在看什么」：主进程据此决定后台跑完的回合要不要发通知。
  useViewStateReport();

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  useEffect(() => {
    const lang = data?.settings?.UI_LANG;
    if (lang === "zh" || lang === "en") setLang(lang);
  }, [data, setLang]);

  // 主题：设置里的 UI_THEME 决定浅色 / 深色；system 跟随系统并监听变化。
  const theme = data?.settings?.UI_THEME;
  useEffect(() => {
    applyTheme(theme ?? "system");
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme ?? "system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  return (
    <SidebarProvider className="h-full h-svh! min-h-0!">
      <AppRail />
      {showSidebar && <AppSidebar />}
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="electrobun-webkit-app-region-drag flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
          {!showSidebar && (
            <button
              type="button"
              onClick={() => setRoute({ path: "chat" })}
              className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeftIcon className="size-4" />
              OmniStudio
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <StatusPill />
            <NotificationBell />
            <DownloadsButton />
          </div>
        </header>

        <Outlet />
      </SidebarInset>
      {/* Agent 生图前需要用户介入（配后端 / 装引擎 / 选模型）：挂在全局，任何页面都能弹。 */}
      <MediaSetupDialog />
    </SidebarProvider>
  );
}