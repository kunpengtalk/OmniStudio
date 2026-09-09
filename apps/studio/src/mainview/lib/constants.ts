import { ClockIcon, Loader2Icon, CheckCircleIcon, XCircleIcon } from "lucide-react";

export const statusConfig = {
  pending: { icon: ClockIcon, label: "Pending", variant: "outline" as const },
  processing: { icon: Loader2Icon, label: "Processing", variant: "secondary" as const },
  completed: { icon: CheckCircleIcon, label: "Done", variant: "default" as const },
  failed: { icon: XCircleIcon, label: "Failed", variant: "destructive" as const },
};

export type DocumentStatus = keyof typeof statusConfig;
