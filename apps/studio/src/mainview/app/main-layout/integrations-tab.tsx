import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Label } from "@ui/label";
import { IntegrationModelSelect } from "@/mainview/components/integration-model-select";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import { CopyButton } from "@components/copy-button";

const LAUNCHER_TOOLS: { key: string; labelKey: string; tool: string }[] = [
  { key: "LAUNCHER_CODEX_MODEL", labelKey: "settings.integrations.codex", tool: "codex" },
  { key: "LAUNCHER_OPENCODE_MODEL", labelKey: "settings.integrations.opencode", tool: "opencode" },
  { key: "LAUNCHER_OPENCLAW_MODEL", labelKey: "settings.integrations.openclaw", tool: "openclaw" },
  { key: "LAUNCHER_HERMES_MODEL", labelKey: "settings.integrations.hermes", tool: "hermes" },
  { key: "LAUNCHER_PI_MODEL", labelKey: "settings.integrations.pi", tool: "pi" },
  { key: "LAUNCHER_COPILOT_MODEL", labelKey: "settings.integrations.copilot", tool: "copilot" },
  { key: "LAUNCHER_CHATGPT_MODEL", labelKey: "settings.integrations.chatgpt", tool: "chatgpt" },
];

const CLAUDE_TIERS = [
  { key: "LAUNCHER_CLAUDE_OPUS", labelKey: "settings.integrations.tier.opus", omiFlag: "opus" },
  { key: "LAUNCHER_CLAUDE_SONNET", labelKey: "settings.integrations.tier.sonnet" },
  { key: "LAUNCHER_CLAUDE_HAIKU", labelKey: "settings.integrations.tier.haiku", omiFlag: "haiku" },
];

function SaveRow({ mutation, hint }: { mutation: { mutate: () => void; isPending: boolean; isSuccess: boolean }; hint?: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 border-t pt-3">
      <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        {mutation.isPending ? (
          <Spinner data-icon="inline-start" />
        ) : mutation.isSuccess ? (
          <CheckIcon data-icon="inline-start" />
        ) : null}
        {mutation.isSuccess ? t("common.saved") : t("common.save")}
      </Button>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * 与 `omi` CLI 对应的启动命令：URL / API Key 都存在设置里，点保存后命令保持最短。
 * Claude Code 的三个档位合成一条命令：默认模型走 --model，Opus / Haiku 走 --opus / --haiku。
 */
function buildOmiCommand(
  tool: string,
  slots: { key: string; value: string; omiFlag?: string }[],
): string {
  const main = slots.find((s) => s.value && !s.omiFlag) ?? slots.find((s) => s.value);
  if (!main?.value) return "";
  let cmd = `omi launch ${tool} --model ${main.value}`;
  for (const s of slots) {
    if (s.omiFlag && s.value && s.value !== main.value) cmd += ` --${s.omiFlag} ${s.value}`;
  }
  return cmd;
}

/** 集成 Agent 卡片：Agent 名 + 模型档位（Claude 三档 / 其他单档）+ 一条 omi 启动命令 + 复制。 */
function IntegrationAgentCard({
  label,
  tool,
  mode,
  modelSlots,
  onModelChange,
}: {
  label: string;
  tool: string;
  mode?: "local" | "cloud";
  modelSlots: { key: string; label: string; value: string; omiFlag?: string }[];
  onModelChange: (key: string, value: string) => void;
}) {
  const t = useT();
  const omiCmd = buildOmiCommand(tool, modelSlots);

  return (
    <div className="rounded-lg border p-3">
      <h3 className="mb-2 text-sm font-medium">{label}</h3>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        {modelSlots.map((slot) => (
          <div key={slot.key} className="w-52">
            {modelSlots.length > 1 && (
              <Label className="mb-1 block text-[10px] text-muted-foreground">{slot.label}</Label>
            )}
            <IntegrationModelSelect
              value={slot.value}
              onChange={(v) => onModelChange(slot.key, v)}
              placeholder={`${t("settings.integrations.model")}…`}
              mode={mode}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5">
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t("settings.integrations.command")}
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums">
          {omiCmd || "—"}
        </code>
        <CopyButton
          text={omiCmd}
          iconOnly
          title={t("settings.integrations.command")}
          size="icon-sm"
          className="h-6 w-6 shrink-0"
        />
      </div>
    </div>
  );
}

export function IntegrationsSettings({
  form,
  updateField,
}: {
  form: Record<string, string>;
  updateField: (key: string, value: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const mode: "local" | "cloud" =
    (form.LAUNCHER_CLAUDE_MODE as "local" | "cloud" | undefined) ?? "local";

  // MODEL_KEYS 是全部 Agent 的模型档位字段；切换本地/云端时清空已选模型，
  // 避免旧模式的模型名串到新模式导致启动报错。
  const MODEL_KEYS = [
    ...CLAUDE_TIERS.map((c) => c.key),
    ...LAUNCHER_TOOLS.map((x) => x.key),
  ];
  // 本页自己的保存：把该页涉及的所有字段一起提交（与 useTabSave 的语义一致）。
  const saveMutation = useMutation({
    mutationFn: () => {
      const settings: Record<string, string> = {};
      for (const k of [...MODEL_KEYS, "LAUNCHER_CLAUDE_MODE"]) {
        if (form[k] !== undefined) settings[k] = form[k];
      }
      return rpcClient.updateSettings({ settings });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["model-dirs"] });
    },
  });
  const setMode = (m: "local" | "cloud") => {
    if (m === mode) return;
    updateField("LAUNCHER_CLAUDE_MODE", m);
    for (const key of MODEL_KEYS) if (form[key]) updateField(key, "");
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 页面级模式：本地只给本地模型，云端只给云端/API 模型。 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("settings.integrations.desc")}</p>
        <div className="flex items-center gap-2">
          <Label className="text-xs">{t("settings.integrations.mode")}</Label>
          <div className="flex gap-2">
            {(["local", "cloud"] as const).map((m) => (
              <Button
                key={m}
                type="button"
                variant={mode === m ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setMode(m)}
              >
                {m === "local" ? t("settings.integrations.mode.local") : t("settings.integrations.mode.cloud")}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Claude Code：一个 Agent，卡片里带三档模型。 */}
      <IntegrationAgentCard
        label={t("settings.integrations.claude")}
        tool="claude"
        mode={mode}
        modelSlots={CLAUDE_TIERS.map((tier) => ({
          key: tier.key,
          label: t(tier.labelKey),
          value: form[tier.key] ?? "",
          omiFlag: tier.omiFlag,
        }))}
        onModelChange={updateField}
      />

      {LAUNCHER_TOOLS.map((tool) => (
        <IntegrationAgentCard
          key={tool.key}
          label={t(tool.labelKey)}
          tool={tool.tool}
          mode={mode}
          modelSlots={[
            { key: tool.key, label: t("settings.integrations.model"), value: form[tool.key] ?? "" },
          ]}
          onModelChange={updateField}
        />
      ))}

      <SaveRow mutation={saveMutation} hint={t("settings.restartHint")} />
    </div>
  );
}
