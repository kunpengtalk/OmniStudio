export const IMAGE_SERVER_PORT = 19782;
/**
 * 图片服务只监听回环地址：它无鉴权地提供文档页图、聊天图片、生成图与 TTS 音频，
 * 绑到 0.0.0.0 会让同网段任何人直接下载这些文件。
 */
export const IMAGE_SERVER_HOST = "127.0.0.1";
/**
 * 媒体服务实际监听的端口。
 *
 * 平时就是 `IMAGE_SERVER_PORT`；只有测试进程（`NODE_ENV=test`，见 test-preload.ts）可以用
 * `OMNI_IMAGE_SERVER_PORT` 换一个：本地开着应用时 19782 被占，路由冒烟测试会整段跳过，
 * 那正是最需要跑它们的时候（媒体 403 就是这类"没人跑到"的路由里漏掉的）。
 *
 * 注意 webview 读不到主进程的 env（CEF 渲染进程），所以这个覆盖**仅限测试**：
 * 正式运行必须让所有进程用同一个常量，否则 URL 与真实端口会各说各话。
 */
export function imageServerPort(): number {
  if (process.env.NODE_ENV === "test") {
    const override = Number(process.env.OMNI_IMAGE_SERVER_PORT);
    if (Number.isInteger(override) && override > 0 && override < 65536) return override;
  }
  return IMAGE_SERVER_PORT;
}
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
  return `${mediaBase()}/${ref}`;
}

/**
 * 媒体地址基址覆盖。
 *
 * 桌面端永远用回环地址；网页端（浏览器里跑同一份前端）连不上宿主的 127.0.0.1，
 * 由它在启动时设成 `<当前站点>/media` —— 网关上有一条带鉴权的媒体代理。
 * 不设就是原来的行为，所以对桌面端零影响。
 */
let mediaBaseOverride: string | null = null;

export function setMediaBaseOverride(base: string | null): void {
  mediaBaseOverride = base ? base.replace(/\/+$/, "") : null;
}

function mediaBase(): string {
  return mediaBaseOverride ?? `http://${IMAGE_SERVER_HOST}:${imageServerPort()}`;
}

/**
 * 产出物在右侧面板里的预览地址（本地回环文件服务，见 bun/image-server.ts）：
 * HTML 直接当网页加载，同目录的相对 css/js/图片也会一起请求到。
 */
export function artifactPreviewUrl(artifactId: number, version?: number): string {
  const suffix = version == null ? "" : `?v=${version}`;
  return `${mediaBase()}/artifact/${artifactId}${suffix}`;
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
  return `${mediaBase()}/workspace/${rootId}/${encoded}${suffix}`;
}
