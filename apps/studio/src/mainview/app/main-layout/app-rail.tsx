import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MessageCircleDashedIcon,
  SquareTerminalIcon,
  PhoneIcon,
  AudioWaveformIcon,
  ShapesIcon,
  ClapperboardIcon,
  MusicIcon,
  ScanSearchIcon,
  EarthIcon,
  WandSparklesIcon,
  BlocksIcon,
  LibraryIcon,
  BrainIcon,
  GaugeIcon,
  LayoutGridIcon,
  SlidersHorizontalIcon,
  WaypointsIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/tooltip";
import { useRouter } from "@stores/router";
import { useAppStore, type AppId } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { APP_RAIL_LAYOUT_KEY, resolveRailLayout, visibleRailEntries } from "@/shared/app-rail";

// 抽象几何风格图标，区别于参考原型（气泡/麦克风/风景画）的具象图标。
// 导出给设置 → 外观 的菜单配置卡复用 —— 配置里看到的图标必须就是菜单里那个。
export const APP_ICONS: Record<AppId, ReactNode> = {
  chat: <MessageCircleDashedIcon className="size-5" />,
  agent: <SquareTerminalIcon className="size-5" />,
  // JEV：滑杆 == "在档位/选项上做判定"，与 Agent 的终端方块、其它具象图标区分开
  jev: <SlidersHorizontalIcon className="size-5" />,
  voicecall: <PhoneIcon className="size-5" />,
  voice: <AudioWaveformIcon className="size-5" />,
  image: <ShapesIcon className="size-5" />,
  video: <ClapperboardIcon className="size-5" />,
  music: <MusicIcon className="size-5" />,
  ocr: <ScanSearchIcon className="size-5" />,
  translate: <EarthIcon className="size-5" />,
  prompt: <WandSparklesIcon className="size-5" />,
  skills: <BlocksIcon className="size-5" />,
  kb: <LibraryIcon className="size-5" />,
  memory: <BrainIcon className="size-5" />,
  benchmark: <GaugeIcon className="size-5" />,
  // 小应用中心：九宫格 == "一堆小格子点进去"，与其它具象图标区分开
  apps: <LayoutGridIcon className="size-5" />,
  // 无限画布：节点 + 连线的路标形 == "素材在节点间流动的生成画布"
  canvas: <WaypointsIcon className="size-5" />,
};

function RailButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={cn(
            "flex size-10 items-center justify-center rounded-xl transition-colors",
            active
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function AppRail() {
  const t = useT();
  const route = useRouter((s) => s.route);
  const setRoute = useRouter((s) => s.setRoute);
  const activeApp = useAppStore((s) => s.activeApp);
  const setActiveApp = useAppStore((s) => s.setActiveApp);

  // 顺序与显示 / 隐藏由「设置 → 外观 → 左侧一级菜单」决定（`APP_RAIL_LAYOUT`）。
  // 设置页改完 invalidate 这个 query，菜单立刻跟着变，不需要重启。
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const items = visibleRailEntries(resolveRailLayout(data?.settings?.[APP_RAIL_LAYOUT_KEY]));

  const onMainRoute = route.path === "index" || route.path === "chat";
  const inSettings = route.path === "settings";

  const handleSelect = (app: AppId) => {
    // 左侧面板永远展开，点击已激活的图标不做任何操作
    if (onMainRoute && activeApp === app) return;
    setActiveApp(app);
    useChatStore.getState().setActiveConversation(null);
    useChatStore.getState().setActiveMessages([]);
    useChatStore.getState().setStreaming(false);
    useAgentStore.getState().clear();
    setRoute({ path: "index" });
  };

  return (
    <TooltipProvider delayDuration={300}>
      <nav
        aria-label="App rail"
        className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-r bg-muted/40 pb-3"
      >
        <div className="electrobun-webkit-app-region-drag h-10 w-full shrink-0" />
        {items.map(({ id: app }) => (
          <RailButton
            key={app}
            active={onMainRoute && activeApp === app}
            label={t(`apps.${app}`)}
            onClick={() => handleSelect(app)}
          >
            {APP_ICONS[app]}
          </RailButton>
        ))}
        <div className="mt-auto">
          <RailButton
            active={inSettings}
            label={t("nav.settings")}
            onClick={() => setRoute({ path: "settings" })}
          >
            <SlidersHorizontalIcon className="size-5" />
          </RailButton>
        </div>
      </nav>
    </TooltipProvider>
  );
}
