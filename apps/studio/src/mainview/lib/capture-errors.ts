/**
 * 麦克风 / 摄像头申请失败 → 一句能照着做的提示。
 *
 * 为什么单开一个模块：`NotAllowedError` 的原始文案是
 * `The request is not allowed by the user agent or the platform in the current context`
 * —— 用户对着这句做不了任何事。而浏览器教程里那套解释（换 HTTPS、给 iframe 加
 * `allow="microphone"`、关掉广告拦截扩展）在**桌面客户端里全都不适用**：我们跑的是
 * Electrobun 的原生窗口、内容从本地 `views://` 加载，前两个条件天然成立。
 *
 * 于是真实成因只剩三种，提示直接指到该点的地方：
 *   - 系统隐私开关关着（macOS 在 TCC 层直接拒，连弹窗都没有）
 *   - 之前点过「不允许」，被 WebKit 按站点记住了
 *   - 设备不存在，或被别的程序占着
 *
 * 纯函数、不碰 DOM：界面层与单测共用同一份文案。
 */

/**
 * 采集失败时的现场快照（一行，进 app.log）。
 *
 * `NotAllowedError` 在桌面端至少三种成因，修法完全不同，而它们抛出的 message 一模一样：
 *   - 系统隐私开关关着 / 之前拒绝过且被 WebKit 记住 → 去系统设置改
 *   - **当前 URL 不是安全上下文**（`views://` 这类自定义 scheme 默认不算）→ 改代码
 *   - 没有任何采集设备 → 插设备
 * 所以把能分辨它们的字段都打出来：`secure` 是最关键的那一个 ——
 * 用户手势、iframe、HTTPS 这些问题在原生窗口里都可排除，但"自定义 scheme 不被当作
 * 安全上下文"只有这一处能看出来。
 */
export function describeCaptureContext(e: unknown): string {
  const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : "Unknown";
  const message = e instanceof Error ? e.message : String(e);
  const loc = typeof location !== "undefined" ? location : undefined;
  // navigator.userAgent 在 WKWebView 里能看出是原生壳还是浏览器。
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const nativeShell = /Electrobun|Electron|AppleWebKit/i.test(ua) && !/Chrome\/|Safari\/\d+\.\d+ Mobile/i.test(ua);
  return [
    `name=${name}`,
    `message=${message.slice(0, 160)}`,
    // 安全上下文：自定义 scheme 下 false 就是根因。
    `secure=${String(typeof isSecureContext !== "undefined" ? isSecureContext : "n/a")}`,
    `origin=${loc?.origin ?? "n/a"}`,
    `protocol=${loc?.protocol ?? "n/a"}`,
    `hasDevices=${String(typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia)}`,
    `nativeShell=${String(nativeShell)}`,
  ].join(" · ");
}

/** 麦克风（或录音）申请失败的提示。 */
export function describeMicFailure(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "麦克风被拒绝：请到「系统设置 → 隐私与安全性 → 麦克风」把 OmniStudio 打开（授权后需要重启本应用），再重新拨号。";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "没有找到可用的麦克风：请确认已连接麦克风，并在「系统设置 → 声音 → 输入」里选中它。";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "麦克风被其它程序占用：关掉正在录音的软件（会议 / 录音机等）后重试。";
  }
  return `无法打开麦克风：${e instanceof Error ? e.message : String(e)}`;
}

/**
 * 摄像头 / 屏幕共享申请失败的提示。
 *
 * 屏幕共享有一个与摄像头不同的分支：用户在系统选择器里点了「取消」也会抛
 * `NotAllowedError`，那是正常操作 —— 返回 null 表示"不用报错"。
 */
export function describeCaptureFailure(
  source: "camera" | "screen",
  e: unknown,
): string | null {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    if (source === "screen") return null;
    return "摄像头被拒绝：请到「系统设置 → 隐私与安全性 → 摄像头」把 OmniStudio 打开（授权后需要重启本应用），再重试。";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return source === "camera"
      ? "没有找到可用的摄像头：请确认已连接摄像头后重试。"
      : "没有可共享的屏幕：请确认显示器连接正常后重试。";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return `${source === "camera" ? "摄像头" : "屏幕"}被其它程序占用：关掉正在使用它的软件后重试。`;
  }
  return `无法打开${source === "camera" ? "摄像头" : "屏幕共享"}：${e instanceof Error ? e.message : String(e)}`;
}
