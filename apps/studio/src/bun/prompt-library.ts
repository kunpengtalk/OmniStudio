import { eq, sql, and, asc, desc } from "drizzle-orm";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { db } from "./db";
import { prompts as promptsTable, promptCategories as catsTable } from "./db/schema";
import { IMAGE_SERVER_PORT } from "../shared/server-info";
import {
  getPromptLibraryMediaBase,
  getPromptLibraryCacheBase,
  promptLibraryLocalUrl,
} from "./image-server";
import type { PromptKind } from "./db/schema";

export type { PromptKind } from "./db/schema";

// ---------------------------------------------------------------------------
// 提示词库媒体 URL 解析
// ---------------------------------------------------------------------------
//
// seed 数据里的媒体是 vibedesign 的相对路径（/prompt-library/...），原本指望把
// vibedesign 的 public/prompt-library 部署到自定义站点再回源，但实际上没有资源。
// 改为直接把各案例解析到各自的**公开云端来源**直链（Image2Hub / awesome-gpt-image-2
// / MiniMax H3 field notes / God），加载失败时前端调用 `ensurePromptMedia` 惰性下载
// 到本地缓存（<dataDir>/prompt-media/prompt-library）兜底。

// GitHub 仓库素材走 jsDelivr CDN（raw.githubusercontent 在本机网络下间歇性超时，
// jsDelivr 带缓存且允许热链，实测稳定）。
const CLOUD_ORIGINS = {
  image2hub: "https://image2hub.netlify.app/assets",
  awesome:
    "https://cdn.jsdelivr.net/gh/freestylefly/awesome-gpt-image-2@main/data/images",
  god: "https://cdn.jsdelivr.net/gh/LIUFelix2004/God-minmax-H3@main/assets/previews",
  h3: "https://h3-field-notes-production.up.railway.app/posters",
} as const;

/** Image2Hub 镜像目录：与 image2hub.netlify.app/assets 下的目录同构。 */
const IMG2HUB_DIRS = new Set([
  "app-icons",
  "kingkong-icons",
  "empty-states",
  "ops-c4d",
  "ops-kv",
  "posters",
  "illustration",
  "ip",
]);

/**
 * 把 seed 里的 `/prompt-library/...` 相对路径解析成原始公开源的云端直链；
 * 已是绝对地址则原样返回，解析不出返回 null。
 */
export function promptMediaCloudUrl(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/prompt-library/")) return raw;
  const rel = raw.slice("/prompt-library/".length);
  const slash = rel.indexOf("/");
  const top = slash === -1 ? rel : rel.slice(0, slash);
  const rest = slash === -1 ? "" : rel.slice(slash + 1);
  // awesome-gpt-image-2 案例图：GitHub raw 的 data/images/caseN.jpg
  if (top === "awesome") return `${CLOUD_ORIGINS.awesome}/${rest}`;
  if (top === "video") {
    // God 案例封面：GitHub raw 的 assets/previews/XX-name.webp（seed 里是 .jpg 镜像名）
    if (rest.startsWith("god/")) {
      const file = rest.slice("god/".length);
      return `${CLOUD_ORIGINS.god}/${file.replace(/\.jpg$/i, ".webp")}`;
    }
    // MiniMax H3 field notes：posters/{k}/{num}.jpg（case id 形如 x-2097561594540773563）
    if (rest.startsWith("sky/")) {
      const file = rest.slice("sky/".length); // x-2097561594540773563.jpg
      const m = /^([a-z0-9]+)-(.+)\.jpg$/i.exec(file);
      if (!m) return null;
      const kind = m[1]!;
      const rest2 = m[2]!;
      // 数字 id：posters/x/2097....jpg
      if (/^\d+$/.test(rest2)) return `${CLOUD_ORIGINS.h3}/${kind}/${rest2}.jpg`;
      // 具名 case：posters 第二段保留完整名字（实测 posters/x/x-xxx.jpg）；
      // 少数名字里没有数字的拿不到，交给下载兜底再查页面。
      return `${CLOUD_ORIGINS.h3}/${kind}/${file.replace(/\.jpg$/i, "")}.jpg`;
    }
    // xianyu（闲鱼）案例只在 tryminimax.asia 页面，无法稳定推导 -> 走下载兜底/占位
    if (rest.startsWith("xianyu/")) return null;
  }
  // 其余为 Image2Hub 镜像目录：与 image2hub.netlify.app/assets 同构
  if (IMG2HUB_DIRS.has(top)) return `${CLOUD_ORIGINS.image2hub}/${rel}`;
  return null;
}

