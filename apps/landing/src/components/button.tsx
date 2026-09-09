import { cn } from "@/lib/utils";

export function Button({
  children,
  href,
  variant = "primary",
  className,
  disabled,
}: {
  children: React.ReactNode;
  href?: string;
  variant?: "primary" | "secondary";
  className?: string;
  disabled?: boolean;
}) {
  const classes = cn(
    "inline-flex items-center gap-2.5 rounded-full px-5 py-3 text-sm font-medium transition-all duration-200",
    variant === "primary" && "text-bg bg-foreground hover:bg-foreground/90",
    variant === "secondary" && "bg-surface border border-border text-foreground hover:bg-border/50",
    disabled && "pointer-events-none opacity-40",
    !disabled && "cursor-pointer",
    className,
  );

  if (disabled) {
    return <span className={classes}>{children}</span>;
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={classes}>
      {children}
    </a>
  );
}
