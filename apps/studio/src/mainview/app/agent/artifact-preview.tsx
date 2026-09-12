import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, FolderSearchIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Markdown } from "@components/markdown";
import { useAgentStore, type AgentPreviewTarget } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { artifactPreviewUrl, workspaceFilePreviewUrl } from "../../../shared/server-info";
import { artifactIcon, ARTIFACT_KIND_LABEL, formatSize, kindFromName, MEDIA_KINDS, WEB_KINDS } from "./artifact-meta";
import type { ArtifactItem } from "../../../bun/agent-artifacts";

/**
 * 产出物 / 工作区文件的预览：
 * - HTML 当网页加载（本地回环文件服务，相对路径的 css/js 也能取到），
 *   顶部给一行地址与「刷新 / 在浏览器打开 / 在访达显示」；
 * - 文本 / Markdown 内联渲染，图片 / 音视频 / PDF 用原生元素。
 * 面板可以拖宽，所以 HTML 能拉到接近浏览器的观感。
 */
export function ArtifactPreviewView({
  target,
  onClose,
}: {
  target: AgentPreviewTarget;
  /** 关闭这个预览页签（不传就只收起预览）。 */
  onClose?: () => void;
}) {
  const t = useT();
  const artifacts = useAgentStore((s) => s.artifacts);
  const [version, setVersion] = useState(() => Date.now());
  const [frameKey, setFrameKey] = useState(0);

  const artifact =
    target.source === "artifact" ? artifacts.find((item) => item.id === target.artifactId) ?? null : null;

  const artifactQuery = useQuery({
    queryKey: ["agent-artifact", artifact?.id, version],
    queryFn: () => rpcClient.readAgentArtifact({ artifactId: artifact?.id ?? 0 }),
    enabled: Boolean(artifact) && !WEB_KINDS.has(artifact?.kind ?? ""),
  });
  const workspaceQuery = useQuery({
    queryKey: ["agent-workspace-file", target.source === "workspace" ? target.path : null],
    queryFn: () => rpcClient.readWorkspaceFile({ path: target.source === "workspace" ? target.path : "" }),
    enabled: target.source === "workspace" && target.rootId !== "",
  });

  if (target.source === "artifact" && !artifact) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
        {t("agent.panel.noPreview")}
      </div>
    );
  }

  const title = artifact ? artifact.title : target.source === "workspace" ? target.name : "";
  const kind = artifact ? artifact.kind : kindFromName(title);
  const size = artifact ? artifact.size : (workspaceQuery.data?.size ?? null);
  const url =
    target.source === "artifact"
      ? artifactPreviewUrl(target.artifactId, version)
      : workspaceFilePreviewUrl(target.rootId, target.path, version);
  const isLoading = artifact ? artifactQuery.isLoading : workspaceQuery.isLoading;
  const text = artifact ? artifactQuery.data?.text : workspaceQuery.data?.text;
  const dataUrl = artifact ? artifactQuery.data?.dataUrl : workspaceQuery.data?.dataUrl;
  const isWeb = WEB_KINDS.has(kind);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <span className="shrink-0">{artifactIcon(kind as ArtifactItem["kind"])}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={title}>
          {title}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {artifact ? (ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind) : ""}
        </span>
        {size ? <span className="shrink-0 text-[10px] text-muted-foreground">{formatSize(size)}</span> : null}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground"
          tooltip={t("agent.panel.closePreview")}
          onClick={() => (onClose ? onClose() : useAgentStore.getState().setPreview(null))}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      {/* 地址行（对齐参考实现的预览工具条）：刷新 / 外部打开 / 定位文件 */}
      <div className="flex items-center gap-1 border-b bg-muted/20 px-2 py-1">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground"
          tooltip={t("agent.artifact.refresh")}
          onClick={() => {
            setVersion(Date.now());
            setFrameKey((v) => v + 1);
          }}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
        {target.source === "artifact" ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 text-muted-foreground"
              tooltip={t("agent.artifact.openExternal")}
              onClick={() =>
                rpcClient.openAgentArtifactExternal({ artifactId: target.artifactId }).catch(() => {})
              }
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 text-muted-foreground"
              tooltip={t("agent.artifact.reveal")}
              onClick={() => rpcClient.revealAgentArtifact({ artifactId: target.artifactId }).catch(() => {})}
            >
              <FolderSearchIcon className="size-3.5" />
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0 text-muted-foreground"
            tooltip={t("agent.artifact.openExternal")}
            onClick={() => window.open(url, "_blank")}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        )}
        <span
          className="min-w-0 flex-1 truncate rounded-md border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          title={url}
        >
          {artifact ? artifact.path : target.source === "workspace" ? target.path : ""}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {isWeb ? (
          // 不加 sandbox：产物是用户自己生成的页面，很多要靠 localStorage / 同源
          // 请求才能跑起来。iframe 的源是回环文件服务，与本应用的 views:// 页面跨源。
          // eslint-disable-next-line react/iframe-missing-sandbox -- 产物/地址是用户自己的页面，sandbox 会挡掉 localStorage 与同源请求；iframe 的源与本应用跨源
          <iframe
            key={`${title}-${frameKey}`}
            src={url}
            title={title}
            className="size-full border-0 bg-white"
          />
        ) : isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : MEDIA_KINDS.has(kind) && dataUrl ? (
          <div className="size-full overflow-auto p-2">
            {kind === "image" ? (
              <img src={dataUrl} alt={title} className="w-full rounded-lg border" />
            ) : kind === "video" ? (
              <video src={dataUrl} controls className="w-full rounded-lg border" />
            ) : kind === "audio" ? (
              <audio src={dataUrl} controls className="w-full" />
            ) : (
              <embed src={dataUrl} type="application/pdf" className="h-full min-h-96 w-full rounded-lg border" />
            )}
          </div>
        ) : KIND_MARKDOWN.has(kind) && text != null ? (
          <div className="size-full overflow-auto p-3">
            <Markdown content={text} />
          </div>
        ) : text != null ? (
          <pre className="size-full overflow-auto p-3 text-[11px] break-all whitespace-pre-wrap">{text}</pre>
        ) : (
          <p className="py-6 text-center text-[11px] text-muted-foreground">
            {t("agent.panel.noPreview")}
          </p>
        )}
      </div>
    </div>
  );
}

const KIND_MARKDOWN = new Set(["markdown"]);
