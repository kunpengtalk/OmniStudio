import { BrowserView, BrowserWindow, RPCSchema, Updater, Utils } from "electrobun/bun";
import { asc, eq, desc, like, sql, inArray } from "drizzle-orm";
import path from "path";
import { existsSync, rmSync, copyFileSync, mkdirSync, appendFileSync } from "fs";

import { db, sqliteClient } from "../db";
import { documents, pages } from "../db/schema";
import { getAllSettings, getSetting, isConfigured, updateSettings } from "../db/settings";
import { getImagesBaseDir, getUploadsBaseDir } from "../image-server";
import { chatImageDir, chatImageUrl } from "../image-server";
import { safeBaseName, safeJoin } from "../path-safety";
import { processDocumentPages } from "../queue";
import { updateState, checkForUpdate, type UpdateInfo } from "../updates";
import * as ReleaseCheck from "../release-check";
import type { ReleaseCheckResult } from "../../shared/release";
import { getUserDataDir } from "../paths";
import * as ServerManager from "../server-manager";
import type { ServerStatus } from "../server-manager";
import * as Gateway from "../gateway";
import type { GatewayStatus } from "../gateway";
import { getSetupEnvironment, type SetupEnvironment } from "../setup-env";
import * as Chat from "../chat";
import type { Conversation, ChatMessage, ChatStats } from "../chat";
import * as Agent from "../agent";
import type { AgentEventRow, AgentMode } from "../agent";
import * as Mcp from "../mcp";
import type { McpServerConfig } from "../mcp";
import * as Memory from "../memory";
import * as MemorySync from "../memory-sync";
import type { MemoryCategory, MemoryEntry, MemoryEventEntry, MemoryStats, MemoryStatus } from "../../shared/memory";
import type { MemorySyncResult, MemorySyncStatus } from "../memory-sync";
import * as VoiceCall from "../voice-call";
import type { VoiceCallOutgoing, VoiceCallPhase, VoiceCallPreflight } from "../voice-call";
import * as RealtimeVoice from "../realtime-voice";
import type { RealtimeProviderConfig } from "../realtime-voice";
import * as Translate from "../translate";
import { listChatModels, selectChatModel, type ChatModelOption } from "../chat-model";
import * as CloudProviders from "../cloud-providers";
import type { CloudModelEntry, CloudProviderInfo } from "../../shared/cloud-providers";
import * as ModelScope from "../modelscope";
import * as HuggingFace from "../huggingface";
import * as ModelScan from "../model-scan";
import type {
  MarketFile,
  MarketSearchResult,
  ModelSource,
  SearchFormat,
} from "../../shared/modelscope";
import * as ModelStore from "../model-store";
import type { InstalledModel } from "../model-store";
import { getServerStats, type ServerStats } from "../stats";
import {
  startBenchmark,
  getBenchmarkRun,
  cancelBenchmark,
  listBenchmarkRecords,
  deleteBenchmarkRecord,
  clearBenchmarkRecords,
  type BenchmarkParams,
  type BenchmarkRunState,
  type BenchmarkRecordRow,
} from "../benchmark";
import { listEvalSuites, type EvalSuiteInfo } from "../eval";
import { downloadManager, type DownloadTask } from "../download-manager";
import * as Voice from "../voice";
import type { VoiceRecordRow, VoiceRecordKind, VoiceClone } from "../voice";
import * as Asr from "../asr";
import type { AsrModelItem, AsrSegment, AsrStatus } from "../asr";
import * as AsrAudioCpp from "../asr-audiocpp";
import type { AsrAudioCppModelInfo, AsrAudioCppStatus } from "../asr-audiocpp";
import * as WhisperEngine from "../whisper-engine";
import * as TTSModels from "../tts-models";
import type { TTSModelInfo } from "../tts-models";
import * as TTSLocal from "../tts-local";
import type { TtsLocalModelInfo, TtsLocalStatus } from "../tts-local";
import * as Ocr from "../ocr";
import type { OcrLangModelInfo, OcrStatus, OcrResult, OcrVlmResult, OcrProviderConfig } from "../ocr";
import * as PpOcr from "../ppocr";
import type { PpOcrModelSize } from "../../shared/ocr";
import * as ImageGen from "../image-gen";
import type { ImageGenConfig, ImageRecordRow, ImageGenBackend } from "../image-gen";
import * as MediaSetup from "../media-setup";
import type { MediaSetupCandidate, MediaSetupPayload } from "../media-setup";
import * as VideoGen from "../video-gen";
import type {
  VideoGenConfig,
  VideoRecordRow,
  VideoGenBackend,
} from "../video-gen";
import * as PromptLib from "../prompt-library";
import * as Up from "../user-prompt";
import * as MlxGen from "../mlx-gen";
import type {
  MlxModelInfo,
  MlxGenStatus,
  MlxModelDownloadProgress,
  MlxModelDownloadState,
  MlxGenPhase,
} from "../mlx-gen";
import type { EdgeVoice } from "../edge-tts";
import type { ModelCategory } from "../../shared/modelscope";
import * as Skills from "../skills";
import type {
  ToolInfo,
  ManagedSkill,
  SkillsShSkill,
  PresetView,
  ProjectView,
  ProjectSkillView,
  DiscoveredSkillGroup,
  SkillsInstallProgress,
} from "../../shared/skills";
import type { BackupStatus as SkillsBackupStatus } from "../skills/git-backup";
import type { SkillUpdateStatus as SkillUpdateStatusView } from "../skills/installer";
import type { CentralInfo as SkillsCentralInfo } from "../skills/central-repo";
import * as Knowledge from "../knowledge";
import type { KbCitation, KbEventEntry, KbHit, KbIndexStats } from "../../shared/knowledge";
import * as Backup from "../backup";
import type {
  BackupCreateRequest,
  BackupDownloadRequest,
  BackupEstimate,
  BackupFinishedEvent,
  BackupInspectResult,
  BackupProgress,
  BackupRemoteConfig,
  BackupRemoteEntry,
  BackupRestoreRequest,
  BackupSummary,
} from "../../shared/backup";

export type GitPreviewItem = { relPath: string; name: string; description: string | null };

/** 聊天附件允许的文本文件类型与大小上限（超限直接跳过）。 */
const CHAT_TEXT_FILE_RE =
  /\.(txt|md|markdown|json|csv|tsv|log|xml|yml|yaml|html?|htm|js|jsx|ts|tsx|mjs|cjs|css|scss|less|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|toml|ini|cfg|conf|sql|vue|svelte|graphql|proto)$/i;
const CHAT_FILE_MAX_BYTES = 512 * 1024;

export type PageData = {
  pageNumber: number;
  markdown: string | null;
  raw: string | null;
  status: string;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
};

export type DocumentMeta = {
  id: number;
  path: string;
  name: string;
  type: string;
  size: number;
  status: string;
  totalPages: number | null;
  processedPages: number | null;
  createdAt: number | null;
  processingStartedAt: number | null;
  /** 文件类别（决定侧边栏左侧图标：图片缩略图 / PDF 图标 / 通用图标）。仅列表接口返回。 */
  kind?: "image" | "pdf" | "other";
  /** 图片缩略图 URL（仅图片类且位于图片服务目录内，否则 null）。仅列表接口返回。 */
  thumbUrl?: string | null;
  /** 首页识别内容首行预览（列表标题用；无内容为 null）。仅列表接口返回。 */
  preview?: string | null;
};

export type DocumentFull = DocumentMeta & {
  pages: PageData[];
  imagesDir: string | null;
  completedAt: number | null;
  failedAt: number | null;
  error: string | null;
};

