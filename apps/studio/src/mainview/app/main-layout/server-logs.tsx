import { useEffect, useRef, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { PlayIcon, SquareIcon, RotateCcwIcon } from "lucide-react";
import Ansi from "ansi-to-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Spinner } from "@ui/spinner";
import { useServerStore } from "@stores/server";
import {
  Terminal,
  TerminalHeader,
  TerminalTitle,
  TerminalActions,
  TerminalCopyButton,
  TerminalClearButton,
} from "@/components/ai-elements/terminal";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    stopped: "bg-muted-foreground/20 text-muted-foreground",
    starting: "bg-amber-500/20 text-amber-500",
    downloading: "bg-amber-500/20 text-amber-500",
    running: "bg-emerald-500/20 text-emerald-500",
    error: "bg-destructive/20 text-destructive",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${colors[status] ?? colors.stopped}`}
    >
      {status}
    </span>
  );
}

const ANSI_RENDER_LIMIT = 30_000;

function ServerTerminalContent({
  output,
  isStreaming,
}: {
  output: string;
  isStreaming: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [output]);

  // Only ANSI-parse the tail to keep rendering cheap
  const renderText =
    output.length > ANSI_RENDER_LIMIT ? output.slice(-ANSI_RENDER_LIMIT) : output;
  const truncated = output.length > ANSI_RENDER_LIMIT;

  return (
    <div
      className="max-h-none flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed"
      ref={containerRef}
    >
      <pre className="wrap-break-word whitespace-pre-wrap">
        {truncated && (
          <span className="text-zinc-600">
            {"… (earlier output trimmed)\n\n"}
          </span>
        )}
        <Ansi>{renderText}</Ansi>
        {isStreaming && (
          <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-zinc-100" />
        )}
      </pre>
    </div>
  );
}

export function ServerLogsScreen() {
  const status = useServerStore((s) => s.status);
  const logs = useServerStore((s) => s.logs);
  const clearLogs = useServerStore((s) => s.clearLogs);
  const setLogs = useServerStore((s) => s.setLogs);
  const setStatus = useServerStore((s) => s.setStatus);

  useEffect(() => {
    rpcClient.getServerStatus().then((data) => {
      setStatus(data.status);
      if (data.logs) setLogs(data.logs);
    });
  }, [setStatus, setLogs]);

  const startMutation = useMutation({
    mutationFn: () => rpcClient.startServer(),
  });

  const stopMutation = useMutation({
    mutationFn: () => rpcClient.stopServer(),
  });

  const restartMutation = useMutation({
    mutationFn: () => rpcClient.restartServer(),
  });

  const handleClear = () => {
    clearLogs();
    rpcClient.clearServerLogs();
  };

  const isRunning = status === "running";
  const isStarting = status === "starting" || status === "downloading";
  const isBusy = startMutation.isPending || stopMutation.isPending || restartMutation.isPending;

  const lineCount = useMemo(() => {
    if (!logs) return 0;
    return logs.split("\n").filter((l) => l.trim()).length;
  }, [logs]);

  return (
    <div className="flex h-full flex-col gap-3 px-6 pb-20">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Server</h2>
        <StatusBadge status={status} />
        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
          {lineCount} lines
        </span>
        <div className="flex-1" />

        {status === "stopped" || status === "error" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => startMutation.mutate()}
            disabled={isBusy}
          >
            {startMutation.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            Start
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => restartMutation.mutate()}
              disabled={isBusy || isStarting}
            >
              {restartMutation.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RotateCcwIcon data-icon="inline-start" />
              )}
              Restart
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => stopMutation.mutate()}
              disabled={isBusy}
            >
              {stopMutation.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SquareIcon data-icon="inline-start" />
              )}
              Stop
            </Button>
          </>
        )}
      </div>

      {/* Terminal */}
      <Terminal
        output={logs}
        isStreaming={isStarting || isRunning}
        autoScroll
        onClear={handleClear}
        className="min-h-0 flex-1"
      >
        <TerminalHeader>
          <TerminalTitle>Inference server</TerminalTitle>
          <TerminalActions>
            <TerminalCopyButton />
            <TerminalClearButton />
          </TerminalActions>
        </TerminalHeader>
        <ServerTerminalContent
          output={logs}
          isStreaming={isStarting || isRunning}
        />
      </Terminal>
    </div>
  );
}
