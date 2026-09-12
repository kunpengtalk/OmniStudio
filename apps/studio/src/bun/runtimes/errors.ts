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
/**
 * 线程已经死掉的痕迹：`Exception in thread Thread-1 (_generate)`。
 *
 * mlx_lm.server 的模型是在后台线程里加载的（`ResponseGenerator._generate` 第一件事
 * 就是 load_default）。架构不认识时那个线程直接抛异常退出，而 HTTP 服务照常起来 ——
 * `/v1/models` 返回 200，就绪探测于是把它当成「跑起来了」，之后每次生图都石沉大海
 * （请求进了队列，已经没人消费）。启动阶段认出这个签名，就按启动失败处理。
 */
const DEAD_WORKER_PATTERN = /Exception in thread/i;
const UNSUPPORTED_TYPE_PATTERN = /Model type\s+(\S+)\s+not supported/i;

/** 从启动日志里认出「服务起来了但生成线程已死」，返回给界面看的说明；没有就返回 null。 */
export function extractDeadWorkerError(logs: string): string | null {
  const plain = logs.replace(ANSI_PATTERN, "");
  if (!DEAD_WORKER_PATTERN.test(plain)) return null;

  const modelType = UNSUPPORTED_TYPE_PATTERN.exec(plain)?.[1];
  if (modelType) {
    return (
      `mlx-lm 不认识这个模型的架构（model_type = ${modelType}），模型加载线程已经退出：` +
      "服务虽然起来了但不会出图。换一个 MLX 支持的模型，或升级 mlx-lm 后再试。"
    );
  }

  const traceback = [...plain.split("\n")]
    .reverse()
    .map((line) => line.trim())
    .find((line) => /^(?:\w*Error|Exception)\b.*:/.test(line));
  return traceback
    ? `MLX 的模型加载线程已退出，生成不可用：${traceback.slice(0, 200)}`
    : "MLX 的模型加载线程已退出，生成不可用（详见引擎日志）。";
}

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
