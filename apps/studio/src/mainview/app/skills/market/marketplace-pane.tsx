import { useQuery } from "@tanstack/react-query";
import { ShoppingBagIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import { useSkillsStore } from "@stores/skills";
import { chipClass } from "../parts";
import { MarketCard } from "./market-card";

export function MarketplacePane({ search }: { search: string }) {
  const t = useT();
  const board = useSkillsStore((s) => s.marketBoard);
  const setBoard = useSkillsStore((s) => s.setMarketBoard);

  const { data: skillsList } = useQuery({
    queryKey: ["skills"],
    queryFn: () => rpcClient.skillsList(undefined),
  });
  const installedRefs = new Set(
    (skillsList?.skills ?? []).filter((s) => s.sourceType === "skillssh").map((s) => s.sourceRef),
  );

  const query = search.trim();
  const leaderboard = useQuery({
    queryKey: ["skills-market-board", board],
    queryFn: () => rpcClient.skillsMarketLeaderboard({ board }),
    staleTime: 5 * 60 * 1000,
    enabled: query.length === 0,
  });
  const searchQuery = useQuery({
    queryKey: ["skills-market-search", query],
    queryFn: () => rpcClient.skillsMarketSearch({ query, limit: 60 }),
    enabled: query.length > 0,
    staleTime: 2 * 60 * 1000,
  });

  const active = query.length > 0 ? searchQuery : leaderboard;
  const items = active.data?.skills ?? [];

  return (
    <div className="flex flex-col gap-3 p-4">
      {query.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { key: "alltime", labelKey: "skills.board.alltime" },
              { key: "trending", labelKey: "skills.board.trending" },
              { key: "hot", labelKey: "skills.board.hot" },
            ] as const
          ).map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setBoard(b.key)}
              className={chipClass(board === b.key)}
            >
              {t(b.labelKey)}
            </button>
          ))}
        </div>
      )}
      {active.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-5" />
        </div>
      ) : active.isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          {t("skills.market.loadFailed")}: {String(active.error)}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <ShoppingBagIcon className="size-7 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground">{t("common.noResults")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((s) => (
            <MarketCard key={s.id} skill={s} installed={installedRefs.has(s.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
