import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon } from "lucide-react";
import { DocumentView } from "./document-view";

import { AppSidebar } from "./app-sidebar";
import { SidebarConsumer, SidebarInset, SidebarProvider, SidebarTrigger } from "@ui/sidebar";
import { rpcClient } from "@lib/rpc";
import { useRouter } from "@stores/router";
import { SettingsScreen } from "./settings";
import { ServerLogsScreen } from "./server-logs";
import { ServerStatsScreen } from "../server-stats";
import { ChatWindow } from "../chat-screen";
import { VoiceScreen } from "../voice-screen";
import { ImageScreen } from "../image-screen";
import { OcrScreen } from "../ocr-screen";
import { TranslateScreen } from "../translate-screen";
import { ModelsScreen } from "../models-screen";
import { ModelDetailScreen } from "../model-detail";
import { DownloadsButton } from "@components/download-panel";
import { StatusPill } from "@components/status-pill";
import { ErrorBoundary } from "@components/error-boundary";
import { useAppStore, type AppId } from "@stores/app";
import { useUILang } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

const renderActiveApp = (activeApp: AppId): ReactNode => {
  switch (activeApp) {
    case "ocr":
      return <OcrScreen />;
    case "voice":
      return <VoiceScreen />;
    case "image":
      return <ImageScreen />;
    case "translate":
      return <TranslateScreen />;
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
    <SidebarProvider className="h-svh! min-h-0!">
      {showSidebar && <AppSidebar />}
      <SidebarInset className="min-w-0 overflow-hidden">
        <SidebarConsumer>
          {(state) => (
            <header
              className={cn(
                "electrobun-webkit-app-region-drag flex shrink-0 items-center gap-2 px-4 pb-2 transition-[padding] will-change-[padding]",
                state === "collapsed" ? "pt-8" : "pt-4",
              )}
            >
              {showSidebar ? (
                <SidebarTrigger className="-ml-1" tooltip="Toggle sidebar" />
              ) : (
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
          )}
        </SidebarConsumer>

        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}