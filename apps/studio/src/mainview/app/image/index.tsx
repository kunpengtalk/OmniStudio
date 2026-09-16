// 图像工作台：按侧栏选中的工具（生成 / 编辑 / 批量）分发到对应标签页，
// 「更多」进入全部历史页。共用件在 parts.tsx。
import { LayersIcon } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { useImageStore } from "@stores/image";
import { HistoryScreen } from "./history";
import { GenerateTab } from "./generate-tab";
import { EditTab } from "./edit-tab";

export function ImageScreen() {
  const t = useT();
  const tool = useImageStore((s) => s.tool);
  const view = useImageStore((s) => s.view);

  // 「更多」进入的全部历史页（含所有图片与提示词）。
  if (view === "history") return <HistoryScreen />;

  if (tool === "batch") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
          <LayersIcon className="size-9 text-primary" />
        </div>
        <p className="text-sm text-muted-foreground">{t("image.comingSoon")}</p>
      </div>
    );
  }

  if (tool === "edit") return <EditTab />;

  return <GenerateTab />;
}
