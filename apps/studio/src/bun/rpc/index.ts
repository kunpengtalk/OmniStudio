import { BrowserView, BrowserWindow, RPCSchema, Updater, Utils } from "electrobun/bun";
import { asc, eq, desc, like, sql, inArray } from "drizzle-orm";
import path from "path";
import { existsSync, rmSync, copyFileSync, mkdirSync } from "fs";

import { db, sqliteClient } from "../db";
import { documents, pages } from "../db/schema";
import { getAllSettings, getSetting, isConfigured, updateSettings } from "../db/settings";
import {
  getImagesBaseDir,
  getUploadsBaseDir,
  registerWorkspaceRoot,
  resolveImageRef,
  setArtifactResolver,
} from "../image-server";
import {
  chatImageDir,
  chatImageUrl,
  getMediaServerStatus,
  type MediaServerStatus,
} from "../image-server";
import { artifactPreviewUrl } from "../../shared/server-info";
import { safeBaseName, safeJoin } from "../path-safety";
import { exportHtmlReport } from "../report-export";
import { processDocumentPages } from "../queue";
import { updateState, checkForUpdate, type UpdateInfo } from "../updates";
import * as ReleaseCheck from "../release-check";
import type { ReleaseCheckResult } from "../../shared/release";
import { getUserDataDir } from "../paths";
import {
  appLogInfo,
  appLogPath,
  clearAppLog,
  logEvent,
  readAppLogs,
  type AppLogEntry,
  type AppLogLevel,
  type AppLogQuery,
  type AppLogSource,
} from "../app-log";
import { LOG_THROTTLE_MS, PROGRESS_THROTTLE_MS, throttleBatch, throttleLatest } from "../throttle";
import * as ServerManager from "../server-manager";
import type { ServerStatus } from "../server-manager";
import * as Served from "../model-servers";
import type { ServedModelInfo, ServedModelsSnapshot } from "../../shared/served-models";
import type { InferenceEngine } from "../../shared/engines";
import * as Gateway from "../gateway";
import type { GatewayStatus } from "../gateway";
import * as GatewayKeys from "../gateway-keys";
import type { GatewayKeyView } from "../gateway-keys";
import * as Tunnel from "../tunnel";
import type { TunnelInfo } from "../tunnel";
import * as Cloudflared from "../cloudflared";
import { getSetupEnvironment, type SetupEnvironment } from "../setup-env";
import * as EngineInstall from "../engine-install";
import * as Chat from "../chat";
import type { Conversation, ChatMessage, ChatStats } from "../chat";
import * as Agent from "../agent";
import type {
  AgentEventRow,
  AgentMode,
  AgentRunState,
  AgentSessionSearchHit,
  AgentSessionView,
} from "../agent";
import type { PendingPermission, PendingQuestion } from "../agent-interactions";
import {
  respondPermission as respondAgentPermissionRequest,
  respondQuestion as respondAgentQuestionRequest,
} from "../agent-interactions";
import type { TodoItem } from "../agent-todos";
import { listTodos as listAgentTodoItems } from "../agent-todos";
import type { AgentGoal } from "../agent-goals";
import {
  getGoal as getAgentGoal,
  maxGoalContinuations,
  setGoalStatus as setAgentGoalStatus,
} from "../agent-goals";

/**
 * 推给界面的目标视图：比库里的多一个"续跑上限"。
 * 上限是可配置的，前端不该自己算一遍（算错了界面就会显示 3/6 实际只允许 2 次）。
 */
type AgentGoalView = AgentGoal & { maxContinuations: number };

function goalView(conversationId: number): AgentGoalView | null {
  const goal = getAgentGoal(conversationId);
  return goal ? { ...goal, maxContinuations: maxGoalContinuations() } : null;
}
import type { AgentPlan } from "../agent-plans";
import {
  approvePlan as approveAgentPlan,
  clearPlan as clearAgentPlan,
  getPlan as getAgentPlan,
} from "../agent-plans";
import type { ArtifactItem, WorkspaceTreeNode } from "../agent-artifacts";
import {
  deleteArtifact as deleteAgentArtifactRow,
  getArtifact as getAgentArtifact,
  listArtifacts as listAgentArtifactItems,
  readArtifact as readAgentArtifactFile,
  readWorkspaceFile as readWorkspaceFileContent,
  workspaceTree,
} from "../agent-artifacts";
import {
  getWorkspaceChanges,
  type WorkspaceChanges,
  getWorkspaceDiff,
  type WorkspaceDiff,
} from "../workspace-changes";
import {
  closeTerminal,
  getTerminal as getTerminalSession,
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  startTerminal,
  writeTerminal,
  type TerminalSessionInfo,
} from "../terminal-sessions";
import * as Permissions from "../permissions";
import type { PermissionRule } from "../permissions";
import type { ApprovalMode as AgentApprovalMode, EffectivePermissionRow } from "../permissions";
import * as Automations from "../automations";
import * as Notifications from "../notifications";
import type { AppNotification } from "../notifications";
import * as ViewState from "../view-state";
import type { AutomationItem, AutomationRunItem } from "../automations";
import * as Mcp from "../mcp";
import type { McpServerConfig } from "../mcp";
import * as Memory from "../memory";
import * as MemorySync from "../memory-sync";
import type {
  MemoryCategory,
  MemoryEntry,
  MemoryEventEntry,
  MemoryStats,
  MemoryStatus,
} from "../../shared/memory";
import type { MemorySyncResult, MemorySyncStatus } from "../memory-sync";
import * as VoiceCall from "../voice-call";
import type { VoiceCallOutgoing, VoiceCallPhase, VoiceCallPreflight } from "../voice-call";
import * as RealtimeVoice from "../realtime-voice";
import type { RealtimeProviderConfig } from "../realtime-voice";
import * as Translate from "../translate";
import {
  listChatModels,
  selectChatModel,
  chatModelSupportsImages,
  getChatModelLabel,
  type ChatModelOption,
} from "../chat-model";
import {
  loadProjectInstructions,
  projectDocEnabled,
  projectDocMaxBytes,
  userInstructionsPath,
} from "../agent-instructions";
import * as Snapshots from "../agent-snapshots";
import * as Context from "../agent-context";
import * as Sandbox from "../agent-sandbox";
import * as NotifyHook from "../agent-notify";
import * as Hooks from "../agent-hooks";
import * as CloudProviders from "../cloud-providers";
import * as Proxy from "../proxy";
import type { ProxyStatus, ProxyTestResult } from "../proxy";
import type {
  CloudModelEntry,
  CloudProviderInfo,
  CloudMusicApi,
  CloudVideoApi,
} from "../../shared/cloud-providers";
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
import { updateModelCategory } from "../model-category";
import { getServerStats, type ServerStats } from "../stats";
import { getUsageStats } from "../usage";
import type { UsageStats } from "../../shared/usage";
import {
  startBenchmark,
  getBenchmarkRun,
  cancelBenchmark,
  listBenchmarkRecordSummaries,
  getBenchmarkRecord,
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
import type {
  OcrLangModelInfo,
  OcrStatus,
  OcrResult,
  OcrVlmResult,
  OcrProviderConfig,
} from "../ocr";
import * as PpOcr from "../ppocr";
import type { PpOcrModelSize } from "../../shared/ocr";
import * as BgRemove from "../bg-remove";
import * as ImageGen from "../image-gen";
import type { ImageGenConfig, ImageRecordRow, ImageGenBackend } from "../image-gen";
import * as MediaSetup from "../media-setup";
import type { MediaSetupCandidate, MediaSetupPayload } from "../media-setup";
import * as MiniApps from "../miniapps";
import type { CompleteTextParams } from "../miniapps";
import type { MiniAppCapabilitySnapshot } from "../../shared/miniapps";
import * as Notes from "../notes";
import type { Note, NoteImage, NoteInput } from "../notes";
import * as VideoGen from "../video-gen";
import type { VideoGenConfig, VideoRecordRow, VideoGenBackend } from "../video-gen";
import * as MusicGen from "../music-gen";
import type {
  MusicGenConfig,
  MusicGenBackend,
  MusicRecordRow,
  MusicTask,
  MusicOutputFormat,
} from "../music-gen";
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
import { filterModelIds, MODEL_CATEGORY_SETS, type ModelCategory } from "../../shared/modelscope";
import { modelTypeOf } from "../../shared/cloud-providers";
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
import * as Knowledge from "../knowledge";
import type {
  KbCitation,
  KbEventEntry,
  KbHit,
  KbIndexStats,
  KbModality,
} from "../../shared/knowledge";
import { chunkMediaForRpc } from "./kb-media";
import * as Backup from "../backup";
import { isDialogPickedPath, rememberDialogPickedPaths } from "../dialog-paths";
import { MAX_UPLOAD_BYTES, formatUploadLimit } from "../../shared/uploads";
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

/**
 * 引擎生命周期类 RPC 的统一失败上报。
 *
 * 这一组接口（装引擎 / 起服务 / 停服务 / 删模型）按仓库约定返回 `{ ok:false, error }`
 * 而**不抛错**，所以 RPC 层那个 try/catch 记日志的写法在这里不成立 —— 结果就是
 * 「本地引擎装了没反应 / 起不来」在 `logs/app.log` 里一点痕迹都没有，`omi logs` 只能
 * 看到前端已经弹过又消失的 toast。包一层之后，每个入口只写自己的 event 名。
 */
async function loggedEngineCall<T extends { ok: boolean; error?: string }>(
  source: AppLogSource,
  event: string,
  detail: Record<string, unknown>,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    const result = await run();
    if (result && result.ok === false) {
      logEvent({
        level: "error",
        source,
        event,
        message: result.error ?? "未知原因",
        detail,
      });
    }
    return result;
  } catch (e) {
    logEvent({
      level: "error",
      source,
      event,
      message: e instanceof Error ? e.message : String(e),
      detail: { ...detail, error: e },
    });
    throw e;
  }
}

/**
 * 只放行"用户刚在系统对话框里选过"的路径，其余丢掉并记一条日志。
 *
 * 这些接口收的是绝对路径（OCR 暂存图片 / 文档导入 / 修图参考图），合法输入本来就
 * 可以是磁盘上任意位置 —— 所以不能用"必须落在数据目录内"来限位，那是把这些功能改坏。
 * 真正的判据是路径的来源：对话框是主进程弹的，用户看得见自己选了什么；
 * 从 webview 直接收下的路径则可能被注入的页面伪造成 `~/.ssh/id_rsa`。
 * 详见 `bun/dialog-paths.ts`。
 */
function acceptedDialogPaths(
  source: AppLogSource,
  event: string,
  paths: readonly string[],
): string[] {
  const accepted = paths.filter((p) => isDialogPickedPath(p));
  const rejected = paths.filter((p) => !isDialogPickedPath(p));
  if (rejected.length > 0) {
    logEvent({
      level: "warn",
      source,
      event,
      message: "拒绝了不是用户从文件对话框选出来的路径",
      detail: { rejected: rejected.slice(0, 10), acceptedCount: accepted.length },
    });
  }
  return accepted;
}

/** 路径被拒时回给界面的说明（改走词条没必要：这句只在异常路径上出现）。 */
function pathNotPickedMessage(): string {
  return "只能处理你在文件对话框里选中的文件，请重新选择。";
}

/**
 * 只在**抛错**时记日志的包装。
 *
 * 与 `loggedEngineCall` 的区别：那一组接口自己已经把 `{ok:false}` 的失败记进 app.log
 * （见 `bun/ppocr.ts` 的 install / download / start 三处），RPC 再记一遍就是重复条目。
 * 但"抛错"是另一回事 —— 它意味着模块里没预料到的路径，此前会被 catch 折叠成
 * 一句 `{ok:false,error}`，日志里什么都没有。
 */
