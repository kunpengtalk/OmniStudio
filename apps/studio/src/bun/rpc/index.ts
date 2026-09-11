import { BrowserView, BrowserWindow, RPCSchema, Updater, Utils } from "electrobun/bun";
import { asc, eq, desc, like, sql, inArray } from "drizzle-orm";
import path from "path";
import { existsSync, rmSync, copyFileSync, mkdirSync, appendFileSync } from "fs";

import { db } from "../db";
import { documents, pages } from "../db/schema";
import { getAllSettings, getSetting, isConfigured, updateSettings } from "../db/settings";
import { getImagesBaseDir, getUploadsBaseDir } from "../image-server";
import { chatImageDir, chatImageUrl } from "../image-server";
import { processDocumentPages } from "../queue";
import { updateState, type UpdateInfo } from "../updates";
import * as ServerManager from "../server-manager";
import type { ServerStatus } from "../server-manager";
import * as Gateway from "../gateway";
import type { GatewayStatus } from "../gateway";
import { getSetupEnvironment, type SetupEnvironment } from "../setup-env";
import * as Chat from "../chat";
import type { Conversation, ChatMessage, ChatStats } from "../chat";
import * as Agent from "../agent";
import type { AgentEventRow, AgentMode } from "../agent";
import * as VoiceCall from "../voice-call";
import type { VoiceCallOutgoing, VoiceCallPhase, VoiceCallPreflight } from "../voice-call";
import * as RealtimeVoice from "../realtime-voice";
import type { RealtimeProviderConfig } from "../realtime-voice";
import * as Translate from "../translate";
import { listChatModels, selectChatModel, type ChatModelOption } from "../chat-model";
import * as ModelScope from "../modelscope";
import type { ModelScopeModel, ModelScopeFile } from "../modelscope";
import * as ModelStore from "../model-store";
import type { InstalledModel } from "../model-store";
import { getServerStats, type ServerStats } from "../stats";
import { runBenchmark, type BenchmarkParams, type BenchmarkResult } from "../benchmark";
import { downloadManager, type DownloadTask } from "../download-manager";
import * as Voice from "../voice";
import type { VoiceRecordRow, VoiceRecordKind, VoiceClone } from "../voice";
import * as Asr from "../asr";
import type { AsrModelItem, AsrSegment, AsrStatus } from "../asr";
import * as AsrAudioCpp from "../asr-audiocpp";
import type { AsrAudioCppModelInfo, AsrAudioCppStatus } from "../asr-audiocpp";
import * as WhisperEngine from "../whisper-engine";
import type { WhisperEngineInfo } from "../whisper-engine";
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
        response: { configured: boolean; settings: Record<string, string> };
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
        params: { allowedFileTypes?: string } | undefined;
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
      // ModelScope search / install
      searchModelScope: {
        params: { query: string; page?: number };
        response: { models: ModelScopeModel[]; total: number };
      };
      listModelScopeFiles: {
        params: { repo: string };
        response: { files: ModelScopeFile[] };
      };
      listDownloads: {
        params: undefined;
        response: { tasks: DownloadTask[] };
      };
      startModelDownload: {
        params: { repo: string; fileName: string; category?: ModelCategory; source?: "modelscope" | "huggingface" };
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
        response: { ok: boolean };
      };
      importModelFile: {
        params: { sourcePath: string };
        response: { ok: boolean; path?: string; error?: string };
      };
      getModelDirs: {
        params: undefined;
        response: { dirs: string[] };
      };
      getAboutInfo: {
        params: undefined;
        response: { version: string; channel: string; sessionStartedAt: number; basePath: string };
      };
      runBenchmark: {
        params: BenchmarkParams;
        response: BenchmarkResult;
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
      };
      chatStats: ChatStats;
      agentEvent: AgentEventRow;
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
      /** CLI（`omi`）请求跳转到某个页面：models / settings / server / stats / chat / index。 */
      navigate: { path: string };
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
        const allowedFileTypes = params?.allowedFileTypes;
        const paths = await Utils.openFileDialog({
          allowedFileTypes: allowedFileTypes ?? "pdf,png,jpg,jpeg,webp,tiff,bmp,heic,heif",
          canChooseFiles: true,
          canChooseDirectory: false,
          allowsMultipleSelection: true,
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
          const filePath = path.join(getImagesBaseDir(), decodeURIComponent(parsed.pathname));
          if (!existsSync(filePath)) return { ok: false };
          const dest = path.join(Utils.paths.downloads, filename);
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

      sendChatMessage: async ({ conversationId, content, images, webSearch, files }) => {
        return Chat.sendMessage(conversationId, content, images ?? [], { webSearch, files });
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
        return { tools: Agent.listAgentTools(mode) };
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

      // ModelScope
      searchModelScope: async ({ query, page }) => {
        return ModelScope.searchModels(query, page ?? 1);
      },

      listModelScopeFiles: async ({ repo }) => {
        return { files: await ModelScope.listRepoFiles(repo) };
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

      deleteLocalModel: async ({ path }) => {
        return ModelStore.deleteLocalModel(path);
      },

      importModelFile: async ({ sourcePath }) => {
        return ModelStore.importModelFile(sourcePath);
      },

      getModelDirs: async () => {
        return { dirs: ModelStore.getModelsDirs() };
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
        };
      },

      runBenchmark: async (params) => {
        return runBenchmark(params);
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
        } catch (e) {
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
        } catch (e) {
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
        } catch (e) {
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
    },
    messages: {},
  },
});

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
