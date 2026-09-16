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
import { isSpillPath } from "./agent-spill";

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

/**
 * 不需要授权的工具：只读且无副作用（知识库 / 记忆 / 媒体检索 / 待办 / 提问）。
 *
 * 这里**只列真实存在的工具名**。写错名字不会报错 —— 未列出的工具会走常规授权评估，
 * 于是"本意是只读"变成"每次都弹窗"，出问题时很难联想到是名单写错了。
 * 新增工具时同步 `agent.ts` 的 `READ_ONLY_TOOLS`（列表页分组用），两边保持一致。
 */
const UNGATED_TOOLS = new Set([
  "knowledge_search",
  "memory_search",
  "media_search",
  "read_skill",
  "think",
  "todo_write",
  "ask_user",
  // 只读的窗口状态查询：不产生副作用，也不值得打扰用户。
  "get_context_remaining",
  // Goal 的目标登记：只写应用的库（目标 / 验收标准 / 用量），不碰文件系统。
  // 和 todo_write 同类 —— 是模型在管理自己的执行状态，不是对外部世界动手。
  "goal",
  // 写方案：落到应用数据目录（plans/），**不碰工作区**。Plan 模式的价值就在于
  // "先看方案再决定"，如果每写一次方案都弹一次授权，这条链路就没法用了。
  "write_plan",
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
  return winningRuleFor(rules, permission, [pattern]);
}

/**
 * 同一条命令的多种等价写法一起匹配（对齐 Codex 的 `command_canonicalization`）。
 *
 * 为什么必须有：规则表是按命令原文做通配匹配的，而 shell 允许大量等价写法 ——
 * `rm  -rf /`（两个空格）、`rm\t-rf /`、`rm "-rf" /` 都能删掉目录，但都不匹配
 * `*rm -rf*` 这条规则。也就是说，审批策略会被一个空格绕过。
 * 这里把命令归一化后再匹配一次（**只用于匹配，绝不用于执行**）。
 *
 * 归一化做的事：按 shell 的引号 / 转义规则切成 token，再用单个空格拼回去
 * （引号内的空白属于 token 内容，不动）。
 */
export function canonicalCommand(command: string): string {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      // 双引号里的反斜杠仍然是转义（shell 语义），单引号里一律字面量。
      if (quote === '"' && char === "\\" && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      current += command[index + 1];
      index += 1;
      hasToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens.join(" ");
}

/** 规则匹配用的候选写法：原文 + 归一化（相同就只留一个）。 */
export function commandPatterns(command: string): string[] {
  const canonical = canonicalCommand(command);
  return canonical && canonical !== command ? [command, canonical] : [command];
}

/** 与 `winningRule` 同义，但同一权限下可以同时匹配多种写法（后者仍然覆盖前者）。 */
export function winningRuleFor(
  rules: PermissionRule[],
  permission: string,
  patterns: string[],
): PermissionRule | null {
  let winner: PermissionRule | null = null;
  for (const rule of rules) {
    if (!matchesPermissionPattern(permission, rule.permission)) continue;
    if (patterns.some((pattern) => matchesPermissionPattern(pattern, rule.pattern))) winner = rule;
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

  /**
   * 沙箱升级（命令被沙箱拦下后，带额外权限重跑一次）单独一档：
   * `auto` / `strict` 下默认**拒绝**。理由是语义边界 ——
   * `auto` 说的是"别为工具调用打扰我"，不是"悄悄关掉我特意开启的沙箱"；
   * 想自动升级的人可以在设置页加一条 `sandbox_escalation * → allow` 的规则
   * （Codex 的 granular.sandbox_approval 也是这个意思，只是它写死在配置里）。
   */
  const escalationAsk: PermissionRule[] = [{ permission: "sandbox_escalation", pattern: "*", action: "ask" }];
  const escalationDeny: PermissionRule[] = [{ permission: "sandbox_escalation", pattern: "*", action: "deny" }];

  if (mode === "auto") {
    return [
      ...readAllow,
      ...escalationDeny,
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "mcp", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ];
  }
  if (mode === "manual") {
    return [
      ...readAllow,
      ...escalationAsk,
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "mcp", pattern: "*", action: "ask" },
    ];
  }
  if (mode === "strict") {
    return [
      ...readAllow,
      ...escalationDeny,
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
    ...escalationAsk,
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
  // bash 的等价写法一起匹配：多一个空格不该绕过危险命令规则。
  const patterns =
    request.permission === "bash" ? commandPatterns(request.pattern) : [request.pattern];
  const rule = winningRuleFor(rules, request.permission, patterns);
  if (rule) return { action: rule.action, rule };
  // 无匹配：交给内置默认表再算一次（smart 模式下依然能覆盖到 doom_loop 等）。
  const fallback = winningRuleFor(defaultRules("manual"), request.permission, patterns);
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
  return commandPatterns(command).some((pattern) =>
    DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(pattern)),
  );
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 生图 / 生视频的参考图参数若是**工作区之外的文件路径**，返回它的绝对路径。
 *
 * 这类文件会被送进（往往是云端的）生图接口，读取必须和 read_file 一样过授权；
 * 而参数里也可能是素材库引用（`#3` / `image#3` / 库里给的 `gen/x.png`），
 * 那些走素材库、不经文件系统读，所以只在值"看起来是路径"（带分隔符或 `~`）时才判。
 */
function externalMediaReference(
  workspace: string,
  args: Record<string, unknown>,
): string | null {
  const raw = stringArg(args, "reference", "first_frame");
  if (!raw) return null;
  if (!/[\\/]/.test(raw) && !raw.startsWith("~")) return null;
  const expanded = raw.startsWith("~")
    ? path.join(process.env.HOME ?? "/", raw.slice(1))
    : raw;
  const target = path.resolve(workspace, expanded);
  return isInsideWorkspace(workspace, target) ? null : target;
}

/**
 * apply_patch 影响到的文件（含 Move to 目标）：只扫段落头，不做完整解析。
 * 补丁格式见 `apply-patch.ts`。
 */
export function patchPathsIn(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const value = match[1]?.trim();
    if (value) paths.push(value);
  }
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
    const value = match[1]?.trim();
    if (value) paths.push(value);
  }
  return [...new Set(paths)];
}

/**
 * 多文件改动没法在规则表里逐个匹配，用它们的公共目录 + `/*` 当模式：
 * 规则写 `src/*` 就能覆盖「改 src 下任意文件」，展示上也比一串路径好读。
 */
export function commonDirPattern(workspace: string, targets: string[]): string {
  if (targets.length === 1) return displayPath(workspace, targets[0]!);
  const dirs = targets.map((target) => path.dirname(path.resolve(target)));
  const first = dirs[0];
  if (!first) return "*";
  let shared = first.split(path.sep);
  for (const dir of dirs.slice(1)) {
    const parts = dir.split(path.sep);
    let index = 0;
    while (index < shared.length && index < parts.length && shared[index] === parts[index]) index += 1;
    shared = shared.slice(0, index);
  }
  const dir = shared.join(path.sep) || path.sep;
  const relative = isInsideWorkspace(workspace, dir) ? path.relative(workspace, dir) : dir;
  if (targets.every((target) => path.dirname(path.resolve(target)) === dir)) {
    return relative ? `${relative}/*` : "*";
  }
  // 文件散落在不同层级的目录里，用递归通配覆盖它们的公共前缀。
  return relative ? `${relative}/**` : "**";
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
      // 展示用原文（用户要看到自己那条命令），写进规则的用归一化形式
      // —— 之后 `rm  -rf` 这类等价写法也能命中同一条「总是允许 / 拒绝」。
      const rulePattern = canonicalCommand(command) || command;
      return {
        permission: "bash",
        pattern: command,
        title: "运行 shell 命令",
        detail: { 命令: command, 目录: workspace },
        always: [rulePattern],
      };
    }
    case "escalate_sandbox": {
      // 命令被沙箱拦下后申请"跳过沙箱重跑一次"：卡片上要能看到原文与沙箱的报错。
      const command = stringArg(args, "command") || "(empty command)";
      const sandboxOutput = stringArg(args, "output").trim().slice(0, 500);
      return {
        permission: "sandbox_escalation",
        pattern: canonicalCommand(command) || command,
        title: "命令被沙箱拦下，是否跳过沙箱重试？",
        detail: {
          命令: command,
          ...(sandboxOutput ? { 沙箱输出: sandboxOutput } : {}),
        },
        always: [canonicalCommand(command) || command],
      };
    }
    case "apply_patch": {
      const patch = stringArg(args, "patch");
      const rawPaths = patchPathsIn(patch);
      // 解析不出文件（补丁本身有问题）时不弹窗：工具会带着明确报错回来，用户不用被白问一次。
      if (!rawPaths.length) return null;
      const targets = rawPaths.map((raw) => path.resolve(workspace, raw));
      const outside = targets.filter((target) => !isInsideWorkspace(workspace, target));
      if (outside.length) {
        const dirs = [...new Set(outside.map((target) => path.dirname(target)))];
        return {
          permission: "external_directory",
          pattern: dirs[0]!,
          title: "在工作区之外应用补丁",
          detail: { 文件: outside.join("\n"), 工作区: workspace },
          always: dirs.flatMap((dir) => [dir, `${dir}/*`]),
        };
      }
      const shown = targets.map((target) => displayPath(workspace, target));
      return {
        permission: "edit",
        pattern: commonDirPattern(workspace, targets),
        title: `应用补丁（${shown.length} 个文件）`,
        detail: { 文件: shown.join("\n") },
        always: shown,
      };
    }
    case "write_file":
    case "edit_file": {
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
    case "request_permissions": {
      // 翻译成"访问工作区之外"：模型主动申请时走的也是这条授权链路。
      const target = rawPath ? path.resolve(workspace, rawPath) : workspace;
      return {
        permission: "external_directory",
        pattern: isInsideWorkspace(workspace, target) ? path.dirname(target) : target,
        title: "模型申请访问工作区之外的路径",
        detail: {
          路径: target,
          ...(stringArg(args, "reason") ? { 原因: stringArg(args, "reason") } : {}),
        },
        always: [path.dirname(target), `${path.dirname(target)}/*`],
      };
    }
    case "read_file":
    case "view_image":
    case "list_dir":
    case "glob":
    case "grep": {
      if (!rawPath) return null;
      const target = path.resolve(workspace, rawPath);
      if (isInsideWorkspace(workspace, target)) return null;
      /**
       * 工具输出的转存文件（`agent-spill.ts`）不算"工作区之外"。
       *
       * 它是应用自己从工具结果里写出来的：用户已经授权过产生它的那次工具调用，
       * 内容模型本来也看过前半段。不放行的话，"截断之后用 read_file 读回原文"
       * 会变成**每读一次弹一次授权窗** —— 提示词里那句建议就成了空话。
       * 只认这个子目录，数据目录的其余部分（存着全部云端 Key）照旧要授权 / 拦死。
       */
      if (isSpillPath(target)) return null;
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
    case "generate_image": {
      const externalRef = externalMediaReference(workspace, args);
      if (externalRef) {
        return {
          permission: "external_directory",
          pattern: externalRef,
          title: "读取工作区之外的图片作为参考图",
          detail: { 文件: externalRef, 工作区: workspace },
          always: [path.dirname(externalRef), path.dirname(externalRef) + "/*"],
        };
      }
      return {
        permission: "media",
        pattern: "generate_image",
        title: "生成图片",
        detail: { 提示词: stringArg(args, "prompt").slice(0, 200) },
        always: ["generate_image"],
      };
    }
    case "generate_speech":
      return {
        permission: "media",
        pattern: "generate_speech",
        title: "合成语音",
        detail: { 文本: stringArg(args, "text").slice(0, 200) },
        always: ["generate_speech"],
      };
    case "generate_video": {
      const externalRef = externalMediaReference(workspace, args);
      if (externalRef) {
        return {
          permission: "external_directory",
          pattern: externalRef,
          title: "读取工作区之外的图片作为首帧",
          detail: { 文件: externalRef, 工作区: workspace },
          always: [path.dirname(externalRef), path.dirname(externalRef) + "/*"],
        };
      }
      return {
        permission: "media",
        pattern: "generate_video",
        title: "生成视频",
        detail: { 提示词: stringArg(args, "prompt").slice(0, 200) },
        always: ["generate_video"],
      };
    }
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
/**
 * 用户可在设置页手写规则的权限名（含中文说明）。
 * 这里是**唯一权威清单**：设置页的下拉选项通过 `getAgentPermissions` 拿的就是它，
 * 避免前端再维护一份会漂移的副本（曾漏掉 websearch / doom_loop）。
 * 内部的 knowledge / memory / ask / todo 不面向用户，不在此列。
 */
export const HUMAN_PERMISSION_LABELS: Record<string, string> = {
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
  sandbox_escalation: "跳过命令沙箱",
};

export function humanPermissionLabel(permission: string): string {
  return HUMAN_PERMISSION_LABELS[permission] ?? permission;
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
  { permission: "sandbox_escalation", pattern: "*" },
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
