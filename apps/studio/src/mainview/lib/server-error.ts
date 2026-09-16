type T = (key: string) => string;

/**
 * 这条启动失败是不是「推理引擎没装」这一类。
 *
 * 单独暴露给界面用：本地模型页碰到这种错误时要直接把「一键安装」摆到报错旁边，
 * 而不是只念一句 `brew install llama.cpp` —— 已经装过模型、走完了引导页的机器
 * 不会再去引导页，光给命令用户找不到界面上的路（issue #8）。
 */
export function isEngineMissingError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /not found on path|not found\. install with|vllm not found|sglang not found|mlx 未安装/i.test(error);
}

/**
 * Map a raw backend startup error to a localized, actionable hint.
 * Returns null when the error is not a known class.
 */
export function serverErrorHint(t: T, error: string | null | undefined): string | null {
  if (!error) return null;
  if (/unknown model architecture|unsupported (model )?architecture/i.test(error)) {
    return t("server.error.hint.arch");
  }
  if (isEngineMissingError(error)) {
    return t("server.error.hint.engine");
  }
  if (/no model configured/i.test(error)) {
    return t("server.error.hint.noModel");
  }
  if (/timed out/i.test(error)) {
    return t("server.error.hint.timeout");
  }
  return null;
}

/** Backend persists assistant failure messages as "⚠️ <raw error>". Extract the raw error. */
export function persistedErrorMessage(content: string): string | null {
  if (!content.startsWith("⚠️")) return null;
  return content.slice(2).trim();
}
