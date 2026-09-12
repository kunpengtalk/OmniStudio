const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const ERROR_LINE_PATTERN =
  /error|failed|unable to|not found|cannot|unknown|invalid|refused|denied|no such file|exiting due to/i;
/**
 * 警告不是失败原因，别把它当成错误展示。
 *
 * mlx-lm 加载模型时会打印
 * 「You are using a model of type qwen3_5_moe ... can yield errors.」这类 UserWarning，
 * 里面的 "errors" 会命中关键词 —— 服务器明明跑起来了，界面上却挂着一条「错误：…」，
 * 看起来就像启动失败（MLX 的这条最容易被误读）。
 */
const WARNING_LINE_PATTERN = /warn|notice|deprecat|can yield errors|not supported for all configurations/i;

/**
 * Pull the most relevant error out of a server's log output, so startup
 * failures surface a real reason (e.g. "unknown model architecture: 'spark2_5'")
 * instead of a bare "Process exited with code 1". Scans from the end of the
 * log, skipping our own `[server ...]` / `$ cmd` annotations, ANSI escapes and
 * warning lines.
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
    if (WARNING_LINE_PATTERN.test(line)) continue;
    if (ERROR_LINE_PATTERN.test(line)) return line.slice(0, 300);
  }
  return fallback;
}
