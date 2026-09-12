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

export interface MemoryEntry {
  id: number;
  content: string;
  category: MemoryCategory;
  tags: string[];
  /** manual = 设置页手工录入；agent = Agent 对话中经 memory_save 写入。 */
  source: "manual" | "agent";
  pinned: boolean;
  usageCount: number;
  lastAccessedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}