export type AppRPC = {
  bun: RPCSchema<{
    requests: {
      getSettings: {
        params: undefined;
        response: { configured: boolean; settings: Record<string, string>; platform: string };
      };
      updateSettings: {
        params: { settings: Record<string, string> };
        response: { ok: boolean };
      };
      checkConnection: {
        params: { baseUrl?: string; apiKey?: string } | undefined;
        response: { connected: boolean; error?: string };
      };
      listRemoteModels: {
        params: { baseUrl?: string; apiKey?: string } | undefined;
        response: { ok: boolean; models: string[]; error?: string };
      };
      /** 模型云服务商管理（cloud_providers 表；激活行同步写回 VLLM_* 槽位）。 */
      cloudProviderList: {
        params: undefined;
        response: { providers: CloudProviderInfo[]; activeId: string | null };
      };
      cloudProviderCreate: {
        params: { presetId?: string; name?: string; baseUrl?: string };
        response: { ok: boolean; id?: string; error?: string };
      };
      cloudProviderUpdate: {
        params: {
          id: string;
          name?: string;
          baseUrl?: string;
          apiKey?: string;
          models?: CloudModelEntry[];
        };
        response: { ok: boolean; error?: string };
      };
      cloudProviderDelete: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      cloudProviderActivate: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      cloudProviderDeactivate: {
        params: undefined;
        response: { ok: boolean };
      };
      checkLlamaServer: {
        params: undefined;
        response: { found: boolean; path?: string };
      };
      getSetupEnvironment: {
        params: undefined;
        response: SetupEnvironment;
      };
      startServer: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      stopServer: {
        params: undefined;
        response: { ok: boolean };
      };
      restartServer: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      getServerStatus: {
        params: undefined;
        response: { status: ServerStatus; pid?: number; logs: string; error?: string };
      };
      getServerStats: {
        params: undefined;
        response: ServerStats;
      };
      clearServerLogs: {
        params: undefined;
        response: { ok: boolean };
      };
      getGatewayStatus: {
        params: undefined;
        response: {
          enabled: boolean;
          status: GatewayStatus;
          host: string;
          port: number;
          configuredPort?: number;
          url: string;
          upstreamStatus: ServerStatus;
          error?: string;
          notice?: string;
        };
      };
      startGateway: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      stopGateway: {
        params: undefined;
        response: { ok: boolean };
      };
      restartGateway: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      openGatewayDocs: {
        params: { url: string };
        response: { ok: boolean };
      };
      generateGatewayKey: {
        params: undefined;
        response: { key: string };
      };
      getLaunchCommand: {
        params: { path?: string };
        response: { command: string; engine: string };
      };
      getDocuments: {
        params: { limit?: number; offset?: number; search?: string } | undefined;
        response: { documents: DocumentMeta[]; total: number };
      };
      getDocument: {
        params: { id: number };
        response: { document: DocumentFull | null };
      };
      openFileDialog: {
        params:
          | {
              allowedFileTypes?: string;
              /** 选择目录（知识库批量导入等场景）。 */
              canChooseDirectory?: boolean;
              canChooseFiles?: boolean;
              allowsMultipleSelection?: boolean;
            }
          | undefined;
        response: { paths: string[] };
      };
      addDocument: {
        params: { filePath: string };
        response: { id: number };
      };
      addDocumentByUpload: {
        params: { data: string; name: string; type: string };
        response: { id: number };
      };
      processDocument: {
        params: { id: number };
        response: { ok: boolean; error?: string };
      };
      deleteDocument: {
        params: { id: number };
        response: { ok: boolean };
      };
      saveImageToDownloads: {
        params: { url: string; filename: string };
        response: { ok: boolean };
      };
      saveAudioToFolder: {
        params: { url: string; filename: string };
        response: { ok: boolean; canceled?: boolean; path?: string; error?: string };
      };
      showInExplorer: {
        params: { filePath: string };
        response: { ok: boolean };
      };
      getUpdateState: {
        params: undefined;
        response: UpdateInfo;
      };
      applyUpdate: {
        params: undefined;
        response: undefined;
      };
      /** 检查 GitHub 仓库最新 release（10 分钟缓存，force 跳过）。 */
      checkReleaseUpdate: {
        params: { force?: boolean };
        response: ReleaseCheckResult;
      };
      /** 返回上次 release 检查结果（首屏展示用，从未检查为 null）。 */
      getReleaseCheck: {
        params: undefined;
        response: ReleaseCheckResult | null;
      };
      /** 触发内置更新器检查 + 自动下载（状态经 updateStatus 广播）。 */
      startAutoUpdate: {
        params: undefined;
        response: { ok: boolean };
      };
      /** 用系统默认程序打开文件/目录（Finder / 资源管理器）。 */
      openPath: {
        params: { path: string };
        response: { ok: boolean };
      };
      // Chat
      listConversations: {
        params: { app?: string } | undefined;
        response: { conversations: Conversation[] };
      };
      getConversation: {
        params: { id: number };
        response: { conversation: Conversation | null; messages: ChatMessage[] };
      };
      createConversation: {
        params: { title?: string; app?: string };
        response: { conversation: Conversation };
      };
      deleteConversation: {
        params: { id: number };
        response: { ok: boolean };
      };
      togglePinConversation: {
        params: { id: number };
        response: { ok: boolean; conversation?: Conversation; error?: string };
      };
      setConversationPinned: {
        params: { id: number; pinned: boolean };
        response: { ok: boolean; conversation?: Conversation; error?: string };
      };
      sendChatMessage: {
        params: {
          conversationId: number;
          content: string;
          images?: string[];
          webSearch?: boolean;
          files?: { name: string; content: string }[];
          /** 挂载的知识库（检索注入 + 引用溯源）。 */
          kbIds?: number[];
        };
        response: { ok: boolean; error?: string };
      };
      deleteMessage: {
        params: { conversationId: number; messageId: number };
        response: { ok: boolean };
      };
      regenerateMessage: {
        params: { conversationId: number; messageId: number };
        response: { ok: boolean; error?: string };
      };
      translateMessage: {
        params: { conversationId: number; messageId: number; targetLang?: string };
        response: { ok: boolean; error?: string };
      };
      runTranslation: {
        params: {
          text: string;
          sourceLang?: string;
          targetLang: string;
          engine?: "model" | "google";
          save?: boolean;
        };
        response: { text?: string; id?: number; error?: string };
      };
      listTranslationRecords: {
        params: { limit?: number } | undefined;
        response: { records: Translate.TranslationRecordRow[] };
      };
      deleteTranslationRecord: {
        params: { id: number };
        response: { ok: boolean };
      };
      // ---- 提示词库 ----
      getPromptLibraryStats: {
        params: undefined;
        response: { counts: Record<PromptLib.PromptKind, number> };
      };
      listPromptCategories: {
        params: { kind: PromptLib.PromptKind };
        response: { categories: PromptLib.PromptCategoryRow[] };
      };
      listPrompts: {
        params: PromptLib.PromptListParams;
        response: { items: PromptLib.PromptRow[]; total: number };
      };
      ensurePromptMedia: {
        params: { path: string };
        response: { url: string | null };
      };
      // ---- 我的提示词 ----
      listMyPrompts: {
        params: Up.MyPromptListParams;
        response: { items: Up.UserPromptView[]; total: number };
      };
      listMyPromptCategories: {
        params: undefined;
        response: { categories: { name: string; intro: string | null; count: number }[] };
      };
      listMyPromptSourceKeys: {
        params: undefined;
        response: { keys: string[] };
      };
      getMyPromptStats: {
        params: undefined;
        response: { counts: Record<Up.PromptKind, number> };
      };
      createMyPrompt: {
        params: Up.MyPromptInput;
        response: { item: Up.UserPromptView };
      };
      importMyPromptFromPlaza: {
        params: { sourceId: number };
        response: { item?: Up.UserPromptView; already?: boolean };
      };
      updateMyPrompt: {
        params: { id: number; patch: Up.MyPromptPatch };
        response: { item: Up.UserPromptView | null };
      };
      deleteMyPrompt: {
        params: { id: number };
        response: { ok: boolean };
      };
      listChatModels: {
        params: undefined;
        response: { models: ChatModelOption[] };
      };
      selectChatModel: {
        params: { type: "local" | "api"; value: string };
        response: { ok: boolean; error?: string; restarting?: boolean };
      };
      // Agent（Pi Agent Harness）
      sendAgentMessage: {
        params: {
          conversationId: number;
          content: string;
          mode?: string;
          workspace?: string;
          files?: { name: string; content: string }[];
          imagePaths?: string[];
        };
        response: { ok: boolean; error?: string };
      };
      stopAgentRun: {
        params: { conversationId: number };
        response: { ok: boolean };
      };
      regenerateAgentMessage: {
        params: { conversationId: number; messageId: number };
        response: { ok: boolean; error?: string };
      };
      listAgentEvents: {
        params: { conversationId: number };
        response: { events: AgentEventRow[] };
      };
      listAgentTools: {
        params: { mode?: string } | undefined;
        response: { tools: { name: string; label: string; description: string }[] };
      };

      // -----------------------------------------------------------------
      // MCP 服务器管理
      // -----------------------------------------------------------------
      /** 服务器列表 + 当前连接状态（缓存里活着的才算已连接）。 */
      mcpListServers: {
        params: undefined;
        response: {
          servers: (McpServerConfig & { status?: { connected: boolean; toolCount: number } })[];
        };
      };
      /** 新建 / 编辑（带 id 为编辑）。 */
      mcpSaveServer: {
        params: { server: McpServerConfig };
        response: { ok: boolean; server: McpServerConfig };
      };
      mcpDeleteServer: {
        params: { id: number };
        response: { ok: boolean };
      };
      mcpSetServerEnabled: {
        params: { id: number; enabled: boolean };
        response: { ok: boolean };
      };
      /** 连接并枚举工具。带 id 用库内配置，否则用传入的临时配置（保存前预检）。 */
      mcpTestServer: {
        params: { server: McpServerConfig };
        response: {
          ok: boolean;
          tools: { name: string; description: string }[];
          error?: string;
        };
      };
      /** 解析 Claude Desktop / Cursor 风格 mcp.json 文本，预览待导入服务器。 */
      mcpParseJson: {
        params: { text: string };
        response: { ok: boolean; servers: McpServerConfig[]; error?: string };
      };

      // -----------------------------------------------------------------
      // 记忆（所有 Agent 共享的长期记忆库）
      // -----------------------------------------------------------------
      /** 记忆列表（可按关键词 / 分类 / 状态过滤，置顶与重要度优先）。 */
      memoryList: {
        params:
          | {
              query?: string;
              category?: MemoryCategory;
              status?: MemoryStatus | "all" | "open";
              limit?: number;
            }
          | undefined;
        response: { memories: MemoryEntry[] };
      };
      /** 新建 / 编辑（带 id 为编辑）。 */
      memorySave: {
        params: {
          memory: {
            id?: number;
            content: string;
            category?: MemoryCategory;
            tags?: string[];
            pinned?: boolean;
            importance?: number;
          };
        };
        response: { ok: boolean; memory: MemoryEntry };
      };
      memoryDelete: {
        params: { id: number };
        response: { ok: boolean };
      };
      memorySetPinned: {
        params: { id: number; pinned: boolean };
        response: { ok: boolean };
      };
      /** 更改生命周期状态：确认待确认记忆 / 归档 / 恢复。 */
      memorySetStatus: {
        params: { id: number; status: MemoryStatus };
        response: { ok: boolean };
      };
      /** 待用户确认的 Agent 写入（开启「写入需确认」后出现）。 */
      memoryPending: {
        params: undefined;
        response: { memories: MemoryEntry[] };
      };
      /** 记忆统计（条数分布、检索命中率、合并与拦截次数、向量化进度）。 */
      memoryStats: {
        params: undefined;
        response: { stats: MemoryStats };
      };
      /** 记忆审计流水（写入 / 合并 / 取代 / 归档 / 删除）。 */
      memoryEvents: {
        params: { limit?: number; memoryId?: number } | undefined;
        response: { events: MemoryEventEntry[] };
      };
      /** 生命周期维护：归档过期 / 长期未用的低价值记忆，补向量。 */
      memoryMaintain: {
        params: undefined;
        response: { hashed: number; expired: number; archived: number; consolidated: number; embedded: number };
      };
      /** 导出全部记忆（JSON，可备份 / 迁移）。 */
      memoryExport: {
        params: undefined;
        response: { version: number; exportedAt: number; memories: MemoryEntry[] };
      };
      /** 导入记忆（逐条判重合并）。 */
      memoryImport: {
        params: { payload: unknown };
        response: { imported: number; merged: number; rejected: number; errors: string[] };
      };
      /** 外部 Agent 同步状态（各工具上下文文件是否已含托管区块）。 */
      memorySyncStatus: {
        params: undefined;
        response: { targets: MemorySyncStatus[] };
      };
      /** 一键同步 / 移除：把记忆写入（或从）目标工具的上下文文件托管区块。 */
      memorySyncApply: {
        params: { tools: string[]; remove?: boolean };
        response: { results: MemorySyncResult[] };
      };
      getAgentWorkspace: {
        params: undefined;
        response: { workspace: string; isDefault: boolean };
      };
      // 实时语音通话（本地 ASR + agent + TTS / 云端 Qwen Realtime）
      voicecallPreflight: {
        params: undefined;
        response: VoiceCallPreflight;
      };
      voicecallStart: {
        params: { conversationId?: number; provider?: "local" | "cloud" };
        response: { ok: boolean; conversation?: Conversation; error?: string };
      };
      voicecallPushAudio: {
        params: { conversationId: number; wavBase64: string; format?: "wav" | "pcm" };
        response: { ok: boolean };
      };
      voicecallEndUtterance: {
        params: { conversationId: number };
        response: { ok: boolean; text?: string; error?: string };
      };
      voicecallInterrupt: {
        params: { conversationId: number };
        response: { ok: boolean };
      };
      voicecallStop: {
        params: { conversationId: number };
        response: { ok: boolean };
      };
      voicecallGetProviderConfig: {
        params: undefined;
        response: { config: RealtimeProviderConfig };
      };
      voicecallSaveProviderConfig: {
        params: {
          provider?: "local" | "cloud";
          apiKey?: string;
          baseUrl?: string;
          model?: string;
          voice?: string;
        };
        response: { ok: boolean };
      };
      voicecallDebug: {
        params: { line: string };
        response: { ok: boolean };
      };
      voicecallTestRealtime: {
        params: {
          apiKey?: string;
          baseUrl?: string;
          model?: string;
          voice?: string;
        };
        response: { ok: boolean; error?: string; latencyMs?: number };
      };
      openDirectoryDialog: {
        params: undefined;
        response: { path: string };
      };
      stageChatImages: {
        params: { conversationId: number; paths: string[] };
        response: { images: { ref: string; url: string }[] };
      };
      stageChatFiles: {
        params: { conversationId: number; paths: string[] };
        response: { files: { name: string; content: string }[] };
      };
      discardChatImage: {
        params: { ref: string };
        response: { ok: boolean };
      };
      // 模型市场：检索 / 列仓库文件（ModelScope 与 HuggingFace 共用同一组接口，
      // 由 `source` 决定请求打到哪个平台，返回值里的 source/formats 决定 UI 怎么标注）。
      searchMarketModels: {
        params: { query: string; page?: number; source?: ModelSource; format?: SearchFormat };
        response: MarketSearchResult;
      };
      listModelFiles: {
        params: { repo: string; source?: ModelSource };
        response: { files: MarketFile[] };
      };
      listDownloads: {
        params: undefined;
        response: { tasks: DownloadTask[] };
      };
      startModelDownload: {
        params: { repo: string; fileName: string; category?: ModelCategory; source?: ModelSource };
        response: { task: DownloadTask };
      };
      pauseModelDownload: {
        params: { id: string };
        response: { ok: boolean };
      };
      resumeModelDownload: {
        params: { id: string };
        response: { ok: boolean };
      };
      cancelModelDownload: {
        params: { id: string };
        response: { ok: boolean };
      };
      removeDownload: {
        params: { id: string };
        response: { ok: boolean };
      };
      listInstalledModels: {
        params: undefined;
        response: { models: InstalledModel[] };
      };
      toggleFavoriteModel: {
        params: { path: string };
        response: { ok: boolean };
      };
      setActiveModel: {
        params: { path: string };
        response: { ok: boolean; error?: string };
      };
      deleteLocalModel: {
        params: { path: string };
        response: { ok: boolean; error?: string; freed?: number };
      };
      importModelFile: {
        params: { sourcePath: string };
        response: { ok: boolean; path?: string; error?: string };
      };
      getModelDirs: {
        params: undefined;
        response: {
          dirs: string[];
          /** 每个扫描目录的详情（模型数 / 体积），用于"本地模型目录"管理。 */
          entries: { path: string; kind: "primary" | "extra" | "hf-cache"; exists: boolean; count: number; size: number }[];
        };
      };
      scanModelDir: {
        params: { dir: string };
        response: {
          ok: boolean;
          error?: string;
          count: number;
          totalSize: number;
          files: { name: string; repo: string; size: number; kind: string }[];
        };
      };
      addModelDir: {
        params: { dir: string };
        response: { ok: boolean; error?: string; count?: number };
      };
      removeModelDir: {
        params: { dir: string };
        response: { ok: boolean; error?: string };
      };
      getAboutInfo: {
        params: undefined;
        response: {
          version: string;
          channel: string;
          sessionStartedAt: number;
          basePath: string;
          dataDir: string;
        };
      };
      // Benchmark（速度扫描 + 能力评测：异步任务 + 历史记录）
      startBenchmark: {
        params: BenchmarkParams;
        response: { runId: string } | { error: string };
      };
      getBenchmarkRun: {
        params: { runId: string };
        response: { run: BenchmarkRunState | null };
      };
      cancelBenchmark: {
        params: { runId: string };
        response: { ok: boolean };
      };
      listBenchmarkRecords: {
        params: undefined;
        response: { records: BenchmarkRecordRow[] };
      };
      deleteBenchmarkRecord: {
        params: { id: number };
        response: { ok: boolean };
      };
      clearBenchmarkRecords: {
        params: undefined;
        response: { ok: boolean };
      };
      /** 能力评测套件清单（含题库下载状态）。 */
      getEvalSuites: {
        params: undefined;
        response: { suites: EvalSuiteInfo[] };
      };
      // Voice (TTS / ASR / voice cloning)
      listVoiceRecords: {
        params: { kind?: VoiceRecordKind } | undefined;
        response: { records: VoiceRecordRow[] };
      };
      deleteVoiceRecord: {
        params: { id: number };
        response: { ok: boolean };
      };
      stageAudio: {
        params: { paths: string[] };
        response: { files: { ref: string; url: string }[] };
      };
      runTTS: {
        params: {
          text: string;
          voice?: string;
          model?: string;
          base?: string;
          referenceAudioRef?: string;
        };
        response: { record: VoiceRecordRow };
      };
      runASR: {
        params: { audioRef: string; model?: string };
        response: { record: VoiceRecordRow };
      };
      listVoiceClones: {
        params: undefined;
        response: { clones: VoiceClone[] };
      };
      createVoiceClone: {
        params: { name: string; audioRef: string; model?: string };
        response: { clone: VoiceClone };
      };
      deleteVoiceClone: {
        params: { id: string };
        response: { ok: boolean };
      };
      // TTS model launcher (Edge TTS + vLLM-deployable TTS models)
      listTTSModels: {
        params: undefined;
        response: { models: TTSModelInfo[] };
      };
      downloadTTSModel: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      enableTTSModel: {
        params: { id: string; enabled: boolean };
        response: { ok: boolean };
      };
      listEdgeVoices: {
        params: undefined;
        response: { voices: EdgeVoice[] };
      };
      listTTSHttpVoices: {
        params: undefined;
        response: { voices: { id: string; name: string; desc?: string }[] };
      };
      runTTSEdge: {
        params: { text: string; voice: string };
        response: { record: VoiceRecordRow };
      };
      getTTSProviderConfig: {
        params: undefined;
        response: { config: { base: string; apiKey: string; model: string } };
      };
      saveTTSProviderConfig: {
        params: { base?: string; apiKey?: string; model?: string };
        response: { ok: boolean };
      };
      listProviderModels: {
        params: { base?: string; apiKey?: string } | undefined;
        response: { models: string[]; error?: string };
      };
      // Local ASR (whisper.cpp engine + remote fallback)
      listAsrModels: {
        params: undefined;
        response: { models: AsrModelItem[] };
      };
      getAsrStatus: {
        params: undefined;
        response: AsrStatus;
      };
      downloadWhisperEngine: {
        params: undefined;
        response: { ok: boolean; error?: string; version?: string };
      };
      startAsr: {
        params: { model?: string } | undefined;
        response: { ok: boolean; error?: string };
      };
      stopAsr: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      transcribeAudio: {
        params: {
          audioRef?: string;
          wavBase64?: string;
          model?: string;
          save?: boolean;
          source?: "auto" | "local" | "remote";
          diarize?: boolean;
        };
        response: {
          text: string;
          engine: string;
          segments?: AsrSegment[];
          hasSpeakers?: boolean;
          record?: VoiceRecordRow;
          error?: string;
        };
      };
      getASRProviderConfig: {
        params: undefined;
        response: { config: { base: string; apiKey: string; model: string } };
      };
      saveASRProviderConfig: {
        params: { base?: string; apiKey?: string; model?: string };
        response: { ok: boolean };
      };
      // Local ASR engine (audio.cpp)
      listAsrAudioCppModels: {
        params: undefined;
        response: { models: AsrAudioCppModelInfo[]; error?: string };
      };
      getAsrAudioCppStatus: {
        params: undefined;
        response: AsrAudioCppStatus;
      };
      startAsrAudioCpp: {
        params: { modelId: string };
        response: { ok: boolean; error?: string };
      };
      stopAsrAudioCpp: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      deleteAsrAudioCppModel: {
        params: { modelId: string };
        response: { ok: boolean; error?: string };
      };
      // Local TTS engine (audio.cpp)
      listTtsLocalModels: {
        params: undefined;
        response: { models: TtsLocalModelInfo[] };
      };
      getTtsLocalStatus: {
        params: undefined;
        response: TtsLocalStatus;
      };
      downloadTtsLocalEngine: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      startTtsLocal: {
        params: { modelId: string } | undefined;
        response: { ok: boolean; error?: string };
      };
      stopTtsLocal: {
        params: undefined;
        response: { ok: boolean };
      };
      deleteTtsLocalModel: {
        params: { modelId: string };
        response: { ok: boolean };
      };
      runTTSLocal: {
        params: { text: string; voice?: string; emotion?: string; language?: string; instruct?: string; model?: string };
        response: { record: VoiceRecordRow };
      };
      // OCR（Tesseract 本地引擎 + VLM 服务）
      listOcrModels: {
        params: undefined;
        response: { models: OcrLangModelInfo[]; error?: string };
      };
      getOcrStatus: {
        params: undefined;
        response: OcrStatus;
      };
      downloadOcrModel: {
        params: { modelId: string };
        response: { ok: boolean; error?: string };
      };
      startOcr: {
        params: { modelId: string };
        response: { ok: boolean; error?: string };
      };
      stopOcr: {
        params: undefined;
        response: { ok: boolean };
      };
      /** 一键安装 tesseract 引擎（brew install，日志经 tesseractInstallLog 推送）。 */
      installTesseractEngine: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      deleteOcrModel: {
        params: { modelId: string };
        response: { ok: boolean };
      };
      stageOcrImage: {
        params: { paths: string[] };
        response: { files: { ref: string; url: string }[] };
      };
      runOcr: {
        params: { imageRef: string; model?: string; psm?: number };
        response: { result?: OcrResult; error?: string };
      };
      runOcrVlm: {
        params: { imageRef: string; profileId?: string; source?: "local" | "remote" };
        response: { result?: OcrVlmResult; error?: string };
      };
      getOcrProviderConfig: {
        params: undefined;
        response: { config: OcrProviderConfig };
      };
      saveOcrProviderConfig: {
        params: { base?: string; apiKey?: string; model?: string };
        response: { ok: boolean };
      };
      listOcrProviderModels: {
        params: { base?: string; apiKey?: string } | undefined;
        response: { models: string[]; error?: string };
      };
      // PaddleOCR（本地 PP-OCRv6 引擎）
      getPpOcrStatus: {
        params: undefined;
        response: PpOcr.PpOcrStatus;
      };
      downloadPpOcrEngine: {
        params: undefined;
        response: { ok: boolean; error?: string; version?: string };
      };
      startPpOcr: {
        params: { modelSize?: PpOcrModelSize };
        response: { ok: boolean; error?: string; already?: boolean };
      };
      stopPpOcr: {
        params: undefined;
        response: { ok: boolean };
      };
      /** 下载指定档位的 PP-OCRv6 模型（det+rec，缺哪个下哪个；分片断点续传）。 */
      downloadPpOcrModels: {
        params: { modelSize: PpOcrModelSize };
        response: { ok: boolean; canceled?: boolean; error?: string };
      };
      /** 取消进行中的模型下载（保留分片，可后续续传）。 */
      cancelPpOcrModelDownload: {
        params: { modelSize: PpOcrModelSize };
        response: { ok: boolean };
      };
      /** 清空指定档位的未完成分片（重新下载前把半成品清掉）。 */
      deletePpOcrPartialModels: {
        params: { modelSize: PpOcrModelSize };
        response: { ok: boolean };
      };
      /** 清理引擎残留（删除虚拟环境，保留已下载模型），装坏后可重置重装。 */
      cleanupPpOcrEngine: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      /** 删除指定档位的全部模型文件（含半成品分片），可重新下载。 */
      deletePpOcrModels: {
        params: { modelSize: PpOcrModelSize };
        response: { ok: boolean };
      };
      runPpOcr: {
        params: { imageRef: string; modelSize?: PpOcrModelSize };
        response: { result?: OcrResult; error?: string };
      };
      // AI 生图
      stageEditImage: {
        params: { paths: string[] };
        response: { files: { ref: string; url: string }[] };
      };
      generateImage: {
        params: {
          prompt: string;
          negativePrompt?: string;
          width?: number;
          height?: number;
          count?: number;
          seed?: number;
          steps?: number;
          model?: string;
          quantize?: number;
          /** AI 修图：参考图 ref（images 目录内）。 */
          referenceImageRef?: string;
          config?: Partial<ImageGenConfig>;
        };
        response: { records: ImageRecordRow[]; error?: string };
      };
      listImageRecords: {
        params: { limit?: number } | undefined;
        response: { records: ImageRecordRow[] };
      };
      deleteImageRecord: {
        params: { id: number };
        response: { ok: boolean };
      };
      getImageGenConfig: {
        params: undefined;
        response: { config: ImageGenConfig };
      };
      saveImageGenConfig: {
        params: Partial<ImageGenConfig>;
        response: { ok: boolean };
      };
      listImageGenModels: {
        params: { backend?: ImageGenBackend; base?: string; apiKey?: string } | undefined;
        response: { models: string[]; error?: string };
      };
      /** Agent 生图弹窗：用户点了确认 / 取消后回传，主进程继续那次工具调用。 */
      resolveMediaSetup: {
        params: {
          id: string;
          action: "confirm" | "cancel";
          backend?: string;
          model?: string;
          apiBase?: string;
          apiKey?: string;
          comfyBase?: string;
        };
        response: { ok: boolean };
      };
      /** Agent 生图弹窗里的「扫描模型」：用表单当前值探测，不落盘配置。 */
      scanMediaSetupCandidates: {
        params: { kind?: string; backend?: string; base?: string; apiKey?: string } | undefined;
        response: { candidates: MediaSetupCandidate[]; error?: string };
      };
      // AI 视频生成（comfyui 本地 / minimax / seedance 云端，提交任务 + 轮询）
      submitVideoGeneration: {
        params: {
          prompt: string;
          negativePrompt?: string;
          duration?: number;
          ratio?: string;
          resolution?: string;
          seed?: number;
          steps?: number;
          cfg?: number;
          model?: string;
          /** 图生视频首帧（images 目录内 ref，仅云端后端支持）。 */
          firstFrameRef?: string;
          watermark?: boolean;
          config?: Partial<VideoGenConfig>;
        };
        response: { record?: VideoRecordRow; error?: string };
      };
      pollVideoRecords: {
        params: { ids: number[] };
        response: { records: VideoRecordRow[] };
      };
      listVideoRecords: {
        params: { limit?: number } | undefined;
        response: { records: VideoRecordRow[] };
      };
      deleteVideoRecord: {
        params: { id: number };
        response: { ok: boolean };
      };
      getVideoGenConfig: {
        params: undefined;
        response: { config: VideoGenConfig };
      };
      saveVideoGenConfig: {
        params: Partial<VideoGenConfig>;
        response: { ok: boolean };
      };
      listVideoGenModels: {
        params: { backend?: VideoGenBackend; base?: string } | undefined;
        response: {
          models: string[];
          checkpoints: string[];
          clips: string[];
          vaes: string[];
          error?: string;
        };
      };
      // MLX 本地生图引擎（mflux）
      getMlxGenStatus: {
        params: undefined;
        response: MlxGenStatus;
      };
      downloadMlxGenEngine: {
        params: undefined;
        response: { ok: boolean; error?: string; version?: string };
      };
      listMlxGenModels: {
        params: undefined;
        response: { models: MlxModelInfo[] };
      };
      downloadMlxModel: {
        params: { modelId: string };
        response: { ok: boolean; error?: string };
      };
      /** 已下载（可生成）的 MLX 模型 id 列表。 */
      getDownloadedMlxModels: {
        params: undefined;
        response: { downloaded: string[] };
      };
      /** 各模型持久化的下载进度（UI 据此展示「继续下载（已下载 X%）」）。 */
      getMlxModelDownloadStates: {
        params: undefined;
        response: { states: MlxModelDownloadState[] };
      };
      /** 启动常驻生图 worker（加载模型到内存，之后生图快）。 */
      startMlxModel: {
        params: { modelId: string; quantize?: number };
        response: { ok: boolean; error?: string; already?: boolean };
      };
      /** 停止常驻 worker，释放内存。 */
      stopMlxModel: {
        params: undefined;
        response: { ok: boolean };
      };
      /** 当前已启动（常驻）的模型，无则 null。 */
      getMlxActiveModel: {
        params: undefined;
        response: { active: { modelId: string; quantize: number } | null };
      };

      // -----------------------------------------------------------------
      // Skills 管理（参照 skills-manager 移植）
      // -----------------------------------------------------------------
      /** 工具列表（53 内置 + 自定义，含安装检测/启停/中央库同根标记）。 */
      skillsGetTools: {
        params: undefined;
        response: { tools: ToolInfo[] };
      };
      skillsSetToolEnabled: {
        params: { tool: string; enabled: boolean };
        response: { ok: boolean };
      };
      skillsSetAllToolsEnabled: {
        params: { enabled: boolean };
        response: { ok: boolean };
      };
      skillsSetCustomToolPath: {
        params: { tool: string; path: string | null };
        response: { ok: boolean };
      };
      skillsAddCustomTool: {
        params: { key: string; name: string; skillsDir: string; projectSkillsDir?: string; category: "coding" | "lobster" };
        response: { ok: boolean; error?: string };
      };
      skillsRemoveCustomTool: {
        params: { key: string };
        response: { ok: boolean };
      };
      /** 中央库信息（路径 / 技能数 / 体积 / 警告）。 */
      skillsGetCentralInfo: {
        params: undefined;
        response: SkillsCentralInfo;
      };
      skillsSetCentralPath: {
        params: { path: string };
        response: { ok: boolean; info: SkillsCentralInfo };
      };
      /** 重建索引（磁盘 → DB 收编，git pull 恢复后调用）。 */
      skillsReindex: {
        params: undefined;
        response: { added: string[]; removed: string[] };
      };
      /** 我的技能列表（含 target 实时同步状态）。 */
      skillsList: {
        params: undefined;
        response: { skills: ManagedSkill[] };
      };
      skillsGetDoc: {
        params: { skillId: string };
        response: { markdown: string | null };
      };
      skillsDelete: {
        params: { ids: string[] };
        response: { ok: boolean; errors: string[] };
      };
      skillsSetTags: {
        params: { skillId: string; tags: string[] };
        response: { ok: boolean };
      };
      skillsGetAllTags: {
        params: undefined;
        response: { tags: string[] };
      };
      skillsRenameTag: {
        params: { from: string; to: string };
        response: { ok: boolean };
      };
      skillsDeleteTag: {
        params: { tag: string };
        response: { ok: boolean };
      };
      /** skills.sh 市场：榜单（alltime/trending/hot）。 */
      skillsMarketLeaderboard: {
        params: { board: "alltime" | "trending" | "hot" };
        response: { skills: SkillsShSkill[] };
      };
      skillsMarketSearch: {
        params: { query: string; limit?: number };
        response: { skills: SkillsShSkill[] };
      };
      skillsInstallFromMarket: {
        params: { source: string; skillId: string };
        response: { ok: boolean; id?: string; error?: string };
      };
      skillsCancelInstall: {
        params: { ref: string };
        response: { ok: boolean };
      };
      /** Git URL 导入：预览仓库内的全部 skill 目录。 */
      skillsGitPreview: {
        params: { url: string };
        response: { ok: boolean; tempDir?: string; skills?: GitPreviewItem[]; error?: string };
      };
      skillsGitConfirm: {
        params: { url: string; tempDir: string; items: { relPath: string; name: string }[] };
        response: { ok: boolean; installed: string[]; errors: string[] };
      };
      skillsGitCancelPreview: {
        params: { tempDir: string };
        response: { ok: boolean };
      };
      /** 本地导入：目录 / .zip / .skill。 */
      skillsInstallLocal: {
        params: { path: string; name?: string };
        response: { ok: boolean; id?: string; error?: string };
      };
      skillsBatchImportFolder: {
        params: { path: string };
        response: { installed: string[]; errors: string[] };
      };
      skillsCheckUpdates: {
        params: { ids?: string[] };
        response: { statuses: SkillUpdateStatusView[] };
      };
      skillsUpdateSkill: {
        params: { skillId: string };
        response: { ok: boolean; error?: string; unchanged?: boolean };
      };
      /** 扫描已启用工具目录里已有的技能（收编用）。 */
      skillsScanDiscovered: {
        params: undefined;
        response: { groups: DiscoveredSkillGroup[] };
      };
      skillsImportDiscovered: {
        params: { name: string; paths: string[]; removeOriginal: boolean };
        response: { ok: boolean; id?: string; error?: string };
      };
      skillsImportAllDiscovered: {
        params: { groups: DiscoveredSkillGroup[]; removeOriginal: boolean };
        response: { installed: string[]; errors: string[] };
      };
      /** 同步：技能 → 工具（needConfirm = 目标被外部目录占用）。 */
      skillsSyncToTool: {
        params: { skillId: string; tool: string; overwrite?: boolean };
        response: { ok: boolean; error?: string; needConfirm?: boolean };
      };
      skillsUnsyncFromTool: {
        params: { skillId: string; tool: string };
        response: { ok: boolean; error?: string };
      };
      skillsGetSyncMode: {
        params: undefined;
        response: { mode: "symlink" | "copy" };
      };
      skillsSetSyncMode: {
        params: { mode: "symlink" | "copy" };
        response: { ok: boolean };
      };
      /** 场景（预设）。 */
      skillsListPresets: {
        params: undefined;
        response: { presets: PresetView[] };
      };
      skillsCreatePreset: {
        params: { name: string; description?: string | null; icon?: string | null };
        response: { id: string };
      };
      skillsUpdatePreset: {
        params: { id: string; name: string; description?: string | null; icon?: string | null };
        response: { ok: boolean };
      };
      skillsDeletePreset: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      skillsAddSkillsToPreset: {
        params: { presetId: string; skillIds: string[] };
        response: { ok: boolean };
      };
      skillsRemoveSkillFromPreset: {
        params: { presetId: string; skillId: string };
        response: { ok: boolean };
      };
      skillsApplyPreset: {
        params: { presetId: string };
        response: { ok: boolean; deployed: number; undeployed: number; errors: string[] };
      };
      skillsApplyPresetToAgents: {
        params: { presetId: string; mode: "add" | "remove" };
        response: { ok: boolean; count: number; errors: string[] };
      };
      skillsTogglePresetSkillTool: {
        params: { presetId: string; skillId: string; tool: string; enabled: boolean };
        response: { ok: boolean; error?: string };
      };
      skillsSetActivePreset: {
        params: { presetId: string };
        response: { ok: boolean };
      };
      /** Git 备份。 */
      skillsBackupStatus: {
        params: undefined;
        response: { status: SkillsBackupStatus };
      };
      skillsBackupInit: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      skillsBackupSetRemote: {
        params: { url: string; pat?: string };
        response: { ok: boolean; error?: string };
      };
      skillsBackupCommit: {
        params: { message?: string };
        response: { ok: boolean; error?: string };
      };
      skillsBackupPush: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      skillsBackupPull: {
        params: undefined;
        response: { ok: boolean; error?: string };
      };
      skillsBackupSetAuto: {
        params: { enabled: boolean };
        response: { ok: boolean };
      };
      skillsSnapshots: {
        params: undefined;
        response: { snapshots: { tag: string; date: string; subject: string }[] };
      };
      skillsCreateSnapshot: {
        params: { name?: string };
        response: { ok: boolean; tag?: string; error?: string };
      };
      skillsRestoreSnapshot: {
        params: { tag: string };
        response: { ok: boolean; error?: string };
      };
      skillsResolveConflict: {
        params: { keep: "local" | "remote" };
        response: { ok: boolean; error?: string };
      };
      skillsSizeReport: {
        params: undefined;
        response: { totalBytes: number; oversized: { id: string; bytes: number }[] };
      };
      /** 项目级管理。 */
      skillsListProjects: {
        params: undefined;
        response: { projects: ProjectView[] };
      };
      skillsAddProject: {
        params: { path: string };
        response: { ok: boolean; id?: string; error?: string; created?: string[] };
      };
      skillsRemoveProject: {
        params: { id: string };
        response: { ok: boolean };
      };
      skillsScanProjects: {
        params: { root: string };
        response: { projects: { path: string; agentDirs: string[] }[] };
      };
      skillsGetProjectSkills: {
        params: { projectId: string };
        response: { skills: ProjectSkillView[]; agentDirs: string[] };
      };
      skillsProjectImportToCenter: {
        params: { projectId: string; relDir: string };
        response: { ok: boolean; id?: string; error?: string };
      };
      skillsProjectExportFromCenter: {
        params: { projectId: string; skillId: string; agentRel?: string };
        response: { ok: boolean; error?: string };
      };
      skillsProjectUpdateToCenter: {
        params: { projectId: string; relDir: string };
        response: { ok: boolean; id?: string; error?: string };
      };
      skillsProjectToggleSkill: {
        params: { projectId: string; relDir: string; enabled: boolean };
        response: { ok: boolean; error?: string };
      };
      skillsProjectDeleteSkill: {
        params: { projectId: string; relDir: string };
        response: { ok: boolean; error?: string };
      };
      skillsGetProjectSkillDoc: {
        params: { projectId: string; relDir: string };
        response: { markdown: string | null };
      };
      /** 在系统文件管理器中打开目录（path="central" 时打开中央库内 skillId 子目录）。 */
      skillsOpenFolder: {
        params: { path: string; skillId?: string };
        response: { ok: boolean };
      };
      // ---- 知识库（本地 RAG） ----
      kbList: {
        params: undefined;
        response: { kbs: Knowledge.KbView[] };
      };
      kbCreate: {
        params: { name: string; description?: string; embeddingModel?: string; rerankModel?: string };
        response: { kb: Knowledge.KbView };
      };
      kbUpdate: {
        params: { id: number; patch: Knowledge.KbUpdatePatch };
        response: { kb: Knowledge.KbView; embeddingsReset: boolean };
      };
      kbDelete: {
        params: { id: number };
        response: { ok: boolean };
      };
      kbDocList: {
        params: { kbId: number };
        response: { docs: Knowledge.KbDocView[] };
      };
      kbAddFiles: {
        params: { kbId: number; paths: string[] };
        response: { docs: Knowledge.KbDocView[] };
      };
      kbAddFolder: {
        params: { kbId: number; path: string };
        response: { docs: Knowledge.KbDocView[]; skipped: number };
      };
      kbAddNote: {
        params: { kbId: number; title: string; content: string };
        response: { doc: Knowledge.KbDocView };
      };
      kbAddWeb: {
        params: { kbId: number; url: string };
        response: { doc: Knowledge.KbDocView };
      };
      kbDocDelete: {
        params: { id: number };
        response: { ok: boolean };
      };
      kbDocReingest: {
        params: { id: number };
        response: { ok: boolean };
      };
      kbChunks: {
        params: { docId: number };
        response: { chunks: Knowledge.KbChunkView[] };
      };
      kbEmbedMissing: {
        params: { kbId: number };
        response: { ok: boolean; embedded?: number; error?: string };
      };
      kbRecall: {
        params: { kbIds: number[]; query: string; topK?: number };
        response: { hits: KbHit[]; notes: string[] };
      };
      kbTestEmbedding: {
        params: { base?: string; apiKey?: string; model: string };
        response: { ok: boolean; dim?: number; error?: string };
      };
      kbEmbeddingModels: {
        params: { base?: string; apiKey?: string } | undefined;
        response: { models: string[] };
      };
      kbTestRerank: {
        params: { base?: string; apiKey?: string; model: string };
        response: { ok: boolean; error?: string };
      };
      kbRerankModels: {
        params: { base?: string; apiKey?: string } | undefined;
        response: { models: string[] };
      };
      /** 审计流水（谁在什么时候导入/删除/检索了什么）+ 各动作计数。 */
      kbEvents: {
        params: { kbId?: number; limit?: number } | undefined;
        response: { events: KbEventEntry[]; counts: Record<string, number> };
      };
      /** 摄取队列概览：排队 / 执行中 / 已失败。 */
      kbQueueStats: {
        params: undefined;
        response: { queued: number; running: number; failed: number };
      };
      /** 已加载检索索引的规模与内存占用（治理页展示）。 */
      kbIndexStats: {
        params: undefined;
        response: { indexes: KbIndexStats[] };
      };
      /** 整库导出到数据目录 kb-exports/（可选带向量）。 */
      kbExport: {
        params: { kbId: number; includeEmbeddings?: boolean };
        response: { path: string; bytes: number; docs: number; chunks: number };
      };
      /** 从导出 JSON 导入为新库（不覆盖既有数据）。 */
      kbImport: {
        params: { json: string; name?: string };
        response: { kb: Knowledge.KbView; docs: number; chunks: number; embedded: number };
      };
      /** 失败文档重新入队（沿用原作业，不清零重试次数）。 */
      kbDocRetry: {
        params: { id: number };
        response: { ok: boolean };
      };
      /** 在系统文件管理器中打开导出目录。 */
      kbOpenExportDir: {
        params: undefined;
        response: { ok: boolean; path: string };
      };
      /** 全局备份 / 恢复（设置 → 数据 → 备份与恢复）。 */
      backupList: {
        params: { dir?: string } | undefined;
        response: { dir: string; backups: BackupSummary[] };
      };
      /** 各作用域当前体积 / 行数估算，创建前预览用。 */
      backupEstimate: {
        params: undefined;
        response: BackupEstimate;
      };
      /** 备份目录 + 进行中的任务（刷新页面后仍能显示进度）。 */
      backupOverview: {
        params: undefined;
        response: { dir: string; appVersion: string; active: BackupProgress | null };
      };
      backupChooseDir: {
        params: undefined;
        response: { dir: string | null; error?: string; freeBytes?: number };
      };
      /** 选一个 .omnibackup 文件（恢复来源）。 */
      backupChooseFile: {
        params: undefined;
        response: { path: string | null };
      };
      /** 预览备份内容；不落地、不改动任何数据。 */
      backupInspect: {
        params: { path: string };
        response: BackupInspectResult;
      };
      /** 启动创建任务：立即返回 taskId，进度与结果走 backupProgress / backupFinished 事件。 */
      backupCreate: {
        params: BackupCreateRequest;
        response: { taskId: string };
      };
      /** 启动恢复任务（破坏性：覆盖所选作用域，默认先自动备份当前数据）。 */
      backupRestore: {
        params: BackupRestoreRequest;
        response: { taskId: string };
      };
      backupCancel: {
        params: { taskId: string };
        response: { ok: boolean };
      };
      backupDelete: {
        params: { path: string; dir?: string };
        response: { ok: boolean; error?: string };
      };
      backupReveal: {
        params: { path: string };
        response: { ok: boolean };
      };
      /** 远端存储（S3 / WebDAV）配置。 */
      backupRemoteGet: {
        params: undefined;
        response: { config: BackupRemoteConfig; configured: boolean };
      };
      backupRemoteSave: {
        params: { config: BackupRemoteConfig };
        response: { ok: boolean; error?: string };
      };
      backupRemoteTest: {
        params: undefined;
        response: { ok: boolean; error?: string; detail?: string };
      };
      backupRemoteList: {
        params: undefined;
        response: { entries: BackupRemoteEntry[]; error?: string };
      };
      /** 远端备份下载到本地（长任务，进度走 backupProgress 事件）。 */
      backupRemoteDownload: {
        params: BackupDownloadRequest;
        response: { taskId: string };
      };
      backupRemoteDelete: {
        params: { fileName: string };
        response: { ok: boolean; error?: string };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      updateStatus: UpdateInfo;
      documentChanged: { id: number };
      serverLog: { text: string };
      serverStatusChanged: { status: ServerStatus };
      chatChunk: {
        conversationId: number;
        messageId: number;
        delta: string;
        kind?: "reasoning" | "content";
      };
      chatDone: {
        conversationId: number;
        messageId: number;
        content: string;
        reasoning?: string;
        error?: string;
        /** 知识库引用溯源（挂了知识库的回答才有）。 */
        citations?: KbCitation[];
      };
      /** 知识库数据变化（摄取进度/删除/向量补齐），前端据此刷新列表。 */
      knowledgeChanged: { kbId?: number; docId?: number };
      chatStats: ChatStats;
      agentEvent: AgentEventRow;
      /** Agent 生图前需要用户介入（配后端 / 选模型）：界面弹窗，用户点确认后回传结果。 */
      mediaSetup: MediaSetupPayload;
      voicecallPartial: { conversationId: number; text: string };
      voicecallUtterance: { conversationId: number; messageId: number; text: string };
      voicecallState: { conversationId: number; phase: VoiceCallPhase };
      voicecallAudio: {
        conversationId: number;
        wavBase64: string;
        format: "wav" | "pcm";
      };
      voicecallAudioStop: { conversationId: number };
      voicecallError: { conversationId: number; message: string };
      modelDownloadProgress: {
        repo: string;
        fileName: string;
        progress: { received: number; total: number | null; percent: number | null };
      };
      downloadsChanged: {
        tasks: DownloadTask[];
      };
      gatewayStatusChanged: {
        status: GatewayStatus;
      };
      mlxInstallLog: {
        text: string;
      };
      mlxModelDownloadProgress: MlxModelDownloadProgress;
      /** 生图阶段事件：启动/加载/生成 n/N/完成。 */
      mlxGenPhase: MlxGenPhase;
      /** PaddleOCR 引擎安装日志 / 阶段（下载模型 / 加载 / 就绪 / 错误），实时推送。 */
      ppOcrInstallLog: { text: string };
      ppOcrPhase: { phase: PpOcr.PpOcrPhase; message: string };
      /** PaddleOCR 模型文件下载进度（字节 + 估算速度），模型卡实时进度条。 */
      ppOcrModelProgress: PpOcr.PpOcrModelProgress;
      /** Tesseract 引擎一键安装（brew install）日志，实时推送。 */
      tesseractInstallLog: { text: string };
      /** Skills 安装进度（市场/Git/更新），实时推送。 */
      skillsInstallProgress: SkillsInstallProgress;
      /** Skills 中央库发生变化（外部编辑/git pull/安装同步完成），前端刷新列表。 */
      skillsChanged: { reason?: string };
      /** CLI（`omi`）请求跳转到某个页面：models / settings / server / stats / chat / index。 */
      navigate: { path: string };
      /** 全局备份 / 恢复进度（节流推送）与终态。 */
      backupProgress: BackupProgress;
      backupFinished: BackupFinishedEvent;
      /** 备份文件列表发生变化（创建 / 删除 / 恢复完成）。 */
      backupChanged: { reason?: string };
    };
  }>;
};

export type BrowserWindowWithRPC = BrowserWindow<typeof appRPC>;

export const appRPC = BrowserView.defineRPC<AppRPC>({
  maxRequestTime: 900_000, // 15 minutes (large TTS model downloads)
  handlers: {
    requests: {
      getSettings: async () => ({
        configured: isConfigured(),
        settings: getAllSettings(),
        // 主进程平台信息，供 UI 做 macOS 专属引擎（MLX）的门控。
        platform: process.platform,
      }),

      updateSettings: async ({ settings }) => {
        updateSettings(settings);
        return { ok: true };
      },

      checkConnection: async (params) => {
        try {
          const baseUrl = params?.baseUrl ?? getSetting("VLLM_API_BASE");
          const apiKey = params?.apiKey ?? getSetting("VLLM_API_KEY");
          const res = await fetch(`${baseUrl}/models`, {
            headers: apiKey !== "EMPTY" ? { Authorization: `Bearer ${apiKey}` } : {},
            signal: AbortSignal.timeout(5000),
          });
          return { connected: res.ok };
        } catch (e) {
          return { connected: false, error: String(e) };
        }
      },

      // 拉取该 Key 有权限的远程模型列表（OpenAI 兼容 GET /models）
      listRemoteModels: async (params) => {
        try {
          const baseUrl = (params?.baseUrl ?? getSetting("VLLM_API_BASE") ?? "").replace(/\/+$/, "");
          const apiKey = params?.apiKey ?? getSetting("VLLM_API_KEY");
          if (!baseUrl) return { ok: false, models: [], error: "缺少 Base URL" };
          const res = await fetch(`${baseUrl}/models`, {
            headers: apiKey && apiKey !== "EMPTY" ? { Authorization: `Bearer ${apiKey}` } : {},
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) return { ok: false, models: [], error: `请求失败：HTTP ${res.status}` };
          // OpenAI 兼容返回 { data: [{id}] }，个别厂商用 { models: [...] }
          const data = (await res.json()) as { data?: { id?: unknown }[]; models?: { id?: unknown }[] };
          const items = data.data ?? data.models ?? [];
          const models = Array.from(
            new Set(items.map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean)),
          ).sort();
          return { ok: true, models };
        } catch (e) {
          return { ok: false, models: [], error: String(e) };
        }
      },

      cloudProviderList: async () => CloudProviders.listCloudProviders(),

      cloudProviderCreate: async (params) => CloudProviders.createCloudProvider(params ?? {}),

      cloudProviderUpdate: async (params) =>
        CloudProviders.updateCloudProvider(params.id, params ?? {}),

      cloudProviderDelete: async ({ id }) => CloudProviders.deleteCloudProvider(id),

      cloudProviderActivate: async ({ id }) => CloudProviders.activateCloudProvider(id),

      cloudProviderDeactivate: async () => CloudProviders.deactivateCloudProvider(),

      checkLlamaServer: async () => {
        return ServerManager.checkBinaryExists();
      },

      getSetupEnvironment: async () => {
        return getSetupEnvironment();
      },

      startServer: async () => {
        return ServerManager.startServer();
      },

      stopServer: async () => {
        await ServerManager.stopServer();
        return { ok: true };
      },

      restartServer: async () => {
        return ServerManager.restartServer();
      },

      getServerStatus: async () => {
        return {
          status: ServerManager.getStatus(),
          pid: ServerManager.getPid(),
          logs: ServerManager.getLogs(),
          error: ServerManager.getLastError() || undefined,
        };
      },

      getServerStats: async () => {
        return getServerStats();
      },

      getLaunchCommand: async ({ path }) => {
        return ServerManager.getLaunchCommand(path);
      },

      clearServerLogs: async () => {
        ServerManager.clearLogs();
        return { ok: true };
      },

      getGatewayStatus: async () => {
        const info = Gateway.getGatewayStatus();
        return {
          enabled: Gateway.isGatewayEnabled(),
          status: info.status,
          host: info.host,
          port: info.port,
          configuredPort: info.configuredPort,
          url: info.url,
          upstreamStatus: ServerManager.getStatus(),
          error: info.error,
          notice: info.notice,
        };
      },

      startGateway: async () => Gateway.startGateway(),

      stopGateway: async () => {
        await Gateway.stopGateway();
        return { ok: true };
      },

      restartGateway: async () => Gateway.restartGateway(),

      openGatewayDocs: async ({ url }) => {
        try {
          const cmd =
            process.platform === "darwin"
              ? ["open", url]
              : process.platform === "win32"
                ? ["cmd", "/c", "start", "", url]
                : ["xdg-open", url];
          Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },

      generateGatewayKey: async () => {
        return { key: Gateway.generateGatewayApiKey() };
      },

      getDocuments: async (params) => {
        const limit = params?.limit ?? 50;
        const offset = params?.offset ?? 0;
        const search = params?.search?.trim();

        const selectFields = {
          id: documents.id,
          path: documents.path,
          type: documents.type,
          size: documents.size,
          status: documents.status,
          totalPages: documents.totalPages,
          processedPages: documents.processedPages,
          createdAt: documents.createdAt,
          processingStartedAt: documents.processingStartedAt,
        };

        const baseQuery = search
          ? db.select(selectFields).from(documents).where(like(documents.path, `%${search}%`))
          : db.select(selectFields).from(documents);

        const countResult = search
          ? db
              .select({ count: sql<number>`count(*)` })
              .from(documents)
              .where(like(documents.path, `%${search}%`))
              .get()
          : db
              .select({ count: sql<number>`count(*)` })
              .from(documents)
              .get();

        const total = countResult?.count ?? 0;

        const docs = baseQuery.orderBy(desc(documents.createdAt)).limit(limit).offset(offset).all();
        if (docs.length === 0) return { documents: [], total };

        // 首页内容预览：识别记录的文件名常是 UUID，用识别文本做标题更有辨识度。
        const firstPages = db
          .select({ documentId: pages.documentId, markdown: pages.markdown })
          .from(pages)
          .where(
            inArray(
              pages.documentId,
              docs.map((d) => d.id),
            ),
          )
          .orderBy(asc(pages.pageNumber))
          .all();
        const previewByDoc = new Map<number, string>();
        for (const p of firstPages) {
          if (previewByDoc.has(p.documentId) || !p.markdown) continue;
          const firstLine =
            p.markdown
              .split("\n")
              .map((l) => l.trim())
              .find((l) => l.length > 0) ?? "";
          previewByDoc.set(
            p.documentId,
            firstLine.replace(/^[#>\s]+/, "").replace(/[*`]/g, "").trim().slice(0, 60),
          );
        }

        // 缩略图：图片类文档且位于图片服务目录内 → 直接给可加载的 URL；PDF 用图标。
        const imagesBase = getImagesBaseDir();
        const kindOf = (d: (typeof docs)[number]): "image" | "pdf" | "other" => {
          if (d.type === "application/pdf" || /\.pdf$/i.test(d.path)) return "pdf";
          if (
            d.type.startsWith("image/") ||
            /\.(png|jpe?g|webp|bmp|tiff?|gif|heic|heif)$/i.test(d.path)
          )
            return "image";
          return "other";
        };

        return {
          documents: docs.map((d) => {
            const kind = kindOf(d);
            const thumbUrl =
              kind === "image" && d.path.startsWith(imagesBase + path.sep)
                ? chatImageUrl(path.relative(imagesBase, d.path))
                : null;
            return {
              ...d,
              name: path.basename(d.path),
              kind,
              thumbUrl,
              preview: previewByDoc.get(d.id) ?? null,
            };
          }),
          total,
        };
      },

      getDocument: async ({ id }) => {
        const doc = db.select().from(documents).where(eq(documents.id, id)).get();
        if (!doc) return { document: null };
        const docPages = db
          .select({
            pageNumber: pages.pageNumber,
            markdown: pages.markdown,
            raw: pages.raw,
            status: pages.status,
            error: pages.error,
            startedAt: pages.startedAt,
            completedAt: pages.completedAt,
            failedAt: pages.failedAt,
          })
          .from(pages)
          .where(eq(pages.documentId, id))
          .orderBy(asc(pages.pageNumber))
          .all();
        return {
          document: { ...doc, name: path.basename(doc.path), pages: docPages },
        };
      },

      openFileDialog: async (params) => {
        const canChooseDirectory = params?.canChooseDirectory === true;
        const paths = await Utils.openFileDialog({
          allowedFileTypes: canChooseDirectory ? undefined : (params?.allowedFileTypes ?? "pdf,png,jpg,jpeg,webp,tiff,bmp,heic,heif"),
          canChooseFiles: params?.canChooseFiles ?? true,
          canChooseDirectory,
          allowsMultipleSelection: params?.allowsMultipleSelection ?? true,
        });
        return { paths: (paths ?? []).filter((p) => p && p.length > 0) };
      },

      addDocument: async ({ filePath }) => {
        const file = Bun.file(filePath);
        const result = db
          .insert(documents)
          .values({
            path: filePath,
            type: file.type || "application/octet-stream",
            size: file.size,
          })
          .returning({ id: documents.id })
          .get();

        return { id: result.id };
      },

      addDocumentByUpload: async ({ data, name, type }) => {
        const uploadsDir = getUploadsBaseDir();
        if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
        let destPath = path.join(uploadsDir, safeName);
        if (existsSync(destPath)) {
          const ext = path.extname(safeName);
          const base = safeName.slice(0, -ext.length || undefined);
          let n = 1;
          while (existsSync(destPath)) {
            destPath = path.join(uploadsDir, `${base}_${n}${ext}`);
            n++;
          }
        }
        const buffer = Buffer.from(data, "base64");
        await Bun.write(destPath, buffer);

        const bunFile = Bun.file(destPath);
        const result = db
          .insert(documents)
          .values({
            path: destPath,
            type: bunFile.type || type || "application/octet-stream",
            size: buffer.length,
          })
          .returning({ id: documents.id })
          .get();

        return { id: result.id };
      },

      processDocument: async ({ id }) => {
        const doc = db.select().from(documents).where(eq(documents.id, id)).get();
        if (!doc) return { ok: false, error: "Document not found" };

        processDocumentPages(id);
        return { ok: true };
      },

      deleteDocument: async ({ id }) => {
        const doc = db.select().from(documents).where(eq(documents.id, id)).get();
        if (doc?.imagesDir && existsSync(doc.imagesDir)) {
          rmSync(doc.imagesDir, { recursive: true, force: true });
        }
        db.delete(pages).where(eq(pages.documentId, id)).run();
        db.delete(documents).where(eq(documents.id, id)).run();
        return { ok: true };
      },

      saveImageToDownloads: async ({ url, filename }) => {
        try {
          const parsed = new URL(url);
          // 源路径（URL 里可能带 %2f..%2f）与目标文件名都来自调用方，双向都要限位。
          const ref = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
          const filePath = safeJoin(getImagesBaseDir(), ref);
          if (!filePath || !existsSync(filePath)) return { ok: false };
          const name = safeBaseName(filename);
          if (!name) return { ok: false };
          const dest = path.join(Utils.paths.downloads, name);
          copyFileSync(filePath, dest);
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },

      /** 选择目录并把生成的音频文件复制到该目录（重名自动加序号）。 */
      saveAudioToFolder: async ({ url, filename }) => {
        try {
          const parsed = new URL(url);
          const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
          const base = path.resolve(getImagesBaseDir());
          const src = path.resolve(base, relative);
          if (!src.startsWith(base + path.sep) || !existsSync(src)) {
            return { ok: false, error: "音频文件不存在" };
          }
          const dirs = await Utils.openFileDialog({
            startingFolder: Utils.paths.downloads,
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });
          const dir = (dirs ?? [])[0]?.trim();
          if (!dir) return { ok: false, canceled: true };

          const safeName = path.basename(filename).replace(/[\\/:*?"<>|]/g, "_") || "audio.mp3";
          const ext = path.extname(safeName);
          const stem = path.basename(safeName, ext);
          let dest = path.join(dir, safeName);
          let i = 1;
          while (existsSync(dest)) {
            dest = path.join(dir, `${stem} (${i})${ext}`);
            i++;
          }
          copyFileSync(src, dest);
          return { ok: true, path: dest };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      showInExplorer: async ({ filePath }) => {
        try {
          Utils.showItemInFolder(filePath);
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },

      getUpdateState: async () => {
        return updateState;
      },

      applyUpdate: async () => {
        console.log("Applying update...");
        Updater.applyUpdate();
      },

      checkReleaseUpdate: async ({ force }) => {
        return ReleaseCheck.checkGitHubRelease(force === true);
      },

      getReleaseCheck: async () => {
        return ReleaseCheck.getReleaseCheckResult();
      },

      startAutoUpdate: async () => {
        void checkForUpdate();
        return { ok: true };
      },

      openPath: async ({ path: target }) => {
        try {
          const cmd =
            process.platform === "darwin"
              ? ["open", target]
              : process.platform === "win32"
                ? ["cmd", "/c", "start", "", target]
                : ["xdg-open", target];
          Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },

      // Chat
      listConversations: async (params) => {
        return { conversations: Chat.listConversations(params?.app) };
      },

      getConversation: async ({ id }) => {
        return Chat.getConversation(id);
      },

      createConversation: async (params) => {
        return { conversation: Chat.createConversation(params?.title, params?.app) };
      },

      deleteConversation: async ({ id }) => {
        Agent.deleteConversationEvents(id);
        Chat.deleteConversation(id);
        return { ok: true };
      },

      togglePinConversation: async ({ id }) => {
        return Chat.togglePinConversation(id);
      },

      setConversationPinned: async ({ id, pinned }) => {
        return Chat.setConversationPinned(id, pinned);
      },

      sendChatMessage: async ({ conversationId, content, images, webSearch, files, kbIds }) => {
        return Chat.sendMessage(conversationId, content, images ?? [], { webSearch, files, kbIds });
      },

      deleteMessage: async ({ conversationId, messageId }) => {
        return Chat.deleteMessage(conversationId, messageId);
      },

      regenerateMessage: async ({ conversationId, messageId }) => {
        return Chat.regenerateMessage(conversationId, messageId);
      },

      translateMessage: async ({ conversationId, messageId, targetLang }) => {
        return Chat.translateMessage(conversationId, messageId, targetLang);
      },

      runTranslation: async (params) => {
        try {
          return await Translate.runTranslation(params);
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },

      listTranslationRecords: async (params) => {
        return { records: Translate.listTranslationRecords(params?.limit) };
      },

      deleteTranslationRecord: async ({ id }) => {
        return Translate.deleteTranslationRecord(id);
      },

      getPromptLibraryStats: async () => {
        return { counts: PromptLib.countPromptsByKind() };
      },

      listPromptCategories: async ({ kind }) => {
        return { categories: PromptLib.listCategories(kind) };
      },

      listPrompts: async (params) => {
        return PromptLib.listPrompts(params);
      },

      ensurePromptMedia: async ({ path }) => {
        return { url: await PromptLib.ensurePromptMedia(path) };
      },

      listMyPrompts: async (params) => {
        return Up.listMyPrompts(params);
      },

      listMyPromptCategories: async () => {
        return { categories: Up.listMyPromptCategories() };
      },

      listMyPromptSourceKeys: async () => {
        return { keys: Up.listMyPromptSourceKeys() };
      },

      getMyPromptStats: async () => {
        return { counts: Up.countMyPromptsByKind() };
      },

      createMyPrompt: async (params) => {
        return { item: Up.createMyPrompt(params) };
      },

      importMyPromptFromPlaza: async ({ sourceId }) => {
        return Up.importMyPromptFromPlaza(sourceId);
      },

      updateMyPrompt: async ({ id, patch }) => {
        return { item: Up.updateMyPrompt(id, patch) };
      },

      deleteMyPrompt: async ({ id }) => {
        return Up.deleteMyPrompt(id);
      },

      listChatModels: async () => {
        return listChatModels();
      },

      selectChatModel: async ({ type, value }) => {
        return selectChatModel(type, value);
      },

      // Agent（Pi Agent Harness）
      sendAgentMessage: async ({ conversationId, content, mode, workspace, files, imagePaths }) => {
        return Agent.runAgentTurn({
          conversationId,
          content,
          mode: (mode ?? undefined) as AgentMode | undefined,
          workspace: workspace ?? undefined,
          files: files ?? undefined,
          imagePaths: imagePaths ?? undefined,
        });
      },

      stopAgentRun: async ({ conversationId }) => {
        return Agent.stopAgentRun(conversationId);
      },

      regenerateAgentMessage: async ({ conversationId, messageId }) => {
        return Agent.regenerateAgentMessage(conversationId, messageId);
      },

      listAgentEvents: async ({ conversationId }) => {
        return { events: Agent.listAgentEvents(conversationId) };
      },

      listAgentTools: async (params) => {
        const mode = params?.mode as AgentMode | undefined;
        return { tools: await Agent.listAgentTools(mode) };
      },

      // MCP 服务器管理
      mcpListServers: async () => {
        const statuses = Mcp.mcpConnectionStatus();
        const servers = Mcp.listMcpServers().map((s) =>
          s.id && statuses[s.id] ? { ...s, status: statuses[s.id] } : s,
        );
        return { servers };
      },
      mcpSaveServer: async ({ server }) => {
        const saved = Mcp.upsertMcpServer(server);
        return { ok: true, server: saved };
      },
      mcpDeleteServer: async ({ id }) => {
        Mcp.deleteMcpServer(id);
        return { ok: true };
      },
      mcpSetServerEnabled: async ({ id, enabled }) => {
        Mcp.setMcpServerEnabled(id, enabled);
        return { ok: true };
      },
      mcpTestServer: async ({ server }) => {
        const result = await Mcp.testMcpServer(server);
        return {
          ok: result.ok,
          tools: result.tools.map((t) => ({ name: t.name, description: t.description })),
          error: result.error,
        };
      },
      mcpParseJson: async ({ text }) => {
        try {
          return { ok: true, servers: Mcp.parseMcpJson(text) };
        } catch (e) {
          return { ok: false, servers: [], error: e instanceof Error ? e.message : String(e) };
        }
      },

      // 记忆（所有 Agent 共享的长期记忆库）
      memoryList: async (params) => {
        // 有查询词时走排序检索（相关度/重要度/新鲜度），界面浏览不累计使用热度。
        if (params?.query?.trim()) {
          const hits = await Memory.searchMemories(params.query, {
            limit: params.limit ?? 50,
            category: params.category,
            includeArchived: params.status === "archived" || params.status === "all",
            trackUsage: false,
          });
          const filtered = params.status && params.status !== "all" && params.status !== "archived"
            ? hits.filter((h) => h.status === params.status)
            : hits;
          return { memories: filtered };
        }
        return { memories: Memory.listMemories(params ?? undefined) };
      },
      memorySave: async ({ memory }) => {
        const saved = Memory.saveMemory(memory);
        return { ok: true, memory: saved };
      },
      memorySetStatus: async ({ id, status }) => {
        Memory.setMemoryStatus(id, status);
        return { ok: true };
      },
      memoryPending: async () => {
        return { memories: Memory.pendingMemories() };
      },
      memoryStats: async () => {
        return { stats: Memory.memoryStats() };
      },
      memoryEvents: async (params) => {
        return { events: Memory.listMemoryEvents(params?.limit ?? 30, params?.memoryId) };
      },
      memoryMaintain: async () => {
        return Memory.runMemoryMaintenance();
      },
      memoryExport: async () => {
        return Memory.exportMemories();
      },
      memoryImport: async ({ payload }) => {
        return Memory.importMemories(payload);
      },
      memoryDelete: async ({ id }) => {
        Memory.deleteMemory(id);
        return { ok: true };
      },
      memorySetPinned: async ({ id, pinned }) => {
        Memory.setMemoryPinned(id, pinned);
        return { ok: true };
      },
      memorySyncStatus: async () => {
        return { targets: MemorySync.memorySyncStatus() };
      },
      memorySyncApply: async ({ tools, remove }) => {
        const results = remove
          ? MemorySync.removeMemoryFromTools(tools)
          : MemorySync.syncMemoryToTools(tools);
        return { results };
      },

      // 实时语音通话
      voicecallPreflight: async () => {
        return VoiceCall.voiceCallPreflight();
      },
      voicecallStart: async ({ conversationId, provider }) => {
        return VoiceCall.startVoiceCall({ conversationId, provider });
      },
      voicecallPushAudio: async ({ conversationId, wavBase64, format }) => {
        return VoiceCall.pushVoiceCallAudio({ conversationId, wavBase64, format });
      },
      voicecallEndUtterance: async ({ conversationId }) => {
        return VoiceCall.endVoiceCallUtterance({ conversationId });
      },
      voicecallInterrupt: async ({ conversationId }) => {
        return VoiceCall.interruptVoiceCall(conversationId);
      },
      voicecallStop: async ({ conversationId }) => {
        return VoiceCall.stopVoiceCall(conversationId);
      },
      voicecallGetProviderConfig: async () => {
        return { config: RealtimeVoice.getRealtimeProviderConfig() };
      },
      voicecallSaveProviderConfig: async (params) => {
        RealtimeVoice.saveRealtimeProviderConfig(params);
        return { ok: true };
      },
      voicecallDebug: async ({ line }) => {
        try {
          appendFileSync("/tmp/omni-voicecall.log", `[${new Date().toISOString()}] [frontend] ${line}\n`);
        } catch {
          // 日志失败忽略
        }
        return { ok: true };
      },
      voicecallTestRealtime: async (params) => {
        return VoiceCall.testRealtimeConnection(params ?? {});
      },

      openDirectoryDialog: async () => {
        const dirs = await Utils.openFileDialog({
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });
        return { path: (dirs ?? [])[0]?.trim() ?? "" };
      },

      getAgentWorkspace: async () => {
        const configured = getSetting("AGENT_WORKSPACE").trim();
        return { workspace: Agent.getAgentWorkspace(), isDefault: !configured };
      },

      stageChatImages: async ({ conversationId, paths }) => {
        const dir = chatImageDir(conversationId);
        mkdirSync(dir, { recursive: true });
        const images: { ref: string; url: string }[] = [];
        for (const p of paths) {
          if (!existsSync(p)) continue;
          const ext = path.extname(p).toLowerCase();
          if (!/^\.(png|jpe?g|webp|gif|bmp)$/.test(ext)) continue;
          const name = `${crypto.randomUUID()}${ext}`;
          const dest = path.join(dir, name);
          await Bun.write(dest, Bun.file(p));
          const ref = `chat/${conversationId}/${name}`;
          images.push({ ref, url: chatImageUrl(ref) });
        }
        return { images };
      },

      discardChatImage: async ({ ref }) => {
        const base = getImagesBaseDir();
        const resolved = path.resolve(base, ref);
        if (!resolved.startsWith(base + path.sep) || !resolved.includes(`${path.sep}chat${path.sep}`)) {
          return { ok: false };
        }
        rmSync(resolved, { force: true });
        return { ok: true };
      },

      stageChatFiles: async ({ paths }) => {
        const files: { name: string; content: string }[] = [];
        for (const p of paths) {
          if (!existsSync(p)) continue;
          if (!CHAT_TEXT_FILE_RE.test(p)) continue;
          try {
            const file = Bun.file(p);
            if (file.size > CHAT_FILE_MAX_BYTES) continue;
            const content = await file.text();
            files.push({ name: path.basename(p), content });
          } catch {
            // skip unreadable files
          }
        }
        return { files };
      },

      // 模型市场
      searchMarketModels: async ({ query, page, source, format }) => {
        const p = page ?? 1;
        return source === "huggingface"
          ? await HuggingFace.searchModels(query, p, 20, format)
          : await ModelScope.searchModels(query, p, 20, format);
      },

      listModelFiles: async ({ repo, source }) => {
        const files =
          source === "huggingface"
            ? await HuggingFace.listRepoFiles(repo)
            : await ModelScope.listRepoFiles(repo);
        return { files };
      },

      listDownloads: async () => {
        return { tasks: downloadManager.list() };
      },

      startModelDownload: async ({ repo, fileName, category, source }) => {
        return { task: downloadManager.start(repo, fileName, category, source) };
      },

      pauseModelDownload: async ({ id }) => {
        return { ok: downloadManager.pause(id) };
      },

      resumeModelDownload: async ({ id }) => {
        return { ok: downloadManager.resume(id) };
      },

      cancelModelDownload: async ({ id }) => {
        return { ok: downloadManager.cancel(id) };
      },

      removeDownload: async ({ id }) => {
        return { ok: downloadManager.remove(id) };
      },

      listInstalledModels: async () => {
        return { models: ModelStore.listInstalledModels() };
      },

      toggleFavoriteModel: async ({ path }) => {
        ModelStore.toggleFavorite(path);
        return { ok: true };
      },

      setActiveModel: async ({ path }) => {
        return ModelStore.setActiveModel(path);
      },

      scanModelDir: async ({ dir }) => {
        return ModelScan.previewModelDir(dir);
      },

      addModelDir: async ({ dir }) => {
        return ModelScan.addModelDir(dir);
      },

      removeModelDir: async ({ dir }) => {
        return ModelScan.removeModelDir(dir);
      },

      deleteLocalModel: async ({ path }) => {
        return ModelStore.deleteLocalModel(path);
      },

      importModelFile: async ({ sourcePath }) => {
        return ModelStore.importModelFile(sourcePath);
      },

      getModelDirs: async () => {
        const primary = ModelStore.getModelsBaseDirForRuntime();
        const hfCache = ModelScan.getHfHubCacheDir();
        const extra = ModelScan.getExtraModelDirs();
        return {
          dirs: [primary, ...extra],
          entries: [
            { path: primary, kind: "primary" as const, ...ModelScan.describeModelDir(primary) },
            ...extra.map((d) => ({
              path: d,
              kind: "extra" as const,
              ...ModelScan.describeModelDir(d),
            })),
            { path: hfCache, kind: "hf-cache" as const, ...ModelScan.describeHfCache() },
          ],
        };
      },

      getAboutInfo: async () => {
        const sessionStartedAt = (await getServerStats()).sessionStartedAt;
        const version = updateState.currentVersion;
        const channel = getSetting("UPDATE_CHANNEL") || "stable";
        return {
          version,
          channel,
          sessionStartedAt,
          basePath: ModelStore.getModelsBaseDirForRuntime(),
          dataDir: getUserDataDir(),
        };
      },

      startBenchmark: async (params) => {
        return startBenchmark(params);
      },
      getBenchmarkRun: async ({ runId }) => {
        return { run: getBenchmarkRun(runId) };
      },
      cancelBenchmark: async ({ runId }) => {
        return cancelBenchmark(runId);
      },
      listBenchmarkRecords: async () => {
        return { records: listBenchmarkRecords() };
      },
      deleteBenchmarkRecord: async ({ id }) => {
        return deleteBenchmarkRecord(id);
      },
      clearBenchmarkRecords: async () => {
        return clearBenchmarkRecords();
      },
      getEvalSuites: async () => {
        return { suites: listEvalSuites() };
      },

      // Voice
      listVoiceRecords: async (params) => {
        return { records: Voice.listVoiceRecords(params?.kind) };
      },

      deleteVoiceRecord: async ({ id }) => {
        Voice.deleteVoiceRecord(id);
        return { ok: true };
      },

      stageAudio: async ({ paths }) => {
        return { files: await Voice.stageAudio(paths) };
      },

      runTTS: async (params) => {
        return { record: await Voice.runTTS(params) };
      },

      runASR: async (params) => {
        return { record: await Voice.runASR(params) };
      },

      listVoiceClones: async () => {
        return { clones: Voice.listVoiceClones() };
      },

      createVoiceClone: async (params) => {
        return { clone: await Voice.createVoiceClone(params) };
      },

      deleteVoiceClone: async ({ id }) => {
        Voice.deleteVoiceClone(id);
        return { ok: true };
      },

      listTTSModels: async () => {
        return { models: TTSModels.listTTSModels() };
      },

      downloadTTSModel: async ({ id }) => {
        return await TTSModels.downloadTTSModel(id, (event) => {
          ttsModelDownloadSink?.(event);
        });
      },

      enableTTSModel: async ({ id, enabled }) => {
        TTSModels.enableTTSModel(id, enabled);
        return { ok: true };
      },

      listEdgeVoices: async () => {
        return { voices: TTSModels.listEdgeTTSVoices() };
      },

      listTTSHttpVoices: async () => {
        return { voices: TTSModels.listTTSVoicesForHttp() };
      },

      runTTSEdge: async (params) => {
        return { record: await Voice.runTTSEdge(params) };
      },

      getTTSProviderConfig: async () => {
        return { config: Voice.getTTSProviderConfig() };
      },

      saveTTSProviderConfig: async ({ base, apiKey, model }) => {
        Voice.saveTTSProviderConfig({ base, apiKey, model });
        return { ok: true };
      },

      listProviderModels: async (params) => {
        try {
          const cfg = Voice.getTTSProviderConfig();
          const models = await Voice.listProviderModels(
            params?.base ?? cfg.base,
            params?.apiKey ?? cfg.apiKey,
          );
          return { models };
        } catch (e) {
          return { models: [], error: e instanceof Error ? e.message : String(e) };
        }
      },

      // Local ASR
      listAsrModels: async () => {
        return { models: Asr.listAsrModels() };
      },

      getAsrStatus: async () => {
        return Asr.getAsrStatus();
      },

      downloadWhisperEngine: async () => {
        try {
          return await WhisperEngine.downloadWhisperEngine();
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      startAsr: async (params) => {
        try {
          return await Asr.startAsr(params?.model);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      stopAsr: async () => {
        try {
          await Asr.stopAsr();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      transcribeAudio: async (params) => {
        try {
          return await Asr.transcribeAudio(params);
        } catch (e) {
          return {
            text: "",
            engine: "error",
            segments: [],
            hasSpeakers: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },

      getASRProviderConfig: async () => {
        return { config: Asr.getASRProviderConfig() };
      },

      saveASRProviderConfig: async ({ base, apiKey, model }) => {
        Asr.saveASRProviderConfig({ base, apiKey, model });
        return { ok: true };
      },

      // Local ASR (audio.cpp)
      listAsrAudioCppModels: async () => {
        try {
          return { models: AsrAudioCpp.listAsrAudioCppModels() };
        } catch (e) {
          return { models: [], error: e instanceof Error ? e.message : String(e) };
        }
      },

      getAsrAudioCppStatus: async () => {
        try {
          return await AsrAudioCpp.getAsrAudioCppStatus();
        } catch {
          return {
            engineInstalled: false,
            binaryPath: null,
            active: false,
            activeModelId: null,
            activeModelPath: null,
          };
        }
      },

      startAsrAudioCpp: async ({ modelId }) => {
        // 两个本地引擎互斥：切到 audio.cpp 前先停掉 whisper-server。
        try {
          await Asr.stopAsr();
          return await AsrAudioCpp.startAsrAudioCpp(modelId);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      stopAsrAudioCpp: async () => {
        try {
          await AsrAudioCpp.stopAsrAudioCpp();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      deleteAsrAudioCppModel: async ({ modelId }) => {
        try {
          return AsrAudioCpp.deleteAsrAudioCppModel(modelId);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      // Local TTS (audio.cpp)
      listTtsLocalModels: async () => {
        return { models: TTSLocal.listTtsLocalModels() };
      },

      getTtsLocalStatus: async () => {
        return TTSLocal.getTtsLocalStatus();
      },

      downloadTtsLocalEngine: async () => {
        return TTSLocal.downloadTtsLocalEngine();
      },

      startTtsLocal: async (params) => {
        if (!params?.modelId) return { ok: false, error: "缺少模型参数" };
        return TTSLocal.startTtsLocal(params.modelId);
      },

      stopTtsLocal: async () => {
        await TTSLocal.stopTtsLocal();
        return { ok: true };
      },

      deleteTtsLocalModel: async ({ modelId }) => {
        return TTSLocal.deleteTtsLocalModel(modelId);
      },

      runTTSLocal: async (params) => {
        return { record: await TTSLocal.runTTSLocal(params) };
      },

      // OCR
      listOcrModels: async () => {
        try {
          return { models: Ocr.listOcrModels() };
        } catch (e) {
          return { models: [], error: e instanceof Error ? e.message : String(e) };
        }
      },

      getOcrStatus: async () => {
        try {
          return await Ocr.getOcrStatus();
        } catch {
          return {
            tesseractInstalled: false,
            tesseractPath: null,
            tesseractVersion: "",
            engine: "",
            activeModelId: null,
            activeModelPath: null,
            serverStatus: ServerManager.getStatus(),
          };
        }
      },

      downloadOcrModel: async ({ modelId }) => {
        try {
          return await Ocr.downloadOcrModel(modelId);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      startOcr: async ({ modelId }) => {
        try {
          return await Ocr.startOcr(modelId);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      stopOcr: async () => {
        try {
          await Ocr.stopOcr();
          // 切回其他引擎时顺手停掉常驻的 PaddleOCR worker，释放内存。
          await PpOcr.stopPpOcr();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      installTesseractEngine: async () => {
        try {
          return await Ocr.installTesseractEngine();
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      deleteOcrModel: async ({ modelId }) => {
        return Ocr.deleteOcrModel(modelId);
      },

      stageOcrImage: async ({ paths }) => {
        return { files: await Ocr.stageOcrImage(paths) };
      },

      runOcr: async (params) => {
        try {
          return { result: await Ocr.runOcr(params) };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },

      runOcrVlm: async (params) => {
        try {
          return { result: await Ocr.runOcrVlm(params) };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },

      getOcrProviderConfig: async () => {
        return { config: Ocr.getOcrProviderConfig() };
      },

      saveOcrProviderConfig: async ({ base, apiKey, model }) => {
        Ocr.saveOcrProviderConfig({ base, apiKey, model });
        return { ok: true };
      },

      listOcrProviderModels: async (params) => {
        try {
          const cfg = Ocr.getOcrProviderConfig();
          const models = await Ocr.listOcrProviderModels(
            params?.base ?? cfg.base,
            params?.apiKey ?? cfg.apiKey,
          );
          return { models };
        } catch (e) {
          return { models: [], error: e instanceof Error ? e.message : String(e) };
        }
      },

      getPpOcrStatus: async () => {
        try {
          return await PpOcr.getPpOcrStatus();
        } catch {
          return {
            pythonFound: false,
            pythonPath: null,
            engineInstalled: false,
            version: "",
            engineDir: null,
            workerRunning: false,
            phase: "idle",
            phaseMessage: "",
            modelSize: "medium",
            installInterrupted: false,
            models: (["medium"] as const).map((size) => ({
              size,
              models: {
                det: { ready: false, partialBytes: 0, totalBytes: 0 },
                rec: { ready: false, partialBytes: 0, totalBytes: 0 },
              },
            })),
          };
        }
      },

      downloadPpOcrEngine: async () => {
        try {
          return await PpOcr.downloadPpOcrEngine();
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      startPpOcr: async ({ modelSize }) => {
        try {
          return await PpOcr.startPpOcr(modelSize);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      stopPpOcr: async () => {
        try {
          await PpOcr.stopPpOcr();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      downloadPpOcrModels: async ({ modelSize }) => {
        try {
          return await PpOcr.downloadPpOcrModels(modelSize);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      cancelPpOcrModelDownload: async ({ modelSize }) => {
        try {
          return PpOcr.cancelPpOcrModelDownload(modelSize);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      deletePpOcrPartialModels: async ({ modelSize }) => {
        try {
          return PpOcr.deletePpOcrPartialModels(modelSize);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      cleanupPpOcrEngine: async () => {
        try {
          return await PpOcr.cleanupPpOcrEngine();
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      deletePpOcrModels: async ({ modelSize }) => {
        try {
          return await PpOcr.deletePpOcrModels(modelSize);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },

      runPpOcr: async (params) => {
        try {
          return { result: await PpOcr.runPpOcr(params) };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },

      // AI 生图
      stageEditImage: async ({ paths }) => {
        const files = await ImageGen.stageEditImage(paths);
        return { files };
      },

      generateImage: async (params) => {
        return ImageGen.generateImage(params);
      },

      listImageRecords: async (params) => {
        try {
          return { records: ImageGen.listImageRecords(params?.limit) };
        } catch {
          return { records: [] };
        }
      },

      deleteImageRecord: async ({ id }) => {
        return ImageGen.deleteImageRecord(id);
      },

      getImageGenConfig: async () => {
        return { config: ImageGen.getImageGenConfig() };
      },

      saveImageGenConfig: async (config) => {
        ImageGen.saveImageGenConfig(config);
        return { ok: true };
      },

      listImageGenModels: async (params) => {
        try {
          const cfg = ImageGen.getImageGenConfig();
          const backend = params?.backend ?? cfg.backend;
          const models =
            backend === "comfyui"
              ? await ImageGen.listComfyCheckpoints(params?.base ?? cfg.comfyBase)
              : backend === "mlx"
                ? MlxGen.MLX_MODELS.map((m) => m.id)
                : await ImageGen.listImageApiModels(
                    params?.base ?? cfg.apiBase,
                    params?.apiKey ?? cfg.apiKey,
                  );
          return { models };
        } catch (e) {
          return { models: [], error: e instanceof Error ? e.message : String(e) };
        }
      },

      // Agent 生图弹窗（media-setup）：用户点确认 / 取消后回传，弹窗里也可扫描候选模型
      resolveMediaSetup: async (params) => {
        return { ok: MediaSetup.resolveMediaSetup(params.id, params) };
      },

      scanMediaSetupCandidates: async (params) => {
        return MediaSetup.scanSetupCandidates(params ?? {});
      },

      // AI 视频生成
      submitVideoGeneration: async (params) => {
        return VideoGen.submitVideoGeneration(params);
      },

      pollVideoRecords: async ({ ids }) => {
        try {
          return { records: await VideoGen.pollVideoRecords(ids) };
        } catch {
          return { records: [] };
        }
      },

      listVideoRecords: async (params) => {
        try {
          return { records: VideoGen.listVideoRecords(params?.limit) };
        } catch {
          return { records: [] };
        }
      },

      deleteVideoRecord: async ({ id }) => {
        return VideoGen.deleteVideoRecord(id);
      },

      getVideoGenConfig: async () => {
        return { config: VideoGen.getVideoGenConfig() };
      },

      saveVideoGenConfig: async (config) => {
        VideoGen.saveVideoGenConfig(config);
        return { ok: true };
      },

      listVideoGenModels: async (params) => {
        try {
          const cfg = VideoGen.getVideoGenConfig();
          const backend = params?.backend ?? cfg.backend;
          if (backend === "comfyui") {
            const lists = await VideoGen.listComfyVideoModels(params?.base ?? cfg.comfyBase);
            return {
              models: lists.models,
              checkpoints: lists.checkpoints,
              clips: lists.clips,
              vaes: lists.vaes,
            };
          }
          const models =
            backend === "seedance"
              ? VideoGen.SEEDANCE_VIDEO_MODELS
              : VideoGen.MINIMAX_VIDEO_MODELS;
          return { models, checkpoints: [], clips: [], vaes: [] };
        } catch (e) {
          return {
            models: [],
            checkpoints: [],
            clips: [],
            vaes: [],
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },

      // MLX 本地生图引擎（mflux）
      getMlxGenStatus: async () => {
        try {
          return await MlxGen.getMlxGenStatus();
        } catch {
          return {
            supported: process.platform === "darwin" && process.arch === "arm64",
            pythonFound: false,
            pythonPath: null,
            engineInstalled: false,
            version: null,
            binDir: null,
          };
        }
      },

      downloadMlxGenEngine: async () => {
        return MlxGen.downloadMlxEngine();
      },

      listMlxGenModels: async () => {
        return { models: MlxGen.MLX_MODELS };
      },

      downloadMlxModel: async ({ modelId }) => {
        MlxGen.invalidateDownloadedMlxCache();
        return MlxGen.downloadMlxModel(modelId);
      },

      getDownloadedMlxModels: async () => {
        return { downloaded: await MlxGen.getDownloadedMlxModels() };
      },

      getMlxModelDownloadStates: async () => {
        return { states: await MlxGen.getMlxModelDownloadStates() };
      },

      startMlxModel: async ({ modelId, quantize }) => {
        return MlxGen.startMlxModel(modelId, quantize);
      },

      stopMlxModel: async () => {
        return MlxGen.stopMlxModel();
      },

      getMlxActiveModel: async () => {
        return { active: MlxGen.getMlxActiveModel() };
      },

      // -----------------------------------------------------------------
      // Skills 管理
      // -----------------------------------------------------------------
      skillsGetTools: async () => {
        return { tools: Skills.listToolInfos() };
      },
      skillsSetToolEnabled: async ({ tool, enabled }) => {
        Skills.setToolEnabled(tool, enabled);
        return { ok: true };
      },
      skillsSetAllToolsEnabled: async ({ enabled }) => {
        Skills.setAllToolsEnabled(enabled);
        return { ok: true };
      },
      skillsSetCustomToolPath: async ({ tool, path }) => {
        Skills.setCustomToolPath(tool, path);
        return { ok: true };
      },
      skillsAddCustomTool: async (def) => {
        return Skills.addCustomTool(def);
      },
      skillsRemoveCustomTool: async ({ key }) => {
        Skills.removeCustomTool(key);
        return { ok: true };
      },
      skillsGetCentralInfo: async () => {
        return Skills.getCentralInfoForRpc();
      },
      skillsSetCentralPath: async ({ path }) => {
        Skills.setCentralRepoPath(path);
        return { ok: true, info: Skills.getCentralInfoForRpc() };
      },
      skillsReindex: async () => {
        return Skills.reindexCentralRepo();
      },
      skillsList: async () => {
        return { skills: Skills.listSkills() };
      },
      skillsGetDoc: async ({ skillId }) => {
        return { markdown: Skills.getSkillDoc(skillId)?.markdown ?? null };
      },
      skillsDelete: async ({ ids }) => {
        return Skills.deleteSkills(ids);
      },
      skillsSetTags: async ({ skillId, tags }) => {
        Skills.setSkillTags(skillId, tags);
        Skills.writeSkillMeta(skillId);
        return { ok: true };
      },
      skillsGetAllTags: async () => {
        return { tags: Skills.getAllTags() };
      },
      skillsRenameTag: async ({ from, to }) => {
        Skills.renameTagEverywhere(from, to);
        return { ok: true };
      },
      skillsDeleteTag: async ({ tag }) => {
        Skills.deleteTagEverywhere(tag);
        return { ok: true };
      },
      skillsMarketLeaderboard: async ({ board }) => {
        return { skills: await Skills.fetchLeaderboard(board) };
      },
      skillsMarketSearch: async ({ query, limit }) => {
        return { skills: await Skills.searchSkillssh(query, limit ?? 60) };
      },
      skillsInstallFromMarket: async ({ source, skillId }) => {
        return Skills.installFromSkillssh(source, skillId);
      },
      skillsCancelInstall: async ({ ref }) => {
        return { ok: Skills.cancelInstall(ref) };
      },
      skillsGitPreview: async ({ url }) => {
        return Skills.gitPreview(url);
      },
      skillsGitConfirm: async ({ url, tempDir, items }) => {
        return Skills.gitConfirm(url, tempDir, items);
      },
      skillsGitCancelPreview: async ({ tempDir }) => {
        Skills.gitCancelPreview(tempDir);
        return { ok: true };
      },
      skillsInstallLocal: async ({ path, name }) => {
        return Skills.installLocal(path, name);
      },
      skillsBatchImportFolder: async ({ path }) => {
        return Skills.batchImportFolder(path);
      },
      skillsCheckUpdates: async ({ ids }) => {
        const statuses = ids && ids.length > 0 ? await Promise.all(ids.map((id) => Skills.checkSkillUpdate(id))) : await Skills.checkAllSkillUpdates();
        return { statuses };
      },
      skillsUpdateSkill: async ({ skillId }) => {
        return Skills.updateSkill(skillId);
      },
      skillsScanDiscovered: async () => {
        return { groups: Skills.scanDiscoveredSkills() };
      },
      skillsImportDiscovered: async ({ name, paths, removeOriginal }) => {
        return Skills.importDiscoveredGroup(name, paths, removeOriginal);
      },
      skillsImportAllDiscovered: async ({ groups, removeOriginal }) => {
        return Skills.importAllDiscovered(groups, removeOriginal);
      },
      skillsSyncToTool: async ({ skillId, tool, overwrite }) => {
        return Skills.syncSkillToTool(skillId, tool, { overwrite });
      },
      skillsUnsyncFromTool: async ({ skillId, tool }) => {
        return Skills.unsyncSkillFromTool(skillId, tool);
      },
      skillsGetSyncMode: async () => {
        return { mode: Skills.getSyncMode() };
      },
      skillsSetSyncMode: async ({ mode }) => {
        Skills.setSyncMode(mode);
        return { ok: true };
      },
      skillsListPresets: async () => {
        return { presets: Skills.getPresetRowsWithCounts() };
      },
      skillsCreatePreset: async ({ name, description, icon }) => {
        return { id: Skills.createPreset(name, description, icon) };
      },
      skillsUpdatePreset: async ({ id, name, description, icon }) => {
        Skills.updatePresetRow(id, name, description, icon);
        return { ok: true };
      },
      skillsDeletePreset: async ({ id }) => {
        return Skills.deletePresetRow(id);
      },
      skillsAddSkillsToPreset: async ({ presetId, skillIds }) => {
        for (const sid of skillIds) Skills.addSkillToPreset(presetId, sid);
        return { ok: true };
      },
      skillsRemoveSkillFromPreset: async ({ presetId, skillId }) => {
        Skills.removeSkillFromPreset(presetId, skillId);
        return { ok: true };
      },
      skillsApplyPreset: async ({ presetId }) => {
        return Skills.applyPresetToDefault(presetId);
      },
      skillsApplyPresetToAgents: async ({ presetId, mode }) => {
        return Skills.applyPresetToCodingAgents(presetId, mode);
      },
      skillsTogglePresetSkillTool: async ({ presetId, skillId, tool, enabled }) => {
        return Skills.togglePresetSkillTool(presetId, skillId, tool, enabled);
      },
      skillsSetActivePreset: async ({ presetId }) => {
        Skills.setActivePreset(presetId);
        return { ok: true };
      },
      skillsBackupStatus: async () => {
        return { status: Skills.backupStatus() };
      },
      skillsBackupInit: async () => {
        return Skills.backupInit();
      },
      skillsBackupSetRemote: async ({ url, pat }) => {
        return Skills.setBackupRemote(url, pat);
      },
      skillsBackupCommit: async ({ message }) => {
        return Skills.backupCommit(message);
      },
      skillsBackupPush: async () => {
        return Skills.backupPush();
      },
      skillsBackupPull: async () => {
        return Skills.backupPull();
      },
      skillsBackupSetAuto: async ({ enabled }) => {
        Skills.setAutoBackup(enabled);
        return { ok: true };
      },
      skillsSnapshots: async () => {
        return { snapshots: Skills.listSnapshots() };
      },
      skillsCreateSnapshot: async ({ name }) => {
        return Skills.createSnapshot(name);
      },
      skillsRestoreSnapshot: async ({ tag }) => {
        return Skills.restoreSnapshot(tag);
      },
      skillsResolveConflict: async ({ keep }) => {
        return Skills.resolveConflict(keep);
      },
      skillsSizeReport: async () => {
        return Skills.sizeReport();
      },
      skillsListProjects: async () => {
        return { projects: Skills.listProjectViews() };
      },
      skillsAddProject: async ({ path }) => {
        return Skills.addProject(path);
      },
      skillsRemoveProject: async ({ id }) => {
        Skills.removeProject(id);
        return { ok: true };
      },
      skillsScanProjects: async ({ root }) => {
        return { projects: Skills.scanProjectWorkspaces(root) };
      },
      skillsGetProjectSkills: async ({ projectId }) => {
        return Skills.getProjectSkillsForRpc(projectId);
      },
      skillsProjectImportToCenter: async ({ projectId, relDir }) => {
        return Skills.projectImportToCenterForRpc(projectId, relDir);
      },
      skillsProjectExportFromCenter: async ({ projectId, skillId, agentRel }) => {
        return Skills.projectExportForRpc(projectId, skillId, agentRel);
      },
      skillsProjectUpdateToCenter: async ({ projectId, relDir }) => {
        return Skills.projectUpdateToCenterForRpc(projectId, relDir);
      },
      skillsProjectToggleSkill: async ({ projectId, relDir, enabled }) => {
        return Skills.projectToggleForRpc(projectId, relDir, enabled);
      },
      skillsProjectDeleteSkill: async ({ projectId, relDir }) => {
        return Skills.projectDeleteForRpc(projectId, relDir);
      },
      skillsGetProjectSkillDoc: async ({ projectId, relDir }) => {
        return Skills.projectSkillDocForRpc(projectId, relDir);
      },
      skillsOpenFolder: async (params) => {
        let target = params.path;
        if (params.path === "central") {
          target = path.join(Skills.getCentralRepoDir(), params.skillId ?? "");
        }
        try {
          const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
          Bun.spawn([opener, target]);
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },

      // ---- 知识库（本地 RAG） ----
      kbList: async () => {
        return { kbs: Knowledge.listKnowledgeBases() };
      },
      kbCreate: async (params) => {
        return {
          kb: Knowledge.createKb({
            name: params.name,
            description: params.description,
            embeddingModel: params.embeddingModel,
            rerankModel: params.rerankModel,
          }),
        };
      },
      kbUpdate: async ({ id, patch }) => {
        return Knowledge.updateKb(id, patch);
      },
      kbDelete: async ({ id }) => {
        Knowledge.deleteKb(id);
        return { ok: true };
      },
      kbDocList: async ({ kbId }) => {
        return { docs: Knowledge.listDocs(kbId) };
      },
      kbAddFiles: async ({ kbId, paths }) => {
        return { docs: Knowledge.addFileDocs(kbId, paths ?? []) };
      },
      kbAddFolder: async ({ kbId, path: dirPath }) => {
        return Knowledge.addFolderDocs(kbId, dirPath);
      },
      kbAddNote: async ({ kbId, title, content }) => {
        return { doc: Knowledge.addNoteDoc(kbId, title, content) };
      },
      kbAddWeb: async ({ kbId, url }) => {
        return { doc: Knowledge.addWebDoc(kbId, url) };
      },
      kbDocDelete: async ({ id }) => {
        Knowledge.deleteDoc(id);
        return { ok: true };
      },
      kbDocReingest: async ({ id }) => {
        Knowledge.reingestDoc(id);
        return { ok: true };
      },
      kbChunks: async ({ docId }) => {
        return { chunks: Knowledge.listChunks(docId) };
      },
      kbEmbedMissing: async ({ kbId }) => {
        return Knowledge.embedMissing(kbId);
      },
      kbRecall: async ({ kbIds, query, topK }) => {
        return Knowledge.recall(kbIds ?? [], query ?? "", topK);
      },
      kbTestEmbedding: async ({ base, apiKey, model }) => {
        return Knowledge.testEmbedding({ base, apiKey, model });
      },
      kbEmbeddingModels: async (params) => {
        return { models: await Knowledge.suggestEmbeddingModels(params ?? undefined) };
      },
      kbTestRerank: async ({ base, apiKey, model }) => {
        return Knowledge.testRerank({ base, apiKey, model });
      },
      kbRerankModels: async (params) => {
        return { models: await Knowledge.suggestRerankModels(params ?? undefined) };
      },
      kbEvents: async (params) => {
        const kbId = params?.kbId;
        return {
          events: Knowledge.kbEvents({ kbId, limit: params?.limit ?? 100 }),
          counts: Knowledge.kbAuditSummary(kbId),
        };
      },
      kbQueueStats: async () => {
        return Knowledge.kbQueueStats();
      },
      kbIndexStats: async () => {
        return { indexes: Knowledge.kbIndexStatsAll() };
      },
      kbExport: async ({ kbId, includeEmbeddings }) => {
        return Knowledge.exportKbToFile(kbId, { includeEmbeddings });
      },
      kbImport: async ({ json, name }) => {
        let payload: unknown;
        try {
          payload = JSON.parse(json);
        } catch {
          throw new Error("导入内容不是合法 JSON");
        }
        return Knowledge.importKb(payload, { name });
      },
      kbDocRetry: async ({ id }) => {
        Knowledge.retryDoc(id);
        return { ok: true };
      },
      kbOpenExportDir: async () => {
        const dir = Knowledge.kbExportDir();
        try {
          const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
          Bun.spawn([opener, dir]);
          return { ok: true, path: dir };
        } catch {
          return { ok: false, path: dir };
        }
      },

      // ---------------------------------------------------------------------
      // 全局备份 / 恢复
      // ---------------------------------------------------------------------

      backupList: async ({ dir } = {}) => Backup.listBackups({ dir }),

      backupEstimate: async () => Backup.estimateBackup(),

      backupOverview: async () => ({
        dir: Backup.defaultBackupDir(),
        appVersion: updateState.currentVersion,
        active: Backup.activeBackupTask(),
      }),

      backupChooseDir: async () => {
        const dirs = await Utils.openFileDialog({
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
          startingFolder: Backup.defaultBackupDir(),
        });
        const dir = (dirs ?? [])[0]?.trim();
        if (!dir) return { dir: null };
        // 选完立刻试写一次：只读盘 / 沙箱目录在创建到一半时才发现就太晚了
        const check = await Backup.checkWritableDir(dir);
        return { dir, error: check.error, freeBytes: check.freeBytes };
      },

      backupChooseFile: async () => {
        // 不过滤扩展名：.omnibackup 不是系统已知类型，按扩展名过滤会让文件在选择器里
        // 变灰；合法性交给 inspectBackup 校验（不是备份会明确报错）。
        const paths = await Utils.openFileDialog({
          allowedFileTypes: "*",
          canChooseFiles: true,
          canChooseDirectory: false,
          allowsMultipleSelection: false,
          startingFolder: Backup.defaultBackupDir(),
        });
        return { path: (paths ?? [])[0]?.trim() ?? null };
      },

      backupInspect: async ({ path }) => Backup.inspectBackup({ path }),

      backupCreate: async (params: BackupCreateRequest) => {
        // 结果通过事件回传：GB 级媒体可能要跑几分钟，不能挂在一次请求上。
        return Backup.startCreateBackup({ ...params, ctx: backupCtx() });
      },

      backupRestore: async (params: BackupRestoreRequest) => Backup.startRestoreBackup({ ...params, ctx: backupCtx() }),

      backupCancel: async ({ taskId }) => ({ ok: Backup.cancelBackupTask(taskId) }),

      backupDelete: async ({ path, dir }) => Backup.deleteBackup({ path, dir }),

      backupReveal: async ({ path }) => {
        try {
          Utils.showItemInFolder(path);
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },

      backupRemoteGet: async () => {
        const config = Backup.readRemoteConfig({ connection: sqliteClient });
        return { config, configured: Backup.isRemoteConfigured(config) };
      },

      backupRemoteSave: async ({ config }) => {
        try {
          Backup.writeRemoteConfig(config, { connection: sqliteClient });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },

      backupRemoteTest: async () => Backup.testRemote({ connection: sqliteClient }),

      backupRemoteList: async () => {
        try {
          return { entries: await Backup.listRemoteBackups({ connection: sqliteClient }) };
        } catch (err) {
          return { entries: [], error: err instanceof Error ? err.message : String(err) };
        }
      },

      backupRemoteDownload: async (params: BackupDownloadRequest) =>
        Backup.startDownloadRemoteBackup({ ...params, ctx: backupCtx() }),

      backupRemoteDelete: async ({ fileName }) => {
        try {
          await Backup.deleteRemoteBackup(fileName);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    messages: {},
  },
});

/**
 * 备份上下文：复用应用自己的 SQLite 连接（单写者，避免恢复时与运行中的应用抢锁），
 * 版本号取当前应用版本，写进清单便于排错。
 */
function backupCtx(): Partial<Backup.BackupContext> {
  return { appVersion: updateState.currentVersion, connection: sqliteClient };
}

/** 备份进度 / 终态推送到 webview。 */
export function initBackupBroadcast(win: BrowserWindowWithRPC) {
  Backup.subscribeBackupEvents((event) => {
    try {
      if (event.type === "progress") win.webview.rpc?.send.backupProgress(event.progress);
      else win.webview.rpc?.send.backupFinished(event);
    } catch {}
  });
}

/**
 * webview 重新加载（刷新 / HMR）后补推一次当前状态。
 *
 * 状态推送只在"发生变化"时发消息，而 webview 侧 store 会随刷新重置为默认值，
 * 于是重启后的界面会显示"未启动"，点了启动才报"已在运行"。
 */
export function broadcastCurrentStatus(win: BrowserWindowWithRPC) {
  try {
    win.webview.rpc?.send.serverStatusChanged({ status: ServerManager.getStatus() });
  } catch {}
  try {
    win.webview.rpc?.send.gatewayStatusChanged({ status: Gateway.getGatewayStatus().status });
  } catch {}
}

export function initServerBroadcast(win: BrowserWindowWithRPC) {
  ServerManager.onLog((text) => {
    try {
      win.webview.rpc?.send.serverLog({ text });
    } catch {}
  });
  ServerManager.onStatusChange((status) => {
    try {
      win.webview.rpc?.send.serverStatusChanged({ status });
    } catch {}
  });
  Chat.onChatChunk((payload) => {
    try {
      win.webview.rpc?.send.chatChunk(payload);
    } catch {}
  });
  Chat.onChatDone((payload) => {
    try {
      win.webview.rpc?.send.chatDone(payload);
    } catch {}
  });
  Chat.onChatStats((payload) => {
    try {
      win.webview.rpc?.send.chatStats(payload);
    } catch {}
  });
  Agent.onAgentEvent((payload) => {
    try {
      win.webview.rpc?.send.agentEvent(payload);
    } catch {}
  });
  // Agent 的文本流复用 chat 的 chunk / done / stats 通道，前端无需区分来源。
  Agent.onAgentChunk((payload) => {
    try {
      win.webview.rpc?.send.chatChunk(payload);
    } catch {}
  });
  Agent.onAgentDone((payload) => {
    try {
      win.webview.rpc?.send.chatDone(payload);
    } catch {}
  });
  Agent.onAgentStats((payload) => {
    try {
      win.webview.rpc?.send.chatStats(payload);
    } catch {}
  });
  // 知识库：摄取进度 / 删除 / 向量补齐 → 前端刷新列表。
  Knowledge.onKnowledgeChanged((payload) => {
    try {
      win.webview.rpc?.send.knowledgeChanged(payload);
    } catch {}
  });
  // 实时语音通话：把后端会话事件按类型路由到对应的一元消息通道。
  VoiceCall.onVoiceCallEvent((msg: VoiceCallOutgoing) => {
    try {
      switch (msg.type) {
        case "partial":
          win.webview.rpc?.send.voicecallPartial({ conversationId: msg.conversationId, text: msg.text });
          break;
        case "utterance":
          win.webview.rpc?.send.voicecallUtterance({
            conversationId: msg.conversationId,
            messageId: msg.messageId,
            text: msg.text,
          });
          break;
        case "state":
          win.webview.rpc?.send.voicecallState({ conversationId: msg.conversationId, phase: msg.phase });
          break;
        case "audio":
          win.webview.rpc?.send.voicecallAudio({
            conversationId: msg.conversationId,
            wavBase64: msg.wavBase64,
            format: msg.format,
          });
          break;
        case "audioStop":
          win.webview.rpc?.send.voicecallAudioStop({ conversationId: msg.conversationId });
          break;
        case "assistantPartial":
          // 云端助手流式正文：走 chatChunk，前端聊天 store 自动建气泡追加。
          win.webview.rpc?.send.chatChunk({
            conversationId: msg.conversationId,
            messageId: msg.messageId,
            delta: msg.text,
            kind: "content",
          });
          break;
        case "assistantDone":
          win.webview.rpc?.send.chatDone({
            conversationId: msg.conversationId,
            messageId: msg.messageId,
            content: msg.text,
          });
          break;
        case "error":
          win.webview.rpc?.send.voicecallError({
            conversationId: msg.conversationId,
            message: msg.message,
          });
          break;
      }
    } catch {}
  });
}

export function initModelDownloadBroadcast(win: BrowserWindowWithRPC) {
  downloadManager.onProgress((payload) => {
    try {
      win.webview.rpc?.send.modelDownloadProgress(payload);
    } catch {}
  });
  downloadManager.onTasksChanged(() => {
    try {
      win.webview.rpc?.send.downloadsChanged({ tasks: downloadManager.list() });
    } catch {}
  });
}

export function initGatewayBroadcast(win: BrowserWindowWithRPC) {
  Gateway.onGatewayStatusChange((status) => {
    try {
      win.webview.rpc?.send.gatewayStatusChanged({ status });
    } catch {}
  });
}

/** MLX 引擎安装日志（mflux venv 安装过程），实时推送到前端展示。 */
export function initMlxInstallBroadcast(win: BrowserWindowWithRPC) {
  MlxGen.onInstallLog((text) => {
    try {
      win.webview.rpc?.send.mlxInstallLog({ text });
    } catch {}
  });
}

/** MLX 模型权重下载进度，实时推送到前端。 */
export function initMlxModelDownloadBroadcast(win: BrowserWindowWithRPC) {
  MlxGen.onMlxModelProgress((p) => {
    try {
      win.webview.rpc?.send.mlxModelDownloadProgress(p);
    } catch {}
  });
  // 生图阶段事件（启动/加载/生成 n/N）实时推送到前端。
  MlxGen.onMlxGenPhase((p) => {
    try {
      win.webview.rpc?.send.mlxGenPhase(p);
    } catch {}
  });
}

/** Agent 生图前的「需要用户介入」弹窗：推给界面，用户确认后走 RPC resolveMediaSetup 回传。 */
export function initMediaSetupBroadcast(win: BrowserWindowWithRPC) {
  MediaSetup.onMediaSetup((payload) => {
    try {
      win.webview.rpc?.send.mediaSetup(payload);
    } catch {}
  });
}

/** PaddleOCR 引擎安装日志 / 阶段 / 模型下载进度，实时推送到前端。 */
export function initPpOcrBroadcast(win: BrowserWindowWithRPC) {
  PpOcr.onPpOcrInstallLog((text) => {
    try {
      win.webview.rpc?.send.ppOcrInstallLog({ text });
    } catch {}
  });
  PpOcr.onPpOcrPhase((phase, message) => {
    try {
      win.webview.rpc?.send.ppOcrPhase({ phase, message });
    } catch {}
  });
  PpOcr.onPpOcrModelProgress((p) => {
    try {
      win.webview.rpc?.send.ppOcrModelProgress(p);
    } catch {}
  });
}

/** Tesseract 引擎一键安装日志，实时推送到前端。 */
export function initTessInstallBroadcast(win: BrowserWindowWithRPC) {
  Ocr.onTesseractInstallLog((text) => {
    try {
      win.webview.rpc?.send.tesseractInstallLog({ text });
    } catch {}
  });
}

/** Skills 安装进度 + 中央库变更，实时推送到前端。 */
export function initSkillsBroadcast(win: BrowserWindowWithRPC) {
  Skills.onInstallProgressForRpc((p) => {
    try {
      win.webview.rpc?.send.skillsInstallProgress(p);
    } catch {}
  });
  Skills.onCentralChanged(() => {
    try {
      win.webview.rpc?.send.skillsChanged({});
    } catch {}
  });
}

let ttsModelDownloadSink:
  | ((event: {
      repo: string;
      fileName: string;
      progress: { received: number; total: number | null; percent: number | null };
    }) => void)
  | null = null;

/** TTS 模型目录（tts-models.ts）的下载进度，复用 modelDownloadProgress 通道。 */
export function initTTSModelDownloadBroadcast(win: BrowserWindowWithRPC) {
  ttsModelDownloadSink = (payload) => {
    try {
      win.webview.rpc?.send.modelDownloadProgress(payload);
    } catch {}
  };
}
