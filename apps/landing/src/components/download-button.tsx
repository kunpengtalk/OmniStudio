import { Monitor } from "lucide-react";
import { Apple } from "./apple-icon";
import { Button } from "./button";
import { GITHUB_URL } from "@/lib/constants";

type Platform = "macos" | "linux" | "windows";

function getPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  return "linux";
}

const platformConfig: Record<
  Platform,
  { icon: React.ElementType; label: string; available: boolean }
> = {
  macos: { icon: Apple, label: "Download for macOS", available: true },
  linux: { icon: Monitor, label: "Linux — coming soon", available: false },
  windows: { icon: Monitor, label: "Windows — coming soon", available: false },
};

export function DownloadButton() {
  const platform = getPlatform();
  const { icon: Icon, label, available } = platformConfig[platform];

  return (
    <Button
      href={available ? `${GITHUB_URL}/releases/latest` : undefined}
      variant="primary"
      disabled={!available}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Button>
  );
}
