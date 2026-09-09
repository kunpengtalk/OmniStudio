import { useQuery } from "@tanstack/react-query";

import { rpcClient } from "../lib/rpc";
import { cn } from "../lib/utils";
import { useServerStore } from "../stores/server";

export function StatusPill() {
  const serverStatus = useServerStore((s) => s.status);

  const { data, isLoading } = useQuery({
    queryKey: ["connection-status"],
    queryFn: () => rpcClient.checkConnection(undefined),
    refetchInterval: 30_000,
  });

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  const isLocal = (settingsData?.settings?.SERVER_MODE ?? "local") === "local";

  if (isLocal) {
    const label =
      serverStatus === "running"
        ? "Running"
        : serverStatus === "downloading"
          ? "Downloading…"
          : serverStatus === "starting"
            ? "Starting…"
            : serverStatus === "error"
              ? "Error"
              : "Stopped";

    const dotClass =
      serverStatus === "running"
        ? "bg-green-500"
        : serverStatus === "downloading" || serverStatus === "starting"
          ? "animate-pulse bg-amber-500"
          : serverStatus === "error"
            ? "bg-destructive"
            : "bg-muted-foreground";

    return (
      <div className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium">
        <div className={cn("size-1.5 rounded-full", dotClass)} />
        {label}
      </div>
    );
  }

  const connected = data?.connected ?? false;
  const label = isLoading ? "Checking…" : connected ? "Connected" : "Disconnected";

  return (
    <div className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium">
      <div
        className={cn(
          "size-1.5 rounded-full",
          isLoading
            ? "animate-pulse bg-muted-foreground"
            : connected
              ? "bg-green-500"
              : "bg-destructive",
        )}
      />
      {label}
    </div>
  );
}
