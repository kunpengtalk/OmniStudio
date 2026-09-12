// ---------------------------------------------------------------------------
// Skills 管理（参照 skills-manager 移植）：共享类型 + 内置工具适配器表。
// 本文件同时被主进程（bun）与 webview 引用，禁止 import electrobun。
// ---------------------------------------------------------------------------

/** 工具分类：编码 Agent / Lobster 类壳。 */
export type ToolCategory = "coding" | "lobster";

/** 内置工具适配器定义（路径相对 home，如 ".cursor/skills"）。 */
export interface ToolAdapterDef {
  key: string;
  name: string;
  /** 全局 skills 目录（相对 home）。 */
  skillsDir: string;
  /** 安装检测目录（相对 home；存在即认为该工具已安装）。 */
  detectDir: string;
  /** 额外扫描的全局目录（相对 home，如 codex 也会读 ~/.agents/skills）。 */
  extraScanDirs?: string[];
  /** 项目内 skills 目录（相对项目根）；缺省时项目内沿用全局同相对路径。 */
  projectSkillsDir?: string;
  category: ToolCategory;
  /** 递归扫描 skills 目录（hermes 一类嵌套结构）。 */
  recursive?: boolean;
}

/** 用户自定义工具（存 settings JSON）。 */
export interface CustomToolDef {
  key: string;
  name: string;
  /** 绝对路径或以 ~ 开头的 home 相对路径。 */
  skillsDir: string;
  projectSkillsDir?: string;
  category: ToolCategory;
}

/** 技能来源。 */
export type SkillSource = "manual" | "local" | "git" | "skillssh" | "scan" | "project";

/** 同步模式：软链接 / 复制。 */
export type SyncMode = "symlink" | "copy";

/** 部署目标在磁盘上的实时分类。 */
export type TargetLiveState =
  | "absent"
  | "link-to-source"
  | "foreign-link"
  | "real-dir"
  | "real-file"
  /** 目标目录与中央库同根（cline/warp 等直接读 ~/.agents/skills），无需同步。 */
  | "central-root";

/** 技能卡上的同步状态徽章。 */
export type SyncStatus = "synced" | "copied" | "outdated" | "missing" | "conflict" | "central";

export interface ToolInfo {
  key: string;
  name: string;
  category: ToolCategory;
  /** 解析后的全局 skills 目录绝对路径。 */
  skillsDir: string;
  /** 解析后的项目内 skills 目录相对路径（相对项目根）。 */
  projectSkillsDir: string;
  /** 检测目录存在（认为工具已安装）。 */
  installed: boolean;
  enabled: boolean;
  isCustom: boolean;
  /** 全局 skills 目录与中央库相同（直接使用，不参与同步）。 */
  isCentral: boolean;
}

export interface SkillTargetView {
  tool: string;
  mode: SyncMode;
  status: SyncStatus;
}

export interface ManagedSkill {
  id: string;
  name: string;
  description: string | null;
  sourceType: SkillSource;
  /** "owner/repo/skill_id"、"git URL" 或本地来源为空。 */
  sourceRef: string | null;
  sourceRevision: string | null;
  tags: string[];
  /** 中央库内目录名（即技能 id）。 */
  updatedAt: number;
  targets: SkillTargetView[];
}

export interface SkillsShSkill {
  /** "{source}/{skill_id}"。 */
  id: string;
  skillId: string;
  name: string;
  /** GitHub "owner/repo"。 */
  source: string;
  installs: number;
}

export interface PresetView {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  skillCount: number;
  /** 成员技能 id（编辑成员用）。 */
  skillIds: string[];
  isActive: boolean;
}

/** 项目内技能与中央库的五态同步关系。 */
export type ProjectSyncState =
  | "in_sync"
  | "project_newer"
  | "center_newer"
  | "diverged"
  | "project_only";

export interface ProjectSkillView {
  /** 项目内相对目录（相对项目根，如 ".agents/skills/foo"）。 */
  relDir: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** 匹配到的中央库技能 id（null = 仅项目存在）。 */
  centralId: string | null;
  centralName: string | null;
  syncState: ProjectSyncState;
}

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  skillCount: number;
}

/** 安装进度事件（主进程 → webview）。 */
export interface SkillsInstallProgress {
  /** 唯一 ref：市场安装 "{source}/{skillId}"，Git/本地导入为临时 id。 */
  ref: string;
  phase: "cloning" | "installing" | "done" | "error" | "canceled";
  message?: string;
}

