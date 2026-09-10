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
import { ServerLogsScreen } from "./server-logs";
import { ServerStatsScreen } from "../server-stats";
import { ChatWindow } from "../chat-screen";
import { AgentWindow } from "../agent-screen";
import { VoiceCallWindow } from "../voice-call-screen";
import { VoiceScreen } from "../voice-screen";
import { ImageScreen } from "../image-screen";
import { OcrScreen } from "../ocr";
import { TranslateScreen } from "../translate-screen";
import { PromptScreen } from "../prompt-screen";
import { ModelsScreen } from "../models-screen";
import { ModelDetailScreen } from "../model-detail";
import { DownloadsButton } from "@components/download-panel";
import { StatusPill } from "@components/status-pill";
import { ErrorBoundary } from "@components/error-boundary";
import { useAppStore, type AppId } from "@stores/app";
import { useUILang } from "@stores/ui-lang";

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
    case "translate":
      return <TranslateScreen />;
    case "prompt":
      return <PromptScreen />;
    default:
      return <ChatWindow />;
  }
};

const Outlet = () => {
  const route = useRouter((s) => s.route);
  const activeApp = useAppStore((s) => s.activeApp);

  let content: ReactNode;
  if (route.path === "models") {
    content = <ModelsScreen />;
  } else if (route.path === "model-detail") {
    content = <ModelDetailScreen />;
  } else if (route.path === "settings") {
    content = <SettingsScreen />;
  } else if (route.path === "server") {
    content = <ServerLogsScreen />;
  } else if (route.path === "stats") {
    content = <ServerStatsScreen />;
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

  // 设置页是全新的一级页面，不显示左侧对话菜单。
  const showSidebar = route.path !== "settings";

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  useEffect(() => {
    const lang = data?.settings?.UI_LANG;
    if (lang === "zh" || lang === "en") setLang(lang);
  }, [data, setLang]);

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
            <DownloadsButton />
          </div>
        </header>

        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}