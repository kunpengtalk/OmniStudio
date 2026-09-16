/**
 * 小应用封面的配色类串。
 *
 * 必须写在这里、不能写进 `shared/miniapps.ts`：Tailwind 的内容扫描以 vite root
 * （`src/mainview`）为界，`shared/` 下的类串不会进 CSS —— 症状是封面一片空白而构建照常通过。
 * 这个坑已经踩过一次，所以语义名留在 shared，类串放在扫描范围内。
 */
import type { MiniAppAccent } from "../../../shared/miniapps";

export const ACCENT_CLASS: Record<MiniAppAccent, string> = {
  violet: "from-violet-500/30 to-fuchsia-500/10",
  sky: "from-sky-500/30 to-cyan-500/10",
  amber: "from-amber-500/30 to-rose-500/10",
  emerald: "from-emerald-500/30 to-teal-500/10",
  indigo: "from-indigo-500/30 to-blue-500/10",
  rose: "from-rose-500/30 to-amber-500/10",
};

/** 封面底色：`bg-gradient-to-br` + 上面那对色标。 */
export function accentClass(accent: MiniAppAccent): string {
  return `bg-gradient-to-br ${ACCENT_CLASS[accent]}`;
}
