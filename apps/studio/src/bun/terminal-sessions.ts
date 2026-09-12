/**
 * 侧边面板里的终端：Bun 的伪终端（PTY）起一个真实 shell，
 * 键盘输入直接写进 PTY，输出按帧批量推给前端的 xterm.js ——
 * 交互式程序（`top`、`vi`、交互式 npm 提示）也能正常跑。
 *
 * 一个会话一个 shell：面板切走再切回来是同一个 shell（含回放缓冲），
 * 只有显式关闭或应用退出才杀进程。
 */
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";

export type TerminalSessionInfo = {
  id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  /** 已有输出（重连 / 切回页签时先补上，终端不会是空白的）。 */
  scrollback: string;
  running: boolean;
};

type DataListener = (payload: { id: string; data: string }) => void;
type ExitListener = (payload: { id: string; exitCode: number; signal: string | null }) => void;

const dataListeners = new Set<DataListener>();
const exitListeners = new Set<ExitListener>();

export function onTerminalData(cb: DataListener): () => void {
  dataListeners.add(cb);
  return () => dataListeners.delete(cb);
}

export function onTerminalExit(cb: ExitListener): () => void {
  exitListeners.add(cb);
  return () => exitListeners.delete(cb);
}

/** 回放缓冲上限（字符）：够看清上一个命令的结果，又不至于把内存吃光。 */
const MAX_SCROLLBACK = 200_000;
/** 输出按帧批量推送（≈30fps）：`yes` 这种刷屏命令不会把 IPC 打爆。 */
const FLUSH_INTERVAL_MS = 32;

type Session = {
  id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  term: Bun.Terminal;
  proc: Bun.Subprocess;
  /** 逐字节解码：UTF-8 被切成半个字符时不会解出乱码。 */
  decoder: TextDecoder;
  scrollback: string;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
};

const sessions = new Map<string, Session>();
let counter = 0;

/** 默认 shell：跟着用户环境走（zsh 是 macOS 默认），登录 shell 才能读到 PATH/别名。 */
function defaultShell(): { shell: string; args: string[] } {
  const shell = process.env.SHELL?.trim() || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const name = path.basename(shell);
  // zsh / bash 用 -l 走登录 shell（读 .zprofile / .zshrc），其它 shell 不加参数。
  return { shell, args: name === "zsh" || name === "bash" ? ["-l"] : [] };
}

/** 工作目录兜底：路径不存在（工作区被删）时退回家目录，终端不能起不来。 */
function resolveCwd(cwd: string | undefined): string {
  if (cwd && existsSync(cwd)) {
    try {
      if (statSync(cwd).isDirectory()) return path.resolve(cwd);
    } catch {
      // 权限等问题：退回默认目录
    }
  }
  return homedir();
}

export function startTerminal(input: {
  cwd?: string;
  cols?: number;
  rows?: number;
  /** 测试用：显式指定 shell 与参数。 */
  shell?: string;
  args?: string[];
}): TerminalSessionInfo {
  const cwd = resolveCwd(input.cwd);
  const fallback = defaultShell();
  const shell = input.shell?.trim() || fallback.shell;
  const args = input.args ?? (input.shell ? [] : fallback.args);
  const cols = Math.max(20, Math.min(500, Math.round(input.cols ?? 80)));
  const rows = Math.max(5, Math.min(300, Math.round(input.rows ?? 24)));
  const id = `term-${++counter}-${Date.now().toString(36)}`;

  const session: Session = {
    id,
    cwd,
    shell,
    cols,
    rows,
    // 下面几项在 term 回调里用到，先占位再补（回调是异步触发的，赋值时已就绪）。
    term: null as unknown as Bun.Terminal,
    proc: null as unknown as Bun.Subprocess,
    decoder: new TextDecoder("utf-8", { fatal: false }),
    scrollback: "",
    pending: "",
    flushTimer: null,
    running: true,
  };

  const flush = () => {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (!session.pending) return;
    const data = session.pending;
    session.pending = "";
    for (const cb of dataListeners) cb({ id, data });
  };

  const term = new Bun.Terminal({
    cols,
    rows,
    name: "xterm-256color",
    data(_terminal, bytes) {
      const text = session.decoder.decode(bytes, { stream: true });
      if (!text) return;
      session.scrollback = (session.scrollback + text).slice(-MAX_SCROLLBACK);
      session.pending += text;
      if (!session.flushTimer) session.flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    },
    exit() {
      flush();
      session.running = false;
      for (const cb of exitListeners) cb({ id, exitCode: 0, signal: null });
    },
  });
  session.term = term;

  const proc = Bun.spawn({
    cmd: [shell, ...args],
    cwd,
    terminal: term,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      // 让 shell 里的程序知道自己跑在一个交互式终端里（有些工具据此决定要不要上色）。
      LANG: process.env.LANG ?? "en_US.UTF-8",
    },
  });
  session.proc = proc;

  void proc.exited.then((code) => {
    flush();
    session.running = false;
    for (const cb of exitListeners) cb({ id, exitCode: code ?? 0, signal: null });
  });

  sessions.set(id, session);
  return {
    id,
    cwd,
    shell,
    cols,
    rows,
    scrollback: "",
    running: true,
  };
}

export function writeTerminal(id: string, data: string): boolean {
  const session = sessions.get(id);
  if (!session || session.term.closed) return false;
  session.term.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const session = sessions.get(id);
  if (!session || session.term.closed) return false;
  const c = Math.max(20, Math.min(500, Math.round(cols)));
  const r = Math.max(5, Math.min(300, Math.round(rows)));
  session.cols = c;
  session.rows = r;
  session.term.resize(c, r);
  return true;
}

export function closeTerminal(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.flushTimer) clearTimeout(session.flushTimer);
  try {
    session.proc.kill();
  } catch {
    // 进程已经退出
  }
  try {
    if (!session.term.closed) session.term.close();
  } catch {
    // 已经关掉了
  }
}

/** 应用退出 / 窗口关闭时统一收摊，别留下没人管的 shell。 */
export function closeAllTerminals(): void {
  for (const id of [...sessions.keys()]) closeTerminal(id);
}

export function listTerminals(): TerminalSessionInfo[] {
  return [...sessions.values()].map((session) => ({
    id: session.id,
    cwd: session.cwd,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    scrollback: session.scrollback,
    running: session.running,
  }));
}

export function getTerminal(id: string): TerminalSessionInfo | null {
  const session = sessions.get(id);
  if (!session) return null;
  return {
    id: session.id,
    cwd: session.cwd,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    scrollback: session.scrollback,
    running: session.running,
  };
}
