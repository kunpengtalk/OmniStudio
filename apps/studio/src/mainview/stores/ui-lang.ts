import { useCallback, useMemo } from "react";
import { create } from "zustand";
import { translate, translateOptional, type UILang } from "../../shared/i18n";

type UILangState = {
  lang: UILang;
  setLang: (lang: UILang) => void;
};

export const useUILang = create<UILangState>((set) => ({
  lang: "zh",
  setLang: (lang) => set({ lang }),
}));

export function t(key: string, params?: Record<string, string>): string {
  return translate(useUILang.getState().lang, key, params);
}

export function useT() {
  const lang = useUILang((s) => s.lang);
  return useMemo(
    () => (key: string, params?: Record<string, string>): string => translate(lang, key, params),
    [lang],
  );
}

/**
 * 词条缺失时回退到调用方给的那份（不返回 key 本身）。
 *
 * 用于"数据里自带一份英文说明、界面有词条就用词条"的场景，见 `translateOptional`。
 */
export function useTOptional() {
  const lang = useUILang((s) => s.lang);
  return useMemo(
    () => (key: string, fallback: string, params?: Record<string, string>): string =>
      translateOptional(lang, key, params) ?? fallback,
    [lang],
  );
}

export function useIsZh() {
  const lang = useUILang((s) => s.lang);
  return useCallback(() => lang === "zh", [lang]);
}