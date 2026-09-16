/**
 * 应用中心：小应用列表页。
 *
 * 这一页的形态刻意与其它页不同 —— 其它页是"一个工具 + 左侧记录列表"，这里是
 * 全宽的卡片墙：顶部一条渐变横幅（标题 + 搜索），下面分类筛选与卡片网格。
 * 卡片本身就是入口，点开进入 `runner.tsx` 的沙箱容器。
 *
 * 「需配置」标签不是装饰：卡片在这一步就把缺的能力标出来（数据来自主进程
 * `getMiniAppCapabilities`，与各功能页的"未配置"判定同一套），避免用户点进去
 * 才发现跑不了。
 */
import type { ReactNode } from "react";
import {
  AudioLinesIcon,
  Grid3x3Icon,
  IdCardIcon,
  NotebookPenIcon,
  PenLineIcon,
  ScissorsIcon,
  SearchIcon,
  SparklesIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";

import { Input } from "@ui/input";
import { ScrollArea } from "@ui/scroll-area";
import { useT } from "@stores/ui-lang";
import { chipClass } from "@components/filter-chip";
import { cn } from "@/mainview/lib/utils";
import { accentClass } from "./accents";
import {
  MINIAPPS,
  MINIAPP_CAPABILITY_LABEL_KEY,
  MINIAPP_CATEGORIES,
  type MiniAppCapability,
  type MiniAppCapabilitySnapshot,
  type MiniAppCategory,
  type MiniAppIcon,
  type MiniAppSpec,
} from "../../../shared/miniapps";

const ICONS: Record<MiniAppIcon, ReactNode> = {
  scissors: <ScissorsIcon className="size-5" />,
  idCard: <IdCardIcon className="size-5" />,
  userRound: <UserRoundIcon className="size-5" />,
  audioLines: <AudioLinesIcon className="size-5" />,
  penLine: <PenLineIcon className="size-5" />,
  grid: <Grid3x3Icon className="size-5" />,
  notebook: <NotebookPenIcon className="size-5" />,
};

const CATEGORY_LABEL_KEY: Record<MiniAppCategory, string> = {
  image: "miniapps.category.image",
  audio: "miniapps.category.audio",
  text: "miniapps.category.text",
};

/** 小应用缺少哪些能力（空数组表示现在就能跑）。 */
export function missingCapabilities(
  app: MiniAppSpec,
  caps: MiniAppCapabilitySnapshot | undefined,
): MiniAppCapability[] {
  if (!caps) return [];
  return app.requires.filter((cap) => !caps[cap]?.ready);
}

function CapabilityTags({
  capabilities,
  caps,
}: {
  capabilities: MiniAppCapability[];
  caps: MiniAppCapabilitySnapshot | undefined;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {capabilities.map((cap) => {
        const state = caps?.[cap];
        const ready = state?.ready ?? false;
        return (
          <span
            key={cap}
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] leading-none",
              ready
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
            )}
            title={state?.label || undefined}
          >
            {ready
              ? t(MINIAPP_CAPABILITY_LABEL_KEY[cap])
              : t("miniapps.cap.missing", { name: t(MINIAPP_CAPABILITY_LABEL_KEY[cap]) })}
          </span>
        );
      })}
    </div>
  );
}

function AppCard({
  app,
  caps,
  onOpen,
}: {
  app: MiniAppSpec;
  caps: MiniAppCapabilitySnapshot | undefined;
  onOpen: () => void;
}) {
  const t = useT();
  const missing = missingCapabilities(app, caps);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border bg-card text-left transition-all",
        "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5",
      )}
    >
      <div className={cn("relative flex h-24 items-center justify-center", accentClass(app.accent))}>
        <span className="flex size-12 items-center justify-center rounded-2xl bg-background/80 text-foreground shadow-sm transition-transform group-hover:scale-105">
          {ICONS[app.icon]}
        </span>
        {missing.length > 0 && (
          <span className="absolute top-2 right-2 rounded-full bg-background/90 px-2 py-0.5 text-[10px] font-medium text-amber-700 shadow-sm dark:text-amber-400">
            {t("miniapps.needSetup")}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-3.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{t(app.nameKey)}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
            {t(CATEGORY_LABEL_KEY[app.category])}
          </span>
        </div>
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{t(app.descKey)}</p>
        <div className="mt-auto pt-1.5">
          <CapabilityTags capabilities={app.requires} caps={caps} />
        </div>
      </div>
    </button>
  );
}

function RecentChip({ app, onOpen }: { app: MiniAppSpec; onOpen: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex shrink-0 items-center gap-2 rounded-full border bg-card py-1.5 pr-3.5 pl-1.5 text-xs transition-colors hover:border-primary/40 hover:bg-muted"
    >
      <span className={cn("flex size-6 items-center justify-center rounded-full", accentClass(app.accent))}>
        {ICONS[app.icon]}
      </span>
      <span className="font-medium">{t(app.nameKey)}</span>
    </button>
  );
}

export function AppCenter({
  caps,
  recent,
  query,
  category,
  onQuery,
  onCategory,
  onOpen,
}: {
  caps: MiniAppCapabilitySnapshot | undefined;
  recent: string[];
  query: string;
  category: MiniAppCategory | "all";
  onQuery: (value: string) => void;
  onCategory: (value: MiniAppCategory | "all") => void;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const needle = query.trim().toLowerCase();

  const items = MINIAPPS.filter((app) => category === "all" || app.category === category).filter(
    (app) => {
      if (!needle) return true;
      const haystack = [
        t(app.nameKey),
        t(app.descKey),
        ...app.keywords,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    },
  );

  const recentApps = recent
    .map((id) => MINIAPPS.find((app) => app.id === id))
    .filter((app): app is MiniAppSpec => Boolean(app));

  return (
    <>
      {/* 横幅：这一页的门面，与其它页的工具条 + 列表结构区分开 */}
      <div className="shrink-0 border-b bg-gradient-to-br from-primary/10 via-background to-background px-6 pt-4 pb-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              <SparklesIcon className="size-5 text-primary" />
              {t("miniapps.title")}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">{t("miniapps.subtitle")}</p>
          </div>
          <div className="relative ml-auto w-full max-w-xs">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder={t("miniapps.search")}
              className="h-9 rounded-full bg-background pr-8 pl-8 text-sm"
            />
            {query && (
              <button
                type="button"
                aria-label={t("miniapps.clear")}
                onClick={() => onQuery("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:bg-muted"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-6">
          {recentApps.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("miniapps.recent")}
              </h2>
              <div className="flex flex-wrap gap-2">
                {recentApps.map((app) => (
                  <RecentChip key={app.id} app={app} onOpen={() => onOpen(app.id)} />
                ))}
              </div>
            </section>
          )}

          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className={chipClass(category === "all")}
                onClick={() => onCategory("all")}
              >
                {t("miniapps.category.all")}
              </button>
              {MINIAPP_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={chipClass(category === cat)}
                  onClick={() => onCategory(cat)}
                >
                  {t(CATEGORY_LABEL_KEY[cat])}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {t("miniapps.count", { n: String(items.length) })}
              </span>
            </div>

            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center">
                <span className="flex size-14 items-center justify-center rounded-2xl bg-muted">
                  <SparklesIcon className="size-6 text-muted-foreground" />
                </span>
                <p className="text-sm font-medium">{t("miniapps.empty.title")}</p>
                <p className="max-w-xs text-xs text-muted-foreground">{t("miniapps.empty.desc")}</p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {items.map((app) => (
                  <AppCard key={app.id} app={app} caps={caps} onOpen={() => onOpen(app.id)} />
                ))}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
    </>
  );
}
