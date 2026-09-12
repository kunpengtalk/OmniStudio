/**
 * Agent 产出物登记（OpenWork 的 artifacts 面板）：
 * 工具写出的文件、生成的图片 / 语音 / 视频都在这里落一条，
 * 会话右侧面板据此列出 + 预览，"agent 到底产出了什么"一眼可见。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { and, desc, eq } from "drizzle-orm";

import { db } from "./db";
import { agentArtifacts } from "./db/schema";

export type ArtifactKind =
  | "markdown"
  | "code"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "html"
  | "text"
  | "other";

export type ArtifactItem = {
  id: number;
  conversationId: number;
  messageId: number | null;
  path: string;
  absPath: string;
  title: string;
  kind: ArtifactKind;
  size: number | null;
  tool: string | null;
  createdAt: number;
};

export type ArtifactRow = typeof agentArtifacts.$inferSelect;

type Listener = (payload: { conversationId: number; artifact: ArtifactItem }) => void;
const listeners = new Set<Listener>();

export function onArtifactRecorded(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const EXT_KINDS: Record<string, ArtifactKind> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  bmp: "image",
  svg: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  flac: "audio",
  ogg: "audio",
  pdf: "pdf",
  html: "html",
  htm: "html",
  csv: "text",
  tsv: "text",
  txt: "text",
  log: "text",
  json: "code",
  yml: "code",
  yaml: "code",
  toml: "code",
  xml: "code",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  py: "code",
  rb: "code",
  rs: "code",
  go: "code",
  java: "code",
  kt: "code",
  swift: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  php: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  sql: "code",
  css: "code",
  scss: "code",
  less: "code",
  vue: "code",
  svelte: "code",
  graphql: "code",
  proto: "code",
};

export function artifactKindFor(filePath: string): ArtifactKind {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return EXT_KINDS[ext] ?? "other";
}

/**
 * 登记一个产出物。同名文件重复写入时更新既有记录（时间与体积），
 * 这样面板里看到的是"这个文件被 agent 改了"，而不是一堆重复条目。
 */
export function recordArtifact(input: {
  conversationId: number;
  messageId?: number | null;
  /** 工作区相对路径或绝对路径。 */
  filePath: string;
  workspace: string;
  tool: string;
}): ArtifactItem | null {
  const abs = path.isAbsolute(input.filePath)
    ? path.resolve(input.filePath)
    : path.resolve(input.workspace, input.filePath);
  let size: number | null = null;
  try {
    if (existsSync(abs) && statSync(abs).isFile()) size = statSync(abs).size;
  } catch {
    size = null;
  }
  const relative = path.isAbsolute(input.filePath)
    ? input.filePath
    : path.relative(input.workspace, abs) || path.basename(abs);

  const existing = db
    .select()
    .from(agentArtifacts)
    .where(and(eq(agentArtifacts.absPath, abs), eq(agentArtifacts.conversationId, input.conversationId)))
    .orderBy(desc(agentArtifacts.id))
    .limit(1)
    .get();

  if (existing) {
    db.update(agentArtifacts)
      .set({ size, createdAt: Date.now(), tool: input.tool, messageId: input.messageId ?? existing.messageId })
      .where(eq(agentArtifacts.id, existing.id))
      .run();
  } else {
    db.insert(agentArtifacts)
      .values({
        conversationId: input.conversationId,
        messageId: input.messageId ?? null,
        path: relative,
        absPath: abs,
        title: path.basename(abs),
        kind: artifactKindFor(abs),
        size,
        tool: input.tool,
      })
      .run();
  }

  const item = findArtifact(input.conversationId, abs);
  if (item) for (const cb of listeners) cb({ conversationId: input.conversationId, artifact: item });
  return item;
}

function findArtifact(conversationId: number, absPath: string): ArtifactItem | null {
  const row = db
    .select()
    .from(agentArtifacts)
    .where(and(eq(agentArtifacts.absPath, absPath), eq(agentArtifacts.conversationId, conversationId)))
    .orderBy(desc(agentArtifacts.id))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    path: row.path,
    absPath: row.absPath,
    title: row.title,
    kind: row.kind,
    size: row.size,
    tool: row.tool,
    createdAt: row.createdAt ?? Date.now(),
  };
}

