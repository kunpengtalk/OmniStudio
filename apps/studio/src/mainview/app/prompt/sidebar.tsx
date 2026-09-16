import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookmarkIcon,
  BotIcon,
  FilmIcon,
  ImageIcon,
  LayoutListIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import type { PromptKind } from "@/bun/prompt-library";
import { Badge } from "@ui/badge";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@ui/sidebar";
import { usePromptStore } from "@stores/prompt";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

const PROMPT_KIND_TABS: {
  kind: PromptKind;
  icon: ReactNode;
  labelKey: string;
}[] = [
  { kind: "image", icon: <ImageIcon className="size-4" />, labelKey: "prompt.kind.image" },
  { kind: "llm", icon: <BotIcon className="size-4" />, labelKey: "prompt.kind.llm" },
  { kind: "video", icon: <FilmIcon className="size-4" />, labelKey: "prompt.kind.video" },
];

/**
 * 提示词库侧边栏：左侧最窄列（AppRail）之外的「菜单」列。
 * 顶部在「提示词广场 / 我的提示词」之间切换，下面在生图 / 大模型 / 视频三类之间
 * 切换，并列出当前大区的分类导航（广场用内置分类，我的用自定义分类）。
 */
export function PromptSidebar() {
  const t = useT();
  const { tab, setTab, kind, setKind, category, setCategory, openCreate } = usePromptStore();

  const { data: stats } = useQuery({
    queryKey: ["prompt-stats"],
    queryFn: () => rpcClient.getPromptLibraryStats(),
    enabled: tab === "plaza",
  });
  const { data: myStats } = useQuery({
    queryKey: ["my-prompt-stats"],
    queryFn: () => rpcClient.getMyPromptStats(),
    enabled: tab === "mine",
  });
  const { data: catsData, isLoading: plazaCatsLoading } = useQuery({
    queryKey: ["prompt-categories", kind],
    queryFn: () => rpcClient.listPromptCategories({ kind }),
    enabled: tab === "plaza",
  });
  const { data: myCatsData, isLoading: myCatsLoading } = useQuery({
    queryKey: ["my-prompt-categories"],
    queryFn: () => rpcClient.listMyPromptCategories(),
    enabled: tab === "mine",
  });

  const categories = tab === "plaza" ? catsData?.categories ?? [] : myCatsData?.categories ?? [];
  const isLoadingCats = tab === "plaza" ? plazaCatsLoading : myCatsLoading;
  const counts = tab === "plaza" ? stats?.counts : myStats?.counts;

  return (
    <SidebarGroup className="min-h-0 flex-1">
      {/* 广场 / 我的 切换 */}
      <div className="mx-2 mb-1 flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
        {(
          [
            { key: "plaza", label: t("prompt.plaza"), icon: <SparklesIcon className="size-3.5" /> },
            { key: "mine", label: t("prompt.mine"), icon: <BookmarkIcon className="size-3.5" /> },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              tab === item.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>

      {/* 我的提示词：快捷新建 */}
      {tab === "mine" && (
        <div className="px-2 pb-1">
          <button
            type="button"
            onClick={() => openCreate(kind)}
            title={t("prompt.new")}
            className="flex w-full items-center gap-1.5 rounded-lg border border-dashed px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
            {t("prompt.new")}
          </button>
        </div>
      )}

      {/* 三类切换菜单：生图 / 大模型 / 视频 */}
      <div className="flex flex-col gap-0.5 px-2 pb-1">
        {PROMPT_KIND_TABS.map(({ kind: k, icon, labelKey }) => {
          const active = kind === k;
          const count = counts?.[k] ?? 0;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors",
                active
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {icon}
              <span className="flex-1 text-left">{t(labelKey)}</span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[9px] tabular-nums">
                {count}
              </Badge>
            </button>
          );
        })}
      </div>

      {/* 分类导航 */}
      <SidebarGroupLabel className="mt-1">
        <span className="flex items-center gap-1.5">
          <LayoutListIcon className="size-3.5" />
          {t("prompt.categories")}
        </span>
      </SidebarGroupLabel>
      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={category === "all"}
              onClick={() => setCategory("all")}
              tooltip={t("prompt.allCategories")}
            >
              <span className="min-w-0 flex-1 truncate text-xs">{t("prompt.allCategories")}</span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[9px] tabular-nums">
                {counts?.[kind] ?? "…"}
              </Badge>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {isLoadingCats ? (
            <div className="flex justify-center py-4">
              <Spinner className="size-3.5" />
            </div>
          ) : (
            categories.map((c) => (
              <SidebarMenuItem key={c.name}>
                <SidebarMenuButton
                  isActive={category === c.name}
                  onClick={() => setCategory(c.name)}
                  tooltip={c.name}
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{c.name}</span>
                  <Badge variant="secondary" className="h-4 px-1.5 text-[9px] tabular-nums">
                    {c.count}
                  </Badge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>
    </SidebarGroup>
  );
}