/** 已有本地缓存 / 开发机 vibedesign 素材时优先本地，否则用云端直链。 */
export function mediaUrl(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/prompt-library/")) return raw; // 已是绝对地址
  const rel = raw.slice("/prompt-library/".length);
  // 已下载过的本地缓存优先（离线也能看）
  if (existsSync(join(getPromptLibraryCacheBase(), rel))) return promptLibraryLocalUrl(rel);
  // 开发机上有 vibedesign 素材目录时由本地 image-server 静态服务
  if (getPromptLibraryMediaBase()) return `http://localhost:${IMAGE_SERVER_PORT}${raw}`;
  return promptMediaCloudUrl(raw);
}

// ---------------------------------------------------------------------------
// 种子数据：首次启动时把随包分发的 JSON 灌入本地 SQLite（幂等）
// ---------------------------------------------------------------------------

const SEED_FILES: { kind: PromptKind; file: string }[] = [
  { kind: "image", file: "image-prompts.json" },
  { kind: "video", file: "video-prompts.json" },
  { kind: "llm", file: "llm-prompts.json" },
];

/** 数据库里 prompt 数量；供前端展示。 */
export function countPromptsByKind(): Record<PromptKind, number> {
  const rows = db
    .select({ kind: promptsTable.kind, n: sql<number>`count(*)` })
    .from(promptsTable)
    .groupBy(promptsTable.kind)
    .all();
  const out: Record<PromptKind, number> = { image: 0, llm: 0, video: 0 };
  for (const r of rows) out[r.kind as PromptKind] = r.n;
  return out;
}

/**
 * 增量灌入：每次启动按 key / 分类去重，只插入库里还没有的条目（幂等）。
 * 这样已有数据的安装也能补齐随版本新增的提示词，且不触碰既有记录。
 */
