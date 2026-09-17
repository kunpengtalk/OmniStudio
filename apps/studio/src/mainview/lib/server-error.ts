import { classifyStartupError, type StartupErrorKind } from "../../shared/engine-errors";

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
 * 把后端给的启动错误映射成一句能照做的中文（或英文）提示。
 *
 * 分类的**唯一判据在 `shared/engine-errors.ts`**，主进程在失败时就把类型算好
 * （`ServedModelInfo.errorKind` / `getServerStatus().errorKind`），这里优先用它。
 * 拿不到类型时才就地分一次类 —— 用的是同一张规则表，所以同一个错误在聊天里、
 * 在控制台里、在模型页里给的建议不会各说各话（这正是以前那四个正则的老毛病：
 * 它们和主进程各判各的，`unknown model architecture` 之外几乎都认不出来）。
 *
 * 仍然就地判的两条不是「引擎启动失败」的类别，而是本应用自己的状态文案，
 * 所以留在分类器之外。
 */
export function serverErrorHint(
  t: T,
  error: string | null | undefined,
  kind?: StartupErrorKind,
): string | null {
  if (!error) return null;
  if (kind) return t(`engine.error.hint.${kind}`);

  const classified = classifyStartupError(error);
  if (classified !== "unknown") return t(`engine.error.hint.${classified}`);

  // 引擎没装不是「引擎启动失败」的类别（分类器认不出 `llama-server not found on PATH`
  // 这种原文），但它对用户是有用的一句：本地模型页据此在原文下面同时挂「一键安装」。
  if (isEngineMissingError(error)) return t("server.error.hint.engine");

  if (/no model configured/i.test(error)) return t("server.error.hint.noModel");
  if (/timed out/i.test(error)) return t("server.error.hint.timeout");
  return null;
}

/** 日志里的 ANSI 着色（llama.cpp 会给 `E` 行上红色）。 */
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/**
 * 「结论句」：加载失败时它总是最后一行，光看它等于什么都没说
 * （`exiting due to model loading error` 就是 issue #16 截图里那一句）。
 */
const SUMMARY_ONLY_RE = /exiting due to model loading error/i;

/** 像一行诊断错误：显式的错误级别（llama.cpp 的 `E srv`）或错误关键词。 */
const ERROR_LINE_RE = /(^|\s)E(\s|:)|\b(error|fatal|panic|failed|invalid|unsupported|unknown)\b/i;

function capLine(line: string, maxLength: number): string {
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}

/**
 * 从启动日志里取出**能定位问题的那一行**：第一条 error，而不是最后那句结论。
 *
 * issue #16 里报告者卡在「嵌入模型加载失败」，要定位就得看这一行的原文 ——
 * 它才写明是 `unknown model architecture`、还是 `wrong shape` / `invalid magic` /
 * 文件截断。两种日志的约定不一样，各按各的取：
 *
 * - 服务器日志（llama.cpp / vLLM 的 stdout）：结论就在第一条 error 行上；
 * - Python 栈：结论在**最后一行**（`Traceback` 之后第一条不缩进的行），
 *   中间那些 `File "...", line N` 是栈帧，没有信息量。
 *
 * 只有结论句时就把结论句给出去（好过 null）—— 至少说明日志确实到这里为止。
 */
export function firstErrorLine(logs: string | null | undefined, maxLength = 300): string | null {
  if (!logs) return null;
  const lines = logs.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());

  const tracebackAt = lines.findIndex((line) => /traceback \(most recent call last\)/i.test(line));
  if (tracebackAt >= 0) {
    const last = lines.slice(tracebackAt + 1).find((line) => line.trim() !== "" && !/^\s/.test(line));
    if (last) return capLine(last.trim(), maxLength);
  }

  const candidate = lines.find((line) => ERROR_LINE_RE.test(line) && !SUMMARY_ONLY_RE.test(line));
  if (candidate) return capLine(candidate.trim(), maxLength);

  const summary = lines.find((line) => SUMMARY_ONLY_RE.test(line));
  return summary ? capLine(summary.trim(), maxLength) : null;
}

/** Backend persists assistant failure messages as "⚠️ <raw error>". Extract the raw error. */
export function persistedErrorMessage(content: string): string | null {
  if (!content.startsWith("⚠️")) return null;
  return content.slice(2).trim();
}
