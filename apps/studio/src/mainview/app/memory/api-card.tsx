import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, CopyIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { SettingsSection } from "@components/setting-ui";

function CopyRow({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-1.5">
      <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{text}</code>
      <Button type="button" variant="ghost" size="icon-sm" className="h-6 w-6 shrink-0" onClick={copy}>
        {copied ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}


/** 对外接入方式：REST + MCP（挂在本地网关上，OpenMemory 同款对外形式）。 */
export function MemoryApiCard() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["gateway-status"],
    queryFn: () => rpcClient.getGatewayStatus(undefined),
  });
  const base = (data?.url ?? "http://127.0.0.1:10000").replace(/\/+$/, "");
  const mcpConfig = JSON.stringify(
    { mcpServers: { "omni-memory": { url: `${base}/mcp` } } },
    null,
    2,
  );

  return (
    <SettingsSection title={t("memory.api.title")} description={t("memory.api.desc")}>
      <div className="flex flex-col gap-2 px-4 py-3">
        <CopyRow label="GET" text={`curl ${base}/v1/memories?q=关键词`} />
        <CopyRow label="POST" text={`curl -X POST ${base}/v1/memories -H "content-type: application/json" -d '{"content":"一句话记忆","category":"fact"}'`} />
        <CopyRow label={t("memory.api.playground")} text={`${base}/mcp`} />
        <CopyRow label="MCP JSON" text={mcpConfig} />
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t("memory.api.hint")}
        </p>
      </div>
    </SettingsSection>
  );
}
