// Skills 页主入口：按侧边栏选中区渲染六个 Tab。
import { useSkillsStore } from "@stores/skills";
import { MarketTab } from "./market-tab";
import { MySkillsTab } from "./my-skills-tab";
import { PresetsTab } from "./presets-tab";
import { ProjectsTab } from "./projects-tab";
import { ToolsTab } from "./tools-tab";
import { BackupTab } from "./backup-tab";

export function SkillsScreen() {
  const section = useSkillsStore((s) => s.section);
  switch (section) {
    case "my":
      return <MySkillsTab />;
    case "presets":
      return <PresetsTab />;
    case "projects":
      return <ProjectsTab />;
    case "tools":
      return <ToolsTab />;
    case "backup":
      return <BackupTab />;
    default:
      return <MarketTab />;
  }
}
