// skills.sh 市场：榜单（HTML 解析）+ 搜索（JSON API）+ 结果缓存。
import type { SkillsShSkill, SkillsLeaderboard } from "../../shared/skills";
import { getCache, setCache } from "./store";

const BASE = "https://skills.sh";
const UA = "omnistudio-skills";
const TIMEOUT_MS = 15_000;
const LEADERBOARD_TTL = 5 * 60 * 1000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 skills.sh 页面：优先取 __NEXT_DATA__ 里的 JSON，正则兜底。 */
function parseLeaderboardHtml(html: string): SkillsShSkill[] {
  const out: SkillsShSkill[] = [];
  const seen = new Set<string>();
  const push = (s: SkillsShSkill) => {
    if (!s?.id || seen.has(s.id)) return;
    if (!s.source || !s.skillId) return;
    seen.add(s.id);
    out.push({
      id: s.id,
      skillId: s.skillId,
      name: s.name || s.skillId,
      source: s.source,
      installs: Number(s.installs) || 0,
    });
  };

  const nextData = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
  );
  if (nextData) {
    try {
      const json = JSON.parse(nextData[1] ?? "");
      const items =
        json?.props?.pageProps?.initialSkills?.skills?.items ??
        json?.props?.pageProps?.skills?.items ??
        json?.props?.pageProps?.initialSkills?.items ??
        [];
      if (Array.isArray(items)) {
        for (const it of items) {
          const s = normalizeSkillsshItem(it);
          if (s) push(s);
        }
      }
      if (out.length > 0) return out;
    } catch {}
  }
  // 正则兜底：抓 skillId / skill_id 字段对。
  const re = /\{"(?:skillId|skill_id)"\s*:\s*"((?:[^"\\]|\\.)*)"(?:[^}]*?"source"\s*:\s*"((?:[^"\\]|\\.)*)")?(?:[^}]*?"name"\s*:\s*"((?:[^"\\]|\\.)*)")?[^}]*"installs"\s*:\s*(\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const skillId = m[1] ?? "";
    const source = m[2] || "";
    if (!source || !skillId) continue;
    push({ id: `${source}/${skillId}`, skillId, name: m[3] || skillId, source, installs: Number(m[4] ?? 0) || 0 });
  }
  return out;
}

function normalizeSkillsshItem(it: any): SkillsShSkill | null {
  if (!it || typeof it !== "object") return null;
  const source = it.source ?? it.repo ?? it.owner_repo;
  const skillId = it.skillId ?? it.skill_id ?? it.slug ?? it.name;
  if (typeof source !== "string" || typeof skillId !== "string") return null;
  return {
    id: it.id && typeof it.id === "string" ? it.id : `${source}/${skillId}`,
    skillId,
    name: typeof it.name === "string" ? it.name : skillId,
    source,
    installs: Number(it.installs ?? it.install_count ?? 0) || 0,
  };
}

/** 拉取榜单（alltime / trending / hot），5 分钟缓存。 */
export async function fetchLeaderboard(board: SkillsLeaderboard): Promise<SkillsShSkill[]> {
  const key = `leaderboard_${board}`;
  const cached = getCache<SkillsShSkill[]>(key, LEADERBOARD_TTL);
  if (cached) return cached;
  const url = board === "alltime" ? `${BASE}/` : `${BASE}/${board}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`skills.sh ${board} HTTP ${res.status}`);
  const html = await res.text();
  const items = parseLeaderboardHtml(html);
  if (items.length === 0) throw new Error("skills.sh parse empty");
  setCache(key, items);
  return items;
}

/** 搜索（JSON API，limit 默认 60、上限 300）。 */
export async function searchSkillssh(query: string, limit = 60): Promise<SkillsShSkill[]> {
  const q = query.trim();
  if (!q) return [];
  const effective = Math.min(Math.max(1, limit), 300);
  const res = await fetchWithTimeout(
    `${BASE}/api/search?q=${encodeURIComponent(q)}&limit=${effective}`,
  );
  if (!res.ok) throw new Error(`skills.sh search HTTP ${res.status}`);
  const json = await res.json();
  const items: unknown[] = Array.isArray(json) ? json : (json?.skills ?? []);
  const out: SkillsShSkill[] = [];
  for (const it of items) {
    const s = normalizeSkillsshItem(it);
    if (s) out.push(s);
  }
  return out;
}
