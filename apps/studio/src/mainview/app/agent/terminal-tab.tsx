import { useEffect, useRef, useState } from "react";
import { EraserIcon, RotateCcwIcon, SquareTerminalIcon } from "lucide-react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useAgentStore } from "@stores/agent";
import { useTerminalStore } from "@stores/terminal";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 终端页签：真实 PTY + xterm.js。
 *
 * 主进程负责起 shell 并把输出按帧推过来（`terminalData`），这里只做三件事：
 * 建会话、把增量写进 xterm、把键盘输入发回去。切页签 / 切会话都不杀 shell
 * —— 重新挂载时先用 store 里的缓冲把屏幕填回去。
 */
export function TerminalTab() {
  const t = useT();
  const workspace = useAgentStore((s) => s.workspace);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 只订阅几个标量：输出增量走 subscribeOutput 直通 xterm，不触发重渲染。
  const sessionCwd = useTerminalStore((s) => (sessionId ? s.sessions[sessionId]?.cwd : undefined));
  const sessionRunning = useTerminalStore((s) => (sessionId ? (s.sessions[sessionId]?.running ?? true) : true));
  const sessionExitCode = useTerminalStore((s) => (sessionId ? (s.sessions[sessionId]?.exitCode ?? null) : null));

  // xterm 实例只建一次；容器尺寸变化时重新 fit 并把新尺寸报给 PTY。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Cascadia Mono", "Roboto Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#0b0d12",
        foreground: "#e6e8ee",
        cursor: "#e6e8ee",
        selectionBackground: "#2a3040",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // 容器还没布局完，ResizeObserver 会补一次
    }
    xtermRef.current = term;
    fitRef.current = fit;

    const disposable = term.onData((data) => {
      const id = sessionIdRef.current;
      if (id) void rpcClient.writeTerminal({ id, data }).catch(() => {});
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = sessionIdRef.current;
      if (id) {
        void rpcClient.resizeTerminal({ id, cols: term.cols, rows: term.rows }).catch(() => {});
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      disposable.dispose();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // 起会话（或复用 store 里已有的那个：切页签回来不新开 shell）。
  useEffect(() => {
    let cancelled = false;
    const existingId = Object.keys(useTerminalStore.getState().sessions).find((id) => {
      const item = useTerminalStore.getState().sessions[id];
      return item?.running && item.cwd === workspace;
    });

    const attach = (id: string) => {
      sessionIdRef.current = id;
      setSessionId(id);
      const term = xtermRef.current;
      const info = useTerminalStore.getState().sessions[id];
      if (term && info) {
        // 先回放缓冲（可能是刚重挂载），再把待写增量倒进去。
        if (info.buffer) term.write(info.buffer);
        const pending = useTerminalStore.getState().takeOutput(id);
        if (pending) term.write(pending);
      }
      const cols = term?.cols ?? 80;
      const rows = term?.rows ?? 24;
      void rpcClient.resizeTerminal({ id, cols, rows }).catch(() => {});
      // 打开终端页签就能直接打字（xterm 的输入依赖它自己的隐藏 textarea 拿到焦点）。
      term?.focus();
    };

    if (existingId) {
      attach(existingId);
      return () => {
        cancelled = true;
      };
    }

    setStarting(true);
    const term = xtermRef.current;
    rpcClient
      .startTerminal({ cwd: workspace || undefined, cols: term?.cols ?? 80, rows: term?.rows ?? 24 })
      .then((info) => {
        if (cancelled) {
          void rpcClient.closeTerminal({ id: info.id }).catch(() => {});
          return;
        }
        useTerminalStore.getState().upsert({ id: info.id, cwd: info.cwd, shell: info.shell });
        attach(info.id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspace]);

  // 输出直通 xterm（不走 React 重渲染）：订阅前先补上缓冲里还没写进去的部分。
  useEffect(() => {
    if (!sessionId) return;
    const write = (data: string) => xtermRef.current?.write(data);
    const pending = useTerminalStore.getState().takeOutput(sessionId);
    if (pending) write(pending);
    return useTerminalStore.getState().subscribeOutput(sessionId, write);
  }, [sessionId]);

  const restart = () => {
    const id = sessionIdRef.current;
    if (id) void rpcClient.closeTerminal({ id }).catch(() => {});
    if (id) useTerminalStore.getState().remove(id);
    sessionIdRef.current = null;
    setSessionId(null);
    // 触发上面的 effect 重新开会话：改一下 key 需要 state 变化，这里直接手动起一个。
    void rpcClient
      .startTerminal({ cwd: workspace || undefined, cols: xtermRef.current?.cols ?? 80, rows: xtermRef.current?.rows ?? 24 })
      .then((info) => {
        useTerminalStore.getState().upsert({ id: info.id, cwd: info.cwd, shell: info.shell });
        sessionIdRef.current = info.id;
        setSessionId(info.id);
        xtermRef.current?.clear();
        void rpcClient
          .resizeTerminal({ id: info.id, cols: xtermRef.current?.cols ?? 80, rows: xtermRef.current?.rows ?? 24 })
          .catch(() => {});
      })
      .catch(() => {});
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0b0d12]">
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1">
        <SquareTerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground"
          title={sessionCwd ?? workspace}
        >
          {sessionCwd ?? workspace}
        </span>
        {sessionId && !sessionRunning && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-500">
            {t("agent.terminal.exited", { code: String(sessionExitCode ?? 0) })}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          tooltip={t("agent.terminal.clear")}
          onClick={() => xtermRef.current?.clear()}
        >
          <EraserIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          tooltip={t("agent.terminal.restart")}
          onClick={restart}
        >
          <RotateCcwIcon className="size-3.5" />
        </Button>
      </div>

      <div className={cn("relative min-h-0 flex-1", starting && "opacity-60")}>
        <div ref={containerRef} className="absolute inset-0 px-1 pt-1" />
        {error && (
          <p className="absolute inset-x-2 bottom-2 rounded-lg bg-destructive/15 px-2 py-1 text-[11px] text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
