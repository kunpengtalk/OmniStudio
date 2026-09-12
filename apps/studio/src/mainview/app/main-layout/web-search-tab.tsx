import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, GlobeIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Spinner } from "@ui/spinner";
import { Switch } from "@ui/switch";
import { useT } from "@stores/ui-lang";
import { SettingsSection, SettingRow, PageHeader } from "./setting-ui";

const WEB_SEARCH_PROVIDERS = ["bing", "duckduckgo", "tavily", "brave"] as const;

/**
 * 设置 → 工具 → 联网检索。
 * 表单值由 SettingsScreen 统一持有，保存时只提交本页的键。
 */
export function WebSearchTab({
  form,
  updateField,
}: {
  form: Record<string, string>;
  updateField: (key: string, value: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: () => {
      const keys = [
        "WEB_SEARCH_ENABLED",
        "WEB_SEARCH_PROVIDER",
        "WEB_SEARCH_API_KEY",
        "WEB_SEARCH_MAX_RESULTS",
      ];
      const settings: Record<string, string> = {};
      for (const k of keys) if (form[k] !== undefined) settings[k] = form[k];
      return rpcClient.updateSettings({ settings });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const provider = form.WEB_SEARCH_PROVIDER ?? "bing";
  const needsKey = provider === "tavily" || provider === "brave";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("settings.webSearch.title")} description={t("settings.webSearch.desc")} />

      <SettingsSection>
        <SettingRow
          title={t("settings.webSearch.defaultEnabled")}
          description={t("settings.webSearch.toggleHint")}
        >
          <Switch
            checked={form.WEB_SEARCH_ENABLED === "1"}
            onCheckedChange={(v) => updateField("WEB_SEARCH_ENABLED", v ? "1" : "0")}
          />
        </SettingRow>

        <SettingRow title={t("settings.webSearch.provider")} stacked>
          <Select value={provider} onValueChange={(v) => updateField("WEB_SEARCH_PROVIDER", v)}>
            <SelectTrigger className="h-8 w-full text-xs sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEB_SEARCH_PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`settings.webSearch.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        {needsKey && (
          <SettingRow title={t("settings.webSearch.apiKey")} description={t("settings.webSearch.apiKeyHint")} stacked>
            <Input
              type="password"
              placeholder="tvly-… / BRF…"
              value={form.WEB_SEARCH_API_KEY ?? ""}
              onChange={(e) => updateField("WEB_SEARCH_API_KEY", e.target.value)}
              className="h-8 w-full text-xs sm:w-80"
            />
          </SettingRow>
        )}

        <SettingRow title={t("settings.webSearch.maxResults")} stacked>
          <Label htmlFor="WEB_SEARCH_MAX_RESULTS" className="sr-only">
            {t("settings.webSearch.maxResults")}
          </Label>
          <Input
            id="WEB_SEARCH_MAX_RESULTS"
            type="text"
            inputMode="numeric"
            placeholder="5"
            value={form.WEB_SEARCH_MAX_RESULTS ?? ""}
            onChange={(e) => updateField("WEB_SEARCH_MAX_RESULTS", e.target.value)}
            className="h-8 w-full text-xs sm:w-32"
          />
        </SettingRow>
      </SettingsSection>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : saveMutation.isSuccess ? (
            <CheckIcon data-icon="inline-start" />
          ) : (
            <GlobeIcon data-icon="inline-start" />
          )}
          {saveMutation.isSuccess ? t("common.saved") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}
