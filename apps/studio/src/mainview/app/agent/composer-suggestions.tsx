import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CornerDownLeftIcon, CpuIcon, FileIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import type { WorkspaceTreeNode } from "../../../bun/agent-artifacts";
import { modelCommandDetail, modelCommandOptions } from "../../../shared/model-command";

export type SlashCommandId =
  | "agent"
  | "plan"
  | "goal"
  | "new"
  | "init"
  | "doctor"
  | "model"
  | "compact"
  | "status"
  | "tools"
  | "clear"
  | "help";

export type SlashCommand = {
  id: SlashCommandId;
  /** 触发词（不含 /）。 */
  command: string;
  labelKey: string;
  /**
   * 允许 `/命令 参数` 这种带尾巴的形式（参数由命令自己解释）。
   *
   * 不声明此字段的命令必须**整条**就是命令，`/goal 开始干活` 依旧按普通消息发出去 ——
   * 否则用户那句话会被静默吞掉。
   */
  takesArgs?: boolean;
};

/** 输入框内可用命令（对齐 OpenWork 的 slash command；`/init` 对齐 Codex 的同名命令）。 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "agent", command: "agent", labelKey: "agent.slash.agent" },
  { id: "plan", command: "plan", labelKey: "agent.slash.plan" },
  { id: "goal", command: "goal", labelKey: "agent.slash.goal" },
  { id: "new", command: "new", labelKey: "agent.slash.new" },
  { id: "init", command: "init", labelKey: "agent.slash.init" },
  // /omni-doctor：内置排障技能（`builtin-skills/omni-doctor`）的入口。症状可以直接跟在
  // 后面（`/omni-doctor 生图失败`），所以声明 takesArgs。
  { id: "doctor", command: "omni-doctor", labelKey: "agent.slash.doctor", takesArgs: true },
  // /model：对齐 Codex 的同名命令 —— 在会话里直接换模型，不用去设置页。
  { id: "model", command: "model", labelKey: "agent.slash.model" },
  // /compact 与 /status：对齐 Codex —— 手动收紧一次上下文、看一眼会话配置。
  { id: "compact", command: "compact", labelKey: "agent.slash.compact" },
  { id: "status", command: "status", labelKey: "agent.slash.status" },
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
  // 命令名允许连字符（`/omni-doctor`）：字符集与 composer 里执行命令的那条判定保持一致，
  // 否则输入 `/omni-doctor` 时补全面板根本不弹，用户只能靠手敲整条命令。
  const slashMatch = /^\/([a-z0-9-]*)$/i.exec(input.trimStart());
  // `/model` 与 `/model <查询词>`：后面这半截是"选哪个模型"，单独一条候选路径。
  const modelMatch = /^\/model(?:\s+(.*))?$/i.exec(input.trim());
  const mentionMatch = /@([^\s@]*)$/.exec(input);

  const filesQuery = useQuery({
    queryKey: ["agent-workspace-files", workspace],
    queryFn: () => rpcClient.listWorkspaceFiles({ workspace: workspace || undefined }),
    enabled: mentionMatch != null,
    staleTime: 15_000,
  });
  const modelsQuery = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(),
    enabled: modelMatch != null,
    staleTime: 15_000,
  });

  const files = useMemo(
    () => flattenFiles(filesQuery.data?.nodes ?? []),
    [filesQuery.data],
  );
  const models = useMemo(
    () => modelCommandOptions(modelsQuery.data?.models ?? [], modelMatch?.[1] ?? ""),
    [modelsQuery.data, modelMatch],
  );

  return useMemo(() => {
    // 先判 /model：它同时也能被命令名补全匹配到，但那会弹出一串命令而不是模型。
    if (modelMatch) {
      return { kind: "model" as const, query: modelMatch[1] ?? "", items: [] as SlashCommand[], files: [] as string[], models };
    }
    if (slashMatch) {
      const query = slashMatch[1]!.toLowerCase();
      const items = SLASH_COMMANDS.filter((command) => command.command.startsWith(query));
      if (items.length === 0) return null;
      return { kind: "slash" as const, query, items, files: [] as string[], models: [] as ModelOption[] };
    }
    if (mentionMatch) {
      const query = mentionMatch[1]!.toLowerCase();
      const items = files
        .filter((file) => !query || file.toLowerCase().includes(query))
        .slice(0, 12);
      return { kind: "mention" as const, query, items: [] as SlashCommand[], files: items, models: [] as ModelOption[] };
    }
    return null;
  }, [slashMatch, modelMatch, mentionMatch, files, models]);
}

/** `/model` 的候选项：与 `ChatModelOption` 的结构子集一致（列表由 RPC 给）。 */
export type ModelOption = {
  type: "local" | "api";
  value: string;
  label: string;
  detail?: string;
  state?: string;
  isActive?: boolean;
  providerId?: string;
  providerName?: string;
};