export function listArtifacts(conversationId: number): ArtifactItem[] {
  return db
    .select()
    .from(agentArtifacts)
    .where(eq(agentArtifacts.conversationId, conversationId))
    .orderBy(desc(agentArtifacts.createdAt), desc(agentArtifacts.id))
    .all()
    .map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      messageId: row.messageId,
      path: row.path,
      absPath: row.absPath,
      title: row.title,
      kind: row.kind,
      size: row.size,
      tool: row.tool,
      createdAt: row.createdAt ?? Date.now(),
    }));
}

export function deleteArtifact(id: number): void {
  db.delete(agentArtifacts).where(eq(agentArtifacts.id, id)).run();
}

/** 按 id 取一条产出物（面板点开预览时用）。 */
export function getArtifact(id: number): ArtifactItem | null {
  const row = db.select().from(agentArtifacts).where(eq(agentArtifacts.id, id)).get();
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    path: row.path,
    absPath: row.absPath,
    title: row.title,
    kind: row.kind,
    size: row.size,
    tool: row.tool,
    createdAt: row.createdAt ?? Date.now(),
  };
}

const TEXTUAL: ArtifactKind[] = ["markdown", "code", "text", "html", "other"];
const MAX_PREVIEW_CHARS = 400_000;

export type ArtifactContent = {
  kind: ArtifactKind;
  /** 文本内容（二进制类型为 null）。 */
  text: string | null;
  /** 二进制类型的前端加载地址（views:// 之外的本地文件走 file 协议由主进程决定）。 */
  dataUrl: string | null;
  truncated: boolean;
  size: number;
};

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
  pdf: "application/pdf",
};

/** 读取产出物内容：文本直接给内容，图片 / 音频 / 视频 / PDF 给 data URL（面板内直接预览）。 */
export function readArtifact(absPath: string, maxChars = MAX_PREVIEW_CHARS): ArtifactContent {
  const kind = artifactKindFor(absPath);
  const stat = statSync(absPath);
  const size = stat.size;
  if (TEXTUAL.includes(kind)) {
    const raw = readFileSync(absPath, "utf8");
    const truncated = raw.length > maxChars;
    return {
      kind,
      text: truncated ? `${raw.slice(0, maxChars)}\n…(truncated)` : raw,
      dataUrl: null,
      truncated,
      size,
    };
  }
  const ext = path.extname(absPath).replace(/^\./, "").toLowerCase();
  const mime = MIME[ext];
  // 大文件（>64MB）不做内联预览，避免把整个 webview 拖死。
  if (!mime || size > 64 * 1024 * 1024) {
    return { kind, text: null, dataUrl: null, truncated: false, size };
  }
  const base64 = Buffer.from(readFileSync(absPath)).toString("base64");
  return { kind, text: null, dataUrl: `data:${mime};base64,${base64}`, truncated: false, size };
}

export type WorkspaceTreeNode = {
  name: string;
  /** 相对工作区的路径。 */
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: WorkspaceTreeNode[];
};

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".gradle",
  "target",
  "Pods",
  "DerivedData",
]);

/**
 * 工作区文件树（产出物面板的「文件」页签）。
 * 深度与条目数都受限：这是给人看的浏览器，不是全量索引。
 */
export function workspaceTree(root: string, maxDepth = 4, maxEntries = 2000): WorkspaceTreeNode[] {
  let budget = maxEntries;
  const walk = (dir: string, depth: number): WorkspaceTreeNode[] => {
    if (depth > maxDepth || budget <= 0) return [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const nodes: WorkspaceTreeNode[] = [];
    for (const name of entries.sort()) {
      if (budget <= 0) break;
      if (name.startsWith(".") && name !== ".env.example") continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue;
        budget -= 1;
        const children = walk(full, depth + 1);
        nodes.push({
          name,
          path: path.relative(root, full),
          type: "dir",
          children,
        });
      } else if (stat.isFile()) {
        budget -= 1;
        nodes.push({ name, path: path.relative(root, full), type: "file", size: stat.size });
      }
    }
    // 目录在前，各自按名字排序
    return nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
  };
  return walk(root, 0);
}

/** 工作区内的文本文件读取（文件页签点开预览用；只允许工作区内）。 */
export function readWorkspaceFile(root: string, relativePath: string): ArtifactContent {
  const abs = path.resolve(root, relativePath);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error("Path outside workspace");
  }
  if (!existsSync(abs)) throw new Error("File not found");
  return readArtifact(abs);
}
