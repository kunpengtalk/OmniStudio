import { ServerIcon } from "lucide-react";

import { Spinner } from "@ui/spinner";
import { Button } from "@ui/button";
import { ArrowLeftIcon } from "lucide-react";
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
} from "@/components/ai-elements/terminal";
import { useState } from "react";

export function SetupHeader<T extends string>({
  title,
  subtitle,
  steps,
  currentStep,
}: {
  title: string;
  subtitle: string;
  steps: T[];
  currentStep: T;
}) {
  return (
    <div className="mb-6 flex flex-col items-center gap-2">
      <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
        <ServerIcon className="size-5 text-primary" />
      </div>
      <h1 className="text-base font-semibold">{title}</h1>
      <p className="text-center text-xs text-muted-foreground">{subtitle}</p>
      <div className="mt-1 flex items-center gap-2">
        {steps.map((s) => (
          <div
            key={s}
            className={`h-1 w-6 rounded-full ${s === currentStep ? "bg-primary" : "bg-muted-foreground/30"}`}
          />
        ))}
      </div>
    </div>
  );
}

export function ModeCard({
  icon,
  label,
  description,
  selected,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex flex-col items-center gap-1 rounded-lg border px-3 py-3 text-center transition-colors ${
        selected ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/40"
      }`}
      onClick={onClick}
    >
      <div className={`${selected ? "text-primary" : "text-muted-foreground"}`}>{icon}</div>
      <span className="text-sm font-medium">{label}</span>
      <span className="text-[11px] text-muted-foreground">{description}</span>
    </button>
  );
}

export function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="ml-4 truncate text-xs font-medium">{value}</span>
    </div>
  );
}

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
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[status] ?? colors.stopped}`}
    >
      {status}
    </span>
  );
}

export function LocalStartStep({
  onBack,
  onStart,
  onComplete,
  serverStatus,
  serverLogs,
  startError,
  title = "llama-server",
}: {
  onBack: () => void;
  onStart: () => void;
  onComplete: () => void;
  serverStatus: string;
  serverLogs: string;
  startError?: string;
  title?: string;
}) {
  const [started, setStarted] = useState(false);

  const handleStart = () => {
    setStarted(true);
    onStart();
  };

  const isReady = serverStatus === "running";
  const isFailed = serverStatus === "error";
  const isLoading = serverStatus === "starting" || serverStatus === "downloading";

  return (
    <div className="flex flex-col gap-3">
      {started && (
        <Terminal
          output={serverLogs}
          isStreaming={isLoading}
          autoScroll
          className="max-h-52"
        >
          <TerminalHeader>
            <TerminalTitle>{title}</TerminalTitle>
            <div className="flex items-center gap-2">
              <StatusBadge status={serverStatus} />
            </div>
          </TerminalHeader>
          <TerminalContent className="max-h-40 text-xs" />
        </Terminal>
      )}

      {isFailed && startError && <p className="text-xs text-destructive">{startError}</p>}

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onBack} disabled={isLoading}>
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
          {!started ? (
            <Button className="flex-1" size="sm" onClick={handleStart}>
              Start Server
            </Button>
          ) : isReady ? (
            <Button className="flex-1" size="sm" onClick={onComplete}>
              Get Started
            </Button>
          ) : isFailed ? (
            <Button className="flex-1" size="sm" variant="outline" onClick={handleStart}>
              Retry
            </Button>
          ) : (
            <Button className="flex-1" size="sm" disabled>
              <Spinner data-icon="inline-start" />
              {serverStatus === "downloading" ? "Downloading model..." : "Starting..."}
            </Button>
          )}
        </div>
        {/* 启动失败 / 卡在下载中时也能直接进入应用，不被引导页困住。 */}
        {!isReady && (
          <Button variant="ghost" size="sm" className="self-center" onClick={onComplete}>
            Skip — enter the app
          </Button>
        )}
      </div>
    </div>
  );
}
