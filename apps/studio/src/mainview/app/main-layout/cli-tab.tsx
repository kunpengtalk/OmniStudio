import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, BookOpenTextIcon, SquareTerminalIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useT, useUILang } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { PageHeader, SettingsSection } from "./setting-ui";
import {
  CLI_DOC_INTRO,
  CLI_MEMORY_SNIPPETS,
  CLI_SECTIONS,
  renderSnippet,
  type CliEntry,
  type CliLang,
} from "@/shared/cli-docs";

/**
 * 设置 → 工具 → 命令行。
 *
 * 内容与 `omi guide` / docs/omi-cli.md 同源（src/shared/cli-docs.ts），
 * 所以终端手册与应用内说明永远一致；这里只负责排版与一键复制。
 */

/** 点击复制的等宽行。 */
function CopyLine({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时忽略
    }
  };
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5", className)}>
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre">{value}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={copy}
        title={value}
      >
        {copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

function Entry({ entry, lang }: { entry: CliEntry; lang: CliLang }) {
  return (
    <div className="flex flex-col gap-2 border-b px-4 py-3.5 last:border-b-0">
      <CopyLine value={entry.cmd} />
      <p className="text-xs text-muted-foreground">{lang === "zh" ? entry.zh : entry.en}</p>
      {(entry.notes?.length ?? 0) > 0 && (
        <ul className="flex flex-col gap-1 text-[11px] text-muted-foreground/90">
          {entry.notes!.map((note) => (
            <li key={note.zh} className="flex gap-1.5">
              <span className="text-muted-foreground/50">·</span>
              <span>{lang === "zh" ? note.zh : note.en}</span>
            </li>
          ))}
        </ul>
      )}
      {(entry.examples?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1.5 pt-0.5">
          {entry.examples!.map((example) => (
            <div key={example.cmd} className="flex flex-col gap-1">
              <CopyLine value={example.cmd} className="bg-background" />
              <span className="px-1 text-[11px] text-muted-foreground">
                {lang === "zh" ? example.zh : example.en}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 代码片段卡片：标题 + 说明 + 可复制的代码块（含网关地址占位符替换）。 */
function SnippetCard({
  title,
  description,
  code,
  language,
}: {
  title: string;
  description: string;
  code: string;
  language: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时忽略
    }
  };
  return (
    <div className="flex flex-col gap-2 border-b px-4 py-3.5 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{title}</span>
            <span className="rounded-full border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {language}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={copy}
          title={title}
        >
          {copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

export function CliTab() {
  const t = useT();
  const lang: CliLang = useUILang((s) => s.lang) === "en" ? "en" : "zh";

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const settings = data?.settings ?? {};
  const snippetCtx = {
    gatewayUrl: `http://${settings.GATEWAY_HOST || "127.0.0.1"}:${settings.GATEWAY_PORT || "10000"}`,
    // 未设置网关 Key 时用 EMPTY 占位：网关无 Key 时对本地进程开放，请求照样通过。
    gatewayKey: (settings.GATEWAY_API_KEY ?? "").trim() || "EMPTY",
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("settings.cli.title")} description={t("settings.cli.desc")} />

      <div className="flex items-start gap-2.5 rounded-xl border bg-muted/30 px-4 py-3">
        <SquareTerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-xs">{lang === "zh" ? CLI_DOC_INTRO.zh : CLI_DOC_INTRO.en}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <BookOpenTextIcon className="size-3" />
            {t("settings.cli.guideHint")}
          </p>
        </div>
      </div>

      {CLI_SECTIONS.map((section) => (
        <SettingsSection
          key={section.id}
          title={lang === "zh" ? section.titleZh : section.titleEn}
          description={lang === "zh" ? section.descZh : section.descEn}
        >
          {section.entries.map((entry) => (
            <Entry key={entry.cmd} entry={entry} lang={lang} />
          ))}
        </SettingsSection>
      ))}

      <SettingsSection
        title={t("settings.cli.snippets")}
        description={t("settings.cli.snippetsDesc")}
      >
        {CLI_MEMORY_SNIPPETS.map((snippet) => (
          <SnippetCard
            key={snippet.id}
            title={lang === "zh" ? snippet.titleZh : snippet.titleEn}
            description={lang === "zh" ? snippet.descZh : snippet.descEn}
            code={renderSnippet(snippet.code, snippetCtx)}
            language={snippet.language}
          />
        ))}
      </SettingsSection>
    </div>
  );
}
