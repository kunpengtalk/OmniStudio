/**
 * 左侧一级菜单（应用栏 `AppRail`）的布局：顺序 + 显示 / 隐藏。
 *
 * 放在 shared 是因为这份 id 清单同时被两边用：webview 的菜单本体（`app-rail.tsx` 渲染）
 * 与设置 → 外观 的配置卡（`app-rail-config.tsx` 排序 / 开关）。各写一份必然漂移，
 * 而漂移的样子是「配置里能排序的一条，菜单里根本没有」——从界面上看不出来。
 * 解析规则做成纯函数，主进程、webview、单测共用同一份。
 *
 * 存储是**一条设置**（`APP_RAIL_LAYOUT`，JSON 字符串），数组顺序即展示顺序：
 *   [{"id":"chat"},{"id":"agent","hidden":true},{"id":"music"}]
 * 存整份清单（含被隐藏的项）而不是"可见项清单"，是为了让「先藏起来、过两天再放出来」
 * 回到原来的位置，而不是被扔到末尾。
 *
 * 三条容错规则（这份值可能被手改过，也可能来自更老的版本）：
 *   1. 认不出的 id 直接丢 —— 老版本删掉的应用不该把整份配置带崩；
 *   2. 重复 id 只认第一次出现的；
 *   3. 存储里没有的 id（新版本新增的应用）按默认顺序补在后面且可见 —— 新功能不会因为
 *      一份老配置"装上了却找不到"。
 * 空串 = 默认布局（「恢复默认」写回的就是空串）；坏 JSON 同样回落默认。
 */

/** 一级菜单的全部条目，数组顺序即默认展示顺序。 */
export const APP_RAIL_IDS = [
  "chat",
  "agent",
  // JEV（类型化判定）：紧挨着 Agent —— 两者是一对（Agent 用它做判断），
  // 但要各自是一级入口：它自己有一整套页面（问题编辑器 / 概率分布 / 后端配置）。
  "jev",
  "voicecall",
  "voice",
  "image",
  "video",
  "music",
  // 无限画布：文本 / 图片 / 视频 / 音频生成集中在一张可缩放画布上，
  // 属于媒体创作面，紧跟 image / video / music。
  "canvas",
  "ocr",
  "translate",
  "prompt",
  "skills",
  "kb",
  "memory",
  "benchmark",
  "apps",
] as const;

export type AppId = (typeof APP_RAIL_IDS)[number];

/** 设置键：左侧一级菜单的顺序与显示 / 隐藏。 */
export const APP_RAIL_LAYOUT_KEY = "APP_RAIL_LAYOUT";

export type RailLayoutEntry = { id: AppId; hidden: boolean };

export function defaultRailLayout(): RailLayoutEntry[] {
  return APP_RAIL_IDS.map((id) => ({ id, hidden: false }));
}

/** 存储里的原始条目：`{"id":"music","hidden":true}`，也接受只写 id 的字符串写法。 */
type StoredEntry = string | { id?: unknown; hidden?: unknown };

function decodeRailLayout(raw: string | null | undefined): StoredEntry[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as StoredEntry[]) : [];
  } catch {
    return [];
  }
}

/** 存储值 → 一份完整、可用、不丢条目的布局。 */
export function resolveRailLayout(raw: string | null | undefined): RailLayoutEntry[] {
  const known = new Set<string>(APP_RAIL_IDS);
  const seen = new Set<string>();
  const out: RailLayoutEntry[] = [];
  for (const item of decodeRailLayout(raw)) {
    const id = typeof item === "string" ? item : item?.id;
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id: id as AppId, hidden: typeof item === "string" ? false : item.hidden === true });
  }
  for (const id of APP_RAIL_IDS) if (!seen.has(id)) out.push({ id, hidden: false });
  return out;
}

/**
 * 布局 → 存储值。默认布局（顺序与显隐都跟默认一致）写回**空串**：
 * 「恢复默认」和「手动拖回原样」因此落到同一个存储状态，配置行里也不会留一堆
 * 没有信息的 `{"id":"chat"}`。
 */
export function serializeRailLayout(entries: RailLayoutEntry[]): string {
  const isDefault =
    entries.every((entry) => !entry.hidden) &&
    entries.map((entry) => entry.id).join(",") === APP_RAIL_IDS.join(",");
  if (isDefault) return "";
  return JSON.stringify(
    entries.map((entry) => (entry.hidden ? { id: entry.id, hidden: true } : { id: entry.id })),
  );
}

/** 把第 from 项移到第 to 位（都是**最终位置**，越界自动夹到合法范围）。 */
export function moveRailEntry(
  entries: RailLayoutEntry[],
  from: number,
  to: number,
): RailLayoutEntry[] {
  const last = entries.length - 1;
  if (from < 0 || from > last) return entries;
  const target = Math.max(0, Math.min(to, last));
  if (target === from) return entries;
  const next = [...entries];
  const [item] = next.splice(from, 1);
  if (!item) return entries;
  next.splice(target, 0, item);
  return next;
}

/** 显示 / 隐藏一条（不传 hidden 就是取反）。 */
export function toggleRailEntry(
  entries: RailLayoutEntry[],
  id: AppId,
  hidden?: boolean,
): RailLayoutEntry[] {
  return entries.map((entry) =>
    entry.id === id ? { ...entry, hidden: hidden ?? !entry.hidden } : entry,
  );
}

/** 当前会显示在菜单里的条目。 */
export function visibleRailEntries(entries: RailLayoutEntry[]): RailLayoutEntry[] {
  return entries.filter((entry) => !entry.hidden);
}
