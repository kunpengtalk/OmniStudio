import { useCallback, useMemo } from "react";
import { create } from "zustand";
import { translate, type UILang } from "../../shared/i18n";

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

export function useIsZh() {
  const lang = useUILang((s) => s.lang);
  return useCallback(() => lang === "zh", [lang]);
}