import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FlaskConicalIcon, Loader2Icon, SearchIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { useT } from "@stores/ui-lang";
import type { KbView } from "@/bun/knowledge";
import type { KbHit } from "@/shared/knowledge";

function MethodBadge({ method }: { method: KbHit["method"] }) {
  const t = useT();
  return (
    <Badge variant="secondary" className="h-5 px-1.5 text-[10px] text-muted-foreground">
      {t(`kb.recall.method.${method}`)}
    </Badge>
  );
}

function RerankBadge() {
  const t = useT();
  return (
    <Badge variant="secondary" className="h-5 px-1.5 text-[10px] text-muted-foreground">
      {t("kb.recall.reranked")}
    </Badge>
  );
}

export function KbRecallTab({ kb }: { kb: KbView }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KbHit[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const runMutation = useMutation({
    mutationFn: () => rpcClient.kbRecall({ kbIds: [kb.id], query }),
    onSuccess: (data) => {
      setHits(data.hits);
      setNotes(data.notes ?? []);
    },
  });

  const run = () => {
    if (!query.trim() || runMutation.isPending) return;
    runMutation.mutate();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 查询条 */}
      <div className="shrink-0 px-6 py-3">
        <div className="relative">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                run();
              }
            }}
            placeholder={t("kb.recall.placeholder")}
            className="h-9 pr-24 pl-9 text-sm"
          />
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground/60" />
          <Button
            size="sm"
            className="absolute top-1/2 right-1.5 h-7 -translate-y-1/2 gap-1 px-2.5 text-xs"
            onClick={run}
            disabled={!query.trim() || runMutation.isPending}
          >
            {runMutation.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <FlaskConicalIcon className="size-3.5" />
            )}
            {t("kb.recall.run")}
          </Button>
        </div>
      </div>

      {/* 结果 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {notes.length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
            {notes.map((n, i) => (
              <p key={i}>{n}</p>
            ))}
          </div>
        )}

        {hits == null ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <FlaskConicalIcon className="size-5" />
            </div>
            <p className="text-sm font-medium">{t("kb.recall.emptyTitle")}</p>
            <p className="max-w-md text-xs leading-5 text-muted-foreground">
              {t("kb.recall.emptyHint")}
            </p>
          </div>
        ) : hits.length === 0 ? (
          <div className="py-16 text-center text-xs text-muted-foreground">{t("kb.recall.noResults")}</div>
        ) : (
          <div className="flex flex-col gap-2">
            {hits.map((h, i) => (
              <div key={h.chunkId} className="rounded-lg border bg-card px-3 py-2.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">#{i + 1}</span>
                  <span className="truncate text-xs font-medium">{h.docName}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {t("kb.recall.chunkSeq", { seq: String(h.seq) })}
                  </span>
                  <MethodBadge method={h.method} />
                  {h.reranked && <RerankBadge />}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(4, Math.round(h.score * 100))}%` }}
                      />
                    </span>
                    <span className="w-9 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                      {h.score.toFixed(2)}
                    </span>
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                  {h.content}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
