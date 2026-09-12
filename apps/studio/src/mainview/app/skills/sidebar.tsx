// Skills 侧边栏：六区导航（市场 / 我的技能 / 场景 / 项目 / 工具 / Git 备份）。
// 与 PromptSidebar 同构：在 AppSidebar 框架内只渲染 SidebarGroup（不嵌套 SidebarRoot）。
import { useQuery } from "@tanstack/react-query";
import {
  GitBranchIcon,
  LayersIcon,
  BlocksIcon,
  ShoppingBagIcon,
  WrenchIcon,
  FolderTreeIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@ui/sidebar";
import { useSkillsStore, type SkillsSection } from "@stores/skills";
import { useT } from "@stores/ui-lang";

const SECTIONS: { key: SkillsSection; labelKey: string; icon: React.ReactNode }[] = [
  { key: "market", labelKey: "skills.nav.market", icon: <PackageSearchIcon className="size-4" /> },
  { key: "my", labelKey: "skills.nav.my", icon: <BlocksIcon className="size-4" /> },
  { key: "presets", labelKey: "skills.nav.presets", icon: <LayersIcon className="size-4" /> },
  { key: "projects", labelKey: "skills.nav.projects", icon: <FolderTreeIcon className="size-4" /> },
  { key: "tools", labelKey: "skills.nav.tools", icon: <WrenchIcon className="size-4" /> },
  { key: "backup", labelKey: "skills.nav.backup", icon: <GitBranchIcon className="size-4" /> },
];

export function SkillsSidebar() {
  const t = useT();
  const section = useSkillsStore((s) => s.section);
  const setSection = useSkillsStore((s) => s.setSection);

  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => rpcClient.skillsList(undefined),
  });
  const { data: toolsData } = useQuery({
    queryKey: ["skills-tools"],
    queryFn: () => rpcClient.skillsGetTools(undefined),
  });

  const skillCount = skillsData?.skills.length ?? 0;
  const enabledTools = (toolsData?.tools ?? []).filter((x) => x.enabled && x.installed).length;

  return (
    <SidebarGroup className="min-h-0 flex-1">
      {/* 中央库概览（极简一行，路径在 tooltip） */}
      <SidebarMenu className="mb-1 px-2">
        <span
          className="block truncate text-[11px] text-muted-foreground"
          title={t("skills.centralPath")}
        >
          {skillCount} {t("skills.unit.skills")} · {enabledTools} {t("skills.unit.tools")}
        </span>
      </SidebarMenu>

      <SidebarGroupContent>
        <SidebarMenu>
          {SECTIONS.map((item) => (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton
                isActive={section === item.key}
                tooltip={t(item.labelKey)}
                onClick={() => setSection(item.key)}
              >
                {item.icon}
                <span>{t(item.labelKey)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
