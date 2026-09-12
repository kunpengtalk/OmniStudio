/**
 * Agent 权限系统（对齐 OpenWork / Claude Cowork 的授权模型）。
 *
 * 语义：
 * - 每个工具调用先被翻译成一条 (permission, pattern) 请求，例如
 *   bash → ("bash", "npm test")、write_file → ("edit", "src/a.ts")、
 *   工作区外的读取 → ("external_directory", "/Users/me/notes.md")；
 * - 规则表按「后匹配覆盖先匹配」求值，无匹配则回落到该权限的内置默认动作；
 * - 动作 allow / ask / deny：ask 会挂起工具执行，把请求推给界面上的授权弹窗，
 *   用户选「仅本次」「本会话总是」「始终允许（写进工作区规则）」或「拒绝」。
 *
 * 规则来源（低 → 高优先级）：
 *   内置默认 → 设置里的 AGENT_PERMISSION_RULES → 工作区规则（agent_permissions 表）
 *   → 会话规则（用户点了「本会话总是」）
 *
 * 这一层只做判断，不碰 UI：挂起 / 唤醒由 agent.ts 负责，弹窗在 mainview。
 */
import path from "path";
import { and, asc, eq } from "drizzle-orm";

import { db } from "./db";
import { agentPermissions } from "./db/schema";
import { getSetting, updateSettings } from "./db/settings";

export type PermissionAction = "allow" | "ask" | "deny";

/** 审批模式的粒度：smart 只拦危险动作，manual 全部问，auto 全放，strict 全拦。 */
export type ApprovalMode = "smart" | "manual" | "auto" | "strict";

export type PermissionRule = {
  permission: string;
  pattern: string;
  action: PermissionAction;
};

/** 一次工具调用翻译出的授权请求（也是弹窗展示的数据源）。 */
export type PermissionRequest = {
  /** 权限名：bash / edit / read / external_directory / webfetch / websearch / mcp / media / task / doom_loop */
  permission: string;
  /** 请求的具体对象（命令 / 路径 / URL / 工具名）。 */
  pattern: string;
  /** 一句话说明这次要做什么（弹窗标题下的正文）。 */
  title: string;
  /** 详情行：文件名、命令、目录、URL … 弹窗里逐行展示。 */
  detail: Record<string, string>;
  /** 建议规则：always = 「本会话总是」写进会话规则的模式。 */
  always: string[];
};

/** 工具调用上下文（由 agent.ts 从工具名 + 入参翻译而来）。 */
export type ToolCallShape = {
  toolName: string;
  args: Record<string, unknown>;
  workspace: string;
};

/** 不需要授权的工具：只读且无副作用（知识库 / 记忆 / 产出物检索 / 待办 / 提问）。 */
const UNGATED_TOOLS = new Set([
  "knowledge_search",
  "memory_search",
  "memory_recall",
  "media_search",
  "media_list",
  "todo_write",
  "todo_read",
  "ask_user",
  "update_plan",
]);

/** 危险命令：smart 模式下会拦下来问一句（破坏面大且几乎不可逆）。 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z-]+\s+)*-[a-z]*[rf][a-z]*\b/i, // rm -rf / rm -r（普通 rm file 不拦）
  /\bsudo\b/,
  /\b(mkfs|dd)\s/,
  /\bchmod\s+-R\s+777/,
  /\b(curl|wget)\b[^|]*\|\s*(ba)?sh/i, // curl … | sh
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\bkill(all)?\s+-9\b/,
  /\b(launchctl|systemctl)\s/,
  /\bdefaults\s+write\b/,
  /\b(shutdown|reboot|halt)\b/,
  /\bdiskutil\b/,
  /\bcrontab\s+-r\b/,
  />\s*\/dev\/(sd|disk|rdisk)/,
  /:\s*\(\)\s*\{.*\}\s*;\s*:/, // fork bomb
];

/**
 * 通配匹配（语义与 OpenWork / opencode 的 Wildcard.match 一致）：
 * `*` 匹配任意多字符，`?` 匹配单个字符，末尾的「 *」可省略，反斜杠统一成 `/`。
 */
