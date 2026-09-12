import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  ImageIcon,
  Loader2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { ARTIFACT_KIND_LABEL, artifactIcon, formatSize, kindFromName, WEB_KINDS } from "./artifact-meta";
import type { WorkspaceTreeNode } from "../../../bun/agent-artifacts";

/** 产出物列表：本次会话 agent 写出的文件 / 生成的媒体，点开进预览页签。 */
export function ArtifactsTab() {
  const t = useT();
  const artifacts = useAgentStore((s) => s.artifacts);
  const activeTabKey = useAgentStore((s) => {
    const tab = s.panelTabs[s.activeTabIndex];
    return tab?.kind === "artifact" ? `artifact:${tab.artifactId}` : "";
  });

  if (artifacts.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-10 text-center">
        <ImageIcon className="size-5 text-muted-foreground/50" />
        <p className="text-[11px] text-muted-foreground">{t("agent.panel.emptyArtifacts")}</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      <div className="flex flex-col gap-0.5">
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            onClick={() => useAgentStore.getState().setPreview({ source: "artifact", artifactId: artifact.id })}
            className={cn(
              "flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60",
              activeTabKey === `artifact:${artifact.id}` && "bg-muted",
            )}
          >
            <span className="mt-0.5 shrink-0">{artifactIcon(artifact.kind)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px]">{artifact.path}</span>
              <span className="block text-[10px] text-muted-foreground/70">
                {ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind}
                {formatSize(artifact.size) ? ` · ${formatSize(artifact.size)}` : ""}
              </span>
            </span>
            {WEB_KINDS.has(artifact.kind) && (
              <span className="mt-0.5 shrink-0 rounded bg-orange-500/10 px-1 text-[9px] text-orange-600">
                {t("agent.panel.webBadge")}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 工作区文件树（「文件」页签）。点文件进预览页签；HTML 会当网页打开。 */
function FileTreeNode({
  node,
  depth,
  onPreview,
}: {
  node: WorkspaceTreeNode;
  depth: number;
  onPreview: (node: WorkspaceTreeNode) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(depth < 1);
  const web = WEB_KINDS.has(kindFromName(node.name));

  if (node.type === "dir") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-muted/60"
          style={{ paddingLeft: 4 + depth * 10 }}
        >
          {open ? (
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          {open ? (
            <FolderOpenIcon className="size-3.5 shrink-0 text-amber-500" />
          ) : (
            <FolderIcon className="size-3.5 shrink-0 text-amber-500" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open &&
          (node.children ?? []).map((child) => (
            <FileTreeNode key={child.path} node={child} depth={depth + 1} onPreview={onPreview} />
          ))}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onPreview(node)}
      className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-muted/60"
      style={{ paddingLeft: 4 + depth * 10 + 14 }}
      title={web ? t("agent.panel.openAsPage") : node.path}
    >
      <FileIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {web && (
        <span className="shrink-0 rounded bg-orange-500/10 px-1 text-[9px] text-orange-600">
          {t("agent.panel.webBadge")}
        </span>
      )}
      <span className="shrink-0 text-[9px] text-muted-foreground/70">{formatSize(node.size)}</span>
    </button>
  );
}

export function FilesTab() {
  const t = useT();
  const workspace = useAgentStore((s) => s.workspace);
  const filesQuery = useQuery({
    queryKey: ["agent-workspace-files", workspace],
    queryFn: () => rpcClient.listWorkspaceFiles({ workspace: workspace || undefined }),
  });

  if (filesQuery.isLoading) {
    return (
      <div className="flex flex-1 justify-center py-6">
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const nodes = filesQuery.data?.nodes ?? [];
  if (nodes.length === 0) {
    return (
      <p className="py-6 text-center text-[11px] text-muted-foreground">{t("agent.panel.emptyFiles")}</p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-1.5">
      {nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={0}
          onPreview={(file) =>
            useAgentStore.getState().setPreview({
              source: "workspace",
              path: file.path,
              name: file.name,
              rootId: filesQuery.data?.rootId ?? "",
            })
          }
        />
      ))}
    </div>
  );
}
