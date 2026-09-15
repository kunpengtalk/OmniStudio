import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
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
import { ARTIFACT_KIND_LABEL, artifactIcon, formatSize, kindFromName, WEB_KINDS } from "./artifact-meta";
import type { WorkspaceTreeNode } from "../../../bun/agent-artifacts";

/** 「网页」标记：这一类产出物点开是当页面渲染的，值得单独标出来。 */
function WebBadge() {
  const t = useT();
  return (
    <span
      className="pi-menu-badge"
      style={{
        background: "color-mix(in oklab, var(--ds-warning) 14%, transparent)",
        color: "var(--ds-warning)",
      }}
    >
      {t("agent.panel.webBadge")}
    </span>
  );
}

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
      <div className="wp-empty">
        <span className="wp-empty-mark">
          <ImageIcon size={18} aria-hidden />
        </span>
        <p className="wp-empty-title">{t("agent.panel.emptyArtifacts")}</p>
      </div>
    );
  }

  return (
    <div className="wp-scroll">
      <div className="artifact-list">
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            title={artifact.path}
            onClick={() => useAgentStore.getState().setPreview({ source: "artifact", artifactId: artifact.id })}
            className={`artifact-row${activeTabKey === `artifact:${artifact.id}` ? " active" : ""}`}
          >
            <span style={{ flex: "none", color: "var(--ds-text-muted)" }}>{artifactIcon(artifact.kind)}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="artifact-card-name" style={{ display: "block" }}>
                {artifact.path}
              </span>
              <span className="artifact-card-kind">
                {ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind}
                {formatSize(artifact.size) ? ` · ${formatSize(artifact.size)}` : ""}
              </span>
            </span>
            {WEB_KINDS.has(artifact.kind) ? <WebBadge /> : null}
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
  // 缩进走 padding-left：每层 12px，叶子节点再多让出一个箭头位，图标才对得齐。
  const indent = 8 + depth * 12;

  if (node.type === "dir") {
    return (
      <div>
        <button
          type="button"
          className="file-row"
          style={{ paddingLeft: indent }}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon size={12} className={`pi-caret${open ? " open" : ""}`} aria-hidden />
          {open ? (
            <FolderOpenIcon size={13} aria-hidden style={{ flex: "none", color: "var(--ds-warning)" }} />
          ) : (
            <FolderIcon size={13} aria-hidden style={{ flex: "none", color: "var(--ds-warning)" }} />
          )}
          <span className="file-row-name">{node.name}</span>
        </button>
        {open
          ? (node.children ?? []).map((child) => (
              <FileTreeNode key={child.path} node={child} depth={depth + 1} onPreview={onPreview} />
            ))
          : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="file-row"
      style={{ paddingLeft: indent + 14 }}
      title={web ? t("agent.panel.openAsPage") : node.path}
      onClick={() => onPreview(node)}
    >
      <FileIcon size={12} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
      <span className="file-row-name">{node.name}</span>
      {web ? <WebBadge /> : null}
      <span className="file-row-meta">{formatSize(node.size)}</span>
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
      <div className="wp-empty">
        <Loader2Icon size={16} className="animate-spin" aria-hidden />
      </div>
    );
  }

  const nodes = filesQuery.data?.nodes ?? [];
  if (nodes.length === 0) {
    return (
      <div className="wp-empty">
        <span className="wp-empty-mark">
          <FolderIcon size={18} aria-hidden />
        </span>
        <p className="wp-empty-title">{t("agent.panel.emptyFiles")}</p>
      </div>
    );
  }

  return (
    <div className="wp-scroll">
      <div className="file-tree">
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
    </div>
  );
}
