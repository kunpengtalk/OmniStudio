/**
 * 引擎安装日志的「终态行」判定。
 *
 * 主进程把安装过程的 stdout 按 80ms 窗口合批推送（见 `bun/throttle.ts`）：
 * 一次 `lines` 里可能有几十行，也可能只有一行。所以判定必须**逐行**做，
 * 不能拿整批字符串做 `includes`（一条日志里混进「安装失败」就会被误判）。
 *
 * 匹配的是三个引擎安装收尾时自己打的那行（生产方在 `bun/mlx-gen.ts` /
 * `bun/ppocr.ts` / `bun/ocr.ts`）：
 *
 * | 引擎 | 成功 | 失败 |
 * |---|---|---|
 * | mflux | `安装成功：mflux 0.9.0` / `安装成功` | `mflux 安装失败` |
 * | PaddleOCR | `安装成功：paddleocr 3.2.0` | `paddleocr 安装失败` |
 * | Tesseract | `tesseract 安装成功。` | `安装失败（退出码 1）` |
 *
 * 「以安装成功 / 安装失败**收尾**」是这里的判据 —— 安装过程中的中间行也会带这两个词，
 * 典型是 PaddleOCR 的 `默认 PyPI 源安装失败（退出码 1），改用清华镜像重试…`：
 * 它说的是"这次尝试失败、还在试"，不是安装结束。锚定行尾就把这类排除了。
 *
 * 界面只拿它决定「去刷新一次引擎状态」：误判的代价是多刷一次查询，不是错误结论 ——
 * 真正的完成信号是 RPC 的返回值（各页的 install mutation 自己会刷新）。
 */
const TERMINAL_SUCCESS = /安装成功(?:[：:].*)?[。.]?$/;
const TERMINAL_FAILURE = /安装失败(?:（退出码 \d+）)?[。.]?$/;

export function isInstallTerminalLine(line: string): boolean {
  const trimmed = line.trim();
  return TERMINAL_SUCCESS.test(trimmed) || TERMINAL_FAILURE.test(trimmed);
}

/** 整批里是否有终态行（有就说明这批里包含了安装收尾）。 */
export function hasInstallTerminalLine(lines: readonly string[]): boolean {
  return lines.some(isInstallTerminalLine);
}
