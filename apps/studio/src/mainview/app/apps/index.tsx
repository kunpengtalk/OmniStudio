/**
 * 小应用中心（AppId = "apps"）。
 *
 * 两个视图在同一页里切换（不占全局路由）：应用中心 ↔ 小应用运行容器。
 * 用页面内 state 而不是 `stores/router.ts`，是因为这里的"打开一个小应用"不像
 * 模型详情那样需要被别处链接或返回 —— 它只是这一页里的一个抽屉。
 *
 * 最近使用记在 localStorage：它是纯界面偏好（哪个小应用常开），
 * 跟着数据目录走反而奇怪（同一台机器换频道不该丢）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";
import { miniAppById, type MiniAppCategory } from "../../../shared/miniapps";
import { AppCenter } from "./center";
import { MiniAppRunner } from "./runner";

const RECENT_KEY = "omni.miniapps.recent";
const RECENT_MAX = 4;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && Boolean(miniAppById(id)));
  } catch {
    // 存储被禁用（隐私模式）或内容坏了：当成没有历史，不影响使用。
    return [];
  }
}

/**
 * 当前主题，直接读 `<html class="dark">`（`applyTheme` 已经把它算好了）。
 *
 * 不在小应用里重算一遍"设置值 + 系统偏好"：那样两边迟早会算出不同结果，
 * 表现就是"宿主是深色、小应用是浅色"。这里只监听那个 class 的变化。
 */
function useResolvedTheme(): "light" | "dark" {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains("dark"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark ? "dark" : "light";
}

export function AppsScreen() {
  const queryClient = useQueryClient();
  const theme = useResolvedTheme();
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MiniAppCategory | "all">("all");
  const [recent, setRecent] = useState<string[]>(() => readRecent());

  // 能力快照：卡片上的「需配置」与容器里的提示都读它。缓存 30s 内不重复问主进程，
  // 「重新检测」按钮直接 invalidate（用户刚在设置里配完模型时的主路径）。
  const { data, isFetching } = useQuery({
    queryKey: ["miniapp-capabilities"],
    queryFn: () => rpcClient.getMiniAppCapabilities(undefined),
    staleTime: 30_000,
  });
  const caps = data?.capabilities;

  const app = useMemo(() => (openId ? miniAppById(openId) : undefined), [openId]);

  const open = useCallback((id: string) => {
    setOpenId(id);
    setRecent((prev) => {
      const next = [id, ...prev.filter((item) => item !== id)].slice(0, RECENT_MAX);
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // 存不下就算了：最近使用是锦上添花，不能因为它挡住打开。
      }
      return next;
    });
  }, []);

  const refreshCaps = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["miniapp-capabilities"] });
  }, [queryClient]);

  if (app) {
    return (
      <MiniAppRunner
        app={app}
        caps={caps}
        theme={theme}
        capsRefreshing={isFetching}
        onExit={() => setOpenId(null)}
        onRefreshCaps={refreshCaps}
      />
    );
  }

  return (
    <AppCenter
      caps={caps}
      recent={recent}
      query={query}
      category={category}
      onQuery={setQuery}
      onCategory={setCategory}
      onOpen={open}
    />
  );
}
