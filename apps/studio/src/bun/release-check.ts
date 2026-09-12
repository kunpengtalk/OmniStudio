import { Updater } from "electrobun";
import { getSetting } from "./db/settings";
import {
  RELEASE_REPO,
  RELEASES_URL,
  type ReleaseCheckResult,
  type ReleaseInfo,
} from "../shared/release";

// GitHub 匿名 API 限流 60 次/h，检查结果缓存 10 分钟，避免反复切页触发限流。
const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: ReleaseCheckResult | null = null;
let inflight: Promise<ReleaseCheckResult> | null = null;

/** 去掉 v 前缀后按段数值比较（非数字段按 0 处理），返回 -1 / 0 / 1。 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((s) => parseInt(s, 10));
  const pb = b.replace(/^v/, "").split(".").map((s) => parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isNaN(pa[i]) ? 0 : pa[i]!;
    const y = Number.isNaN(pb[i]) ? 0 : pb[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
}

async function doCheck(): Promise<ReleaseCheckResult> {
  const channel: "stable" | "beta" = getSetting("UPDATE_CHANNEL") === "beta" ? "beta" : "stable";

  let currentVersion = "0.0.0";
  try {
    const localInfo = await Updater.getLocallocalInfo();
    if (localInfo.version) currentVersion = localInfo.version;
  } catch {
    // 拿不到本地版本时按 0.0.0 处理（任何已发布版本都视为更新）
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "omni-studio" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub API 返回 HTTP ${res.status}`);
    }
    const releases = (await res.json()) as GitHubRelease[];
    // stable 通道跳过 prerelease / 带连字符的 tag（如 v0.0.6-canary.1），beta 通道取最新一条。
    const pick = releases.find(
      (r) => channel === "beta" || (!r.prerelease && !(r.tag_name ?? "").includes("-")),
    );

    const result: ReleaseCheckResult = {
      currentVersion,
      channel,
      upToDate: false,
      latest: null,
      checkedAt: Date.now(),
    };
    if (pick?.tag_name) {
      const version = pick.tag_name.replace(/^v/, "");
      const latest: ReleaseInfo = {
        version,
        name: pick.name || pick.tag_name,
        body: pick.body ?? "",
        htmlUrl: pick.html_url || RELEASES_URL,
        publishedAt: pick.published_at ?? "",
      };
      result.latest = latest;
      result.upToDate = compareVersions(version, currentVersion) <= 0;
    }
    cached = result;
    return result;
  } catch (err) {
    // 失败不写缓存，避免一次网络抖动阻塞 10 分钟内的重试。
    const result: ReleaseCheckResult = {
      currentVersion,
      channel,
      upToDate: false,
      latest: null,
      checkedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
    return result;
  }
}

/**
 * 检查 GitHub 仓库是否有新 release。10 分钟内的重复调用直接返回缓存，
 * force=true 跳过缓存（用户手动点「检查更新」时）。
 */
export function checkGitHubRelease(force = false): Promise<ReleaseCheckResult> {
  if (!force && cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached);
  }
  if (inflight) return inflight;
  inflight = doCheck().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 返回上次检查结果（供页面首屏展示），从未检查过为 null。 */
export function getReleaseCheckResult(): ReleaseCheckResult | null {
  return cached;
}
