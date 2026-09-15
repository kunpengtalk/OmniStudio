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

/**
 * 每条消息下面该显示哪些产物（纯函数，界面只负责画）。
 *
 * 归属某条消息的产物归各自的消息；**没有归属**的一律挂到最后一条助手消息下面，
 * 排在它自己的产物后面。没有归属有两种来源：
 *   1. `message_id` 为空 —— 这个字段是后补的，自动化跑出来的与历史行都是 NULL
 *      （现代码在工具回调里现取消息 id，见 agent.ts 的 messageIdNow）；
 *   2. 归属的消息已经不在这屏里 —— 重跑过 / 被删掉的消息留下的产物。
 * 两种都不该只活在右侧面板里：产物是这一轮的成果，回答底下就得看得见，
 * 点一下才去右侧预览（用户不该为了找它去翻面板）。
 */
export function artifactsByMessage(
  artifacts: ArtifactItem[],
  messages: { id: number; role: string }[],
): Map<number, ArtifactItem[]> {
  const known = new Set(messages.map((message) => message.id));
  const map = new Map<number, ArtifactItem[]>();
  const unowned: ArtifactItem[] = [];
  for (const artifact of artifacts) {
    if (artifact.messageId == null || !known.has(artifact.messageId)) unowned.push(artifact);
    else {
      const bucket = map.get(artifact.messageId);
      if (bucket) bucket.push(artifact);
      else map.set(artifact.messageId, [artifact]);
    }
  }
  if (unowned.length === 0) return map;
  // 最后一条助手消息（不是"最后一条消息"：用户刚发完那一轮时最后一条是用户消息）。
  let lastAssistant: number | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "assistant") {
      lastAssistant = message.id;
      break;
    }
  }
  if (lastAssistant == null) return map;
  const bucket = map.get(lastAssistant) ?? [];
  // 按登记顺序（id 升序）追加：产物的先后就是它干活的先后。
  map.set(
    lastAssistant,
    [...bucket, ...unowned.slice().sort((a, b) => a.id - b.id)],
  );
  return map;
}

/** 最后一条助手消息的 id（产出物兜底与「查看所有产物」挂在它下面）。 */
export function lastAssistantMessageId(messages: { id: number; role: string }[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "assistant") return message.id;
  }
  return null;
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
