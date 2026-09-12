// GitHub Release 版本检查：主进程（release-check.ts）与前端（about-tab）共用。

export const RELEASE_REPO = "kunpengtalk/OmniStudio";

export const RELEASE_REPO_URL = `https://github.com/${RELEASE_REPO}`;

export const RELEASES_URL = `${RELEASE_REPO_URL}/releases`;

export interface ReleaseInfo {
  version: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
}

export interface ReleaseCheckResult {
  currentVersion: string;
  channel: "stable" | "beta";
  /** true = 已是当前通道下最新版本（仓库没有 release 时为 false）。 */
  upToDate: boolean;
  /** 当前通道下最新 release；仓库还没有发布时为 null。 */
  latest: ReleaseInfo | null;
  checkedAt: number;
  error?: string;
}