async function loggedThrow<T>(
  source: AppLogSource,
  event: string,
  detail: Record<string, unknown>,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    logEvent({
      level: "error",
      source,
      event,
      message: e instanceof Error ? e.message : String(e),
      detail: { ...detail, error: e },
    });
    throw e;
  }
}

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
      /** 代理（设置 → 偏好 → 通用）：当前生效的地址与「谁走代理、谁直连」的采样。 */
      getProxyStatus: {
        params: undefined;
        response: ProxyStatus;
      };
      /** 「测试代理」：按当前（或表单里正在编辑的）设置请求一次模型市场。 */
      testProxy: {
        params: Proxy.ProxyTestOverride | undefined;
        response: ProxyTestResult;
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
          videoApi?: CloudVideoApi;
          musicApi?: CloudMusicApi;
        };
        response: { ok: boolean; error?: string };
      };
      /** 启用 / 停用服务商（可同时启用多个）。启用前会校验密钥。 */
      cloudProviderSetEnabled: {
        params: { id: string; enabled: boolean };
        response: { ok: boolean; error?: string; modelCount?: number };
      };
      /** 按已保存的地址 + 密钥探测服务商（设置页「校验密钥」）。 */
      cloudProviderProbe: {
        params: { id: string };
        response: { ok: boolean; error?: string; models?: string[] };
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
      /**
       * 一键安装推理引擎（引导页 / 设置里的「安装引擎」）：
       * llama.cpp 下载官方预编译二进制，mlx-lm / vLLM / SGLang 在数据目录里建 venv 装包。
       * 过程日志与阶段走 engineInstallLog / engineInstallPhase 推送。
       */
      installInferenceEngine: {
        params: { engine: InferenceEngine };
        response: { ok: boolean; error?: string; version?: string };
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
        response: {
          status: ServerStatus;
          pid?: number;
          logs: string;
          error?: string;
          /** 端口上有没有活着的推理服务（外部启动的也算）：UI 据此决定要不要提示去控制台启动。 */
          reachable: boolean;
        };
      };
      getServerStats: {
        params: undefined;
        response: ServerStats;
      };
      /**
       * 用量统计（设置 → 数据 → 使用统计）。`rangeDays` 只影响趋势与分组表，
       * 「累计」那几个数永远是全量口径。
       */
      getUsageStats: {
        params: { rangeDays?: number } | undefined;
        response: UsageStats;
      };
      clearServerLogs: {
        params: undefined;
        response: { ok: boolean };
      };
      // 已启动模型（可同时驻留多个）：控制台列表 / 启动 / 卸载 / 单模型日志
      listServedModels: {
        params: undefined;
        response: ServedModelsSnapshot;
      };
      startServedModel: {
        params: { path: string; engine?: InferenceEngine };
        response: { ok: boolean; error?: string; model?: ServedModelInfo };
      };
      stopServedModel: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      restartServedModel: {
        params: { id: string };
        response: { ok: boolean; error?: string; model?: ServedModelInfo };
      };
      setActiveServedModel: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      getServedModelLogs: {
        params: { id: string };
        response: { logs: string };
      };
      clearServedModelLogs: {
        params: { id: string };
        response: { ok: boolean };
      };
      /**
       * 统一应用日志（`<数据目录>/logs/app.log`）—— 各子系统（生图 / 生视频 /
       * 语音 / OCR / 服务器 / 下载 / 网关 …）的失败与关键事件都记在这里。
       * 排查任何「某个功能不好使」的问题，先看它。
       */
      getAppLogs: {
        params: AppLogQuery | undefined;
        response: { entries: AppLogEntry[]; path: string };
      };
      getAppLogInfo: {
        params: undefined;
        response: ReturnType<typeof appLogInfo>;
      };
      clearAppLogs: {
        params: undefined;
        response: { ok: boolean; cleared: number };
      };
      /** webview 侧上报（渲染异常、未捕获错误）：写进同一份 app.log，source=client。 */
      writeAppLog: {
        params: {
          level?: AppLogLevel;
          source?: string;
          event: string;
          message: string;
          detail?: unknown;
        };
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
      /** 网关 API Key 列表（含已停用；值默认由界面掩码展示）。 */
      listGatewayKeys: {
        params: undefined;
        response: { keys: GatewayKeyView[] };
      };
      /** 新建一把 Key：名字必填（列表里靠它区分是哪台机器 / 哪个客户端在用）。 */
      createGatewayKey: {
        params: { name: string };
        response: { ok: boolean; key?: GatewayKeyView; error?: string };
      };
      /** 停用 / 启用：立即生效（网关每个请求现读 Key），不需要重启。 */
      setGatewayKeyEnabled: {
        params: { id: string; enabled: boolean };
        response: { ok: boolean; key?: GatewayKeyView; error?: string };
      };
      deleteGatewayKey: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      /** 内网穿透（Cloudflare 隧道）：状态 / 二进制安装 / 启停。 */
      getTunnelStatus: {
        params: undefined;
        response: TunnelInfo;
      };
      installCloudflared: {
        params: undefined;
        response: { ok: boolean; error?: string; version?: string };
      };
      removeCloudflared: {
        params: undefined;
        response: { ok: boolean; error?: string; notice?: string };
      };
      startTunnel: {
        params: undefined;
        response: { ok: boolean; error?: string; reason?: string };
      };
      stopTunnel: {
        params: undefined;
        response: { ok: boolean };
      };
      restartTunnel: {
        params: undefined;
        response: { ok: boolean; error?: string; reason?: string };
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
        /** 路径不是从文件对话框选出来的 → `id: -1` + error（见 acceptedDialogPaths）。 */
        response: { id: number; error?: string };
      };
      addDocumentByUpload: {
        params: { data: string; name: string; type: string };
        /** 超限 / base64 非法 → `id: -1` + error（见 `shared/uploads.ts` 的体积上限）。 */
        response: { id: number; error?: string };
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
      /** 停止对话页正在进行的生成（保留已生成的部分）。 */
      stopChatGeneration: {
        params: { conversationId: number };
        response: { ok: boolean };
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
        response: { ok: boolean; error?: string };
      };
      listChatModels: {
        params: undefined;
        response: { models: ChatModelOption[] };
      };
      selectChatModel: {
        params: { type: "local" | "api"; value: string; providerId?: string };
        response: { ok: boolean; error?: string; needsStart?: boolean };
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
      /** 运行中继续发消息：steer = 立即插话，queue = 排在本次之后（没在跑就直接开跑）。 */
      followUpAgentMessage: {
        params: {
          conversationId: number;
          content: string;
          mode?: "steer" | "queue";
          workspace?: string;
        };
        response: { ok: boolean; queued: boolean; error?: string };
      };
      /** 排队中的消息（输入框上方的队列面板）。 */
      listQueuedAgentMessages: {
        params: { conversationId: number };
        response: { messages: string[] };
      };
      removeQueuedAgentMessage: {
        params: { conversationId: number; index: number };
        response: { messages: string[] };
      };
      regenerateAgentMessage: {
        params: { conversationId: number; messageId: number };
        response: { ok: boolean; error?: string };
      };
      listAgentEvents: {
        /** `afterId` = 只取比它新的事件（跑动中界面按 id 增量追平，见 Agent.listAgentEvents）。 */
        params: { conversationId: number; afterId?: number };
        response: { events: AgentEventRow[] };
      };
      /** 会话当前是否在跑（打开会话时取一次：刷新窗口 / 切回会话都要能把状态补上）。 */
      getAgentRunState: {
        params: { conversationId: number };
        response: AgentRunState;
      };
      listAgentTools: {
        params: { mode?: string } | undefined;
        response: {
          tools: {
            name: string;
            label: string;
            description: string;
            group: string;
            gated: boolean;
          }[];
        };
      };

      // -----------------------------------------------------------------
      // Agent 会话管理（侧栏：新建 / 重命名 / 置顶 / 归档 / 工作区）
      // -----------------------------------------------------------------
      /** 会话列表（含 per-conversation 工作区与归档状态）。 */
      listAgentSessions: {
        params: { includeArchived?: boolean; query?: string } | undefined;
        response: { sessions: AgentSessionView[] };
      };
      /** 会话搜索：标题 + 全部消息正文（结果带命中片段）。 */
      searchAgentSessions: {
        params: { query: string; limit?: number };
        response: { hits: AgentSessionSearchHit[] };
      };
      createAgentSession: {
        params: { title?: string; workspace?: string };
        response: { session: AgentSessionView };
      };
      /** 从某条消息分叉出新会话（原会话不动）。 */
      forkAgentSession: {
        params: { conversationId: number; messageId: number };
        response: { ok: boolean; conversationId?: number; error?: string };
      };
      renameAgentSession: {
        params: { conversationId: number; title: string };
        response: { ok: boolean; error?: string };
      };
      setAgentSessionPinned: {
        params: { conversationId: number; pinned: boolean };
        response: { ok: boolean };
      };
      setAgentSessionArchived: {
        params: { conversationId: number; archived: boolean };
        response: { ok: boolean; error?: string };
      };
      setAgentSessionWorkspace: {
        params: { conversationId: number; workspace: string | null };
        response: { ok: boolean; workspace: string };
      };

      // -----------------------------------------------------------------
      // Agent 交互：工具授权 / 反问 / 待办 / 产出物
      // -----------------------------------------------------------------
      /** 打开会话时恢复挂起的授权与提问（切会话 / 重启窗口后不能丢弹窗）。 */
      listAgentInteractions: {
        params: { conversationId: number };
        response: {
          permissions: PendingPermission[];
          questions: PendingQuestion[];
        };
      };
      respondAgentPermission: {
        params: { id: string; reply: "once" | "session" | "workspace" | "deny" };
        response: { ok: boolean };
      };
      respondAgentQuestion: {
        params: { id: string; answers: string[][] };
        response: { ok: boolean };
      };
      listAgentTodos: {
        params: { conversationId: number };
        response: { todos: TodoItem[] };
      };
      getAgentGoal: {
        params: { conversationId: number };
        response: { goal: AgentGoalView | null };
      };
      /** 目标的人工操作：暂停自动推进 / 恢复 / 放弃。 */
      setAgentGoalStatus: {
        params: {
          conversationId: number;
          status: "active" | "paused" | "dropped";
          outcome?: string;
        };
        response: { ok: boolean; goal: AgentGoalView | null };
      };
      getAgentPlan: {
        params: { conversationId: number };
        response: { plan: AgentPlan | null; approved: boolean };
      };
      /** 批准方案并切到 Agent 模式执行（界面上的「批准并执行」）。 */
      approveAgentPlan: {
        params: { conversationId: number };
        response: { ok: boolean; error?: string };
      };
      clearAgentPlan: {
        params: { conversationId: number };
        response: { ok: boolean };
      };
      listAgentArtifacts: {
        params: { conversationId: number };
        response: { artifacts: ArtifactItem[] };
      };
      readAgentArtifact: {
        params: { artifactId: number };
        response: {
          kind: string;
          text: string | null;
          dataUrl: string | null;
          truncated: boolean;
          size: number;
          title: string;
        };
      };
      deleteAgentArtifact: {
        params: { artifactId: number };
        response: { ok: boolean };
      };
      /** 用系统默认浏览器打开产出物（HTML / PDF 这类适合外部打开的）。 */
      openAgentArtifactExternal: {
        params: { artifactId: number };
        response: { ok: boolean };
      };
      /** 在访达 / 文件管理器里定位产出物。 */
      revealAgentArtifact: {
        params: { artifactId: number };
        response: { ok: boolean };
      };
      /** 工作区文件树（产出物面板的「文件」页签）。 */
      listWorkspaceFiles: {
        params: { workspace?: string } | undefined;
        response: { root: string; rootId: string; nodes: WorkspaceTreeNode[] };
      };
      readWorkspaceFile: {
        params: { path: string; workspace?: string };
        response: { kind: string; text: string | null; dataUrl: string | null; size: number };
      };
      /** 工作区改动（侧边面板「审查」页签）：git 仓库给文件清单 + 增删行数。 */
      getWorkspaceChanges: {
        params: { workspace?: string } | undefined;
        response: WorkspaceChanges;
      };
      /** 单个文件的 unified diff。 */
      getWorkspaceDiff: {
        params: { path: string; workspace?: string };
        response: WorkspaceDiff;
      };

      // -----------------------------------------------------------------
      // 侧边面板的终端（真实 PTY）
      // -----------------------------------------------------------------
      startTerminal: {
        params: { cwd?: string; cols?: number; rows?: number } | undefined;
        response: TerminalSessionInfo;
      };
      /** 键盘输入（原样写进 PTY，含控制序列）。 */
      writeTerminal: {
        params: { id: string; data: string };
        response: { ok: boolean };
      };
      resizeTerminal: {
        params: { id: string; cols: number; rows: number };
        response: { ok: boolean };
      };
      closeTerminal: {
        params: { id: string };
        response: { ok: boolean };
      };
      /** 面板重新挂载时取回会话（含回放缓冲），终端不会变成空白。 */
      getTerminal: {
        params: { id: string };
        response: TerminalSessionInfo | null;
      };

      // -----------------------------------------------------------------
      // Agent 权限（设置页 + 授权弹窗的「总是允许」管理）
      // -----------------------------------------------------------------
      getAgentPermissions: {
        params: { conversationId?: number; workspace?: string } | undefined;
        response: {
          mode: AgentApprovalMode;
          rules: (PermissionRule & { id?: number; scope?: string; scopeRef?: string })[];
          effective: EffectivePermissionRow[];
          authorizedFolders: string[];
          sessionGrants: (PermissionRule & { id: number; scopeRef: string })[];
          /** 可手写规则的权限名（唯一权威清单，取自 permissions.ts）。 */
          permissionNames: string[];
        };
      };
      setAgentApprovalMode: {
        params: { mode: AgentApprovalMode };
        response: { ok: boolean };
      };
      setAgentPermissionRules: {
        params: { rules: PermissionRule[] };
        response: { ok: boolean; error?: string };
      };
      deleteAgentPermissionRule: {
        params: { id: number };
        response: { ok: boolean };
      };
      clearAgentPermissionGrants: {
        params: { conversationId?: number; workspace?: string; scope: "session" | "workspace" };
        response: { ok: boolean };
      };
      setAgentAuthorizedFolders: {
        params: { folders: string[] };
        response: { ok: boolean };
      };
      /**
       * Agent 能力开关（对齐 Codex 的那批能力）：项目指令（AGENTS.md）与看图工具。
       * 项目指令的现状单独有 getAgentInstructions：设置页要展示「读到了哪几个文件」。
       */
      getAgentCapabilities: {
        params: undefined;
        response: {
          visionTool: "auto" | "on" | "off";
          /** 当前模型看起来能不能收图片（auto 档的实际判定结果）。 */
          visionAvailable: boolean;
          modelName: string;
        };
      };
      setAgentCapabilities: {
        params: { visionTool?: "auto" | "on" | "off" };
        response: { ok: boolean };
      };
      getAgentInstructions: {
        params: { workspace?: string } | undefined;
        response: {
          enabled: boolean;
          maxBytes: number;
          workspace: string;
          truncated: boolean;
          files: { path: string; source: "user" | "project"; bytes: number }[];
          userPath: string;
        };
      };
      setAgentInstructions: {
        params: { enabled?: boolean; maxBytes?: number };
        response: { ok: boolean };
      };
      /**
       * 回合快照与回退（对齐 Codex 的回合安全网）：每轮 Agent 开跑前记一次工作区状态，
       * 界面据此给助手消息挂「撤销本轮」。
       */
      listAgentSnapshots: {
        params: { conversationId?: number } | undefined;
        response: {
          enabled: boolean;
          gitAvailable: boolean;
          workspace: string;
          turns: number;
          snapshots: {
            id: string;
            messageId: number | null;
            label: string;
            createdAt: number;
            files: number;
          }[];
          /** 影子仓库占用与维护阈值（设置页显示"吃了多少磁盘"）。 */
          usage: {
            repoDir: string;
            bytes: number;
            turns: number;
            lastSnapshotAt: number | null;
            lastGcAt: number | null;
            truncated: boolean;
          } | null;
          gcThresholds: { bytes: number; turns: number };
        };
      };
      /** 手动整理影子仓库（设置页的「立即清理」）。 */
      gcAgentSnapshots: {
        params: undefined;
        response: {
          ok: boolean;
          ran: boolean;
          reason?: string;
          freedBytes: number;
          bytesBefore: number;
          bytesAfter: number;
        };
      };
      /** 回退前先看一眼会改哪些文件（状态 A / ? = 会被删除）。 */
      previewAgentSnapshot: {
        params: { id: string };
        response: {
          ok: boolean;
          workspace?: string;
          files?: { status: string; path: string }[];
          error?: string;
        };
      };
      revertAgentSnapshot: {
        params: { id: string };
        response: { ok: boolean; restored?: string[]; removed?: string[]; error?: string };
      };
      setAgentSnapshots: {
        params: { enabled: boolean };
        response: { ok: boolean };
      };
      /**
       * 上下文占用（对齐 Codex 的 /status）：输入框上的占用条用它。
       * 实测优先（上一轮的 usage.prompt_tokens），否则按消息估算。
       */
      /**
       * 命令沙箱（对齐 Codex 的 workspace-write）：管住 bash 里那些不经过
       * 工具层路径校验的操作（写工作区外、读凭据目录）。
       */
      getAgentSandbox: {
        params: undefined;
        response: {
          mode: "off" | "workspace-write" | "read-only";
          supported: boolean;
          /** 实际生效的后端：macOS 的 seatbelt / Linux 的 bwrap 或 landlock / none。 */
          backend: "seatbelt" | "bwrap" | "landlock" | "none";
          platform: string;
          allowNetwork: boolean;
          /** Linux 上 bwrap 是否探测通过（没装的话界面给出安装命令）。 */
          bwrapAvailable: boolean;
          /** 后端偏好：auto（默认）/ bwrap / landlock（设置项 AGENT_SANDBOX_BACKEND）。 */
          backendPreference: "auto" | "bwrap" | "landlock";
          /**
           * Landlock（Linux 5.13+）：策略生成已就绪，辅助程序是首次使用时按源码现编的
           * （需要 C 编译器）。`helperAvailable` 是**真实探测结果**（编译 + 内核 ABI），
           * 不是"理论上可以"。
           */
          landlock: {
            policyReady: boolean;
            helperAvailable: boolean;
            abi: number | null;
            reason: string | null;
            note: string;
          };
        };
      };
      setAgentSandbox: {
        params: { mode?: "off" | "workspace-write" | "read-only"; allowNetwork?: boolean };
        response: { ok: boolean };
      };
      /**
       * 外部通知回调（对齐 Codex 的 notify）：跑完 / 需要授权 / 自动化结果发生时，
       * 把事件 JSON 交给用户自己的命令（最后一个参数 + OMNI_NOTIFY_PAYLOAD）。
       */
      getAgentNotify: {
        params: undefined;
        response: { command: string; configured: boolean };
      };
      setAgentNotify: {
        params: { command: string };
        response: { ok: boolean };
      };
      /**
       * 生命周期 hooks（对齐 Codex 的 SessionStart / UserPromptSubmit）：
       * 配置是 JSON 数组，返回时连带把解析错误带出来（设置页要能指出哪条写错了）。
       */
      getAgentHooks: {
        params: undefined;
        response: {
          raw: string;
          hooks: { event: string; command: string; timeoutMs: number }[];
          errors: string[];
          events: string[];
        };
      };
      setAgentHooks: {
        params: { raw: string };
        response: { ok: boolean; errors?: string[] };
      };
      /** 手动压缩（对齐 Codex 的 `/compact`）：现在就把上下文收紧一次。 */
      compactAgentConversation: {
        params: { conversationId: number };
        response: {
          ok: boolean;
          dropped: number;
          tokensBefore: number;
          tokensAfter: number;
          budgetTokens: number;
          reason?: string;
        };
      };
      /** 会话配置速览（对齐 Codex 的 `/status`）。 */
      getAgentSessionStatus: {
        params: { conversationId: number };
        response: {
          model: string;
          mode: string;
          workspace: string;
          serverMode: "local" | "remote";
          contextWindow: number;
          contextBudget: number;
          usedTokens: number;
          remainingTokens: number;
          percent: number;
          usageSource: "usage" | "estimate";
          approvalMode: string;
          thinkingLevel: string;
          sandboxMode: string;
          droppedSoFar: number;
        };
      };
      /**
       * 推理等级开关。与 `AGENT_MODE` 不同，这个值必须校验后才落库 ——
       * 拼错的等级会被原样发进请求体，服务端只会回一个看不懂的 400。
       */
      setAgentThinkingLevel: {
        params: { level: string };
        response: { ok: boolean; level: string };
      };
      getAgentContextUsage: {
        params: { conversationId: number };
        response: {
          windowTokens: number;
          budgetTokens: number;
          usedTokens: number;
          remainingTokens: number;
          percent: number;
          source: "usage" | "estimate";
        };
      };

      // -----------------------------------------------------------------
      // 自动化（定时把 Agent 跑起来）
      // -----------------------------------------------------------------
      listAutomations: {
        params: undefined;
        response: { automations: AutomationItem[] };
      };
      createAutomation: {
        params: {
          name: string;
          instructions: string;
          workspace: string;
          scheduleKind: "once" | "daily" | "weekly";
          schedule: { at?: string; hour?: number; minute?: number; daysOfWeek?: number[] };
          timezone: string;
          mode?: string;
        };
        response: { ok: boolean; automation?: AutomationItem; error?: string };
      };
      updateAutomation: {
        params: {
          id: number;
          patch: {
            name?: string;
            instructions?: string;
            workspace?: string;
            scheduleKind?: "once" | "daily" | "weekly";
            schedule?: { at?: string; hour?: number; minute?: number; daysOfWeek?: number[] };
            timezone?: string;
            mode?: string;
            enabled?: boolean;
          };
        };
        response: { ok: boolean; automation?: AutomationItem; error?: string };
      };
      deleteAutomation: {
        params: { id: number };
        response: { ok: boolean };
      };
      /** 立刻跑一次（不等到计划时间）。 */
      runAutomationNow: {
        params: { id: number };
        response: { ok: boolean; runId: number; conversationId: number | null; error?: string };
      };
      listAutomationRuns: {
        params: { automationId?: number; limit?: number } | undefined;
        response: { runs: AutomationRunItem[] };
      };

      // -----------------------------------------------------------------
      // 通知中心（后台跑完 / 需要授权 / 自动化结果）
      // -----------------------------------------------------------------
      listNotifications: {
        params: { limit?: number } | undefined;
        response: { notifications: AppNotification[]; unread: number };
      };
      markNotificationsRead: {
        params: { ids?: string[] } | undefined;
        response: { ok: boolean; unread: number };
      };
      clearNotifications: {
        params: undefined;
        response: { ok: boolean };
      };
      /**
       * webview 回报「用户在看什么」（当前会话 + 窗口是否聚焦）。
       * 主进程据此决定后台跑完的回合要不要发通知 —— 它自己看不到界面状态。
       */
      setViewState: {
        params: { conversationId?: number | null; focused?: boolean } | undefined;
        response: { ok: boolean };
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
              pinned?: boolean;
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
        response: {
          hashed: number;
          expired: number;
          archived: number;
          consolidated: number;
          embedded: number;
        };
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
          /** 选中的云厂商：API Key 从厂商行取（页面不再手填）。 */
          providerId?: string;
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
        params: {
          repo: string;
          fileName: string;
          category?: ModelCategory;
          source?: ModelSource;
          /** 市场列表已知的字节数：用于「小文件先下」排队，省一次探测。 */
          size?: number | null;
          /** 用户单独点的文件插队优先（批量下载不传）。 */
          explicit?: boolean;
        };
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
      /** 更新已下载模型的类别（模型详情页下拉）：只对应用下载目录里的模型生效。 */
      setModelCategory: {
        params: { path: string; category: ModelCategory };
        response: { ok: boolean; error?: string; model?: InstalledModel };
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
          entries: {
            path: string;
            kind: "primary" | "extra" | "hf-cache";
            exists: boolean;
            count: number;
            size: number;
          }[];
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
        response: { records: BenchmarkRecordRow[]; total: number };
      };
      getBenchmarkRecord: {
        params: { id: number };
        response: { record: BenchmarkRecordRow | null };
      };
      deleteBenchmarkRecord: {
        params: { id: number };
        response: { ok: boolean };
      };
      clearBenchmarkRecords: {
        params: undefined;
        response: { ok: boolean };
      };
      /**
       * 导出基准报告为单文件 HTML（正文由界面生成，主进程只负责落盘）。
       *
       * 界面已经握着 rows / summary / params，HTML 在那边拼好传过来；写盘、去重、
       * 文件名清洗留在主进程，产物落在系统「下载」目录。
       */
      exportBenchmarkReport: {
        params: { filename: string; html: string };
        response: { ok: boolean; path?: string; error?: string };
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
          referenceAudioRef?: string;
        };
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
        // 不回 apiKey：页面只需要厂商 id / 地址 / 模型，密钥留在主进程（由服务商行解析）。
        response: {
          config: { providerId: string; base: string; model: string };
        };
      };
      /** 语音页只写「厂商 + 模型」：地址 / 密钥由服务商行提供。 */
      saveTTSProviderConfig: {
        params: { providerId?: string; model?: string };
        /** voice = 本次生效的音色（换厂商后可能落成新厂商的默认值，页面据此刷新显示）。 */
        response: { ok: boolean; voice: string };
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
        // 不回 apiKey：同 TTS，页面不需要看到密钥。
        response: {
          config: { providerId: string; base: string; model: string };
        };
      };
      saveASRProviderConfig: {
        params: { providerId?: string; model?: string };
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
        params: {
          text: string;
          voice?: string;
          emotion?: string;
          language?: string;
          instruct?: string;
          model?: string;
        };
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
        params: { providerId?: string; model?: string };
        response: { ok: boolean };
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
      // 本地抠图（去背景 / 换背景）—— 模型在本机跑，图片不出进程
      bgRemoveModels: {
        params: {};
        response: {
          models: BgRemove.BgModelStatus[];
          defaultModel: string;
          /** 当前可用模型：优先默认模型，否则任意一个已下载的；都没有时 null。 */
          ready: string | null;
        };
      };
      bgRemoveDownloadModel: {
        params: { model: string };
        response: { ok: boolean; error?: string };
      };
      /** 把用户刚在系统对话框里选中的图片收进 images/ 并返回 ref（小应用靠它拿到可加载的 URL）。 */
      bgRemoveStageSource: {
        params: { path: string };
        response: { ref?: string; url?: string; error?: string };
      };
      bgRemoveRun: {
        params: { ref: string; model?: string; refine?: number; maxSize?: number };
        response: {
          cutout?: { ref: string; url: string };
          mask?: { ref: string; url: string };
          width?: number;
          height?: number;
          model?: string;
          inferenceMs?: number;
          totalMs?: number;
          error?: string;
        };
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
          /** 页面能改的只有这四项：地址与密钥属于厂商行（`providerId` 现取），不从页面传。 */
          config?: Partial<Pick<ImageGenConfig, "backend" | "providerId" | "model" | "comfyBase">>;
        };
        response: { records: ImageRecordRow[]; error?: string };
      };
      listImageRecords: {
        params: { limit?: number } | undefined;
        response: { records: ImageRecordRow[]; error?: string };
      };
      deleteImageRecord: {
        params: { id: number };
        response: { ok: boolean; error?: string };
      };
      getImageGenConfig: {
        params: undefined;
        response: { config: ImageGenConfig };
      };
      saveImageGenConfig: {
        params: Partial<ImageGenConfig>;
        response: { ok: boolean };
      };
      /** 模型清单：地址与密钥一律按 `providerId`（或已保存配置）现取，页面不传凭据。 */
      listImageGenModels: {
        params: { backend?: ImageGenBackend; base?: string } | undefined;
        response: { models: string[]; relaxed?: boolean; error?: string };
      };
      /** Agent 生图弹窗：用户点了确认 / 取消后回传，主进程继续那次工具调用。 */
      resolveMediaSetup: {
        params: {
          id: string;
          action: "confirm" | "cancel";
          backend?: string;
          model?: string;
          /** 云端生图选中的服务商（地址 / 密钥由服务商行提供）。 */
          providerId?: string;
          comfyBase?: string;
        };
        response: { ok: boolean };
      };
      /** Agent 生图弹窗里的「扫描模型」：用表单当前值探测，不落盘配置；凭据按 `providerId` 取。 */
      scanMediaSetupCandidates: {
        params: { kind?: string; backend?: string; base?: string; providerId?: string } | undefined;
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
        response: { records: VideoRecordRow[]; error?: string };
      };
      listVideoRecords: {
        params: { limit?: number } | undefined;
        response: { records: VideoRecordRow[]; error?: string };
      };
      deleteVideoRecord: {
        params: { id: number };
        response: { ok: boolean; error?: string };
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
        params: { backend?: VideoGenBackend; base?: string; providerId?: string } | undefined;
        response: {
          models: string[];
          checkpoints: string[];
          clips: string[];
          vaes: string[];
          error?: string;
        };
      };
      // AI 音乐生成（云端按厂商协议分派：stepfun 异步提交 + 轮询 / minimax 同步长请求；
      // local 本地引擎为预留位，见 bun/music-gen.ts）
      submitMusicGeneration: {
        params: {
          /** 风格描述（曲风 / 人声 / 情绪 / 调式…）。 */
          caption: string;
          lyrics?: string;
          /** 歌名：本地标签，不会发给上游（两家接口都没有这个参数）。 */
          title?: string;
          instrumental?: boolean;
          /** 任务类型；省略时按"有无参考音频"推断。 */
          task?: MusicTask;
          /** 参考歌曲 / 干声（images 目录内 ref，stageAudio 暂存）。 */
          refAudioRef?: string;
          responseFormat?: MusicOutputFormat;
          sampleRate?: number;
          config?: Partial<MusicGenConfig>;
        };
        response: { record?: MusicRecordRow; error?: string };
      };
      pollMusicRecords: {
        params: { ids: number[] };
        response: { records: MusicRecordRow[]; error?: string };
      };
      listMusicRecords: {
        params: { limit?: number } | undefined;
        response: { records: MusicRecordRow[]; error?: string };
      };
      deleteMusicRecord: {
        params: { id: number };
        response: { ok: boolean; error?: string };
      };
      getMusicGenConfig: {
        params: undefined;
        response: { config: MusicGenConfig };
      };
      saveMusicGenConfig: {
        params: Partial<MusicGenConfig>;
        response: { ok: boolean };
      };
      listMusicGenModels: {
        params: { backend?: MusicGenBackend; providerId?: string } | undefined;
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
        /** 非法路径（家目录 / 根目录 / 应用数据目录内）→ ok:false + error。 */
        response: { ok: boolean; error?: string };
      };
      skillsAddCustomTool: {
        params: {
          key: string;
          name: string;
          skillsDir: string;
          projectSkillsDir?: string;
          category: "coding" | "lobster";
        };
        response: { ok: boolean; error?: string };
      };
      skillsRemoveCustomTool: {
        params: { key: string };
        response: { ok: boolean };
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
        params: { skillId?: string };
        response: { ok: boolean };
      };
      // ---- 知识库（本地 RAG） ----
      kbList: {
        params: undefined;
        response: { kbs: Knowledge.KbView[] };
      };
      kbCreate: {
        params: {
          name: string;
          description?: string;
          embeddingModel?: string;
          rerankModel?: string;
          embeddingProviderId?: string;
          rerankProviderId?: string;
          /** 模态能力声明：随建库快照（数据层缺省 false，不从全局继承）。 */
          embedImage?: boolean;
          embedAudio?: boolean;
          embedVideo?: boolean;
        };
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
        response: { docs: Knowledge.KbDocView[]; total: number };
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
        response: { chunks: Knowledge.KbChunkView[]; total: number };
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
        params: { base?: string; apiKey?: string; providerId?: string; model: string };
        response: { ok: boolean; dim?: number; error?: string };
      };
      /** 探测全局默认嵌入配置当前是否可用（新建弹窗预填门控；未配置不发起嵌入请求）。 */
      kbDefaultEmbeddingProbe: {
        params: undefined;
        response:
          | { configured: false }
          | { configured: true; reachable: boolean; model: string; dim?: number; error?: string };
      };
      kbEmbeddingModels: {
        params: { base?: string; apiKey?: string; providerId?: string } | undefined;
        response: Knowledge.KbModelCandidates;
      };
      kbTestRerank: {
        params: { base?: string; apiKey?: string; providerId?: string; model: string };
        response: { ok: boolean; error?: string };
      };
      kbRerankModels: {
        params: { base?: string; apiKey?: string; providerId?: string } | undefined;
        response: Knowledge.KbModelCandidates;
      };
      /** 分块媒体表示：图片=按 size 档位缩放的 dataUrl（thumb 512/full 2048）；音视频/文本/文件缺失 dataUrl=null（UI 图标兜底；打开原文件复用 openPath）。 */
      kbChunkMedia: {
        params: { chunkId: number; size?: "thumb" | "full" };
        response: {
          dataUrl: string | null;
          modality: KbModality | null;
          fileName: string;
          mediaPath: string | null;
          text: string | null;
        };
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
      // 小应用（应用中心）：能力探测 / 一次性补全 / 产物落盘 / 自报日志。
      // 小应用自己跑在 sandbox iframe 里，这四个是宿主代它执行的全部主进程动作
      // （动作清单见 shared/miniapps.ts 的 MINIAPP_ACTIONS），没有任意方法透传的口子。
      getMiniAppCapabilities: {
        params: undefined;
        response: { capabilities: MiniAppCapabilitySnapshot };
      };
      miniappComplete: {
        params: CompleteTextParams;
        response: { text: string; model?: string; error?: string };
      };
      miniappSaveFile: {
        params: { name: string; dataUrl: string };
        response: { ok: boolean; path?: string; error?: string };
      };
      miniappReadFile: {
        params: { path: string };
        response: { ok: boolean; dataUrl?: string; name?: string; size?: number; error?: string };
      };
      miniappLog: {
        params: { appId: string; event: string; message?: string; detail?: unknown };
        response: { ok: boolean; dropped?: boolean };
      };
      // 小应用「笔记」：正文在主库、附件在数据目录。小应用自己没有存储
      //（沙箱 iframe 里 localStorage 不存在），所以这四个方法是它唯一的落点。
      miniappNotesList: {
        params: undefined;
        response: {
          notes: Note[];
          stats: { notes: number; images: number; bytes: number };
          /** 笔记是否对 Agent 可见（沉淀记忆 + 可读正文，见 bun/memory.ts）。 */
          agentAccess: boolean;
        };
      };
      miniappNotesSetAgentAccess: {
        params: { enabled: boolean };
        response: { ok: boolean; enabled: boolean };
      };
      miniappNotesSave: {
        params: NoteInput;
        response: { ok: boolean; note?: Note; error?: string };
      };
      miniappNotesDelete: {
        params: { id: number };
        response: { ok: boolean; error?: string };
      };
      miniappNotesAttach: {
        params: { dataUrl: string; name?: string };
        response: { ok: boolean; image?: NoteImage; error?: string };
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
      /**
       * 媒体服务状态（聊天图片 / 生成图 / OCR 页图 / TTS 音频都靠它取文件）：
       * 端口被另一个数据目录的实例占着时，预览会取不到或取错，顶栏要如实显示。
       */
      mediaStatusChanged: { status: MediaServerStatus };
      /** 已启动模型列表变化（启动 / 就绪 / 出错 / 卸载）：整份快照推送。 */
      servedModelsChanged: ServedModelsSnapshot;
      /** 某个已启动模型的日志增量（按 id 区分，控制台里各自一个日志窗口）。 */
      servedModelLog: { id: string; text: string };
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
      /**
       * 本轮助手消息的行刚建好（开跑瞬间，一个字还没出）。
       *
       * 从"按下发送"到"第一个 token"之间是建会话 / 起推理服务 / 模型加载 / 预填充 /
       * 检索这些活儿，几秒到几十秒都可能。界面据此**立刻**把这条消息画出来
       * （对话页「生成中…」、Agent 页「处理中 · N 秒」），而不是干等到第一个增量
       * 才凭空冒出一个气泡 —— 那段没有任何反馈的等待看着就是"程序挂了"。
       */
      chatMessageStarted: { conversationId: number; messageId: number };
      /** 知识库数据变化（摄取进度/删除/向量补齐），前端据此刷新列表。 */
      knowledgeChanged: { kbId?: number; docId?: number };
      chatStats: ChatStats;
      agentEvent: AgentEventRow;
      /**
       * 会话的运行态（开跑 / 收尾各一次）。
       * 为什么不能只靠前端自己记：刷新窗口、切走再切回、自动化起的运行都不经过
       * 本窗口的"发送"按钮，只有后端推过来，界面才知道它还在干活。
       */
      agentRunState: { conversationId: number; running: boolean };
      /** 工具授权请求 / 已结束（弹窗的显示与收起）。 */
      agentPermissionRequest: PendingPermission;
      agentPermissionSettled: {
        conversationId: number;
        id: string;
        reply: "once" | "session" | "workspace" | "deny";
        permission: string;
        pattern: string;
      };
      /** ask_user 的提问 / 已作答。 */
      agentQuestion: PendingQuestion;
      agentQuestionSettled: { conversationId: number; id: string; answers: string[][] };
      /** 待办清单变化（全量覆盖）。 */
      agentTodos: { conversationId: number; todos: TodoItem[] };
      /** 目标变化（Goal 模式）：立项 / 完成 / 暂停 / 撞预算都会推。 */
      agentGoalChanged: { conversationId: number; goal: AgentGoalView | null };
      /** 方案变化（Plan 模式）：写入 / 批准 / 清空都会推。 */
      agentPlanChanged: { conversationId: number; plan: AgentPlan | null };
      /** 新产出物登记。 */
      agentArtifact: { conversationId: number; artifact: ArtifactItem };
      /** 终端输出（按帧批量推送）。 */
      terminalData: { id: string; data: string };
      /** 终端里的 shell 退出了（界面标一下，可以一键重开）。 */
      terminalExit: { id: string; exitCode: number; signal: string | null };
      /** 自动化任务 / 运行记录变化，前端刷新列表。 */
      automationsChanged: { id?: number };
      /** 新通知（后台跑完 / 需要授权 / 自动化结果）。 */
      notificationAdded: AppNotification;
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
      /** 内网穿透状态（公网地址、连接状态、失败原因），变化时推送。 */
      tunnelStatusChanged: TunnelInfo;
      /** cloudflared 安装日志（80ms 合批，同 PaddleOCR / MLX）。 */
      tunnelInstallLog: { lines: string[] };
      mlxInstallLog: {
        /** 一批日志行（主进程按 80ms 窗口合批，见 bun/throttle.ts）。 */
        lines: string[];
      };
      mlxModelDownloadProgress: MlxModelDownloadProgress;
      /** 生图阶段事件：启动/加载/生成 n/N/完成。 */
      mlxGenPhase: MlxGenPhase;
      /** PaddleOCR 引擎安装日志 / 阶段（下载模型 / 加载 / 就绪 / 错误），实时推送。 */
      ppOcrInstallLog: { lines: string[] };
      ppOcrPhase: { phase: PpOcr.PpOcrPhase; message: string };
      /** PaddleOCR 模型文件下载进度（字节 + 估算速度），模型卡实时进度条。 */
      ppOcrModelProgress: PpOcr.PpOcrModelProgress;
      /** 本地抠图模型下载进度（字节 + 百分比），模型卡与抠图页实时进度条。 */
      bgRemoveProgress: BgRemove.BgDownloadProgress;
      /** Tesseract 引擎一键安装（brew install）日志，实时推送。 */
      tesseractInstallLog: { lines: string[] };
      /** 推理引擎一键安装（llama.cpp 下载官方构建 / Python 引擎建 venv）的日志与阶段。 */
      engineInstallLog: { lines: string[] };
      engineInstallPhase: EngineInstall.EngineInstallEvent;
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

// 产出物预览（/artifact/<id>）的路径解析：只在服务端按 id 查库，
// 预览地址里带不了任意路径 —— 这是"只服务登记过的产出物"的关键。
setArtifactResolver((id) => getAgentArtifact(id)?.absPath ?? null);

/**
 * 请求处理器表。
 *
 * 抽成独立常量是为了给**网页端**复用：`/v1/web/rpc`（bun/gateway-web.ts）把浏览器里
 * 那份 webview 发来的 RPC 请求按同一张表分发 —— 界面是同一套 React 组件，处理器
 * 当然也必须是同一份实现，否则"网页版"立刻变成第二套后端。
 * 暴露面由 gateway-web.ts 的白名单收口（只放对话 / Agent 用得到的那些）。
 *
 * 类型从 defineRPC 的入参反推：裸对象字面量拿不到上下文类型，
 * 几百个 handler 的参数会集体退化成 implicit any。
 */
/**
 * 抠图模型下载进度的出口。
 *
 * 用可替换的 sink 而不是直接引用窗口：handler 在 `initBgRemoveBroadcast` 之前就可能
 * 被调用（前端一进来就查模型清单），写死窗口会在那时抛空引用。没接窗口时静默丢弃，
 * 进度只是展示信息，丢了不影响下载本身。
 */
let bgRemoveProgressSink: ((p: BgRemove.BgDownloadProgress) => void) | null = null;
const bgRemoveProgress = {
  push: (p: BgRemove.BgDownloadProgress) => bgRemoveProgressSink?.(p),
};

const rpcRequests: NonNullable<
  Parameters<typeof BrowserView.defineRPC<AppRPC>>[0]["handlers"]["requests"]
> = {
  getSettings: async () => ({
    configured: isConfigured(),
    settings: getAllSettings(),
    // 主进程平台信息，供 UI 做 macOS 专属引擎（MLX）的门控。
    platform: process.platform,
  }),

  updateSettings: async ({ settings }) => {
    updateSettings(settings);
    // 代理设置改完立刻生效：重装环境变量与探测缓存，否则要等下一次启动。
    if (Object.keys(settings).some((key) => key.startsWith("PROXY_"))) {
      Proxy.applyProxySettings();
    }
    // 网关 / 隧道的配置改完重新对账：端口变了隧道要重新指向，Key 被清掉要立刻下线
    // （公网开着但没有 Key 等于对外开放）。
    if (
      Object.keys(settings).some((key) => key.startsWith("TUNNEL_") || key.startsWith("GATEWAY_"))
    ) {
      void Tunnel.reconcileTunnel("settings");
    }
    return { ok: true };
  },

  getProxyStatus: async () => Proxy.proxyStatus(),

  testProxy: async (params) => Proxy.testProxyConnection(params),

  checkConnection: async (params) => {
    const baseUrl = (params?.baseUrl ?? getSetting("VLLM_API_BASE") ?? "").trim();
    const apiKey = params?.apiKey ?? getSetting("VLLM_API_KEY");
    if (!baseUrl) return { connected: false, error: "缺少服务地址" };
    // 走模型清单探测而不是只看 res.ok：聚合站（New API 等）的根路径返回
    // 200 + 前端首页 HTML，只看状态码会把「不是接口」报成连接成功。
    const r = await CloudProviders.fetchRemoteModels({ baseUrl, apiKey, timeoutMs: 5000 });
    return r.ok ? { connected: true } : { connected: false, error: r.error };
  },

  // 拉取该 Key 有权限的远程模型列表（OpenAI 兼容 GET /models）
  listRemoteModels: async (params) => {
    const baseUrl = (params?.baseUrl ?? getSetting("VLLM_API_BASE") ?? "").trim();
    const apiKey = params?.apiKey ?? getSetting("VLLM_API_KEY");
    const r = await CloudProviders.fetchRemoteModels({ baseUrl, apiKey });
    if (!r.ok) {
      logEvent({
        level: "warn",
        source: "app",
        event: "cloud-provider.models.failed",
        message: `获取模型列表失败：${r.error ?? "未知原因"}`,
        detail: { baseUrl: baseUrl || null, error: r.error ?? null },
      });
      return { ok: false, models: [], error: r.error };
    }
    return { ok: true, models: [...r.models].sort() };
  },

  cloudProviderList: async () => CloudProviders.listCloudProviders(),

  cloudProviderCreate: async (params) => CloudProviders.createCloudProvider(params ?? {}),

  cloudProviderUpdate: async (params) =>
    CloudProviders.updateCloudProvider(params.id, params ?? {}),

  cloudProviderDelete: async ({ id }) => CloudProviders.deleteCloudProvider(id),

  cloudProviderSetEnabled: async ({ id, enabled }) =>
    CloudProviders.setCloudProviderEnabled(id, enabled),

  cloudProviderProbe: async ({ id }) => {
    const provider = CloudProviders.getCloudProviderInfo(id);
    if (!provider) return { ok: false, error: "服务商不存在" };
    return CloudProviders.probeProviderKey({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    });
  },

  cloudProviderActivate: async ({ id }) => CloudProviders.activateCloudProvider(id),

  cloudProviderDeactivate: async () => CloudProviders.deactivateCloudProvider(),

  checkLlamaServer: async () => {
    return ServerManager.checkBinaryExists();
  },

  getSetupEnvironment: async () => {
    return getSetupEnvironment();
  },

  installInferenceEngine: async ({ engine }) => {
    return EngineInstall.installInferenceEngine(engine);
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
    const status = ServerManager.getStatus();
    return {
      status,
      pid: ServerManager.getPid(),
      logs: ServerManager.getLogs(),
      error: ServerManager.getLastError() || undefined,
      // 有实例在跑就不用探测；否则探一次端口，区分「没启动」和「外部服务在跑」。
      reachable: status === "running" ? true : await ServerManager.probeLocalServer(),
    };
  },

  getServerStats: async () => {
    return getServerStats();
  },

  getUsageStats: async ({ rangeDays } = {}) => {
    return getUsageStats(rangeDays);
  },

  getLaunchCommand: async ({ path }) => {
    return ServerManager.getLaunchCommand(path);
  },

  clearServerLogs: async () => {
    ServerManager.clearLogs();
    return { ok: true };
  },

  listServedModels: async () => {
    return Served.getServedModels();
  },

  startServedModel: async ({ path, engine }) => {
    const result = await Served.startServedModel({ model: path, engine });
    return { ok: result.ok, error: result.error, model: result.model };
  },

  stopServedModel: async ({ id }) => {
    return Served.stopServedModel(id);
  },

  restartServedModel: async ({ id }) => {
    const result = await Served.restartServedModel(id);
    return { ok: result.ok, error: result.error, model: result.model };
  },

  setActiveServedModel: async ({ id }) => {
    return Served.setActiveServedId(id);
  },

  getServedModelLogs: async ({ id }) => {
    return { logs: Served.getServedModelLogs(id) };
  },

  clearServedModelLogs: async ({ id }) => {
    Served.clearServedModelLogs(id);
    return { ok: true };
  },

  getAppLogs: async (query) => {
    return { entries: readAppLogs(query ?? {}), path: appLogPath() };
  },

  getAppLogInfo: async () => {
    return appLogInfo();
  },

  clearAppLogs: async () => {
    const { cleared } = clearAppLog();
    return { ok: true, cleared };
  },

  writeAppLog: async ({ level, source, event, message, detail }) => {
    // source 由 webview 决定（默认 client）；主进程侧的类型联合只用于内部调用。
    logEvent({
      level: level ?? "error",
      source: (source ?? "client") as AppLogSource,
      event,
      message,
      detail,
    });
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

  listGatewayKeys: async () => ({ keys: GatewayKeys.listGatewayKeys() }),

  createGatewayKey: async ({ name }) => {
    const result = GatewayKeys.createGatewayKey(name);
    // Key 的增减同样影响隧道能否开启（"公网暴露前必须有 Key"），跟改设置走同一条对账。
    if (result.ok) void Tunnel.reconcileTunnel("gateway-keys");
    return result;
  },

  setGatewayKeyEnabled: async ({ id, enabled }) => {
    const result = GatewayKeys.setGatewayKeyEnabled(id, enabled);
    // 停用最后一把 Key = 回到"开放访问"，暴露中的隧道必须立刻下线。
    if (result.ok) void Tunnel.reconcileTunnel("gateway-keys");
    return result;
  },

  deleteGatewayKey: async ({ id }) => {
    const result = GatewayKeys.deleteGatewayKey(id);
    if (result.ok) void Tunnel.reconcileTunnel("gateway-keys");
    return result;
  },

  getTunnelStatus: async () => Tunnel.getTunnelInfo(),

  installCloudflared: async () =>
    loggedEngineCall("tunnel", "tunnel.install.failed", { trigger: "ui" }, async () => {
      const result = await Cloudflared.installCloudflared();
      // 装好/失败都会改变快照（binary 字段），推一次让界面上的按钮与状态同步。
      Tunnel.refreshTunnelStatus();
      return result;
    }),

  removeCloudflared: async () =>
    loggedEngineCall("tunnel", "tunnel.uninstall.failed", { trigger: "ui" }, () => {
      // 二进制还在被跑着的隧道占用（Windows 上甚至删不掉），先关隧道。
      if (Tunnel.getTunnelInfo().status !== "stopped") {
        return { ok: false, error: "请先关闭隧道，再移除 cloudflared" };
      }
      const result = Cloudflared.removeCloudflared();
      Tunnel.refreshTunnelStatus();
      return result;
    }),

  startTunnel: async () =>
    loggedEngineCall("tunnel", "tunnel.start.failed", { trigger: "ui" }, () =>
      Tunnel.startTunnel(),
    ),

  stopTunnel: async () => {
    await Tunnel.stopTunnel();
    return { ok: true };
  },

  restartTunnel: async () =>
    loggedEngineCall("tunnel", "tunnel.restart.failed", { trigger: "ui" }, () =>
      Tunnel.restartTunnel(),
    ),

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
      ? db
          .select(selectFields)
          .from(documents)
          .where(like(documents.path, `%${search}%`))
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
        firstLine
          .replace(/^[#>\s]+/, "")
          .replace(/[*`]/g, "")
          .trim()
          .slice(0, 60),
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
      allowedFileTypes: canChooseDirectory
        ? undefined
        : (params?.allowedFileTypes ?? "pdf,png,jpg,jpeg,webp,tiff,bmp,heic,heif"),
      canChooseFiles: params?.canChooseFiles ?? true,
      canChooseDirectory,
      allowsMultipleSelection: params?.allowsMultipleSelection ?? true,
    });
    const picked = (paths ?? []).filter((p) => p && p.length > 0);
    // 记下"用户亲手选的"：收绝对路径的接口（OCR 暂存 / 文档导入 / 修图参考图）
    // 只认这份白名单，见 `bun/dialog-paths.ts`。
    rememberDialogPickedPaths(picked);
    return { paths: picked };
  },

  addDocument: async ({ filePath }) => {
    const accepted = acceptedDialogPaths("ocr", "ocr.document.add", [filePath]);
    if (accepted.length === 0) return { id: -1, error: pathNotPickedMessage() };
    const file = Bun.file(accepted[0]!);
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
    // 体积先于解码判断：`Buffer.from(data, "base64")` 会把整份数据实体化，
    // 先解再判等于白付一次内存峰值。base64 的 4/3 膨胀在这里显式算进去。
    if (typeof data !== "string" || data.length === 0) {
      return { id: -1, error: "上传内容为空" };
    }
    if (data.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024) {
      logEvent({
        level: "warn",
        source: "ocr",
        event: "ocr.upload.rejected",
        message: `上传文件超过 ${formatUploadLimit()}`,
        detail: { name, base64Length: data.length },
      });
      return {
        id: -1,
        error: `文件太大（超过 ${formatUploadLimit()}），请改用「选择文件」按路径导入`,
      };
    }
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
      if (!filePath || !existsSync(filePath)) {
        // 「保存到下载目录」点了没反应时，用户只能反复点 —— 三种原因（限位拒绝 /
        // 文件已不在 / 文件名非法）此前都折叠成一个静默的 {ok:false}。
        logEvent({
          level: "warn",
          source: "image",
          event: "image.save_to_downloads.failed",
          message: !filePath ? "路径不在图片目录内，已拒绝" : "源文件不存在",
          detail: { url: url.slice(0, 300), ref, filename },
        });
        return { ok: false };
      }
      const name = safeBaseName(filename);
      if (!name) {
        logEvent({
          level: "warn",
          source: "image",
          event: "image.save_to_downloads.failed",
          message: "文件名非法（净化后为空）",
          detail: { url: url.slice(0, 300), filename },
        });
        return { ok: false };
      }
      const dest = path.join(Utils.paths.downloads, name);
      copyFileSync(filePath, dest);
      return { ok: true };
    } catch (e) {
      logEvent({
        level: "error",
        source: "image",
        event: "image.save_to_downloads.failed",
        message: e instanceof Error ? e.message : String(e),
        detail: { url: url.slice(0, 300), filename, error: e },
      });
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

  stopChatGeneration: async ({ conversationId }) => {
    const result = Chat.stopChatGeneration(conversationId);
    logEvent({
      level: "info",
      source: "chat",
      event: "chat.stop.requested",
      message: result.ok ? "已请求停止本轮生成" : "当前没有正在进行的生成",
      detail: { conversationId },
    });
    return result;
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

  selectChatModel: async ({ type, value, providerId }) => {
    return selectChatModel(type, value, providerId);
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
  followUpAgentMessage: async ({ conversationId, content, mode, workspace }) => {
    return Agent.followUpAgentMessage({ conversationId, content, mode, workspace });
  },
  listQueuedAgentMessages: async ({ conversationId }) => {
    return { messages: Agent.listQueuedMessages(conversationId) };
  },
  removeQueuedAgentMessage: async ({ conversationId, index }) => {
    return { messages: Agent.removeQueuedMessage(conversationId, index) };
  },

  regenerateAgentMessage: async ({ conversationId, messageId }) => {
    return Agent.regenerateAgentMessage(conversationId, messageId);
  },

  listAgentEvents: async ({ conversationId, afterId }) => {
    return { events: Agent.listAgentEvents(conversationId, afterId ?? 0) };
  },

  getAgentRunState: async ({ conversationId }) => {
    return Agent.getAgentRunState(conversationId);
  },

  listAgentTools: async (params) => {
    const mode = params?.mode as AgentMode | undefined;
    return { tools: await Agent.listAgentTools(mode) };
  },

  // ---- Agent 会话管理 ----
  listAgentSessions: async (params) => {
    return { sessions: Agent.listAgentSessions(params ?? undefined) };
  },
  searchAgentSessions: async ({ query, limit }) => {
    return { hits: Agent.searchAgentSessions(query, limit ?? 20) };
  },
  createAgentSession: async (params) => {
    return { session: Agent.createAgentSession(params ?? undefined) };
  },
  forkAgentSession: async ({ conversationId, messageId }) => {
    return Chat.forkConversation(conversationId, messageId);
  },
  renameAgentSession: async ({ conversationId, title }) => {
    return Chat.renameConversation(conversationId, title);
  },
  setAgentSessionPinned: async ({ conversationId, pinned }) => {
    const result = Chat.setConversationPinned(conversationId, pinned);
    return { ok: result.ok };
  },
  setAgentSessionArchived: async ({ conversationId, archived }) => {
    // 归档等价于"把这条会话收起来"：归档时顺手停掉正在跑的运行。
    if (archived) Agent.stopAgentRun(conversationId);
    return Chat.setConversationArchived(conversationId, archived);
  },
  setAgentSessionWorkspace: async ({ conversationId, workspace }) => {
    Agent.setConversationWorkspace(conversationId, workspace);
    return { ok: true, workspace: Agent.workspaceForConversation(conversationId) };
  },

  // ---- Agent 交互 ----
  listAgentInteractions: async ({ conversationId }) => {
    const all = Agent.listAgentInteractions(conversationId);
    return { permissions: all.permissions, questions: all.questions };
  },
  respondAgentPermission: async ({ id, reply }) => {
    return respondAgentPermissionRequest(id, reply);
  },
  respondAgentQuestion: async ({ id, answers }) => {
    return respondAgentQuestionRequest(id, answers);
  },
  listAgentTodos: async ({ conversationId }) => {
    return { todos: listAgentTodoItems(conversationId) };
  },
  getAgentGoal: async ({ conversationId }) => {
    return { goal: goalView(conversationId) };
  },
  setAgentGoalStatus: async ({ conversationId, status, outcome }) => {
    const goal = setAgentGoalStatus(conversationId, status, outcome ?? null);
    return { ok: goal !== null, goal: goalView(conversationId) };
  },
  getAgentPlan: async ({ conversationId }) => {
    const plan = getAgentPlan(conversationId);
    return { plan, approved: Boolean(plan?.approvedAt) };
  },
  approveAgentPlan: async ({ conversationId }) => {
    const result = approveAgentPlan(conversationId);
    if (!result.ok) return { ok: false, error: result.error };
    // 批准 = 立刻开始执行：切到 Agent 模式，把方案正文作为这一轮的开工说明。
    Agent.setAgentMode("agent");
    const content = [
      "按下面这份**已经批准**的方案执行。",
      "",
      "要求：严格按方案走，不要顺手扩大范围；方案里没写、但执行中发现必须改的地方，",
      "先在回复里说明再改。每完成一步，用方案里写的验证方式确认一次。",
      "",
      "--- 已批准的方案 ---",
      result.plan!.content,
    ].join("\n");
    void Agent.runAgentTurn({ conversationId, content }).catch(() => {
      // 执行轮失败会在会话里留下错误轨迹，界面能看到。
    });
    return { ok: true };
  },
  clearAgentPlan: async ({ conversationId }) => {
    clearAgentPlan(conversationId);
    return { ok: true };
  },
  listAgentArtifacts: async ({ conversationId }) => {
    return { artifacts: listAgentArtifactItems(conversationId) };
  },
  readAgentArtifact: async ({ artifactId }) => {
    const found = getAgentArtifact(artifactId);
    if (!found) throw new Error("Artifact not found");
    const content = readAgentArtifactFile(found.absPath);
    return {
      kind: content.kind,
      text: content.text,
      dataUrl: content.dataUrl,
      truncated: content.truncated,
      size: content.size,
      title: found.title,
    };
  },
  deleteAgentArtifact: async ({ artifactId }) => {
    deleteAgentArtifactRow(artifactId);
    return { ok: true };
  },
  openAgentArtifactExternal: async ({ artifactId }) => {
    if (!getAgentArtifact(artifactId)) throw new Error("Artifact not found");
    return { ok: Utils.openExternal(artifactPreviewUrl(artifactId)) };
  },
  revealAgentArtifact: async ({ artifactId }) => {
    const found = getAgentArtifact(artifactId);
    if (!found) throw new Error("Artifact not found");
    Utils.showItemInFolder(found.absPath);
    return { ok: true };
  },
  listWorkspaceFiles: async (params) => {
    const root = params?.workspace?.trim()
      ? path.resolve(params.workspace)
      : Agent.getAgentWorkspace();
    // 登记工作区根目录，预览地址里只出现 rootId（见 image-server 的 /workspace 路由）。
    return { root, rootId: registerWorkspaceRoot(root), nodes: workspaceTree(root) };
  },
  getWorkspaceChanges: async (params) => {
    const root = params?.workspace?.trim()
      ? path.resolve(params.workspace)
      : Agent.getAgentWorkspace();
    return getWorkspaceChanges(root);
  },
  getWorkspaceDiff: async ({ path: filePath, workspace }) => {
    const root = workspace?.trim() ? path.resolve(workspace) : Agent.getAgentWorkspace();
    return getWorkspaceDiff(root, filePath);
  },
  startTerminal: async (params) => {
    const cwd = params?.cwd?.trim() ? path.resolve(params.cwd) : Agent.getAgentWorkspace();
    return startTerminal({ cwd, cols: params?.cols, rows: params?.rows });
  },
  writeTerminal: async ({ id, data }) => ({ ok: writeTerminal(id, data) }),
  resizeTerminal: async ({ id, cols, rows }) => ({ ok: resizeTerminal(id, cols, rows) }),
  closeTerminal: async ({ id }) => {
    closeTerminal(id);
    return { ok: true };
  },
  getTerminal: async ({ id }) => getTerminalSession(id),
  readWorkspaceFile: async ({ path: filePath, workspace }) => {
    const root = workspace?.trim() ? path.resolve(workspace) : Agent.getAgentWorkspace();
    const content = readWorkspaceFileContent(root, filePath);
    return {
      kind: content.kind,
      text: content.text,
      dataUrl: content.dataUrl,
      size: content.size,
    };
  },

  // ---- Agent 权限 ----
  getAgentPermissions: async (params) => {
    const workspace = params?.workspace?.trim()
      ? path.resolve(params.workspace)
      : Agent.getAgentWorkspace();
    const conversationId = params?.conversationId ?? null;
    const rows = Permissions.listPermissionRows();
    return {
      mode: Permissions.approvalMode(),
      rules: Permissions.settingRules().map((rule) => ({ ...rule })),
      effective: Permissions.summarizeEffectivePermissions(conversationId, workspace),
      authorizedFolders: Permissions.getAuthorizedFolders(),
      permissionNames: Object.keys(Permissions.HUMAN_PERMISSION_LABELS),
      sessionGrants: rows
        .filter((row) => row.scope === "session")
        .map((row) => ({
          id: row.id,
          permission: row.permission,
          pattern: row.pattern,
          action: row.action,
          scopeRef: row.scopeRef,
        })),
    };
  },
  setAgentApprovalMode: async ({ mode }) => {
    updateSettings({ AGENT_APPROVAL_MODE: mode });
    return { ok: true };
  },
  setAgentPermissionRules: async ({ rules }) => {
    for (const rule of rules) {
      if (!rule?.permission?.trim() || !rule?.pattern?.trim()) {
        return { ok: false, error: "权限名与模式都不能为空" };
      }
    }
    updateSettings({ AGENT_PERMISSION_RULES: JSON.stringify(rules) });
    return { ok: true };
  },
  deleteAgentPermissionRule: async ({ id }) => {
    Permissions.deletePermissionRow(id);
    return { ok: true };
  },
  clearAgentPermissionGrants: async ({ conversationId, workspace, scope }) => {
    const ref =
      scope === "session"
        ? String(conversationId ?? 0)
        : path.resolve(workspace?.trim() ? workspace : Agent.getAgentWorkspace());
    Permissions.clearPermissions(scope, ref);
    return { ok: true };
  },
  setAgentAuthorizedFolders: async ({ folders }) => {
    Permissions.setAuthorizedFolders(folders);
    return { ok: true };
  },
  getAgentCapabilities: async () => ({
    visionTool: (getSetting("AGENT_VISION_TOOL") as "auto" | "on" | "off") || "auto",
    visionAvailable: chatModelSupportsImages(),
    modelName: getChatModelLabel(),
  }),
  setAgentCapabilities: async ({ visionTool }) => {
    if (visionTool) updateSettings({ AGENT_VISION_TOOL: visionTool });
    return { ok: true };
  },
  getAgentInstructions: async (params) => {
    const workspace = params?.workspace?.trim()
      ? path.resolve(params.workspace)
      : Agent.getAgentWorkspace();
    const loaded = loadProjectInstructions(workspace);
    return {
      enabled: projectDocEnabled(),
      maxBytes: projectDocMaxBytes(),
      workspace,
      truncated: loaded.truncated,
      files: loaded.files.map((file) => ({
        path: file.path,
        source: file.source,
        bytes: Buffer.byteLength(file.contents, "utf8"),
      })),
      userPath: userInstructionsPath(),
    };
  },
  setAgentInstructions: async ({ enabled, maxBytes }) => {
    const patch: Record<string, string> = {};
    if (enabled !== undefined) patch.AGENT_PROJECT_DOC = enabled ? "1" : "0";
    if (maxBytes !== undefined) {
      if (!Number.isFinite(maxBytes) || maxBytes < 512) return { ok: false };
      patch.AGENT_PROJECT_DOC_MAX_BYTES = String(Math.floor(maxBytes));
    }
    if (Object.keys(patch).length) updateSettings(patch);
    return { ok: true };
  },
  listAgentSnapshots: async (params) => {
    const workspace = Agent.getAgentWorkspace();
    const status = Snapshots.snapshotStatus(workspace);
    return {
      enabled: status.enabled,
      gitAvailable: status.gitAvailable,
      workspace,
      turns: status.turns,
      snapshots: Snapshots.listTurnSnapshots(params?.conversationId).map((snapshot) => ({
        id: snapshot.id,
        messageId: snapshot.messageId,
        label: snapshot.label,
        createdAt: snapshot.createdAt,
        files: snapshot.files,
      })),
      usage: status.usage,
      gcThresholds: status.gcThresholds,
    };
  },
  gcAgentSnapshots: async () => {
    const result = Snapshots.maybeGcSnapshotRepo(Agent.getAgentWorkspace(), { force: true });
    return {
      ok: result.ran,
      ran: result.ran,
      ...(result.reason ? { reason: result.reason } : {}),
      freedBytes: result.freedBytes,
      bytesBefore: result.bytesBefore,
      bytesAfter: result.bytesAfter,
    };
  },
  previewAgentSnapshot: async ({ id }) => Snapshots.previewSnapshotChanges(id),
  revertAgentSnapshot: async ({ id }) => {
    const result = Snapshots.revertToSnapshot(id);
    if (!result.ok) return { ok: false, error: result.error };
    // 回退是"工作区被改动"的大动作，通知中心留一条，用户离开界面也能看到发生了什么。
    Notifications.notify({
      kind: "info",
      title: "已回退到回合快照",
      body: `还原 ${result.restored.length} 个文件、删除 ${result.removed.length} 个`,
    });
    return { ok: true, restored: result.restored, removed: result.removed };
  },
  setAgentSnapshots: async ({ enabled }) => {
    updateSettings({ AGENT_SNAPSHOTS: enabled ? "1" : "0" });
    return { ok: true };
  },
  getAgentContextUsage: async ({ conversationId }) => Context.contextUsage(conversationId),
  compactAgentConversation: async ({ conversationId }) =>
    Agent.compactConversationNow(conversationId),
  getAgentSessionStatus: async ({ conversationId }) => {
    const status = Agent.describeAgentSession(conversationId);
    return {
      model: status.model,
      mode: status.mode,
      workspace: status.workspace,
      serverMode: status.serverMode,
      contextWindow: status.contextWindow,
      contextBudget: status.contextBudget,
      usedTokens: status.usedTokens,
      remainingTokens: status.remainingTokens,
      percent: status.percent,
      usageSource: status.usageSource,
      approvalMode: status.approvalMode,
      thinkingLevel: status.thinkingLevel,
      sandboxMode: status.sandboxMode,
      droppedSoFar: status.droppedSoFar,
    };
  },
  setAgentThinkingLevel: async ({ level }) => {
    Agent.setAgentThinkingLevel(level as Agent.AgentThinkingLevel);
    return { ok: true, level: Agent.getAgentThinkingLevel() };
  },
  getAgentSandbox: async () => Sandbox.sandboxStatus(),
  getAgentNotify: async () => ({
    command: NotifyHook.notifyCommand(),
    configured: NotifyHook.externalNotifyConfigured(),
  }),
  setAgentNotify: async ({ command }) => {
    updateSettings({ AGENT_NOTIFY_COMMAND: typeof command === "string" ? command.trim() : "" });
    return { ok: true };
  },
  getAgentHooks: async () => {
    const { hooks, errors } = Hooks.hooksStatus();
    return { raw: getSetting("AGENT_HOOKS"), hooks, errors, events: Hooks.HOOK_EVENTS };
  },
  setAgentHooks: async ({ raw }) => {
    const { errors } = Hooks.parseHookConfigs(raw);
    // 有写错的条目也照样存下来（用户正在编辑），但把错误回给界面逐条显示。
    updateSettings({ AGENT_HOOKS: typeof raw === "string" ? raw : "[]" });
    return errors.length ? { ok: false, errors } : { ok: true };
  },
  setAgentSandbox: async ({ mode, allowNetwork }) => {
    const patch: Record<string, string> = {};
    if (mode) {
      if (!Sandbox.isSandboxMode(mode)) return { ok: false };
      patch.AGENT_SANDBOX_MODE = mode;
    }
    if (allowNetwork !== undefined) patch.AGENT_SANDBOX_NETWORK = allowNetwork ? "1" : "0";
    if (Object.keys(patch).length) updateSettings(patch);
    return { ok: true };
  },

  // ---- 自动化 ----
  listAutomations: async () => ({ automations: Automations.listAutomations() }),
  createAutomation: async (params) => {
    const automation = Automations.createAutomation({
      name: params.name,
      instructions: params.instructions,
      workspace: path.resolve(params.workspace),
      scheduleKind: params.scheduleKind,
      schedule: params.schedule as never,
      timezone: params.timezone,
      mode: params.mode as AgentMode | undefined,
    });
    return { ok: true, automation };
  },
  updateAutomation: async ({ id, patch }) => {
    const automation = Automations.updateAutomation(id, {
      ...patch,
      workspace: patch.workspace ? path.resolve(patch.workspace) : undefined,
      schedule: patch.schedule as never,
      mode: patch.mode as AgentMode | undefined,
    });
    return automation ? { ok: true, automation } : { ok: false, error: "自动化任务不存在" };
  },
  deleteAutomation: async ({ id }) => {
    Automations.deleteAutomation(id);
    return { ok: true };
  },
  runAutomationNow: async ({ id }) => {
    return Automations.runAutomation(id, "manual");
  },
  listAutomationRuns: async (params) => {
    return { runs: Automations.listAutomationRuns(params?.automationId, params?.limit ?? 50) };
  },

  listNotifications: async (params) => {
    return {
      notifications: Notifications.listNotifications(params?.limit ?? 50),
      unread: Notifications.unreadNotificationCount(),
    };
  },
  markNotificationsRead: async (params) => {
    Notifications.markNotificationsRead(params?.ids);
    return { ok: true, unread: Notifications.unreadNotificationCount() };
  },
  clearNotifications: async () => {
    Notifications.clearNotifications();
    return { ok: true };
  },
  setViewState: async (params) => {
    ViewState.setViewState(params ?? {});
    return { ok: true };
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
      const filtered =
        params.status && params.status !== "all" && params.status !== "archived"
          ? hits.filter((h) => h.status === params.status)
          : hits;
      // 置顶筛选放到服务端：此前是「先取 limit 条再在客户端过滤置顶」，
      // 置顶条目一旦落在截断区间之外就会漏。
      return { memories: params.pinned ? filtered.filter((h) => h.pinned) : filtered };
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
    logEvent({ level: "debug", source: "client", event: "voicecall", message: line });
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
    // ref 也可能带前导 "/" 过来（与另存为 / 保存音频同一套写法）：先剥掉再解析，
    // 否则合法引用会被当成越界，被丢弃的附件就一直留在磁盘上。
    const rel = ref.trim().replace(/^\/+/, "");
    const resolved = path.resolve(base, rel);
    if (
      !rel ||
      !resolved.startsWith(base + path.sep) ||
      !resolved.includes(`${path.sep}chat${path.sep}`)
    ) {
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

  startModelDownload: async ({ repo, fileName, category, source, size, explicit }) => {
    return { task: downloadManager.start(repo, fileName, category, source, { size, explicit }) };
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

  setModelCategory: async ({ path, category }) => {
    return updateModelCategory(path, category);
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
    // 只回轻量元数据；结果页需要正文时用 getBenchmarkRecord 单条拉取。
    return listBenchmarkRecordSummaries();
  },
  getBenchmarkRecord: async ({ id }) => {
    return { record: getBenchmarkRecord(id) };
  },
  deleteBenchmarkRecord: async ({ id }) => {
    return deleteBenchmarkRecord(id);
  },
  clearBenchmarkRecords: async () => {
    return clearBenchmarkRecords();
  },
  exportBenchmarkReport: async ({ filename, html }) => {
    // 目标目录：系统「下载」（用户的直觉位置）。Electrobun 在极简环境下可能拿不到
    // 这个路径，退到数据目录的 exports/ —— 宁可换个地方，也不能让导出失败。
    const dir = Utils.paths.downloads || path.join(getUserDataDir(), "exports");
    const res = exportHtmlReport({ dir, filename, html });
    if (res.ok) {
      logEvent({
        source: "benchmark",
        event: "benchmark.report.exported",
        message: `基准报告已导出：${res.path}`,
        detail: { path: res.path, bytes: Buffer.byteLength(html, "utf8") },
      });
    } else {
      logEvent({
        level: "error",
        source: "benchmark",
        event: "benchmark.report.export_failed",
        message: `基准报告导出失败：${res.error}`,
        detail: { filename, dir, error: res.error },
      });
    }
    return res.ok ? { ok: true, path: res.path } : { ok: false, error: res.error };
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
    try {
      return { record: await Voice.runTTS(params) };
    } catch (e) {
      logEvent({
        level: "error",
        source: "tts",
        event: "tts.run.failed",
        message: e instanceof Error ? e.message : String(e),
        detail: { entry: "runTTS", params: { text: params?.text?.slice(0, 200) }, error: e },
      });
      throw e;
    }
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
    try {
      return { record: await Voice.runTTSEdge(params) };
    } catch (e) {
      logEvent({
        level: "error",
        source: "tts",
        event: "tts.edge.failed",
        message: e instanceof Error ? e.message : String(e),
        detail: { entry: "runTTSEdge", voice: params?.voice, error: e },
      });
      throw e;
    }
  },

  getTTSProviderConfig: async () => {
    const { providerId, base, model } = Voice.getTTSProviderConfig();
    return { config: { providerId, base, model } };
  },

  saveTTSProviderConfig: async ({ providerId, model }) => {
    const { voice } = Voice.saveTTSProviderConfig({ providerId, model });
    return { ok: true, voice };
  },

  // Local ASR
  listAsrModels: async () => {
    return { models: Asr.listAsrModels() };
  },

  getAsrStatus: async () => {
    return Asr.getAsrStatus();
  },

  downloadWhisperEngine: async () =>
    loggedEngineCall("asr", "asr.engine.download_failed", { engine: "whisper.cpp" }, () =>
      WhisperEngine.downloadWhisperEngine(),
    ),

  startAsr: async (params) =>
    loggedEngineCall("asr", "asr.server.start_failed", { model: params?.model ?? null }, () =>
      Asr.startAsr(params?.model),
    ),

  stopAsr: async () =>
    loggedEngineCall("asr", "asr.server.stop_failed", {}, async () => {
      await Asr.stopAsr();
      return { ok: true };
    }),

  transcribeAudio: async (params) => {
    try {
      return await Asr.transcribeAudio(params);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "error",
        source: "asr",
        event: "asr.transcribe.failed",
        message,
        detail: { audioRef: params?.audioRef, model: params?.model, error: e },
      });
      return {
        text: "",
        engine: "error",
        segments: [],
        hasSpeakers: false,
        error: message,
      };
    }
  },

  getASRProviderConfig: async () => {
    const { providerId, base, model } = Asr.getASRProviderConfig();
    return { config: { providerId, base, model } };
  },

  saveASRProviderConfig: async ({ providerId, model }) => {
    Asr.saveASRProviderConfig({ providerId, model });
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

  startAsrAudioCpp: async ({ modelId }) =>
    // 两个本地引擎互斥：切到 audio.cpp 前先停掉 whisper-server。
    loggedEngineCall("asr", "asr.audiocpp.start_failed", { modelId }, async () => {
      await Asr.stopAsr();
      return AsrAudioCpp.startAsrAudioCpp(modelId);
    }),

  stopAsrAudioCpp: async () =>
    loggedEngineCall("asr", "asr.audiocpp.stop_failed", {}, async () => {
      await AsrAudioCpp.stopAsrAudioCpp();
      return { ok: true };
    }),

  deleteAsrAudioCppModel: async ({ modelId }) =>
    loggedEngineCall("asr", "asr.audiocpp.delete_failed", { modelId }, () =>
      AsrAudioCpp.deleteAsrAudioCppModel(modelId),
    ),

  // Local TTS (audio.cpp)
  listTtsLocalModels: async () => {
    return { models: TTSLocal.listTtsLocalModels() };
  },

  getTtsLocalStatus: async () => {
    return TTSLocal.getTtsLocalStatus();
  },

  downloadTtsLocalEngine: async () =>
    loggedEngineCall("tts", "tts.local.engine_download_failed", {}, () =>
      TTSLocal.downloadTtsLocalEngine(),
    ),

  startTtsLocal: async (params) => {
    if (!params?.modelId) {
      logEvent({
        level: "warn",
        source: "tts",
        event: "tts.local.start_failed",
        message: "缺少模型参数",
      });
      return { ok: false, error: "缺少模型参数" };
    }
    return loggedEngineCall("tts", "tts.local.start_failed", { modelId: params.modelId }, () =>
      TTSLocal.startTtsLocal(params.modelId),
    );
  },

  stopTtsLocal: async () => {
    await TTSLocal.stopTtsLocal();
    return { ok: true };
  },

  deleteTtsLocalModel: async ({ modelId }) => {
    return TTSLocal.deleteTtsLocalModel(modelId);
  },

  runTTSLocal: async (params) => {
    try {
      return { record: await TTSLocal.runTTSLocal(params) };
    } catch (e) {
      logEvent({
        level: "error",
        source: "tts",
        event: "tts.local.failed",
        message: e instanceof Error ? e.message : String(e),
        detail: {
          entry: "runTTSLocal",
          params: { text: params?.text?.slice(0, 200), model: params?.model },
          error: e,
        },
      });
      throw e;
    }
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
      const r = await Ocr.installTesseractEngine();
      if (!r.ok) {
        logEvent({
          level: "error",
          source: "ocr",
          event: "ocr.tesseract.install_failed",
          message: r.error ?? "tesseract 安装失败",
          detail: {},
        });
      }
      return r;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "error",
        source: "ocr",
        event: "ocr.tesseract.install_failed",
        message,
        detail: { error: e },
      });
      return { ok: false, error: message };
    }
  },

  deleteOcrModel: async ({ modelId }) => {
    return Ocr.deleteOcrModel(modelId);
  },

  stageOcrImage: async ({ paths }) => {
    return { files: await Ocr.stageOcrImage(acceptedDialogPaths("ocr", "ocr.stage", paths)) };
  },

  runOcr: async (params) => {
    try {
      return { result: await Ocr.runOcr(params) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "error",
        source: "ocr",
        event: "ocr.run.failed",
        message,
        detail: { engine: "tesseract", imageRef: params?.imageRef, psm: params?.psm, error: e },
      });
      return { error: message };
    }
  },

  runOcrVlm: async (params) => {
    try {
      return { result: await Ocr.runOcrVlm(params) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "error",
        source: "ocr",
        event: "ocr.vlm.failed",
        message,
        detail: { engine: "vlm", imageRef: params?.imageRef, error: e },
      });
      return { error: message };
    }
  },

  getOcrProviderConfig: async () => {
    return { config: Ocr.getOcrProviderConfig() };
  },

  saveOcrProviderConfig: async ({ providerId, model }) => {
    Ocr.saveOcrProviderConfig({ providerId, model });
    return { ok: true };
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

  downloadPpOcrEngine: async () =>
    loggedThrow("ocr", "ocr.ppocr.unexpected", { op: "downloadPpOcrEngine" }, async () => {
      try {
        return await PpOcr.downloadPpOcrEngine();
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),

  startPpOcr: async ({ modelSize }) =>
    loggedThrow("ocr", "ocr.ppocr.unexpected", { op: "startPpOcr", modelSize }, async () => {
      try {
        return await PpOcr.startPpOcr(modelSize);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),

  stopPpOcr: async () => {
    try {
      await PpOcr.stopPpOcr();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  downloadPpOcrModels: async ({ modelSize }) =>
    loggedThrow(
      "ocr",
      "ocr.ppocr.unexpected",
      { op: "downloadPpOcrModels", modelSize },
      async () => {
        try {
          return await PpOcr.downloadPpOcrModels(modelSize);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    ),

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
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "error",
        source: "ocr",
        event: "ocr.ppocr.failed",
        message,
        detail: {
          engine: "paddleocr",
          imageRef: params?.imageRef,
          modelSize: params?.modelSize,
          error: e,
        },
      });
      return { error: message };
    }
  },

  // 本地抠图：模型清单 / 下载 / 暂存源图 / 跑一次
  bgRemoveModels: async () => {
    return {
      models: BgRemove.listBgModels(),
      defaultModel: BgRemove.DEFAULT_BG_MODEL,
      ready: BgRemove.anyReadyModel(),
    };
  },

  bgRemoveDownloadModel: async ({ model }) => {
    return BgRemove.downloadBgModel(model, {
      onProgress: (p) => bgRemoveProgress.push(p),
    });
  },

  bgRemoveStageSource: async ({ path }) => {
    try {
      const staged = await ImageGen.stageEditImage(
        acceptedDialogPaths("image", "bgremove.stage", [path]),
      );
      const first = staged[0];
      if (!first) {
        return { error: "图片无法读取：仅支持 PNG / JPG / WebP" };
      }
      return { ref: first.ref, url: first.url };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "warn",
        source: "image",
        event: "bgremove.stage.failed",
        message: `抠图源图暂存失败：${message}`,
        detail: { error: message },
      });
      return { error: message };
    }
  },

  bgRemoveRun: async ({ ref, model, refine, maxSize }) => {
    try {
      const abs = resolveImageRef(ref);
      if (!abs) return { error: `找不到图片：${ref}` };
      const res = await BgRemove.removeBackground({
        imagePath: abs,
        model,
        refine,
        maxSize,
      });
      if (!res.ok) return { error: res.error };
      const r = res.result;
      return {
        cutout: { ref: r.cutoutRef, url: chatImageUrl(r.cutoutRef) },
        mask: { ref: r.maskRef, url: chatImageUrl(r.maskRef) },
        width: r.width,
        height: r.height,
        model: r.model,
        inferenceMs: r.inferenceMs,
        totalMs: r.totalMs,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "error",
        source: "image",
        event: "bgremove.run.failed",
        message,
        detail: { ref, model, error: e },
      });
      return { error: message };
    }
  },

  // AI 生图
  stageEditImage: async ({ paths }) => {
    const files = await ImageGen.stageEditImage(
      acceptedDialogPaths("image", "image.edit.stage", paths),
    );
    return { files };
  },

  generateImage: async (params) => {
    return ImageGen.generateImage(params);
  },

  listImageRecords: async (params) => {
    try {
      return { records: ImageGen.listImageRecords(params?.limit) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 空列表 + 一句静默的 catch，界面看起来就是「一张图都没生过」——
      // 必须留一条日志，否则「历史记录突然空了」无从查起。
      logEvent({
        level: "error",
        source: "image",
        event: "image.records.list_failed",
        message,
        detail: { limit: params?.limit ?? null, error: e },
      });
      return { records: [], error: message };
    }
  },

  deleteImageRecord: async ({ id }) => {
    const r = ImageGen.deleteImageRecord(id);
    if (!r.ok) {
      logEvent({
        level: "warn",
        source: "image",
        event: "image.record.delete_failed",
        message: `记录不存在：${id}`,
        detail: { id },
      });
      return { ok: false, error: `记录不存在（id ${id}）` };
    }
    return { ok: true };
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
      // 凭据只从厂商行取（`listImageGenModelIds` 内部解析）：页面此前传 `apiKey: ""`
      // 会把「未传」变成「空密钥」，需要鉴权的上游列模型必然 401。
      const models = await ImageGen.listImageGenModelIds(params?.backend, params?.base);
      // 生图后端（尤其 OpenAI 兼容的聚合服务）会把对话 / 语音模型也列出来，
      // 只留生图模型；一个都认不出时保留全量并标记 relaxed。
      const picked = filterModelIds(models, MODEL_CATEGORY_SETS.image, { relax: true });
      return { models: picked.ids, relaxed: picked.relaxed };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "warn",
        source: "image",
        event: "image.models.list_failed",
        message,
        detail: { backend: params?.backend ?? null, error: e },
      });
      return { models: [], error: message };
    }
  },

  // Agent 生图弹窗（media-setup）：用户点确认 / 取消后回传，弹窗里也可扫描候选模型
  resolveMediaSetup: async (params) => {
    return { ok: MediaSetup.resolveMediaSetup(params.id, params) };
  },

  scanMediaSetupCandidates: async (params) => {
    const r = await MediaSetup.scanSetupCandidates(params ?? {});
    if (r.error) {
      logEvent({
        level: "warn",
        source: "image",
        event: "image.setup.scan_failed",
        message: r.error,
        detail: { backend: params?.backend ?? null, kind: params?.kind ?? "image" },
      });
    }
    return r;
  },

  // AI 视频生成
  submitVideoGeneration: async (params) => {
    return VideoGen.submitVideoGeneration(params);
  },

  pollVideoRecords: async ({ ids }) => {
    try {
      return { records: await VideoGen.pollVideoRecords(ids) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "error",
        source: "video",
        event: "video.poll.records_failed",
        message,
        detail: { ids: ids.slice(0, 20), error: e },
      });
      return { records: [], error: message };
    }
  },

  listVideoRecords: async (params) => {
    try {
      return { records: VideoGen.listVideoRecords(params?.limit) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 空列表 + 静默 catch = 界面显示"还没有生成记录"，而库里其实有 —— 必须留痕。
      logEvent({
        level: "error",
        source: "video",
        event: "video.records.list_failed",
        message,
        detail: { limit: params?.limit ?? null, error: e },
      });
      return { records: [], error: message };
    }
  },

  deleteVideoRecord: async ({ id }) => {
    const r = VideoGen.deleteVideoRecord(id);
    if (!r.ok) {
      logEvent({
        level: "warn",
        source: "video",
        event: "video.record.delete_failed",
        message: `记录不存在：${id}`,
        detail: { id },
      });
      return { ok: false, error: `记录不存在（id ${id}）` };
    }
    return { ok: true };
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
      // 云端：模型清单来自选中的服务商（生图 / 视频分类在设置页里维护）。
      const provider = CloudProviders.getCloudProviderInfo(params?.providerId ?? cfg.providerId);
      const models =
        provider?.models.filter((m) => modelTypeOf(m) === "video").map((m) => m.id) ?? [];
      return { models, checkpoints: [], clips: [], vaes: [] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "warn",
        source: "video",
        event: "video.models.list_failed",
        message,
        detail: { backend: params?.backend ?? null, error: e },
      });
      return {
        models: [],
        checkpoints: [],
        clips: [],
        vaes: [],
        error: message,
      };
    }
  },

  // AI 音乐生成
  submitMusicGeneration: async (params) => {
    return MusicGen.submitMusicGeneration(params);
  },

  pollMusicRecords: async ({ ids }) => {
    try {
      return { records: await MusicGen.pollMusicRecords(ids) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "error",
        source: "music",
        event: "music.poll.records_failed",
        message,
        detail: { ids: ids.slice(0, 20), error: e },
      });
      return { records: [], error: message };
    }
  },

  listMusicRecords: async (params) => {
    try {
      return { records: MusicGen.listMusicRecords(params?.limit) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 空列表 + 静默 catch = 界面显示"还没有生成记录"，而库里其实有 —— 必须留痕。
      logEvent({
        level: "error",
        source: "music",
        event: "music.records.list_failed",
        message,
        detail: { limit: params?.limit ?? null, error: e },
      });
      return { records: [], error: message };
    }
  },

  deleteMusicRecord: async ({ id }) => {
    const r = MusicGen.deleteMusicRecord(id);
    if (!r.ok) {
      logEvent({
        level: "warn",
        source: "music",
        event: "music.record.delete_failed",
        message: `记录不存在：${id}`,
        detail: { id },
      });
      return { ok: false, error: `记录不存在（id ${id}）` };
    }
    return { ok: true };
  },

  getMusicGenConfig: async () => {
    return { config: MusicGen.getMusicGenConfig() };
  },

  saveMusicGenConfig: async (config) => {
    MusicGen.saveMusicGenConfig(config);
    return { ok: true };
  },

  listMusicGenModels: async (params) => {
    try {
      return MusicGen.listMusicGenModels(params);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "warn",
        source: "music",
        event: "music.models.list_failed",
        message,
        detail: { backend: params?.backend ?? null, providerId: params?.providerId ?? null, error: e },
      });
      return { models: [], error: message };
    }
  },

  // MLX 本地生图引擎（mflux）
  getMlxGenStatus: async () => {
    try {
      return await MlxGen.getMlxGenStatus();
    } catch (e) {
      // 探测失败按"未安装"渲染，但别把原因也吞掉 —— 否则界面只说一句"未安装"，
      // 用户反复点「下载引擎」也修不好。
      logEvent({
        level: "warn",
        source: "image",
        event: "image.mlx.status_failed",
        message: e instanceof Error ? e.message : String(e),
        detail: { error: e },
      });
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
    return Skills.setCustomToolPath(tool, path);
  },
  skillsAddCustomTool: async (def) => {
    return Skills.addCustomTool(def);
  },
  skillsRemoveCustomTool: async ({ key }) => {
    Skills.removeCustomTool(key);
    return { ok: true };
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
  skillsInstallFromMarket: async ({ source, skillId }) =>
    loggedEngineCall("skills", "skills.market.install_failed", { source, skillId }, () =>
      Skills.installFromSkillssh(source, skillId),
    ),
  skillsCancelInstall: async ({ ref }) => {
    return { ok: Skills.cancelInstall(ref) };
  },
  skillsGitPreview: async ({ url }) =>
    loggedThrow("skills", "skills.git.preview_failed", { url }, () => Skills.gitPreview(url)),
  skillsGitConfirm: async ({ url, tempDir, items }) =>
    loggedEngineCall("skills", "skills.git.confirm_failed", { url, count: items.length }, () =>
      Skills.gitConfirm(url, tempDir, items),
    ),
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
    const statuses =
      ids && ids.length > 0
        ? await Promise.all(ids.map((id) => Skills.checkSkillUpdate(id)))
        : await Skills.checkAllSkillUpdates();
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
  // 技能 Git 备份：这一组按约定返回 `{ok:false,error}` 而不抛错（见 loggedEngineCall），
  // 所以"推送失败只弹一下就没了"的情况必须在这一层留痕。
  skillsBackupInit: async () =>
    loggedEngineCall("skills", "skills.backup.init_failed", {}, () => Skills.backupInit()),
  skillsBackupSetRemote: async ({ url, pat }) =>
    loggedEngineCall("skills", "skills.backup.remote_failed", { url }, () =>
      Skills.setBackupRemote(url, pat),
    ),
  skillsBackupCommit: async ({ message }) =>
    loggedEngineCall("skills", "skills.backup.commit_failed", { message }, () =>
      Skills.backupCommit(message),
    ),
  skillsBackupPush: async () =>
    loggedEngineCall("skills", "skills.backup.push_failed", {}, () => Skills.backupPush()),
  skillsBackupPull: async () =>
    loggedEngineCall("skills", "skills.backup.pull_failed", {}, () => Skills.backupPull()),
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
    // 只允许打开中央库里的技能目录：skillId 来自 webview，不许拿 `../..`
    // 去打开中央库外面的目录；也不再接受任意绝对路径（前端只有这一个入口）。
    const dir = params.skillId
      ? Skills.centralSkillDir(params.skillId)
      : Skills.getCentralRepoDir();
    if (!dir) return { ok: false };
    try {
      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer"
            : "xdg-open";
      Bun.spawn([opener, dir]);
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
        embeddingProviderId: params.embeddingProviderId,
        rerankProviderId: params.rerankProviderId,
        embedImage: params.embedImage,
        embedAudio: params.embedAudio,
        embedVideo: params.embedVideo,
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
    return Knowledge.listDocs(kbId);
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
    return Knowledge.listChunks(docId);
  },
  kbEmbedMissing: async ({ kbId }) => {
    return Knowledge.embedMissing(kbId);
  },
  kbRecall: async ({ kbIds, query, topK }) => {
    return Knowledge.recall(kbIds ?? [], query ?? "", topK);
  },
  kbTestEmbedding: async ({ base, apiKey, providerId, model }) => {
    return Knowledge.testEmbedding({ base, apiKey, providerId, model });
  },
  kbDefaultEmbeddingProbe: async () => {
    return Knowledge.probeDefaultEmbedding();
  },
  kbEmbeddingModels: async (params) => {
    return Knowledge.suggestEmbeddingModels(params ?? undefined);
  },
  kbTestRerank: async ({ base, apiKey, providerId, model }) => {
    return Knowledge.testRerank({ base, apiKey, providerId, model });
  },
  kbRerankModels: async (params) => {
    return Knowledge.suggestRerankModels(params ?? undefined);
  },

  kbChunkMedia: async ({ chunkId, size }) => {
    return chunkMediaForRpc(chunkId, size);
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
      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer"
            : "xdg-open";
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

  backupRestore: async (params: BackupRestoreRequest) =>
    Backup.startRestoreBackup({ ...params, ctx: backupCtx() }),

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

  // 小应用：宿主代 sandbox iframe 执行的动作（见 shared/miniapps.ts）。
  getMiniAppCapabilities: async () => ({
    capabilities: MiniApps.getMiniAppCapabilities(),
  }),

  miniappComplete: async (params) => MiniApps.completeText(params),

  miniappSaveFile: async ({ name, dataUrl }) =>
    MiniApps.saveMiniAppFile({
      name,
      dataUrl,
      // 目录只能由主进程决定：小应用给文件名与内容，落点永远在系统下载目录。
      directory: Utils.paths.downloads || path.join(getUserDataDir(), "exports"),
    }),

  miniappReadFile: async ({ path: filePath }) => {
    // 路径直接来自 sandbox iframe：只放行用户刚在系统对话框里亲手选过的那些，
    // 否则这就是一个"读磁盘任意文件"的接口（判据与 OCR / 文档导入同一份）。
    const accepted = acceptedDialogPaths("miniapp", "miniapp.read.rejected", [filePath]);
    if (accepted.length === 0) return { ok: false, error: "请先在文件选择框里选择文件" };
    return MiniApps.readPickedFileAsDataUrl(accepted[0]!);
  },

  miniappLog: async (params) => MiniApps.logFromMiniApp(params),

  // 小应用「笔记」：正文进主库、附件进数据目录（见 bun/notes.ts）。
  // 列表把统计一起带回去，省掉小应用自己数一遍（也让它没有"该信哪个数"的分歧）。
  miniappNotesList: async () => {
    const notes = await Notes.listNotes();
    return {
      notes,
      stats: Notes.noteStats(notes),
      agentAccess: Memory.noteAgentAccessEnabled(),
    };
  },

  miniappNotesSetAgentAccess: async ({ enabled }) => {
    // 只写设置：**不回头补写历史笔记的记忆**（用户刚关掉它，说明不想让 Agent 看到这些笔记；
    // 打开时也不批量补，避免一次点击往记忆库里灌进几百条）。之后的每次保存各自生效，
    // 三个 note_* 工具则从下一次组装工具集开始生效（agent.ts 里读同一把开关）。
    updateSettings({ NOTES_AGENT_ACCESS: enabled ? "1" : "0" });
    return { ok: true, enabled };
  },

  miniappNotesSave: async (params) => Notes.saveNote(params),

  miniappNotesDelete: async ({ id }) => Notes.removeNote(id),

  miniappNotesAttach: async ({ dataUrl, name }) => Notes.attachNoteImage({ dataUrl, name }),
};

export const appRPC = BrowserView.defineRPC<AppRPC>({
  maxRequestTime: 900_000, // 15 minutes (large TTS model downloads)
  handlers: { requests: rpcRequests, messages: {} },
});

export { rpcRequests };

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
    win.webview.rpc?.send.servedModelsChanged(Served.getServedModels());
  } catch {}
  try {
    win.webview.rpc?.send.gatewayStatusChanged({ status: Gateway.getGatewayStatus().status });
  } catch {}
  try {
    win.webview.rpc?.send.tunnelStatusChanged(Tunnel.getTunnelInfo());
  } catch {}
  try {
    win.webview.rpc?.send.mediaStatusChanged({ status: getMediaServerStatus() });
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
  // 已启动模型注册表：列表快照 + 每个实例的日志增量（控制台 / 选择器用）。
  Served.onServedModelsChange((snapshot) => {
    try {
      win.webview.rpc?.send.servedModelsChanged(snapshot);
    } catch {}
  });
  Served.onServedModelLog((id, text) => {
    try {
      win.webview.rpc?.send.servedModelLog({ id, text });
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
  // 助手行一建好就推：界面立刻画出这条消息并开始走秒（见 chatMessageStarted 的说明）。
  Chat.onChatMessageStarted((payload) => {
    try {
      win.webview.rpc?.send.chatMessageStarted(payload);
    } catch {}
  });
  Agent.onAgentEvent((payload) => {
    try {
      win.webview.rpc?.send.agentEvent(payload);
    } catch {}
  });
  // 运行态（开跑 / 收尾）：界面据此显示"还在干活"的进度行与停止按钮，
  // 刷新窗口、切会话、后台起的运行都靠这一条补齐状态。
  Agent.onAgentRunState((payload) => {
    try {
      win.webview.rpc?.send.agentRunState(payload);
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
  // Agent 交互：工具授权弹窗、ask_user 提问、待办清单、产出物登记。
  Agent.onAgentPermissionRequest((payload) => {
    try {
      win.webview.rpc?.send.agentPermissionRequest(payload);
    } catch {}
  });
  Agent.onAgentPermissionSettled((payload) => {
    try {
      win.webview.rpc?.send.agentPermissionSettled(payload);
    } catch {}
  });
  Agent.onAgentQuestion((payload) => {
    try {
      win.webview.rpc?.send.agentQuestion(payload);
    } catch {}
  });
  Agent.onAgentQuestionSettled((payload) => {
    try {
      win.webview.rpc?.send.agentQuestionSettled(payload);
    } catch {}
  });
  Agent.onAgentTodos((payload) => {
    try {
      win.webview.rpc?.send.agentTodos(payload);
    } catch {}
  });
  Agent.onAgentGoalChanged((payload) => {
    try {
      // 负载里补上续跑上限：界面要显示 "K/上限"，不该让前端自己去猜这个数。
      win.webview.rpc?.send.agentGoalChanged({
        conversationId: payload.conversationId,
        goal: payload.goal ? { ...payload.goal, maxContinuations: maxGoalContinuations() } : null,
      });
    } catch {}
  });
  Agent.onAgentPlanChanged((payload) => {
    try {
      win.webview.rpc?.send.agentPlanChanged(payload);
    } catch {}
  });
  Agent.onAgentArtifact((payload) => {
    try {
      win.webview.rpc?.send.agentArtifact(payload);
    } catch {}
  });
  // 侧边面板的终端：输出与退出事件按会话 id 推给界面。
  onTerminalData((payload) => {
    try {
      win.webview.rpc?.send.terminalData(payload);
    } catch {}
  });
  onTerminalExit((payload) => {
    try {
      win.webview.rpc?.send.terminalExit(payload);
    } catch {}
  });
  // 自动化：计划 / 运行记录变化 → 前端刷新。
  Automations.onAutomationsChanged(() => {
    try {
      win.webview.rpc?.send.automationsChanged({});
    } catch {}
  });
  // 通知中心：后台发生的事推给界面（铃铛未读数）。
  Notifications.onNotification(({ notification }) => {
    try {
      win.webview.rpc?.send.notificationAdded(notification);
    } catch {}
  });
  // 定时巡检：应用起来就按计划跑自动化任务（30 秒一次）。
  Automations.startAutomationScheduler();
  // 知识库：摄取进度 / 删除 / 向量补齐 → 前端刷新列表。
  Knowledge.onKnowledgeChanged((payload) => {
    try {
      win.webview.rpc?.send.knowledgeChanged(payload);
    } catch {}
  });
  // 实时语音通话：把后端会话事件按类型路由到对应的一元消息通道。
  // 增量字幕（partial）在说话时会高频触发，每个事件都重渲染 webview，按 60ms 合并；
  // 定稿 / 阶段切换 / 打断 / 报错这些终态事件前必须 flush，否则最后一段字幕会丢。
  const throttlePartial = throttleLatest<[number, string]>((conversationId, text) => {
    win.webview.rpc?.send.voicecallPartial({ conversationId, text });
  }, 60);
  // TTS 音频分片（audio）刻意不节流：它是**追加**到播放队列的，不是可覆盖的中间态，
  // 合并会直接丢音频导致断句（这与进度条的"只保留最后一个值"语义相反）。
  VoiceCall.onVoiceCallEvent((msg: VoiceCallOutgoing) => {
    try {
      switch (msg.type) {
        case "partial":
          throttlePartial.push(msg.conversationId, msg.text);
          break;
        case "utterance":
          throttlePartial.flush();
          win.webview.rpc?.send.voicecallUtterance({
            conversationId: msg.conversationId,
            messageId: msg.messageId,
            text: msg.text,
          });
          break;
        case "state":
          throttlePartial.flush();
          win.webview.rpc?.send.voicecallState({
            conversationId: msg.conversationId,
            phase: msg.phase,
          });
          break;
        case "audio":
          win.webview.rpc?.send.voicecallAudio({
            conversationId: msg.conversationId,
            wavBase64: msg.wavBase64,
            format: msg.format,
          });
          break;
        case "audioStop":
          throttlePartial.flush();
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
          throttlePartial.flush();
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

/** 内网穿透：状态（含公网地址）逐次推送，cloudflared 安装日志按 80ms 合批。 */
export function initTunnelBroadcast(win: BrowserWindowWithRPC) {
  Tunnel.onTunnelStatusChange((info) => {
    try {
      win.webview.rpc?.send.tunnelStatusChanged(info);
    } catch {}
  });
  const logs = throttleBatch((lines) => {
    try {
      win.webview.rpc?.send.tunnelInstallLog({ lines });
    } catch {}
  });
  Cloudflared.onCloudflaredInstallLog((text) => logs.push(text));
}

// ---------------------------------------------------------------------------
// 网页端（/chat、/agent）：同一套界面 + 同一张处理器表，白名单收口
// ---------------------------------------------------------------------------

/**
 * 网页端可调用的方法白名单。
 *
 * 为什么是白名单而不是黑名单：这张表是**唯一的暴露面**，默认拒绝才能在以后新增
 * RPC 时不会悄悄把权限也一并送出去。表里的方法就是"对话 + Agent 两个页面"实际用到的
 * 那些（`grep rpcClient.` 出来的全集），几类刻意排除：
 *   - 会在**宿主机器**上弹窗 / 落盘 / 装东西的：openFileDialog、openDirectoryDialog、
 *     saveImageToDownloads、downloadMlxGenEngine、downloadMlxModel、skills 安装；
 *   - 会改安全策略的：setAgentApprovalMode（把审批模式改成 auto 等于关掉全部授权）；
 *   - 网页端用不到的宿主文件：stageChatFiles / stageChatImages / discardChatImage
 *     （浏览器的附件要走上传通道，本期没做）；
 *   - 整个控制台 / 终端 / 浏览器 / 评审面板：那些面板远程不渲染。
 *
 * `updateSettings` 单独处理：只放行这几个键（它自己就能改所有设置，包括 Key 与隧道）。
 */
const REMOTE_METHODS = new Set<string>([
  // 通用
  "getSettings",
  "writeAppLog",
  // 模型
  "listChatModels",
  "selectChatModel",
  "listInstalledModels",
  "listServedModels",
  "getServedModelLogs",
  "clearServedModelLogs",
  "getMlxGenStatus",
  "getDownloadedMlxModels",
  "startServedModel",
  "stopServedModel",
  "restartServedModel",
  "setActiveServedModel",
  "getServerStatus",
  // 对话
  "createConversation",
  "listConversations",
  "getConversation",
  "deleteConversation",
  "renameConversation",
  "togglePinConversation",
  "setConversationArchived",
  "forkConversation",
  "sendChatMessage",
  "stopChatGeneration",
  "regenerateMessage",
  "deleteMessage",
  "translateMessage",
  "readChatImage",
  // Agent
  "sendAgentMessage",
  "stopAgentRun",
  "followUpAgentMessage",
  "listQueuedAgentMessages",
  "removeQueuedAgentMessage",
  "regenerateAgentMessage",
  "listAgentSessions",
  "createAgentSession",
  "renameAgentSession",
  "deleteAgentSession",
  "setAgentSessionPinned",
  "setAgentSessionArchived",
  "setAgentSessionWorkspace",
  "forkAgentSession",
  "searchAgentSessions",
  "getAgentSessionStatus",
  "getAgentRunState",
  "getAgentWorkspace",
  "getAgentContextUsage",
  "getAgentPermissions",
  "respondAgentPermission",
  "respondAgentQuestion",
  "listAgentInteractions",
  "listAgentTodos",
  "listAgentEvents",
  "listAgentTools",
  "listAgentArtifacts",
  "readAgentArtifact",
  "getAgentPlan",
  "approveAgentPlan",
  "clearAgentPlan",
  "getAgentGoal",
  "compactAgentConversation",
  "listAgentSnapshots",
  "previewAgentSnapshot",
  "revertAgentSnapshot",
  "listWorkspaceFiles",
  "readWorkspaceFile",
  "setAgentThinkingLevel",
  "listNotifications",
  "markNotificationsRead",
  "clearNotifications",
  // 对话输入框里的知识库选择器（只读列出知识库，供挂载到这一轮检索）
  "kbList",
  // 本地生图/语音的"需要准备"弹窗（对话里挂媒体能力时会弹）
  "scanMediaSetupCandidates",
  "resolveMediaSetup",
]);

/** 网页端允许改的设置键：够切模式 / 工作区 / 思考等级，其余一律拒绝。 */
const REMOTE_SETTINGS_KEYS = new Set(["AGENT_MODE", "AGENT_WORKSPACE", "AGENT_THINKING_LEVEL"]);

/** 网页端调用被拒的方法名（同时写 app.log，便于排查"点了没反应"）。 */
const deniedRemoteMethods = new Set<string>();

/**
 * 网页端可读的设置里必须抹掉的字段。
 *
 * 桌面端读全量设置是因为它要渲染设置页；网页端只渲染对话与 Agent，用不到任何密钥，
 * 而它拿到的是"任何持 Key 的人"——包括被分享出去的那把。凭据一律清空，
 * 界面照常工作（这些值大多只用于"是否已配置"的判断）。
 */
const REMOTE_SECRET_KEY = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)$|_API_KEY$|_TOKEN$/i;

function scrubSettingsForRemote(settings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    out[key] = REMOTE_SECRET_KEY.test(key) ? "" : value;
  }
  return out;
}

export type RemoteDispatchResult = { ok: boolean; payload?: unknown; error?: string };

/**
 * 按同一张处理器表分发一个来自浏览器的 RPC 请求。
 *
 * 与 `appRPC` 里的实现是**同一批函数**：网页端与桌面端的行为不可能各自漂移。
 */
export async function dispatchRemoteRpc(
  method: string,
  params: unknown,
): Promise<RemoteDispatchResult> {
  try {
    if (method === "updateSettings") {
      const settings = (params as { settings?: Record<string, string> } | null)?.settings ?? {};
      const keys = Object.keys(settings);
      const blocked = keys.filter((key) => !REMOTE_SETTINGS_KEYS.has(key));
      if (blocked.length) {
        logEvent({
          level: "warn",
          source: "client",
          event: "web.rpc.denied",
          message: `网页端尝试修改受限设置：${blocked.join(", ")}`,
          detail: { method, keys: blocked },
        });
        return { ok: false, error: `网页端不允许修改设置项：${blocked.join(", ")}` };
      }
    } else if (!REMOTE_METHODS.has(method)) {
      if (!deniedRemoteMethods.has(method)) {
        deniedRemoteMethods.add(method);
        logEvent({
          level: "warn",
          source: "client",
          event: "web.rpc.denied",
          message: `网页端调用了未开放的方法：${method}`,
          detail: { method },
        });
      }
      return { ok: false, error: `网页端未开放该方法：${method}` };
    }

    const handler = (rpcRequests as Record<string, (p: unknown) => unknown>)[method];
    if (typeof handler !== "function") return { ok: false, error: `未实现的方法：${method}` };
    const payload = await handler(params);
    // getSettings 会带出全部设置（含云端凭据）：网页端只留非敏感项。
    if (method === "getSettings" && payload && typeof payload === "object") {
      const typed = payload as { settings?: Record<string, string> };
      if (typed.settings) {
        return { ok: true, payload: { ...typed, settings: scrubSettingsForRemote(typed.settings) } };
      }
    }
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

let remoteBound = false;

/**
 * 假窗口：那批 `init*Broadcast(win)` 只用到 `win.webview.rpc?.send.<名字>(payload)`，
 * 一个 Proxy 就能把它们发出的几十种推送全部转到给定的出口（SSE）。
 */
function makeFakeWindow(send: (name: string, payload: unknown) => void): BrowserWindowWithRPC {
  // 注意用 globalThis.Proxy：本文件把 `./proxy`（出站代理）也 import 成了 Proxy，
  // 直接写 `new Proxy(...)` 会去构造那个模块命名空间。
  const channel = new globalThis.Proxy(
    {},
    {
      get: (_target: object, name: string | symbol) => (payload: unknown) =>
        send(String(name), payload),
    },
  );
  return { webview: { rpc: { send: channel }, on: () => {} } } as unknown as BrowserWindowWithRPC;
}

/**
 * 把桌面端的推送总线接到网页端：给那批 `init*Broadcast(win)` 喂一个**假窗口**。
 *
 * 它们只用到 `win.webview.rpc?.send.<名字>(payload)` 这一件事，所以一个 Proxy 就能
 * 把几十种推送全部转成 SSE —— 不需要为网页端再抄一份推送清单，将来新增推送也自动生效。
 */
export function initRemoteBroadcast(broadcast: (name: string, payload: unknown) => void): void {
  if (remoteBound) return;
  remoteBound = true;
  const fakeWin = makeFakeWindow(broadcast);

  initServerBroadcast(fakeWin);
  initModelDownloadBroadcast(fakeWin);
  initTTSModelDownloadBroadcast(fakeWin);
  initGatewayBroadcast(fakeWin);
  initTunnelBroadcast(fakeWin);
  initEngineInstallBroadcast(fakeWin);
  initMlxInstallBroadcast(fakeWin);
  initMlxModelDownloadBroadcast(fakeWin);
  initMediaSetupBroadcast(fakeWin);
  initPpOcrBroadcast(fakeWin);
  initBgRemoveBroadcast(fakeWin);
  initTessInstallBroadcast(fakeWin);
  initSkillsBroadcast(fakeWin);
  initBackupBroadcast(fakeWin);
  broadcastCurrentStatus(fakeWin);
}

/**
 * 新网页端连上时补推一次当前状态。
 *
 * 推送只在"变化时"发（桌面端靠 dom-ready 补一次），而网页端可能在任何时刻打开 ——
 * 不补推的话，模型列表 / 服务器状态这些一次性快照就一直是空的。
 */
export function replayRemoteStatus(send: (name: string, payload: unknown) => void): void {
  try {
    broadcastCurrentStatus(makeFakeWindow(send));
  } catch {
    // 补推失败不影响新连接
  }
}

/**
 * 推理引擎一键安装（llama.cpp 下载官方构建 / Python 引擎建 venv 装包）的日志与阶段。
 *
 * 日志整批下发（pip 一次能打出几百行，逐行 send 会让 webview 每行重渲染一次）；
 * 阶段用 throttleLatest 合并 —— 下载进度 400ms 一帧就够，界面只关心最新的百分比。
 */
export function initEngineInstallBroadcast(win: BrowserWindowWithRPC) {
  const logs = throttleBatch((lines) => {
    try {
      win.webview.rpc?.send.engineInstallLog({ lines });
    } catch {}
  });
  EngineInstall.onEngineInstallLog((text) => logs.push(text));
  const phase = throttleLatest<[EngineInstall.EngineInstallEvent]>((event) => {
    try {
      win.webview.rpc?.send.engineInstallPhase(event);
    } catch {}
  });
  EngineInstall.onEngineInstallPhase((event) => phase.push(event));
}

/**
 * MLX 引擎安装日志（mflux venv 安装过程），推送到前端展示。
 *
 * 整批下发（80ms 窗口，AGENTS.md 的日志节流口径）：pip / uv 一次安装能打出几百行，
 * 逐行 send 会让 webview 每行写一次 store、重渲染一次。
 */
export function initMlxInstallBroadcast(win: BrowserWindowWithRPC) {
  const logs = throttleBatch((lines) => {
    try {
      win.webview.rpc?.send.mlxInstallLog({ lines });
    } catch {}
  });
  MlxGen.onInstallLog((text) => logs.push(text));
}

/** MLX 模型权重下载进度，实时推送到前端（合并到 400ms 一帧）。 */
export function initMlxModelDownloadBroadcast(win: BrowserWindowWithRPC) {
  const send = throttleLatest<[Parameters<Parameters<typeof MlxGen.onMlxModelProgress>[0]>[0]]>(
    (p) => {
      try {
        win.webview.rpc?.send.mlxModelDownloadProgress(p);
      } catch {}
    },
  );
  MlxGen.onMlxModelProgress((p) => send.push(p));
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

/** PaddleOCR 引擎安装日志 / 阶段 / 模型下载进度，推送到前端（日志整批、进度合并）。 */
export function initPpOcrBroadcast(win: BrowserWindowWithRPC) {
  const logs = throttleBatch((lines) => {
    try {
      win.webview.rpc?.send.ppOcrInstallLog({ lines });
    } catch {}
  });
  PpOcr.onPpOcrInstallLog((text) => logs.push(text));
  PpOcr.onPpOcrPhase((phase, message) => {
    try {
      win.webview.rpc?.send.ppOcrPhase({ phase, message });
    } catch {}
  });
  const send = throttleLatest<[Parameters<Parameters<typeof PpOcr.onPpOcrModelProgress>[0]>[0]]>(
    (p) => {
      try {
        win.webview.rpc?.send.ppOcrModelProgress(p);
      } catch {}
    },
  );
  PpOcr.onPpOcrModelProgress((p) => send.push(p));
}

/** 抠图模型下载进度，推送到前端（合并推送：整个下载只关心最新百分比）。 */
export function initBgRemoveBroadcast(win: BrowserWindowWithRPC) {
  const send = throttleLatest<[BgRemove.BgDownloadProgress]>((p) => {
    try {
      win.webview.rpc?.send.bgRemoveProgress(p);
    } catch {}
  });
  bgRemoveProgressSink = (p) => send.push(p);
}

/** Tesseract 引擎一键安装日志，推送到前端（整批，同 MLX）。 */
export function initTessInstallBroadcast(win: BrowserWindowWithRPC) {
  const logs = throttleBatch((lines) => {
    try {
      win.webview.rpc?.send.tesseractInstallLog({ lines });
    } catch {}
  });
  Ocr.onTesseractInstallLog((text) => logs.push(text));
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
