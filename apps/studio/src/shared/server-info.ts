export const IMAGE_SERVER_PORT = 19782;
/**
 * 图片服务只监听回环地址：它无鉴权地提供文档页图、聊天图片、生成图与 TTS 音频，
 * 绑到 0.0.0.0 会让同网段任何人直接下载这些文件。
 */
export const IMAGE_SERVER_HOST = "127.0.0.1";
/** 本地推理服务器（llama.cpp / vLLM / SGLang）的默认端口。 */
export const DEFAULT_INFERENCE_PORT = "18080";
/**
 * 提示词库封面/视频的远程源。部署时把 vibedesign 的
 * `frontend/public/prompt-library` 内容放到该域根路径下即可。
 */
export const PROMPT_LIBRARY_MEDIA_ORIGIN = "https://kunpengtalk.com";

/**
 * 本机回环 Host / Origin 判定：本地无鉴权服务（图片服务、网关）用它挡 DNS rebinding
 * —— 网页把自己的域名解析到 127.0.0.1 后，Host/Origin 仍是攻击者域名。
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  const raw = (host ?? "").trim().toLowerCase();
  if (!raw) return false;
  const name = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : (raw.split(":")[0] ?? "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/** 请求是否来自本应用（webview / 本地进程）；外部网页的 http(s) Origin 一律拒绝。 */
export function isLocalOrigin(origin: string | null | undefined): boolean {
  const raw = (origin ?? "").trim().toLowerCase();
  if (!raw) return true; // 非浏览器请求（curl / 本地 agent）不带 Origin
  if (raw === "null") return true; // file:// 页面
  if (raw.startsWith("views://") || raw.startsWith("electrobun://")) return true;
  if (raw.startsWith("file://")) return true;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      return isLoopbackHost(new URL(raw).host);
    } catch {
      return false;
    }
  }
  return false;
}

export function chatImageUrl(ref: string): string {
  return `http://${IMAGE_SERVER_HOST}:${IMAGE_SERVER_PORT}/${ref}`;
}

/**
 * 产出物在右侧面板里的预览地址（本地回环文件服务，见 bun/image-server.ts）：
 * HTML 直接当网页加载，同目录的相对 css/js/图片也会一起请求到。
 */
export function artifactPreviewUrl(artifactId: number, version?: number): string {
  const suffix = version == null ? "" : `?v=${version}`;
  return `http://${IMAGE_SERVER_HOST}:${IMAGE_SERVER_PORT}/artifact/${artifactId}${suffix}`;
}

/** 工作区文件预览地址；rootId 由主进程登记（见 registerWorkspaceRoot）。 */
export function workspaceFilePreviewUrl(
  rootId: string,
  relativePath: string,
  version?: number,
): string {
  const encoded = relativePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const suffix = version == null ? "" : `?v=${version}`;
  return `http://${IMAGE_SERVER_HOST}:${IMAGE_SERVER_PORT}/workspace/${rootId}/${encoded}${suffix}`;
}