/** 发现的已有技能分组（扫描收编）。 */
export interface DiscoveredSkillGroup {
  name: string;
  /** 每个工具目录下的发现位置。 */
  locations: { tool: string; path: string }[];
  /** 是否已收编进中央库。 */
  imported: boolean;
}

export type SkillsLeaderboard = "alltime" | "trending" | "hot";

// ---------------------------------------------------------------------------
// 内置 53 个工具适配器（照搬 skills-manager 的 tool_adapters 映射表）
// ---------------------------------------------------------------------------

export const TOOL_ADAPTERS: ToolAdapterDef[] = [
  { key: "claude_code", name: "Claude Code", skillsDir: ".claude/skills", detectDir: ".claude", projectSkillsDir: ".claude/skills", category: "coding" },
  { key: "cursor", name: "Cursor", skillsDir: ".cursor/skills", detectDir: ".cursor", projectSkillsDir: ".cursor/skills", category: "coding" },
  { key: "codex", name: "Codex", skillsDir: ".codex/skills", detectDir: ".codex", extraScanDirs: [".agents/skills"], projectSkillsDir: ".codex/skills", category: "coding" },
  { key: "github_copilot", name: "GitHub Copilot", skillsDir: ".copilot/skills", detectDir: ".copilot", extraScanDirs: [".agents/skills"], projectSkillsDir: ".github/skills", category: "coding" },
  { key: "gemini_cli", name: "Gemini CLI", skillsDir: ".gemini/skills", detectDir: ".gemini", projectSkillsDir: ".gemini/skills", category: "coding" },
  { key: "opencode", name: "OpenCode", skillsDir: ".config/opencode/skills", detectDir: ".config/opencode", projectSkillsDir: ".opencode/skills", category: "coding" },
  { key: "grok", name: "Grok CLI", skillsDir: ".grok/skills", detectDir: ".grok", category: "coding" },
  { key: "amp", name: "Amp", skillsDir: ".config/agents/skills", detectDir: ".config/agents", category: "coding" },
  { key: "windsurf", name: "Windsurf", skillsDir: ".codeium/windsurf/skills", detectDir: ".codeium/windsurf", category: "coding" },
  { key: "cline", name: "Cline", skillsDir: ".agents/skills", detectDir: ".cline", category: "coding" },
  { key: "warp", name: "Warp", skillsDir: ".agents/skills", detectDir: ".warp", category: "coding" },
  { key: "kilo_code", name: "Kilo Code", skillsDir: ".kilocode/skills", detectDir: ".kilocode", category: "coding" },
  { key: "roo_code", name: "Roo Code", skillsDir: ".roo/skills", detectDir: ".roo", category: "coding" },
  { key: "goose", name: "Goose", skillsDir: ".config/goose/skills", detectDir: ".config/goose", category: "coding" },
  { key: "qwen_code", name: "Qwen Code", skillsDir: ".qwen/skills", detectDir: ".qwen", category: "coding" },
  { key: "crush", name: "Crush", skillsDir: ".config/crush/skills", detectDir: ".config/crush", category: "coding" },
  { key: "trae", name: "Trae", skillsDir: ".trae/skills", detectDir: ".trae", category: "coding" },
  { key: "trae_cn", name: "Trae CN", skillsDir: ".trae-cn/skills", detectDir: ".trae-cn", category: "coding" },
  { key: "iflow", name: "iFlow CLI", skillsDir: ".iflow/skills", detectDir: ".iflow", category: "coding" },
  { key: "junie", name: "Junie", skillsDir: ".junie/skills", detectDir: ".junie", category: "coding" },
  { key: "kiro", name: "Kiro", skillsDir: ".kiro/skills", detectDir: ".kiro", category: "coding" },
  { key: "continue", name: "Continue", skillsDir: ".continue/skills", detectDir: ".continue", category: "coding" },
  { key: "augment", name: "Augment", skillsDir: ".augment/skills", detectDir: ".augment", category: "coding" },
  { key: "openhands", name: "OpenHands", skillsDir: ".openhands/skills", detectDir: ".openhands", category: "coding" },
  { key: "openclaw", name: "OpenClaw", skillsDir: ".openclaw/skills", detectDir: ".openclaw", category: "coding" },
  { key: "droid", name: "Droid", skillsDir: ".factory/skills", detectDir: ".factory", category: "coding" },
  { key: "antigravity", name: "Antigravity", skillsDir: ".gemini/antigravity/skills", detectDir: ".gemini/antigravity", category: "coding" },
  { key: "replit", name: "Replit", skillsDir: ".config/agents/skills", detectDir: ".replit", category: "coding" },
  { key: "cortex", name: "Snowflake Cortex", skillsDir: ".snowflake/cortex/skills", detectDir: ".snowflake/cortex", category: "coding" },
  { key: "codebuddy", name: "CodeBuddy", skillsDir: ".codebuddy/skills", detectDir: ".codebuddy", category: "coding" },
  { key: "zcode", name: "ZCode", skillsDir: ".zcode/skills", detectDir: ".zcode", category: "coding" },
  { key: "omp_agent", name: "OMP Agent", skillsDir: ".omp/agent/skills", detectDir: ".omp", projectSkillsDir: ".omp/skills", category: "coding" },
  { key: "deepagents", name: "DeepAgents", skillsDir: ".deepagents/agent/skills", detectDir: ".deepagents", category: "coding" },
  { key: "pi", name: "Pi", skillsDir: ".pi/agent/skills", detectDir: ".pi", projectSkillsDir: ".pi/skills", category: "coding" },
  { key: "kimi", name: "Kimi CLI", skillsDir: ".kimi-code/skills", detectDir: ".kimi-code", category: "coding" },
  { key: "hermes", name: "Hermes", skillsDir: ".hermes/skills", detectDir: ".hermes", recursive: true, category: "coding" },
  { key: "deepseek_harness", name: "DeepSeek Harness", skillsDir: ".dsh/skills", detectDir: ".dsh", category: "coding" },
  // Lobster 类壳工具
  { key: "qclaw", name: "QClaw", skillsDir: ".qclaw/skills", detectDir: ".qclaw", category: "lobster" },
  { key: "easyclaw", name: "EasyClaw", skillsDir: ".easyclaw/skills", detectDir: ".easyclaw", category: "lobster" },
  { key: "autoclaw", name: "AutoClaw", skillsDir: ".openclaw-autoclaw/skills", detectDir: ".openclaw-autoclaw", category: "lobster" },
  { key: "workbuddy", name: "WorkBuddy", skillsDir: ".workbuddy/skills", detectDir: ".workbuddy", category: "lobster" },
  { key: "firebender", name: "Firebender", skillsDir: ".firebender/skills", detectDir: ".firebender", category: "lobster" },
  { key: "mistral_vibe", name: "Mistral Vibe", skillsDir: ".vibe/skills", detectDir: ".vibe", category: "lobster" },
  { key: "mcpjam", name: "MCPJam", skillsDir: ".mcpjam/skills", detectDir: ".mcpjam", category: "lobster" },
  { key: "mux", name: "Mux", skillsDir: ".mux/skills", detectDir: ".mux", category: "lobster" },
  { key: "neovate", name: "Neovate", skillsDir: ".neovate/skills", detectDir: ".neovate", category: "lobster" },
  { key: "pochi", name: "Pochi", skillsDir: ".pochi/skills", detectDir: ".pochi", category: "lobster" },
  { key: "qoder", name: "Qoder", skillsDir: ".qoder/skills", detectDir: ".qoder", category: "lobster" },
  { key: "kode", name: "Kode", skillsDir: ".kode/skills", detectDir: ".kode", category: "lobster" },
  { key: "bob", name: "Bob", skillsDir: ".bob/skills", detectDir: ".bob", category: "lobster" },
  { key: "command_code", name: "Command Code", skillsDir: ".commandcode/skills", detectDir: ".commandcode", category: "lobster" },
  { key: "adal", name: "Adal", skillsDir: ".adal/skills", detectDir: ".adal", category: "lobster" },
  { key: "zencoder", name: "ZenCoder", skillsDir: ".zencoder/skills", detectDir: ".zencoder", category: "lobster" },
];

/** 中央库默认目录：Agent Skills 开放标准的厂商中立路径。 */
export const DEFAULT_CENTRAL_SKILLS_DIR = ".agents/skills";

/** 中央库内随 git 提交的跨设备元数据命名空间。 */
export const SKILLS_META_DIR = ".omnistudio";

/** 单个技能体积警告阈值（100MB，与 skills-manager 一致）。 */
export const SKILL_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;

export function toolDisplayName(key: string): string {
  return TOOL_ADAPTERS.find((t) => t.key === key)?.name ?? key;
}
