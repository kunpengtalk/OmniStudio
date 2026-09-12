/** 记忆功能前后端共享类型（RPC 边界）。 */

/**
 * 记忆分类：参照主流记忆框架的多扇区模型，
 * fact=事实 preference=偏好 experience=经验 skill=技能 other=其他。
 */
export type MemoryCategory = "fact" | "preference" | "experience" | "skill" | "other";

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  "fact",
  "preference",
  "experience",
  "skill",
  "other",
];

/**
 * 记忆生命周期：
 * - active     可用（默认）；
 * - pending    待用户确认（开启「写入需确认」后 Agent 的写入先落这里，不进检索与提示词）；
 * - archived   归档：长期未被用到的低价值记忆不再注入，但仍可被检索/恢复；
 * - superseded 已被新记忆取代（冲突更新的旧事实），保留可追溯但不参与检索排序。
 */
export type MemoryStatus = "active" | "pending" | "archived" | "superseded";

export const MEMORY_STATUSES: MemoryStatus[] = ["active", "pending", "archived", "superseded"];

export interface MemoryEntry {
  id: number;
  content: string;
  category: MemoryCategory;
  tags: string[];
  /** manual = 界面手工录入；agent = Agent / CLI / MCP 写入。 */
  source: "manual" | "agent";
  pinned: boolean;
  usageCount: number;
  lastAccessedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** 重要度 0..1：分类默认值 + 复用/置顶加成，参与检索打分与归档判定。 */
  importance: number;
  status: MemoryStatus;
  /** 来源描述：ui / cli / rest / mcp:claude / agent:conv-12。 */
  sourceRef: string | null;
  /** 项目作用域（工作区绝对路径，NULL = 全局记忆）。 */
  scope: string | null;
  /** 被哪条记忆取代。 */
  supersededBy: number | null;
  /** 可选失效时间（毫秒时间戳）。 */
  validUntil: number | null;
}

/** 检索命中：带分数拆解，便于 UI / 调试回答「为什么召回它」。 */
export interface MemoryHit extends MemoryEntry {
  /** 综合得分 0..1。 */
  score: number;
  /** 词法/语义相关度 0..1。 */
  relevance: number;
  /** 重要度归一 0..1。 */
  importanceScore: number;
  /** 新鲜度 0..1（按半衰期衰减）。 */
  recency: number;
  /** 命中来源：关键词 / 向量 / 两者。 */
  matched: "keyword" | "vector" | "both";
}

export interface MemorySaveResult {
  memory: MemoryEntry;
  /** created=新建；merged=与已有记忆合并；pending=待确认；blocked 由 error 返回。 */
  action: "created" | "merged" | "pending";
  /** merged：并入的既有条目 id。 */
  mergedWith?: number;
  /** 被本次写入取代的旧记忆 id。 */
  superseded?: number[];
}

export interface MemoryStats {
  total: number;
  active: number;
  pending: number;
  archived: number;
  superseded: number;
  pinned: number;
  /** 项目作用域记忆条数。 */
  scoped: number;
  agentWritten: number;
  updatedLast7d: number;
  /** 记忆正文总字符数（估算上下文成本）。 */
  chars: number;
  byCategory: Record<MemoryCategory, number>;
  /** 检索次数 / 命中次数（命中 = 至少返回 1 条）。 */
  searches: number;
  hitSearches: number;
  /** 写入合并次数与安全拦截次数。 */
  merges: number;
  blocked: number;
  /** 归档总数（累计）。 */
  archivedTotal: number;
  /** 已向量化的条数与嵌入模型名（未配置为空）。 */
  embedded: number;
  embeddingModel: string;
}

export interface MemoryEventEntry {
  id: number;
  memoryId: number | null;
  action: string;
  detail: unknown;
  createdAt: number | null;
}

/**
 * 写入与注入的硬约束：前后端共用，UI 校验与服务端裁剪保持一致。
 * 数值对齐主流记忆系统的默认量级（单条一句话、注入块千字符级）。
 */
export const MEMORY_LIMITS = {
  /** 单条记忆正文上限（字符）。 */
  maxContentChars: 500,
  /** 单条记忆标签数与单个标签长度上限。 */
  maxTags: 8,
  maxTagChars: 24,
  /** Agent 侧单次检索返回条数上限。 */
  maxSearchLimit: 20,
  /** 常驻核心记忆块预算（字符）与条数上限。 */
  coreBudgetChars: 1200,
  coreMaxItems: 8,
  /** 单轮按需召回预算（字符）与条数上限。 */
  recallBudgetChars: 800,
  recallMaxItems: 5,
  /** 同步到外部 Agent 上下文文件的托管区块预算。 */
  syncBudgetChars: 4000,
  syncMaxItems: 60,
} as const;
