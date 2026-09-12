/**
 * 知识库（本地 RAG）共享类型：bun 主进程与 mainview 都要用，
 * 不 import 任何运行时模块，保持类型-only。
 */

/** 数据源类型：本地文件 / 手写笔记 / 网页。 */
export type KbDocKind = "file" | "note" | "web";

/** 摄取管道状态：pending → parsing → chunking → (embedding) → ready | failed。 */
export type KbDocStatus = "pending" | "parsing" | "chunking" | "embedding" | "ready" | "failed";

/** 单条命中来源（关键词 / 向量 / 两者都命中）。 */
export type KbHitMethod = "keyword" | "vector" | "both";

/** 聊天回答里的引用溯源（存在 assistant 消息行上）。 */
export type KbCitation = {
  /** 注入上下文里的编号，正文以 [n] 标注。 */
  n: number;
  kbId: number;
  kbName: string;
  docId: number;
  docName: string;
  /** 文档内分块序号（1 起）。 */
  seq: number;
  /** 内容开头预览，悬浮提示用。 */
  snippet: string;
};

/** 单条召回命中（召回测试页与检索内部共用）。 */
export type KbHit = {
  kbId: number;
  kbName: string;
  docId: number;
  docName: string;
  chunkId: number;
  seq: number;
  content: string;
  charCount: number;
  /** 融合后归一化得分（0-1，仅展示排序用）。 */
  score: number;
  method: KbHitMethod;
  keywordScore: number | null;
  vectorScore: number | null;
  /** 经过重排模型二次打分时为 true，rerankScore 为其相关性得分（0-1）。 */
  reranked?: boolean;
  rerankScore?: number | null;
  /** 分块所在标题路径（摄取时记录），引用与调试用。 */
  headingPath?: string | null;
  /** 在来源正文中的字符偏移（开启相邻分块合并时覆盖整段范围）。 */
  charStart?: number | null;
  charEnd?: number | null;
  /** 合并了相邻分块时，被并入的分块序号（含自身）。 */
  mergedSeqs?: number[];
};

/** 摄取队列中的一条作业（文档列表据此展示「排队中 / 第 2 次重试」）。 */
export type KbIngestJobView = {
  docId: number;
  state: "queued" | "running" | "done" | "failed" | "canceled";
  attempts: number;
  maxAttempts: number;
  nextRunAt: number;
  lastError: string | null;
};

/** 检索索引的运行时占用（治理页展示，帮助判断内存与规模）。 */
export type KbIndexStats = {
  kbId: number;
  chunks: number;
  vectors: number;
  dimensions: number;
  terms: number;
  bytes: number;
  builtAt: number;
};

/** 审计流水条目：谁在什么时候导入/删除/检索了什么。 */
export type KbEventEntry = {
  id: number;
  kbId: number | null;
  docId: number | null;
  action: string;
  detail: unknown;
  actor: string;
  createdAt: number | null;
};
