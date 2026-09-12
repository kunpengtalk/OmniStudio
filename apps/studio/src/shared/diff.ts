/**
 * 统一 diff 的行分类：右侧「审查」页签按 + / - / @@ 上色，
 * 主进程（git diff）与界面共用同一套解析，避免两边规则漂移。
 */
export type DiffLine = { type: "add" | "del" | "context" | "meta"; text: string };

export function parseUnifiedDiff(diff: string): DiffLine[] {
  return diff.split("\n").map((line) => {
    if (
      line.startsWith("@@") ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      return { type: "meta" as const, text: line };
    }
    if (line.startsWith("+")) return { type: "add" as const, text: line.slice(1) };
    if (line.startsWith("-")) return { type: "del" as const, text: line.slice(1) };
    return { type: "context" as const, text: line.startsWith(" ") ? line.slice(1) : line };
  });
}
