import type { InferenceEngine } from "./engines";

/** 本地模型服务实例的状态（与单实例时代的 ServerStatus 同名同义）。 */
export type ServedModelStatus = "stopped" | "starting" | "downloading" | "running" | "error";

/**
 * 一个已启动的本地模型服务实例。
 *
 * 一个实例 = 一个推理服务器进程（各自端口）；同一引擎可以同时驻留多个模型。
 * 主进程与 webview 共用这个形状（RPC 推送的就是它），UI 只读不改。
 */
export type ServedModelInfo = {
  /** 稳定 id：同一模型重复启动返回同一条，服务端与前端都用它引用实例。 */
  id: string;
  /** 加载目标：本地文件 / 仓库目录 / HF repo id。 */
  modelRef: string;
  /** 展示名（服务名 slug / 目录名）。 */
  label: string;
  engine: InferenceEngine;
  port: number;
  /** OpenAI 兼容端点（含 /v1）。 */
  endpoint: string;
  /** 请求里该填的 model id（llama.cpp / vLLM / SGLang 是 slug，MLX 是绝对路径）。 */
  servedName: string;
  status: ServedModelStatus;
  pid?: number;
  error?: string;
  startedAt?: number;
  /**
   * 端口就是该引擎设置里的端口：各 App、`omi`、外部集成默认连它，
   * 所以第一个启动的模型会占住设置端口（UI 上标记「默认端点」）。
   */
  usesDefaultPort: boolean;
  /** 是不是当前对话 / 默认模型用的那个（本地模式请求发给它）。 */
  isActive: boolean;
  /** 目录条目（整仓库加载）。 */
  isDir: boolean;
  /** 展示用的来源仓库名。 */
  repo?: string;
  sizeBytes?: number;
};

/** 已启动模型列表快照（推送 / 查询共用）。 */
export type ServedModelsSnapshot = {
  models: ServedModelInfo[];
  /** 当前活动模型 id（本地模式请求的目标）；没有时为 null。 */
  activeId: string | null;
};
