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
};