/**
 * 补全下拉：键盘上下选择、Tab / 回车确认、Esc 关闭。
 * 选中命令由调用方执行（切模式 / 新建会话…），选文件则插进输入框。
 */
export function ComposerSuggestions({
  input,
  workspace,
  onPickCommand,
  onPickModel,
  onPickFile,
}: {
  input: string;
  workspace: string;
  onPickCommand: (id: SlashCommandId) => void;
  /** 选中 `/model` 的某个候选（复用模型选择器的同一条切换链路）。 */
  onPickModel: (option: ModelOption) => void;
  onPickFile: (path: string) => void;
}) {
  const t = useT();
  const suggestions = useComposerSuggestions(input, workspace);
  const [active, setActive] = useState(0);
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);

  const count = suggestions
    ? suggestions.kind === "slash"
      ? suggestions.items.length
      : suggestions.kind === "model"
        ? suggestions.models.length
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
        } else if (suggestions.kind === "model") {
          const model = suggestions.models[index];
          if (model) onPickModel(model);
        } else {
          const file = suggestions.files[index];
          if (file) onPickFile(file);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [suggestions, count, index, input, onPickCommand, onPickModel, onPickFile]);

  if (!suggestions || dismissedInput === input) return null;

  return (
    <div className="composer-ac">
      <div className="composer-ac-list">
        {suggestions.kind === "slash"
          ? suggestions.items.map((command, itemIndex) => (
              <button
                key={command.id}
                type="button"
                onMouseEnter={() => setActive(itemIndex)}
                onClick={() => onPickCommand(command.id)}
                className={`composer-ac-item${itemIndex === index ? " active" : ""}`}
              >
                <span className="composer-ac-name">/{command.command}</span>
                <span className="composer-ac-desc">{t(command.labelKey)}</span>
                {itemIndex === index ? (
                  <CornerDownLeftIcon size={12} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
                ) : null}
              </button>
            ))
          : suggestions.kind === "model"
            ? suggestions.models.map((model, itemIndex) => (
                <button
                  key={`${model.type}-${model.value}`}
                  type="button"
                  onMouseEnter={() => setActive(itemIndex)}
                  onClick={() => onPickModel(model)}
                  className={`composer-ac-item${itemIndex === index ? " active" : ""}`}
                >
                  <CpuIcon size={12} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {model.label}
                  </span>
                  {model.isActive ? <span className="pi-menu-badge">{t("agent.slash.model.current")}</span> : null}
                  <span className="composer-ac-desc" style={{ flex: "none", maxWidth: 160 }}>
                    {modelCommandDetail(model)}
                  </span>
                  {itemIndex === index ? (
                    <CornerDownLeftIcon size={12} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
                  ) : null}
                </button>
              ))
            : suggestions.files.map((file, itemIndex) => (
                <button
                  key={file}
                  type="button"
                  onMouseEnter={() => setActive(itemIndex)}
                  onClick={() => onPickFile(file)}
                  className={`composer-ac-item${itemIndex === index ? " active" : ""}`}
                >
                  <FileIcon size={12} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
                  <span className="composer-ac-name" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {file}
                  </span>
                  {itemIndex === index ? (
                    <CornerDownLeftIcon size={12} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
                  ) : null}
                </button>
              ))}
      </div>
      <div className="composer-ac-footer">
        {suggestions.kind === "slash"
          ? t("agent.slash.title")
          : suggestions.kind === "model"
            ? t("agent.slash.model.title")
            : t("agent.mention.title")}
      </div>
    </div>
  );
}