export function seedIfNeeded(): void {
  for (const { kind, file } of SEED_FILES) {
    const path = join(import.meta.dir, "prompt-library/seed", file);
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as {
        categories?: { name: string; intro?: string }[];
        items?: Record<string, unknown>[];
      };

      const items = data.items ?? [];
      if (items.length === 0) continue;

      const existingKeys = new Set(
        db
          .select({ key: promptsTable.key })
          .from(promptsTable)
          .where(eq(promptsTable.kind, kind))
          .all()
          .map((r) => r.key),
      );
      const toInsert = items.filter((it) => !existingKeys.has(String(it.id)));
      if (toInsert.length === 0) continue;

      // 分类：表里没有的才补，sort 接在现有分类后面
      const existingCats = new Set(
        db
          .select({ name: catsTable.name })
          .from(catsTable)
          .where(eq(catsTable.kind, kind))
          .all()
          .map((c) => c.name),
      );
      const maxSort =
        db
          .select({ m: sql<number>`coalesce(max(${catsTable.sort}), -1)` })
          .from(catsTable)
          .where(eq(catsTable.kind, kind))
          .get()?.m ?? -1;
      let catIdx = 0;
      for (const c of data.categories ?? []) {
        if (existingCats.has(c.name)) continue;
        db.insert(catsTable)
          .values({ kind, name: c.name, intro: c.intro ?? "", sort: maxSort + 1 + catIdx })
          .run();
        existingCats.add(c.name);
        catIdx++;
      }

      db.transaction((tx) => {
        for (const it of toInsert) {
          tx.insert(promptsTable)
            .values({
              key: String(it.id),
              kind,
              category: String(it.category ?? ""),
              subcategory: it.subcategory ? String(it.subcategory) : null,
              name: String(it.name ?? ""),
              prompt: String(it.prompt ?? ""),
              summary: it.summary ? String(it.summary) : null,
              ratio: it.ratio ? String(it.ratio) : null,
              image: it.image ? String(it.image) : null,
              video: it.video ? String(it.video) : null,
              mode: it.mode ? String(it.mode) : null,
              duration: it.duration ? Number(it.duration) : null,
              playUrl: it.playUrl ? String(it.playUrl) : null,
              playLabel: it.playLabel ? String(it.playLabel) : null,
              source: it.source ? String(it.source) : null,
              sourceUrl: it.sourceUrl ? String(it.sourceUrl) : null,
              sourceLabel: it.sourceLabel ? String(it.sourceLabel) : null,
              featured: Number(it.featured) || 0,
            })
            .onConflictDoNothing()
            .run();
        }
      });
      console.log(`[prompt-library] seeded ${kind}: +${toInsert.length} prompts`);
    } catch (e) {
      console.warn(`[prompt-library] seed ${kind} failed: ${e}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export type PromptCategoryRow = {
  name: string;
  intro: string | null;
  count: number;
};

export type PromptRow = {
  id: number;
  key: string;
  kind: PromptKind;
  category: string;
  subcategory: string | null;
  name: string;
  prompt: string;
  summary: string | null;
  ratio: string | null;
  image: string | null;
  video: string | null;
  /** 未解析的原始媒体相对路径（如 `prompt-library/awesome/case544.jpg`），
   *  供前端在云端直链加载失败时调用 ensurePromptMedia 拉取本地缓存。 */
  mediaKey: string | null;
  playUrl: string | null;
  playLabel: string | null;
  source: string | null;
  sourceUrl: string | null;
  sourceLabel: string | null;
  featured: number;
  /** 从广场导入时对应的 prompts.key（仅我的提示词有值）。 */
  sourceKey?: string | null;
  /** 视频提示词的生成方式（文生视频 / 首尾帧 / 图生视频 …）。 */
  mode: string | null;
  /** 视频提示词的参考时长（秒）。 */
  duration: number | null;
};

export type PromptListParams = {
  kind: PromptKind;
  category?: string;
  search?: string;
  source?: string;
  limit?: number;
  offset?: number;
};

const PAGE_SIZE = 60;

/** 某类型下的分类列表（含条数）。 */
export function listCategories(kind: PromptKind): PromptCategoryRow[] {
  const cats = db.select().from(catsTable).where(eq(catsTable.kind, kind)).all();
  const counts = db
    .select({ category: promptsTable.category, n: sql<number>`count(*)` })
    .from(promptsTable)
    .where(eq(promptsTable.kind, kind))
    .groupBy(promptsTable.category)
    .all();
  const countMap = new Map(counts.map((c) => [c.category, c.n]));
  return cats.map((c) => ({
    name: c.name,
    intro: c.intro,
    count: countMap.get(c.name) ?? 0,
  }));
}

/** 分页列出提示词（按分类/来源/关键词过滤）。 */
export function listPrompts(params: PromptListParams): { items: PromptRow[]; total: number } {
  const { kind, category, source, search } = params;
  const limit = Math.min(params.limit ?? PAGE_SIZE, 200);
  const offset = params.offset ?? 0;

  const conds = [eq(promptsTable.kind, kind)];
  if (category) conds.push(eq(promptsTable.category, category));
  if (source) conds.push(eq(promptsTable.source, source));
  if (search?.trim()) {
    const kw = `%${search.trim()}%`;
    conds.push(
      sql`(${promptsTable.name} like ${kw} or ${promptsTable.subcategory} like ${kw} or ${promptsTable.summary} like ${kw} or ${promptsTable.prompt} like ${kw})`,
    );
  }

  const where = and(...conds);
  const items = db
    .select()
    .from(promptsTable)
    .where(where)
    .orderBy(desc(promptsTable.featured), asc(promptsTable.name))
    .limit(limit)
    .offset(offset)
    .all()
    .map(toRow);

  const totalRow = db
    .select({ n: sql<number>`count(*)` })
    .from(promptsTable)
    .where(where)
    .get();
  return { items, total: totalRow?.n ?? 0 };
}

function toRow(r: (typeof promptsTable.$inferSelect)): PromptRow {
  const mediaKey =
    r.image && r.image.startsWith("/prompt-library/") ? r.image.slice(1) : null;
  return {
    id: r.id,
    key: r.key,
    kind: r.kind,
    category: r.category,
    subcategory: r.subcategory,
    name: r.name,
    prompt: r.prompt,
    summary: r.summary,
    ratio: r.ratio,
    image: mediaUrl(r.image),
    video: mediaUrl(r.video),
    mediaKey,
    mode: r.mode,
    duration: r.duration,
    playUrl: r.playUrl,
    playLabel: r.playLabel,
    source: r.source,
    sourceUrl: r.sourceUrl,
    sourceLabel: r.sourceLabel,
    featured: r.featured,
  };
}

// ---------------------------------------------------------------------------
// 惰性下载媒体到本地缓存（云端直链加载失败时的兜底）
// ---------------------------------------------------------------------------

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** 校验下载内容确为图片（魔数校验；content-type 只用于排除回退页）。 */
function isImageBytes(buf: Uint8Array): boolean {
  if (buf.byteLength < 12) return false;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // RIFF (WebP)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  return false;
}

async function downloadToCache(url: string, rel: string): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) return false;
    // HTML/XML 之类的是站点回退页（如 SPA 对缺失资源的 200 响应），直接排除
    const ct = resp.headers.get("content-type") ?? "";
    if (/text\/html|application\/xml|application\/json/i.test(ct)) return false;
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength < 12 || buf.byteLength > MAX_MEDIA_BYTES) return false;
    if (!isImageBytes(buf)) return false;
    const dest = join(getPromptLibraryCacheBase(), rel);
    mkdirSync(dirname(dest), { recursive: true });
    await Bun.write(dest, buf);
    return true;
  } catch {
    return false;
  }
}

/** 云端直链拿不到时，尝试从案例页面解析真实媒体地址（少数特例）。 */
async function resolveSpecialMedia(rel: string): Promise<string | null> {
  // MiniMax H3 field notes 的具名 case：页面里带真实 poster 地址
  if (rel.startsWith("video/sky/")) {
    const file = rel.slice("video/sky/".length); // x-ivan-space-...jpg
    const m = /^([a-z0-9]+)-(.+)\.jpg$/i.exec(file);
    if (!m) return null;
    try {
      const resp = await fetch(
        `https://h3-field-notes-production.up.railway.app/cases/${m[1]}-${m[2]}/`,
        { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "Mozilla/5.0" } },
      );
      if (!resp.ok) return null;
      const html = await resp.text();
      const urls = [
        ...html.matchAll(
          /https:\/\/h3-field-notes-production\.up\.railway\.app\/posters\/[^\s"']+\.jpg/g,
        ),
      ];
      return urls[0]?.[0] ?? null;
    } catch {
      return null;
    }
  }
  // xianyu（闲鱼）案例：tryminimax.asia 的案例页按 prompt id 定位封面
  if (rel.startsWith("video/xianyu/")) {
    const file = rel.slice("video/xianyu/".length); // prompt-xxx.jpg
    const pid = file.replace(/^prompt-/, "").replace(/\.jpg$/i, "");
    try {
      const resp = await fetch("https://tryminimax.asia/minimax-h3-prompts", {
        signal: AbortSignal.timeout(20_000),
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      const i = html.indexOf(`id="prompt-${pid}"`);
      if (i < 0) return null;
      const m = /\/minimax\/prompts\/thumbs\/[^\s"']+\.jpg/.exec(html.slice(i, i + 3000));
      return m ? `https://tryminimax.asia${m[0]}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 惰性下载提示词库媒体到本地缓存（`<dataDir>/prompt-media/prompt-library/...`），
 * 返回可直接加载的本地 URL；下载失败（无所谓源）返回 null。由前端在云端直链
 * 加载失败时调用，成功后同一路径后续直接走 mediaUrl 的本地缓存分支。
 */
export async function ensurePromptMedia(mediaKey: string): Promise<string | null> {
  const rel = mediaKey
    .replace(/^\/+/, "")
    .replace(/^prompt-library\//, "");
  if (!rel || rel.includes("..") || rel.length > 300) return null;
  if (existsSync(join(getPromptLibraryCacheBase(), rel))) return promptLibraryLocalUrl(rel);
  const cloud = promptMediaCloudUrl(`/prompt-library/${rel}`);
  if (cloud && (await downloadToCache(cloud, rel))) return promptLibraryLocalUrl(rel);
  const special = await resolveSpecialMedia(rel);
  if (special && (await downloadToCache(special, rel))) return promptLibraryLocalUrl(rel);
  return null;
}
