import { getSetting } from "./db/settings";
import { DEFAULT_LANG, translate, type UILang } from "../shared/i18n";

/**
 * 主进程侧的取词。
 *
 * 绝大多数界面文案在前端用 `useT()` 就够了。但有一类字符串是**主进程生成、之后长期显示**
 * 的（最典型的是会话标题：分叉出来的标题要落库，侧栏一直在读它）—— 这类没法交给前端渲染时
 * 翻译，只能在生成时按当前界面语言定稿。本模块就是给这类字符串一个统一的入口：
 * 与 webview 共用同一份字典（`shared/i18n.ts`），不另建一套。
 */
export function uiLang(): UILang {
  const value = getSetting("UI_LANG");
  return value === "zh" || value === "en" ? value : DEFAULT_LANG;
}

/** 按当前界面语言取词；`{name}` 插值规则同前端 `t()`。 */
export function mainT(key: string, params?: Record<string, string>): string {
  return translate(uiLang(), key, params);
}
