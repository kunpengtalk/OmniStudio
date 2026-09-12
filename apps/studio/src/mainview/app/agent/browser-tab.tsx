import { useState } from "react";
import { ExternalLinkIcon, GlobeIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { useT } from "@stores/ui-lang";

/**
 * 浏览器页签：一个地址栏 + iframe。
 * 用途是看「本地起了个 dev server / 产物页面」——这类地址同源限制少；
 * 外部站点若禁止被内嵌（X-Frame-Options），用右侧的「外部打开」按钮走系统浏览器。
 */
export function BrowserTab({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(url);
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const normalize = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
    // 本机端口按 http 补全（`localhost:5173` 这种写法最常见），其余当作搜索。
    if (/^[\w.-]+(:\d+)?(\/|$)/.test(trimmed)) return `http://${trimmed}`;
    return `https://${trimmed}`;
  };

  const go = (value: string) => {
    const next = normalize(value);
    setDraft(next);
    setLoaded(false);
    onChange(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b bg-muted/20 px-2 py-1">
        <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go(draft);
          }}
          placeholder={t("agent.browser.placeholder")}
          className="h-6 min-w-0 flex-1 rounded-md border-none bg-background/70 px-1.5 py-0 font-mono text-[10px] shadow-none focus-visible:ring-0"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground"
          tooltip={t("agent.artifact.refresh")}
          onClick={() => {
            setVersion((v) => v + 1);
            setLoaded(false);
          }}
          disabled={!url}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground"
          tooltip={t("agent.browser.openExternal")}
          onClick={() => {
            if (url) window.open(url, "_blank");
          }}
          disabled={!url}
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 bg-white">
        {url ? (
          <>
            {/* eslint-disable-next-line react/iframe-missing-sandbox -- 同上：地址页要能正常跑脚本 */}
            <iframe
              key={`${url}-${version}`}
              src={url}
              title={url}
              className="size-full border-0 bg-white"
              onLoad={() => setLoaded(true)}
            />
            {!loaded && (
              <p className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background text-center text-[11px] text-muted-foreground">
                {t("agent.browser.loading")}
                <span className="max-w-64 text-[10px] text-muted-foreground/70">
                  {t("agent.browser.blockedHint")}
                </span>
              </p>
            )}
          </>
        ) : (
          <p className="flex h-full flex-col items-center justify-center gap-1 bg-background text-center text-[11px] text-muted-foreground">
            {t("agent.browser.empty")}
            <span className="max-w-64 text-[10px] text-muted-foreground/70">
              {t("agent.browser.emptyHint")}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
