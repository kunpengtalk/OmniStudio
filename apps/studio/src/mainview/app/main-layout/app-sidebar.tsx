import { SettingsIcon } from "lucide-react";

import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@ui/sidebar";
import { useRouter } from "@stores/router";
import { useAppStore } from "@stores/app";
import { useT } from "@stores/ui-lang";
import { isRemoteClient } from "@lib/remote";
import { OcrRecordList } from "../ocr/record-list";
import { VoiceRecordList } from "../voice/record-list";
import { ImageRecordList } from "../image/record-list";
import { VideoRecordList } from "../video/record-list";
import { MusicRecordList } from "../music/record-list";
import { TranslateRecordList } from "../translate/record-list";
import { PromptSidebar } from "../prompt/sidebar";
import { BenchmarkRecordList } from "../benchmark/record-list";
import { ConversationRecordList } from "../chat/record-list";
import { SkillsSidebar } from "../skills/sidebar";
import { MemorySidebar } from "../memory/sidebar";
import { KbSidebar } from "../kb/sidebar";

export function AppSidebar() {
  const t = useT();
  const { activeApp } = useAppStore();
  const { setRoute } = useRouter();

  return (
    <SidebarRoot collapsible="none" side="left" className="border-r">
      <div className="electrobun-webkit-app-region-drag h-8 w-full shrink-0" />

      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem className="px-2" onClick={() => setRoute({ path: "index" })}>
            <span className="font-semibold tracking-tight">{t("chat.aimStudio")}</span>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {activeApp === "ocr" ? (
          <OcrRecordList />
        ) : activeApp === "voice" ? (
          <VoiceRecordList />
        ) : activeApp === "image" ? (
          <ImageRecordList />
        ) : activeApp === "video" ? (
          <VideoRecordList />
        ) : activeApp === "music" ? (
          <MusicRecordList />
        ) : activeApp === "translate" ? (
          <TranslateRecordList />
        ) : activeApp === "prompt" ? (
          <PromptSidebar />
        ) : activeApp === "skills" ? (
          <SkillsSidebar />
        ) : activeApp === "kb" ? (
          <KbSidebar />
        ) : activeApp === "memory" ? (
          <MemorySidebar />
        ) : activeApp === "benchmark" ? (
          <BenchmarkRecordList />
        ) : (
          <ConversationRecordList app={activeApp} />
        )}
      </SidebarContent>

      <SidebarFooter>
        {/* 网页端只有对话 / Agent 两个页面，没有设置页可去 —— 入口一并收起来。 */}
        {!isRemoteClient() && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={t("nav.settings")}
                onClick={() => setRoute({ path: "settings" })}
              >
                <SettingsIcon className="size-4" />
                <span>{t("nav.settings")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarFooter>
    </SidebarRoot>
  );
}
