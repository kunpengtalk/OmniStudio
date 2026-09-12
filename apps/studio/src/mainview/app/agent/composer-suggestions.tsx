import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CornerDownLeftIcon, FileIcon, SlashIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { WorkspaceTreeNode } from "../../../bun/agent-artifacts";

export type SlashCommandId =
  | "agent"
  | "plan"
  | "goal"
  | "new"
  | "tools"
  | "clear"
  | "help";

export type SlashCommand = {
  id: SlashCommandId;
  /** 触发词（不含 /）。 */
  command: string;
  labelKey: string;
};

/** 输入框内可用命令（对齐 OpenWork 的 slash command）。 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "agent", command: "agent", labelKey: "agent.slash.agent" },
  { id: "plan", command: "plan", labelKey: "agent.slash.plan" },
  { id: "goal", command: "goal", labelKey: "agent.slash.goal" },
  { id: "new", command: "new", labelKey: "agent.slash.new" },
  { id: "tools", command: "tools", labelKey: "agent.slash.tools" },
  { id: "help", command: "help", labelKey: "help" },
];

/** 把工作区文件树摊平成文件路径列表（@ 提及的候选）。 */
function flattenFiles(nodes: WorkspaceTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === "file") out.push(node.path);
    else if (node.children) flattenFiles(node.children, out);
  }
  return out;
}

/**
 * 输入框的补全：`/` 开头给命令，`@` 之后的片段给工作区文件。
 * 返回 null 表示当前输入不该弹补全。
 */
export function useComposerSuggestions(input: string, workspace: string) {
  const slashMatch = /^\/([a-z]*)$/i.exec(input.trimStart());
  const mentionMatch = /@([^\s@]*)$/.exec(input);

  const filesQuery = useQuery({
    queryKey: ["agent-workspace-files", workspace],
    queryFn: () => rpcClient.listWorkspaceFiles({ workspace: workspace || undefined }),
    enabled: mentionMatch != null,
    staleTime: 15_000,
  });

  const files = useMemo(
    () => flattenFiles(filesQuery.data?.nodes ?? []),
    [filesQuery.data],
  );

  return useMemo(() => {
    if (slashMatch) {
      const query = slashMatch[1]!.toLowerCase();
      const items = SLASH_COMMANDS.filter((command) => command.command.startsWith(query));
      if (items.length === 0) return null;
      return { kind: "slash" as const, query, items, files: [] as string[] };
    }
    if (mentionMatch) {
      const query = mentionMatch[1]!.toLowerCase();
      const items = files
        .filter((file) => !query || file.toLowerCase().includes(query))
        .slice(0, 12);
      return { kind: "mention" as const, query, items: [] as SlashCommand[], files: items };
    }
    return null;
  }, [slashMatch, mentionMatch, files]);
}

/**
 * 补全下拉：键盘上下选择、Tab / 回车确认、Esc 关闭。
 * 选中命令由调用方执行（切模式 / 新建会话…），选文件则插进输入框。
 */
export function ComposerSuggestions({
  input,
  workspace,
  onPickCommand,
  onPickFile,
}: {
  input: string;
  workspace: string;
  onPickCommand: (id: SlashCommandId) => void;
  onPickFile: (path: string) => void;
}) {
  const t = useT();
  const suggestions = useComposerSuggestions(input, workspace);
  const [active, setActive] = useState(0);
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);

  const count = suggestions
    ? suggestions.kind === "slash"
      ? suggestions.items.length
      : suggestions.files.length
    : 0;
  const index = Math.min(active, Math.max(0, count - 1));

  // 列表变化（继续打字 / 换了一批候选）时把高亮重置回第一项。
  useEffect(() => {
    setActive(0);
  }, [suggestions?.kind, count]);

  /**
   * 键盘导航挂在 window 的捕获阶段：补全列表本身不聚焦，
   * 输入焦点始终在 Textarea 上，所以必须在这里拦。
   * 列表打开时 Enter/Tab 用于确认候选（否则回车会直接把半截命令发出去）。
   */
  useEffect(() => {
    if (!suggestions || count === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setActive((prev) => (prev + 1) % count);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActive((prev) => (prev - 1 + count) % count);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        // 关掉补全：把输入里的触发字符去掉，避免列表立刻又弹出来。
        setActive(0);
        setDismissedInput(input);
      } else if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        if (suggestions.kind === "slash") {
          const command = suggestions.items[index];
          if (command) onPickCommand(command.id);
        } else {
          const file = suggestions.files[index];
          if (file) onPickFile(file);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [suggestions, count, index, input, onPickCommand, onPickFile]);

  if (!suggestions || dismissedInput === input) return null;

  return (
    <div className="absolute bottom-full left-0 z-40 mb-2 w-full max-w-md overflow-hidden rounded-xl border bg-popover shadow-lg">
      <div className="flex items-center gap-1.5 border-b px-2.5 py-1.5 text-[10px] text-muted-foreground">
        {suggestions.kind === "slash" ? (
          <>
            <SlashIcon className="size-3" />
            {t("agent.slash.title")}
          </>
        ) : (
          <>
            <FileIcon className="size-3" />
            {t("agent.mention.title")}
          </>
        )}
      </div>
      <div
        className="max-h-56 overflow-y-auto p-1"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((prev) => Math.min(prev + 1, count - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((prev) => Math.max(prev - 1, 0));
          }
        }}
      >
        {suggestions.kind === "slash"
          ? suggestions.items.map((command, itemIndex) => (
              <button
                key={command.id}
                type="button"
                onMouseEnter={() => setActive(itemIndex)}
                onClick={() => onPickCommand(command.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                  itemIndex === index ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <span className="font-mono text-[11px]">/{command.command}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {t(command.labelKey)}
                </span>
                {itemIndex === index && <CornerDownLeftIcon className="size-3 text-muted-foreground" />}
              </button>
            ))
          : suggestions.files.map((file, itemIndex) => (
              <button
                key={file}
                type="button"
                onMouseEnter={() => setActive(itemIndex)}
                onClick={() => onPickFile(file)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                  itemIndex === index ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file}</span>
              </button>
            ))}
      </div>
    </div>
  );
}
