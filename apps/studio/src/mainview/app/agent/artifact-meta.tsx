import {
  FileCode2Icon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  MusicIcon,
  VideoIcon,
} from "lucide-react";

import type { ArtifactItem } from "../../../bun/agent-artifacts";

/** 产出物类型 → 中文标签 / 图标 / 预览方式（消息卡片与右侧面板共用一套。 */
export const ARTIFACT_KIND_LABEL: Record<ArtifactItem["kind"], string> = {
  markdown: "Markdown",
  code: "代码",
  image: "图片",
  video: "视频",
  audio: "音频",
  pdf: "PDF",
  html: "网站 · HTML",
  text: "文本",
  other: "文件",
};

export function artifactIcon(kind: ArtifactItem["kind"]) {
  switch (kind) {
    case "image":
      return <FileImageIcon className="size-3.5 text-sky-600" />;
    case "video":
      return <VideoIcon className="size-3.5 text-violet-600" />;
    case "audio":
      return <MusicIcon className="size-3.5 text-emerald-600" />;
    case "code":
      return <FileCode2Icon className="size-3.5 text-amber-600" />;
    case "html":
      return <FileCode2Icon className="size-3.5 text-orange-600" />;
    case "markdown":
    case "text":
      return <FileTextIcon className="size-3.5 text-muted-foreground" />;
    default:
      return <FileIcon className="size-3.5 text-muted-foreground" />;
  }
}

export function formatSize(size: number | null | undefined): string {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 能当网页打开的（HTML / SVG）：用 iframe 渲染。 */
export const WEB_KINDS = new Set(["html"]);
/** 用原生元素预览的媒体类型。 */
export const MEDIA_KINDS = new Set(["image", "video", "audio", "pdf"]);

/** 从文件名猜类型（工作区文件树里的文件没有登记过 kind）。 */
export function kindFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["html", "htm"].includes(ext)) return "html";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "flac", "ogg"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (
    ["json", "yml", "yaml", "toml", "xml", "ts", "tsx", "js", "jsx", "py", "rs", "go", "sh", "css"].includes(ext)
  ) {
    return "code";
  }
  return "text";
}
