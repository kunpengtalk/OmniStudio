import { useState } from "react";
import { ExternalLinkIcon, GlobeIcon, RefreshCwIcon } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { PiTip } from "./pi-tip";

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
    <div className="wp-body">
      <div className="wp-browser-bar">
        <GlobeIcon size={13} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
        <input
          value={draft}
          className="wp-browser-url"
          placeholder={t("agent.browser.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go(draft);
          }}
        />
        <PiTip label={t("agent.artifact.refresh")}>
          <button
            type="button"
            className="wp-action-btn"
            aria-label={t("agent.artifact.refresh")}
            disabled={!url}
            onClick={() => {
              setVersion((v) => v + 1);
              setLoaded(false);
            }}
          >
            <RefreshCwIcon size={13} aria-hidden />
          </button>
        </PiTip>
        <PiTip label={t("agent.browser.openExternal")}>
          <button
            type="button"
            className="wp-action-btn"
            aria-label={t("agent.browser.openExternal")}
            disabled={!url}
            onClick={() => {
              if (url) window.open(url, "_blank");
            }}
          >
            <ExternalLinkIcon size={13} aria-hidden />
          </button>
        </PiTip>
      </div>

      {/* iframe 底下永远垫白：站点自己没设背景时，深色主题下会透出面板底色。 */}
      <div style={{ position: "relative", display: "flex", minHeight: 0, flex: 1, background: "#ffffff" }}>
        {url ? (
          <>
            {/* eslint-disable-next-line react/iframe-missing-sandbox -- 同上：地址页要能正常跑脚本 */}
            <iframe
              key={`${url}-${version}`}
              src={url}
              title={url}
              className="wp-browser-frame"
              onLoad={() => setLoaded(true)}
            />
            {!loaded ? (
              <div className="wp-empty" style={{ position: "absolute", inset: 0, background: "var(--ds-bg-primary)" }}>
                <span className="wp-empty-mark">
                  <GlobeIcon size={18} aria-hidden />
                </span>
                <p className="wp-empty-title">{t("agent.browser.loading")}</p>
                <p className="wp-empty-body">{t("agent.browser.blockedHint")}</p>
              </div>
            ) : null}
          </>
        ) : (
          <div className="wp-empty" style={{ width: "100%" }}>
            <span className="wp-empty-mark">
              <GlobeIcon size={18} aria-hidden />
            </span>
            <p className="wp-empty-title">{t("agent.browser.empty")}</p>
            <p className="wp-empty-body">{t("agent.browser.emptyHint")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
