import type { MemoryCategory, MemoryStatus } from "@/shared/memory";

export const CATEGORY_KEY = (c: MemoryCategory) => `settings.memory.category.${c}`;
export const STATUS_KEY = (s: MemoryStatus) => `settings.memory.status.${s}`;
