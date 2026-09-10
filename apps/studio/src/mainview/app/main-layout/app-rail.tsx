import type { ReactNode } from "react";
import {
  MessageCircleDashedIcon,
  AudioWaveformIcon,
  ShapesIcon,
  ScanSearchIcon,
  EarthIcon,
  WandSparklesIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/tooltip";
import { useRouter } from "@stores/router";
import { useAppStore, type AppId } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

const APP_IDS: AppId[] = ["chat", "voice", "image", "ocr", "translate", "prompt"];

// 抽象几何风格图标，区别于参考原型（气泡/麦克风/风景画）的具象图标
const APP_ICONS: Record<AppId, ReactNode> = {
  chat: <MessageCircleDashedIcon className="size-5" />,
  voice: <AudioWaveformIcon className="size-5" />,
  image: <ShapesIcon className="size-5" />,
  ocr: <ScanSearchIcon className="size-5" />,
  translate: <EarthIcon className="size-5" />,
  prompt: <WandSparklesIcon className="size-5" />,
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

  const onMainRoute = route.path === "index" || route.path === "chat";
  const inSettings = route.path === "settings";

  const handleSelect = (app: AppId) => {
    // 左侧面板永远展开，点击已激活的图标不做任何操作
    if (onMainRoute && activeApp === app) return;
    setActiveApp(app);
    useChatStore.getState().setActiveConversation(null);
    useChatStore.getState().setActiveMessages([]);
    useChatStore.getState().setStreaming(false);
    setRoute({ path: "index" });
  };

  return (
    <TooltipProvider delayDuration={300}>
      <nav
        aria-label="App rail"
        className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-r bg-muted/40 pb-3"
      >
        <div className="electrobun-webkit-app-region-drag h-10 w-full shrink-0" />
        {APP_IDS.map((app) => (
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
