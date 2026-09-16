import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpcClient } from "@lib/rpc";
import { usePromptStore } from "@stores/prompt";
import { MyView } from "./my-view";
import { PlazaView } from "./plaza-view";
import { PromptDetailDialog } from "./detail-dialog";
import { PromptEditDialog } from "./edit-dialog";
import { JoinMineButton } from "./parts";
import type { PromptRow } from "../../../bun/prompt-library";

type Viewer = { kind: "plaza" | "mine"; items: PromptRow[]; index: number } | null;

export function PromptScreen() {
  const queryClient = useQueryClient();
  const { tab, setTab, setKind } = usePromptStore();

  // 「已加入我的提示词」集合 + 加入动作（卡片与详情浮层共用）
  const { data: keysData } = useQuery({
    queryKey: ["my-prompt-keys"],
    queryFn: () => rpcClient.listMyPromptSourceKeys(),
  });
  const addedKeys = useMemo(() => new Set(keysData?.keys ?? []), [keysData]);

  const joinMutation = useMutation({
    mutationFn: (sourceId: number) => rpcClient.importMyPromptFromPlaza({ sourceId }),
    onSuccess: async (res) => {
      if (!res.item) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-prompt-keys"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-stats"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompts"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-categories"] }),
      ]);
      setTab("mine");
      setKind(res.item.kind);
      setViewer({ kind: "mine", items: [res.item], index: 0 });
    },
  });

  const handleJoin = (item: PromptRow) => {
    if (addedKeys.has(item.key) || joinMutation.isPending) return;
    joinMutation.mutate(item.id);
  };

  const [viewer, setViewer] = useState<Viewer>(null);
  const closeViewer = () => setViewer(null);
  const openPlazaViewer = (items: PromptRow[], index: number) =>
    setViewer({ kind: "plaza", items, index });
  const openMineViewer = (items: PromptRow[], index: number) =>
    setViewer({ kind: "mine", items, index });
  const step = (delta: number) =>
    setViewer((v) =>
      v && v.items.length > 0
        ? { ...v, index: (v.index + delta + v.items.length) % v.items.length }
        : v,
    );

  // 键盘导航：Escape / ← / →
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!viewer) return;
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  const viewerItem = viewer ? viewer.items[viewer.index] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tab === "plaza" ? (
        <PlazaView
          addedKeys={addedKeys}
          joinPending={joinMutation.isPending}
          onJoin={handleJoin}
          onOpenViewer={openPlazaViewer}
        />
      ) : (
        <MyView onOpenViewer={openMineViewer} />
      )}

      {viewer && (
        <PromptDetailDialog
          items={viewer.items}
          index={viewer.index}
          onClose={closeViewer}
          onStep={step}
          footerExtra={
            viewer.kind === "plaza" && viewerItem ? (
              <JoinMineButton
                added={addedKeys.has(viewerItem.key)}
                busy={joinMutation.isPending}
                onClick={() => handleJoin(viewerItem)}
              />
            ) : undefined
          }
        />
      )}

      <PromptEditDialog />
    </div>
  );
}
