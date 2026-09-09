import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { OcrScreen } from "../ocr-screen";
import { ModelsScreen } from "../models-screen";
import { ModelDetailScreen } from "../model-detail";
import { DownloadsButton } from "@components/download-panel";
import { useAppStore } from "@stores/app";
import { useUILang } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

const Outlet = () => {
  const route = useRouter((s) => s.route);
  const activeApp = useAppStore((s) => s.activeApp);

  if (route.path === "models") {
    return <ModelsScreen />;
  }

  if (route.path === "model-detail") {
    return <ModelDetailScreen />;
  }

  if (route.path === "settings") {
    return <SettingsScreen />;
  }

  if (route.path === "server") {
    return <ServerLogsScreen />;
  }

  if (route.path === "stats") {
    return <ServerStatsScreen />;
  }

  if (route.path === "document") {
    return <DocumentView id={route.id} />;
  }

  if (route.path === "chat") {
    return (
      activeApp === "ocr" ? <OcrScreen /> :
      activeApp === "voice" ? <VoiceScreen /> :
      <ChatWindow />
    );
  }

  // index / default home
  if (activeApp === "ocr") {
    return <OcrScreen />;
  }

  if (activeApp === "voice") {
    return <VoiceScreen />;
  }

  return <ChatWindow />;
};

export function MainLayout() {
  const setLang = useUILang((s) => s.setLang);

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
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-hidden">
        <SidebarConsumer>
          {(state) => (
            <header
              className={cn(
                "electrobun-webkit-app-region-drag flex shrink-0 items-center gap-2 px-4 pb-2 transition-[padding] will-change-[padding]",
                state === "collapsed" ? "pt-8" : "pt-4",
              )}
            >
              <SidebarTrigger className="-ml-1" tooltip="Toggle sidebar" />
              <div className="ml-auto">
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