export function matchesPermissionPattern(input: string, pattern: string): boolean {
  const normalized = input.replace(/\\/g, "/");
  let escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(normalized);
}

/** 规则求值：最后一条命中的规则生效；没有命中返回 null（由默认动作兜底）。 */
export function winningRule(
  rules: PermissionRule[],
  permission: string,
  pattern: string,
): PermissionRule | null {
  let winner: PermissionRule | null = null;
  for (const rule of rules) {
    if (
      matchesPermissionPattern(permission, rule.permission) &&
      matchesPermissionPattern(pattern, rule.pattern)
    ) {
      winner = rule;
    }
  }
  return winner;
}

/** 解析设置里的自定义规则（JSON 数组）；非法内容一律忽略，不影响内置策略。 */
export function parseRuleList(raw: string): PermissionRule[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PermissionRule[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const { permission, pattern, action } = item as Record<string, unknown>;
      if (typeof permission !== "string" || !permission.trim()) continue;
      if (typeof pattern !== "string" || !pattern.trim()) continue;
      if (action !== "allow" && action !== "ask" && action !== "deny") continue;
      out.push({ permission: permission.trim(), pattern: pattern.trim(), action });
    }
    return out;
  } catch {
    return [];
  }
}

export function approvalMode(): ApprovalMode {
  const raw = getSetting("AGENT_APPROVAL_MODE");
  return raw === "manual" || raw === "auto" || raw === "strict" ? raw : "smart";
}

/** 内置默认规则：先给一组「本地开发顺手、破坏面可控」的策略。 */
export function defaultRules(mode: ApprovalMode = approvalMode()): PermissionRule[] {
  const readAllow: PermissionRule[] = [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "websearch", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "allow" },
    { permission: "todo", pattern: "*", action: "allow" },
    { permission: "ask", pattern: "*", action: "allow" },
    { permission: "task", pattern: "*", action: "allow" },
    { permission: "knowledge", pattern: "*", action: "allow" },
    { permission: "memory", pattern: "*", action: "allow" },
    { permission: "media", pattern: "*", action: "allow" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    // 工作区外的读写默认都要问一句：这是 agent 最容易被注入利用的边界。
    { permission: "external_directory", pattern: "*", action: "ask" },
  ];

  if (mode === "auto") {
    return [
      ...readAllow,
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "mcp", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ];
  }
  if (mode === "manual") {
    return [
      ...readAllow,
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "mcp", pattern: "*", action: "ask" },
    ];
  }
  if (mode === "strict") {
    return [
      ...readAllow,
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "mcp", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ];
  }
  // smart（默认）：写工作区、跑普通命令不打扰；危险的命令与工作区外访问才问。
  // 危险命令写成数据（而不是代码里的 if），才能被用户在设置页看到并覆盖。
  return [
    ...readAllow,
    { permission: "bash", pattern: "*", action: "allow" },
    ...DANGEROUS_COMMAND_WILDCARDS.map(
      (pattern): PermissionRule => ({ permission: "bash", pattern, action: "ask" }),
    ),
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "mcp", pattern: "*", action: "allow" },
  ];
}

/**
 * 危险命令的通配写法（smart 模式下把这些 bash 调用升级成「询问」）。
 * 覆盖面刻意保守：只拦几乎不可逆的操作，噪声太大会让用户直接关掉审批。
 */
export const DANGEROUS_COMMAND_WILDCARDS: string[] = [
  "*rm -rf*",
  "*rm -fr*",
  "*rm -r *",
  "*sudo *",
  "*mkfs*",
  "*dd if=*",
  "*chmod -R 777*",
  "*| sh",
  "*| bash",
  "*|sh",
  "*|bash",
  "*curl * | *",
  "*wget * | *",
  "*git push*",
  "*git reset --hard*",
  "*git clean -*f*",
  "*npm publish*",
  "*pnpm publish*",
  "*yarn publish*",
  "*bun publish*",
  "*launchctl *",
  "*systemctl *",
  "*defaults write*",
  "*shutdown*",
  "*reboot*",
  "*diskutil*",
  "*crontab -r*",
];

