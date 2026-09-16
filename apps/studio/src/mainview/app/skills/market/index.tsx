import { useEffect, useState } from "react";
import { SearchIcon, XIcon, GitBranchIcon, ShoppingBagIcon, FolderInputIcon, RadarIcon } from "lucide-react";
import { Input } from "@ui/input";
import { ScrollArea } from "@ui/scroll-area";
import { useT } from "@stores/ui-lang";
import { useSkillsStore, type SkillsMarketTab } from "@stores/skills";
import { SegmentedControl, Toolbar } from "../parts";
import { MarketplacePane } from "./marketplace-pane";
import { GitImportPane } from "./git-import-pane";
import { LocalImportPane } from "./local-import-pane";
import { ScanPane } from "./scan-pane";

const MARKET_TABS = [
  { value: "marketplace", labelKey: "skills.market.tab", icon: <ShoppingBagIcon className="size-3.5" /> },
  { value: "git", labelKey: "skills.market.git", icon: <GitBranchIcon className="size-3.5" /> },
  { value: "local", labelKey: "skills.market.local", icon: <FolderInputIcon className="size-3.5" /> },
  { value: "scan", labelKey: "skills.market.scan", icon: <RadarIcon className="size-3.5" /> },
] as const;


export function MarketTab() {
  const t = useT();
  const tab = useSkillsStore((s) => s.marketTab);
  const setTab = useSkillsStore((s) => s.setMarketTab);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 450);
    return () => clearTimeout(timer);
  }, [searchInput]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar icon={<ShoppingBagIcon className="size-4 text-muted-foreground" />} title={t("skills.nav.market")}>
        {tab === "marketplace" && (
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("skills.market.searchPlaceholder")}
              className="h-8 w-56 pl-8 text-xs"
            />
            {searchInput && (
              <button
                type="button"
                aria-label={t("common.cancel")}
                onClick={() => setSearchInput("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </Toolbar>
      <div className="shrink-0 px-4 py-2">
        <SegmentedControl<SkillsMarketTab>
          value={tab}
          onChange={setTab}
          options={MARKET_TABS.map((x) => ({ value: x.value as SkillsMarketTab, label: t(x.labelKey), icon: x.icon }))}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {tab === "marketplace" && <MarketplacePane search={search} />}
        {tab === "git" && <GitImportPane />}
        {tab === "local" && <LocalImportPane />}
        {tab === "scan" && <ScanPane />}
      </ScrollArea>
    </div>
  );
}
