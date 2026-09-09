type T = (key: string) => string;

/**
 * Map a raw backend startup error to a localized, actionable hint.
 * Returns null when the error is not a known class.
 */
export function serverErrorHint(t: T, error: string | null | undefined): string | null {
  if (!error) return null;
  if (/unknown model architecture|unsupported (model )?architecture/i.test(error)) {
    return t("server.error.hint.arch");
  }
  if (/not found on path|not found\. install with|vllm not found|sglang not found/i.test(error)) {
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