/** 设置层规则（用户在「权限」设置页里显式写的）。 */
export function settingRules(): PermissionRule[] {
  return parseRuleList(getSetting("AGENT_PERMISSION_RULES"));
}

function storedRules(scope: "session" | "workspace", scopeRef: string): PermissionRule[] {
  try {
    return db
      .select()
      .from(agentPermissions)
      .where(and(eq(agentPermissions.scope, scope), eq(agentPermissions.scopeRef, scopeRef)))
      .orderBy(asc(agentPermissions.id))
      .all()
      .map((row) => ({ permission: row.permission, pattern: row.pattern, action: row.action }));
  } catch {
    return [];
  }
}

export function sessionRules(conversationId: number): PermissionRule[] {
  return storedRules("session", String(conversationId));
}

export function workspaceRules(workspace: string): PermissionRule[] {
  return storedRules("workspace", path.resolve(workspace));
}

export function grantPermission(input: {
  scope: "session" | "workspace";
  scopeRef: string;
  permission: string;
  pattern: string;
  action: PermissionAction;
}): void {
  db.insert(agentPermissions)
    .values({
      scope: input.scope,
      scopeRef: input.scope === "workspace" ? path.resolve(input.scopeRef) : input.scopeRef,
      permission: input.permission,
      pattern: input.pattern,
      action: input.action,
    })
    .run();
}

export function listPermissionRows(): (typeof agentPermissions.$inferSelect)[] {
  return db.select().from(agentPermissions).orderBy(asc(agentPermissions.id)).all();
}

export function deletePermissionRow(id: number): void {
  db.delete(agentPermissions).where(eq(agentPermissions.id, id)).run();
}

export function clearPermissions(scope: "session" | "workspace", scopeRef: string): void {
  const ref = scope === "workspace" ? path.resolve(scopeRef) : scopeRef;
  db.delete(agentPermissions)
    .where(and(eq(agentPermissions.scope, scope), eq(agentPermissions.scopeRef, ref)))
    .run();
}

/** 完整规则链（低 → 高优先级）。 */
export function effectiveRules(conversationId: number | null, workspace: string): PermissionRule[] {
  return [
    ...defaultRules(),
    ...settingRules(),
    ...workspaceRules(workspace),
    ...(conversationId === null ? [] : sessionRules(conversationId)),
  ];
}

export type Decision = {
  action: PermissionAction;
  /** 命中的规则；null = 用默认动作（无匹配时 ask）。 */
  rule: PermissionRule | null;
};

export function evaluate(
  request: Pick<PermissionRequest, "permission" | "pattern">,
  rules: PermissionRule[],
): Decision {
  const rule = winningRule(rules, request.permission, request.pattern);
  if (rule) return { action: rule.action, rule };
  // 无匹配：交给内置默认表再算一次（smart 模式下依然能覆盖到 doom_loop 等）。
  const fallback = winningRule(defaultRules("manual"), request.permission, request.pattern);
  return fallback ? { action: fallback.action, rule: null } : { action: "ask", rule: null };
}

