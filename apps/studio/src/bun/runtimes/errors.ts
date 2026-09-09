const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const ERROR_LINE_PATTERN =
  /error|failed|unable to|not found|cannot|unknown|invalid|refused|denied|no such file|exiting due to/i;

/**
 * Pull the most relevant error out of a server's log output, so startup
 * failures surface a real reason (e.g. "unknown model architecture: 'spark2_5'")
 * instead of a bare "Process exited with code 1". Scans from the end of the
 * log, skipping our own `[server ...]` / `$ cmd` annotations and ANSI escapes.
 */
export function extractStartupError(logs: string, fallback: string): string {
  const lines = logs
    .split("\n")
    .map((line) => line.replace(ANSI_PATTERN, "").trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith("[") || line.startsWith("$")) continue;
    if (ERROR_LINE_PATTERN.test(line)) return line.slice(0, 300);
  }
  return fallback;
}
