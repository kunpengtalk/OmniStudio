import { useState } from "react";
import { rpcClient } from "@lib/rpc";
import { LocalFlow } from "./local-flow";
import { RemoteFlow } from "./remote-flow";

export interface SetupScreenProps {
  onComplete: () => void;
}

type ServerMode = "local" | "remote";

export function SetupScreen({ onComplete }: SetupScreenProps) {
  const [mode, setMode] = useState<ServerMode>("local");

  const handleComplete = async () => {
    await rpcClient.updateSettings({ settings: { SETUP_COMPLETE: "1" } });
    onComplete();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center overflow-y-auto bg-background px-6 py-8">
      <div className="electrobun-webkit-app-region-drag fixed inset-x-0 top-0 h-11" />
      <div className="w-full max-w-md">
        {mode === "local" ? (
          <LocalFlow onComplete={handleComplete} onSwitchToRemote={() => setMode("remote")} />
        ) : (
          <RemoteFlow onComplete={handleComplete} onSwitchToLocal={() => setMode("local")} />
        )}
      </div>
    </div>
  );
}