/** 路径是否在工作区内。 */
export function isInsideWorkspace(workspace: string, target: string): boolean {
  const root = path.resolve(workspace);
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** 相对工作区展示路径：区内给相对路径（规则更好写），区外给绝对路径。 */
export function displayPath(workspace: string, target: string): string {
  const abs = path.resolve(target);
  return isInsideWorkspace(workspace, abs) ? path.relative(workspace, abs) || "." : abs;
}

/** 危险的 shell 命令（smart 模式据此把 bash 升级成 ask）。 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(command));
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 把一次工具调用翻译成授权请求；返回 null 表示这个工具不需要授权。
 *
 * 注意：这里的 pattern 会同时用于「规则匹配」和「弹窗展示」，
 * 因此用用户能读懂的形式（相对路径、原始命令、完整 URL）。
 */
export function permissionRequestForTool(call: ToolCallShape): PermissionRequest | null {
  const { toolName, args, workspace } = call;
  if (UNGATED_TOOLS.has(toolName)) return null;
  const rawPath = stringArg(args, "path", "filePath", "file_path");

  switch (toolName) {
    case "bash":
    case "shell":
    case "run_command": {
      const command = stringArg(args, "command", "cmd") || "(empty command)";
      return {
        permission: "bash",
        pattern: command,
        title: "运行 shell 命令",
        detail: { 命令: command, 目录: workspace },
        always: [command],
      };
    }
    case "write_file":
    case "edit_file":
    case "apply_patch": {
      const target = rawPath ? path.resolve(workspace, rawPath) : workspace;
      const inside = isInsideWorkspace(workspace, target);
      if (!inside) {
        return {
          permission: "external_directory",
          pattern: path.dirname(target),
          title: "在工作区之外写文件",
          detail: { 文件: target, 工作区: workspace },
          always: [path.dirname(target), path.dirname(target) + "/*"],
        };
      }
      return {
        permission: "edit",
        pattern: displayPath(workspace, target),
        title: "修改工作区文件",
        detail: { 文件: displayPath(workspace, target) },
        always: [displayPath(workspace, target)],
      };
    }
    case "read_file":
    case "list_dir":
    case "glob":
    case "grep": {
      if (!rawPath) return null;
      const target = path.resolve(workspace, rawPath);
      if (isInsideWorkspace(workspace, target)) return null;
      return {
        permission: "external_directory",
        pattern: target,
        title: "读取工作区之外的文件",
        detail: { 路径: target },
        always: [path.dirname(target), path.dirname(target) + "/*"],
      };
    }
    case "web_fetch": {
      const url = stringArg(args, "url");
      return {
        permission: "webfetch",
        pattern: url || "*",
        title: "抓取网页",
        detail: { URL: url },
        always: [url || "*"],
      };
    }
    case "web_search":
      return null; // 有独立开关（WEB_SEARCH_ENABLED），不再弹窗
    case "generate_image":
      return {
        permission: "media",
        pattern: "generate_image",
        title: "生成图片",
        detail: { 提示词: stringArg(args, "prompt").slice(0, 200) },
        always: ["generate_image"],
      };
    case "generate_speech":
      return {
        permission: "media",
        pattern: "generate_speech",
        title: "合成语音",
        detail: { 文本: stringArg(args, "text").slice(0, 200) },
        always: ["generate_speech"],
      };
    case "generate_video":
      return {
        permission: "media",
        pattern: "generate_video",
        title: "生成视频",
        detail: { 提示词: stringArg(args, "prompt").slice(0, 200) },
        always: ["generate_video"],
      };
    case "task": {
      const description = stringArg(args, "description", "prompt").slice(0, 120);
      return {
        permission: "task",
        pattern: stringArg(args, "subagent_type") || "general",
        title: "派子智能体执行子任务",
        detail: { 任务: description },
        always: ["*"],
      };
    }
    default: {
      // MCP 与其它外部工具统一按 mcp 权限管理（弹窗里能看到工具名）。
      const mcpTool = workspace === "" ? toolName : toolName;
      return {
        permission: "mcp",
        pattern: mcpTool,
        title: "调用外部工具",
        detail: { 工具: mcpTool },
        always: [mcpTool],
      };
    }
  }
}

/**
 * 授权弹窗里的「本会话总是」默认会写成 allow；deny 记进会话规则则表现为
 * 「这会话别再问这个了，直接拒」。两者都只影响当前会话（用户显式选择）。
 */
export function humanPermissionLabel(permission: string): string {
  const map: Record<string, string> = {
    bash: "执行命令",
    edit: "修改文件",
    read: "读取文件",
    external_directory: "访问工作区之外",
    webfetch: "抓取网页",
    websearch: "联网搜索",
    mcp: "外部工具",
    media: "生成媒体",
    task: "派发子任务",
    doom_loop: "重复调用保护",
  };
  return map[permission] ?? permission;
}

/** 已授权的工作区之外目录（设置项，权限弹窗与设置页都会写）。 */
export function getAuthorizedFolders(): string[] {
  try {
    const parsed = JSON.parse(getSetting("AGENT_AUTHORIZED_FOLDERS"));
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function setAuthorizedFolders(folders: string[]): string[] {
  const clean = folders
    .filter((folder) => typeof folder === "string" && folder.trim())
    .map((folder) => path.resolve(folder.trim().replace(/^~/, process.env.HOME ?? "/")));
  // 去重但不排序：用户添加的顺序就是他心里的顺序。
  const unique = [...new Set(clean)];
  updateSettings({ AGENT_AUTHORIZED_FOLDERS: JSON.stringify(unique) });
  return unique;
}

/** 授权弹窗里「始终允许这个目录」：把目录加进白名单（幂等）。 */
export function addAuthorizedFolder(folder: string): void {
  const existing = getAuthorizedFolders();
  const resolved = path.resolve(folder.replace(/^~/, process.env.HOME ?? "/"));
  if (existing.includes(resolved)) return;
  setAuthorizedFolders([...existing, resolved]);
}

/** 设置页「当前生效的权限」展示用：探针 + 命中规则 + 来源。 */
export type EffectivePermissionRow = {
  permission: string;
  label: string;
  action: PermissionAction;
  /** 命中的规则模式；null = 默认策略。 */
  pattern: string | null;
  source: "builtin" | "settings" | "workspace" | "session";
  /**
   * 比这条通则更窄的规则数量（比如「bash 全允许，但 rm -rf* 要问」里的那条例外）。
   * 通则看不出例外，这个计数让用户知道"下面还有别的规则在起作用"。
   */
  exceptions: number;
};

const PROBES: { permission: string; pattern: string }[] = [
  { permission: "bash", pattern: "*" },
  { permission: "edit", pattern: "*" },
  { permission: "webfetch", pattern: "*" },
  { permission: "mcp", pattern: "*" },
  { permission: "external_directory", pattern: "*" },
  { permission: "doom_loop", pattern: "*" },
];

export function summarizeEffectivePermissions(
  conversationId: number | null,
  workspace: string,
): EffectivePermissionRow[] {
  const layers: { rules: PermissionRule[]; source: EffectivePermissionRow["source"] }[] = [
    { rules: settingRules(), source: "settings" },
    { rules: workspaceRules(workspace), source: "workspace" },
    ...(conversationId === null
      ? []
      : [{ rules: sessionRules(conversationId), source: "session" as const }]),
  ];
  const all = effectiveRules(conversationId, workspace);
  return PROBES.map(({ permission, pattern }) => {
    const rule = winningRule(all, permission, pattern);
    let source: EffectivePermissionRow["source"] = "builtin";
    if (rule) {
      for (const layer of layers) {
        const hit = layer.rules.some(
          (candidate) =>
            candidate.permission === rule.permission &&
            candidate.pattern === rule.pattern &&
            candidate.action === rule.action,
        );
        if (hit) {
          source = layer.source;
          break;
        }
      }
    }
    const decision = evaluate({ permission, pattern }, all);
    return {
      permission,
      label: humanPermissionLabel(permission),
      action: decision.action,
      pattern: rule?.pattern ?? null,
      source,
      exceptions: all.filter(
        (candidate) =>
          candidate.permission === permission &&
          candidate.pattern !== "*" &&
          !(
            candidate.permission === rule?.permission &&
            candidate.pattern === rule.pattern &&
            candidate.action === rule.action
          ),
      ).length,
    };
  });
}
