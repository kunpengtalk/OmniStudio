import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, LanguagesIcon, PaletteIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Spinner } from "@ui/spinner";
import { useT, useUILang } from "@stores/ui-lang";
import { LANGS, type UILang } from "@/shared/i18n";
import { PageHeader, SettingsSection, SettingRow } from "@components/setting-ui";

export const THEME_OPTIONS = ["system", "light", "dark"] as const;
export type ThemeOption = (typeof THEME_OPTIONS)[number];

/** 把主题设置落到 <html> 的 .dark 类（system 跟随系统）。 */
export function applyTheme(theme: string) {
  const dark =
    theme === "dark" ||
    (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** 设置 → 偏好 → 外观：主题与界面语言。 */
export function AppearanceTab({
  form,
  updateField,
}: {
  form: Record<string, string>;
  updateField: (key: string, value: string) => void;
}) {
  const t = useT();
  const lang = useUILang((s) => s.lang);
  const setLang = useUILang((s) => s.setLang);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: () => {
      const settings: Record<string, string> = {};
      for (const k of ["UI_THEME", "UI_LANG"]) {
        if (form[k] !== undefined) settings[k] = form[k];
      }
      return rpcClient.updateSettings({ settings });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const theme = form.UI_THEME ?? "system";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("settings.appearance")} description={t("settings.appearance.desc")} />

      <SettingsSection>
        <SettingRow title={t("settings.appearance.theme")} description={t("settings.appearance.themeDesc")}>
          <Select
            value={theme}
            onValueChange={(v) => {
              updateField("UI_THEME", v);
              applyTheme(v);
            }}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {t(`settings.appearance.theme.${opt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow title={t("settings.interface.language")} description={t("settings.interface.languageDesc")}>
          <div className="flex gap-2">
            {LANGS.map((l: { value: UILang; label: string }) => (
              <Button
                key={l.value}
                variant={lang === l.value ? "default" : "outline"}
                size="sm"
                className="h-7 min-w-[64px] text-xs"
                onClick={() => {
                  setLang(l.value);
                  updateField("UI_LANG", l.value);
                }}
                disabled={saveMutation.isPending && lang !== l.value}
              >
                {l.label}
              </Button>
            ))}
          </div>
        </SettingRow>
      </SettingsSection>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : saveMutation.isSuccess ? (
            <CheckIcon data-icon="inline-start" />
          ) : (
            <PaletteIcon data-icon="inline-start" />
          )}
          {saveMutation.isSuccess ? t("common.saved") : t("common.save")}
        </Button>
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <LanguagesIcon className="size-3" />
          {t("settings.appearance.hint")}
        </p>
      </div>
    </div>
  );
}
