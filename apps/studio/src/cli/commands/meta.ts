import { APP_NAME } from "../data-dir";
import { rootVersion } from "../data-dir";
import { controlRequest } from "../client";

const REPO = "kunpengtalk/OmniStudio";

export async function cmdVersion() {
  // 源码运行时读仓库根 package.json；运行中的应用版本与其一致。
  const v = rootVersion();
  if (v) {
    console.log(`${APP_NAME} ${v}`);
    return;
  }
  const r = await controlRequest("ping", undefined, 2000);
  if (r.connected && r.ok && r.data?.version) {
    console.log(`${APP_NAME} ${r.data.version}`);
    return;
  }
  console.log(`${APP_NAME} (版本未知)`);
}

export async function cmdUpdate() {
  const current = rootVersion();
  console.log(`当前版本：${current ?? "未知"}`);
  let latest = "";
  try {
    // 仓库还没有 latest release 时 404，退回取 releases 列表的头一个。
    let release: { tag_name?: string } | null = null;
    let res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "omni" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status === 404) {
      res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "omni" },
        signal: AbortSignal.timeout(15_000),
      });
    }
    if (!res.ok) {
      console.log(`检查更新失败（HTTP ${res.status}）。`);
      return;
    }
    const body = (await res.json()) as { tag_name?: string } | { tag_name?: string }[];
    if (Array.isArray(body)) {
      release = body[0] ?? null;
    } else {
      release = body;
    }
    latest = (release?.tag_name ?? "").replace(/^v/, "");
    console.log(`最新版本：${latest || "暂无发布"}`);
    if (latest && current && latest !== current) {
      console.log(`有可用更新（${latest}）。`);
      console.log(`请在应用内更新，或从 GitHub Releases 下载：https://github.com/${REPO}/releases`);
    } else if (latest && current && latest === current) {
      console.log("已是最新版本。");
    } else if (!latest) {
      console.log(`仓库还没有发布版本：https://github.com/${REPO}/releases`);
    }
  } catch (err) {
    console.log(`检查更新失败：${String(err)}`);
  }
}
