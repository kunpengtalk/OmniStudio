/**
 * 工作区（Agent 的文件夹）有两处会去选它：输入框上的工作区选择器、侧栏的项目段。
 * 展示名与「最近工作区」设置的解析 / 合并放在这里给两边共用 —— 各写一份的话，
 * 去重与条数上限迟早会不一致，于是"我在侧栏打开过的文件夹，选择器里找不到"。
 */

/** 最近工作区（AGENT_WORKSPACES）里保留几条。 */
const RECENTS_LIMIT = 8;

/** 路径展示名：最后一段目录名，当"项目名"用。 */
export function workspaceLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 解析最近工作区设置：坏 JSON 与非字符串项一律丢掉 —— 菜单里少一条，好过整块炸掉。 */
export function parseWorkspaceRecents(raw: string | undefined | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** 把一个工作区提到"最近"的首位：去重 + 截到上限。 */
export function withRecentWorkspace(current: string[], path: string): string[] {
  return [path, ...current.filter((item) => item !== path)].slice(0, RECENTS_LIMIT);
}
