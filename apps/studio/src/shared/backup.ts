/**
 * 全局备份 / 恢复的共享定义：作用域、归档布局、清单结构与进度事件。
 *
 * 这里只有纯数据与纯函数 —— 主进程、`omi` CLI 与 webview 三方共用，
 * 因此不 import 任何 Node / DOM / drizzle 模块（与 `cli-docs.ts` 同样的约束）。
 */

/** 归档格式标识：写在 manifest 里，恢复前校验，避免把普通 tar 当备份解开。 */
export const BACKUP_FORMAT = "omnistudio.backup";
/** 归档结构版本。新增可选字段不升版本，破坏性变更才升。 */
export const BACKUP_VERSION = 1;
/** 备份文件扩展名（原生文件选择器按它过滤）。 */
export const BACKUP_FILE_EXT = "omnibackup";
export const BACKUP_MANIFEST_ENTRY = "manifest.json";
/** 数据库快照在归档内的固定路径。 */
export const BACKUP_DB_ENTRY = "data/omni-studio.db";
/** 普通文件在归档内的前缀，其后为 `<文件根 id>/<根内相对路径>`。 */
export const BACKUP_FILES_PREFIX = "data/files/";

/** 备份作用域：一个作用域 = 一组逻辑上不可拆分的表 + 若干文件根。 */
export type BackupScopeId =
  | "settings"
  | "chats"
  | "prompts"
  | "skills"
  | "memory"
  | "knowledge"
  | "media";

export interface BackupScopeDef {
  id: BackupScopeId;
  /** 界面分组（配置与记忆 / 内容 / 大文件）。 */
  group: BackupScopeGroup;
  /**
   * 该作用域涉及的表，恢复时整表替换。
   * 划分必须按「逻辑整体」：messages 与 conversations 同属 chats，
   * 否则会出现"有消息没会话"的悬挂数据。
   */
  tables: string[];
  /** 创建备份时的默认勾选状态。 */
  defaultOn: boolean;
}

/**
 * 作用域定义。
 *
 * 故意不包含 `skillssh_cache`（纯缓存，可重新拉取）与 `__drizzle_migrations`
 * （结构版本，由应用自己的迁移管理）。
 */
export const BACKUP_SCOPES: BackupScopeDef[] = [
  {
    id: "settings",
    group: "core",
    tables: ["settings", "cloud_providers", "mcp_servers"],
    defaultOn: true,
  },
  {
    id: "chats",
    group: "content",
    tables: ["conversations", "messages", "agent_events"],
    defaultOn: true,
  },
  {
    id: "prompts",
    group: "core",
    tables: ["prompt_categories", "prompts", "user_prompts"],
    defaultOn: true,
  },
  {
    id: "skills",
    group: "core",
    tables: [
      "skills",
      "skill_targets",
      "skill_presets",
      "preset_skills",
      "preset_skill_tools",
      "skill_projects",
      "skill_audit_log",
    ],
    defaultOn: true,
  },
  {
    id: "memory",
    group: "core",
    tables: ["memories", "memory_events", "memory_metrics"],
    defaultOn: true,
  },
  {
    id: "knowledge",
    group: "large",
    tables: ["knowledge_bases", "knowledge_docs", "knowledge_chunks", "kb_ingest_jobs", "kb_events"],
    // 向量可重算、原文在用户自己的目录里，体积又可能很大 —— 默认不勾。
    defaultOn: false,
  },
  {
    id: "media",
    group: "large",
    tables: ["documents", "pages", "image_records", "video_records", "voice_records", "translation_records"],
    // 生成的音频 / 图片 / 视频动辄几个 GB：默认不备份，否则云端上传又慢又贵。
    defaultOn: false,
  },
];

/** 作用域分组：界面按「勾选项分组」展示，先让用户看懂再让他挑。 */
export type BackupScopeGroup = "core" | "content" | "large";

export const BACKUP_SCOPE_GROUPS: { id: BackupScopeGroup; defaultOn: boolean }[] = [
  { id: "core", defaultOn: true },
  { id: "content", defaultOn: true },
  { id: "large", defaultOn: false },
];

/** 远端存储：S3 兼容对象存储，或 WebDAV（坚果云 / Nextcloud / 群晖等）。 */
export type BackupRemoteKind = "s3" | "webdav";

export interface BackupRemoteConfig {
  kind: BackupRemoteKind;
  /** 是否启用远端备份（关闭时创建流程完全不动网络）。 */
  enabled: boolean;
  /** S3：服务地址（含协议，如 https://s3.us-east-1.amazonaws.com）；WebDAV：目录 URL。 */
  endpoint: string;
  bucket: string;
  region: string;
  /** S3：Access Key ID；WebDAV：用户名。 */
  accessKey: string;
  /** S3：Secret Access Key；WebDAV：密码 / 应用密码。仅存本机，且备份里会被剔除。 */
  secretKey: string;
  /** 远端目录前缀（S3 的 key 前缀 / WebDAV 的子目录）。 */
  prefix: string;
  /** S3 是否用 path-style（R2 / MinIO / OSS / COS 用 true；AWS 官方桶建议 false）。 */
  forcePathStyle: boolean;
  /** 创建备份后自动上传。 */
  autoUpload: boolean;
  /** 上传成功后删除本地文件（只留远端）。 */
  deleteLocalAfterUpload: boolean;
}

/**
 * 远端配置在 settings 表里的键名（主进程与界面共用）。
 * 密钥类的键名刻意带 KEY / SECRET 字样：备份的「剔除密钥」按词根匹配，
 * 分享出去的备份不会带上远端凭据。
 */
export const BACKUP_REMOTE_SETTING_KEYS = {
  kind: "BACKUP_REMOTE_KIND",
  enabled: "BACKUP_REMOTE_ENABLED",
  endpoint: "BACKUP_REMOTE_ENDPOINT",
  bucket: "BACKUP_REMOTE_BUCKET",
  region: "BACKUP_REMOTE_REGION",
  accessKey: "BACKUP_REMOTE_ACCESS_KEY",
  secretKey: "BACKUP_REMOTE_SECRET_KEY",
  prefix: "BACKUP_REMOTE_PREFIX",
  pathStyle: "BACKUP_REMOTE_PATH_STYLE",
  autoUpload: "BACKUP_REMOTE_AUTO_UPLOAD",
  deleteLocal: "BACKUP_REMOTE_DELETE_LOCAL",
} as const;

export const DEFAULT_REMOTE_CONFIG: BackupRemoteConfig = {
  kind: "s3",
  enabled: false,
  endpoint: "",
  bucket: "",
  region: "us-east-1",
  accessKey: "",
  secretKey: "",
  prefix: "OmniStudio",
  forcePathStyle: true,
  autoUpload: false,
  deleteLocalAfterUpload: false,
};

/** 远端备份文件（列表项）。 */
export interface BackupRemoteEntry {
  /** 文件名（不含前缀路径）。 */
  name: string;
  bytes: number;
  modifiedAt: number;
}

export interface BackupRemoteStatus {
  configured: boolean;
  config: BackupRemoteConfig;
  /** 上次测试连接的结果（仅内存态，不落库）。 */
  lastTest?: { ok: boolean; at: number; error?: string; detail?: string };
}

/** 数据目录下永远不参与备份的条目（体积大且可重新获取），UI 会明确提示。 */
export const BACKUP_NEVER_INCLUDED = [
  "models",
  "engines",
  "db-backups",
  "logs",
  "self-extraction",
  "mlx-downloads",
];

export interface BackupFileRoot {
  /** 归档内的一级目录名（`data/files/<id>/…`），恢复时靠它反推落地位置。 */
  id: string;
  scope: BackupScopeId;
  /** 数据目录内的相对路径；外部目录为 null，由 external 规则在运行时解析。 */
  rel: string | null;
  /** 外部根：目前只有技能中央库（默认 ~/.agents/skills，可在设置里改）。 */
  external?: "skillsRepo";
  /** 相对本根的排除前缀（如技能仓库的 .git）。 */
  exclude?: string[];
  /** 默认是否参与备份（可按作用域之外的粒度再关掉，如技能仓库体积过大）。 */
  defaultOn: boolean;
}

/**
 * 参与备份的文件根，顺序即匹配优先级（长前缀先命中）：
 * `images/chat` 必须先于 `images`，聊天附件才会归到 chats 而不是 media。
 */
export const BACKUP_FILE_ROOTS: BackupFileRoot[] = [
  { id: "chat-images", scope: "chats", rel: "images/chat", defaultOn: true },
  { id: "images", scope: "media", rel: "images", exclude: ["chat"], defaultOn: true },
  { id: "uploads", scope: "media", rel: "uploads", defaultOn: true },
  { id: "prompt-media", scope: "prompts", rel: "prompt-media", defaultOn: false },
  { id: "kb-exports", scope: "knowledge", rel: "kb-exports", defaultOn: false },
  {
    id: "skills-repo",
    scope: "skills",
    rel: null,
    external: "skillsRepo",
    exclude: [".git"],
    defaultOn: true,
  },
];

/** 单个文件根在清单里的统计。 */
export interface BackupRootStat {
  rootId: string;
  scope: BackupScopeId;
  /** 生成备份时的绝对路径（仅供参考；恢复时按当前机器的规则重新解析）。 */
  dir: string;
  count: number;
  bytes: number;
}

export interface BackupManifest {
  format: string;
  version: number;
  appVersion: string;
  createdAt: number;
  platform: string;
  /** 来源机器上的数据目录，仅用于展示与排错。 */
  sourceDataDir: string;
  /** 是否已剔除明文密钥。 */
  redacted: boolean;
  /** 是否加密（带密码）。清单本身在密文里，这个字段只有解密后才有意义。 */
  encrypted?: boolean;
  /** 归档内实际包含的作用域（未勾选的作用域既不在表里也不在文件里）。 */
  scopes: BackupScopeId[];
  /** 数据库快照：条目路径、体积与各表行数。 */
  db: { entry: string; bytes: number; tables: Record<string, number> };
  files: BackupRootStat[];
  totals: { files: number; filesBytes: number; bytes: number };
  /** 用户填写的备注。 */
  note?: string;
}

/** 备份文件列表项（由 manifest 摘要而来，UI / CLI 共用）。 */
export interface BackupSummary {
  path: string;
  name: string;
  bytes: number;
  createdAt: number;
  appVersion: string;
  scopes: BackupScopeId[];
  redacted: boolean;
  /** 加密备份在列表里只能看到文件名 / 体积 / 时间（内容要密码才能读）。 */
  encrypted: boolean;
  note?: string;
  totals: BackupManifest["totals"];
  /** 列表读取时 manifest 解析失败才有值（损坏 / 非本应用的归档）。 */
  error?: string;
}

/** 一个作用域当前的体积估算（创建备份前的预览）。 */
export interface BackupScopeEstimate {
  scope: BackupScopeId;
  bytes: number;
  files: number;
  rows: number;
}

export interface BackupEstimate {
  scopes: BackupScopeEstimate[];
  /** 每个文件根的体积（勾选项比作用域更细，UI 直接展示）。 */
  roots: { rootId: string; scope: BackupScopeId; dir: string; bytes: number; files: number; exists: boolean }[];
  /** 数据目录总占用（含不参与备份的模型 / 引擎），用于说明"为什么备份比数据目录小"。 */
  dataDirBytes: number;
  dbBytes: number;
  /** 目标目录当前可用空间，空间不足时 UI 提前拦一道。 */
  freeBytes: number | null;
}

export type BackupTaskKind = "create" | "restore" | "download";

/** 创建备份的入参（webview / CLI / 控制通道共用同一份形状）。 */
export interface BackupCreateRequest {
  scopes: BackupScopeId[];
  /** 目标目录；缺省为「数据目录/backups」。 */
  destinationDir?: string;
  fileName?: string;
  note?: string;
  /** 剔除明文 API Key（把备份发给别人排错时用）。 */
  redactSecrets?: boolean;
  /** 是否 gzip 压缩，默认是。 */
  compress?: boolean;
  /** 设置后写出加密归档（AES-256-GCM + scrypt）；密码不会保存在任何地方。 */
  password?: string;
  /** 创建完成后上传到已配置的远端存储。 */
  upload?: boolean;
}

export interface BackupCreateResult {
  path: string;
  name: string;
  bytes: number;
  manifest: BackupManifest;
  /** 已上传到远端时的位置信息。 */
  uploaded?: { key: string; location: string; bytes: number };
  /** 上传成功后按设置删除了本地文件。 */
  localDeleted?: boolean;
}

export interface BackupRestoreRequest {
  path: string;
  /** 加密备份的密码。 */
  password?: string;
  /** 只恢复其中一部分作用域；缺省恢复归档里的全部。 */
  scopes?: BackupScopeId[];
  /** 恢复前先把当前数据备份一份（默认 true）。 */
  safety?: boolean;
}

export interface BackupRestoreResult {
  path: string;
  scopes: BackupScopeId[];
  tables: { table: string; rows: number }[];
  files: number;
  bytes: number;
  /** 恢复前自动生成的"回到现在"备份。 */
  safetyPath?: string;
  warnings: string[];
}

export interface BackupInspectResult {
  manifest: BackupManifest;
  scopes: BackupScopeId[];
  path: string;
  bytes: number;
  warnings: string[];
}

export interface BackupDownloadRequest {
  /** 远端备份文件名。 */
  fileName: string;
  /** 需要密码的加密备份，可在这里带上（下载本身不需要，留给后续预览 / 恢复用）。 */
  password?: string;
}

export interface BackupDownloadResult {
  path: string;
  name: string;
  bytes: number;
}

export type BackupTaskResult = BackupCreateResult | BackupRestoreResult | BackupDownloadResult;

/** 任务终态：长任务的结果通过事件送达，不挂在一次请求上。 */
export interface BackupFinishedEvent {
  taskId: string;
  kind: BackupTaskKind;
  ok: boolean;
  canceled?: boolean;
  result?: BackupTaskResult;
  error?: string;
}

export type BackupPhase =
  | "scan"
  | "snapshot"
  | "prune"
  | "pack"
  | "unpack"
  | "safety"
  | "database"
  | "files"
  | "upload"
  | "download"
  | "cleanup"
  | "done"
  | "error";

/**
 * 进度事件。长任务（GB 级媒体）必须让用户看到进展与"卡在哪一步"，
 * 因此同时带上阶段、当前条目与字节进度。
 */
export interface BackupProgress {
  taskId: string;
  kind: BackupTaskKind;
  phase: BackupPhase;
  /** 0-100；总量未知时为 null（UI 显示不确定进度条）。 */
  percent: number | null;
  processedBytes?: number;
  totalBytes?: number;
  processedItems?: number;
  totalItems?: number;
  /** 当前处理的文件相对路径 / 表名。 */
  current?: string;
  message?: string;
}

/**
 * 密钥类设置键判定。
 *
 * 「剔除密钥」选项靠它决定抹掉哪些 `settings` 行：按 `_` 分词后整词匹配，
 * `SERVER_IMAGE_MAX_TOKENS` 这类含 TOKENS 的普通配置不会被误伤。
 * 新增密钥设置时，`backup.test.ts` 会因清单不一致而失败，提醒补进断言。
 */
const SECRET_TOKENS = new Set([
  "KEY",
  "APIKEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASS",
  "PAT",
  "BEARER",
  "CREDENTIAL",
  "CREDENTIALS",
]);

export function isSecretSettingKey(key: string): boolean {
  return key
    .toUpperCase()
    .split("_")
    .some((token) => SECRET_TOKENS.has(token));
}

/** 密钥类的数据库列（表名 → 列名），「剔除密钥」时按此清空。 */
export const SECRET_COLUMNS: Record<string, string[]> = {
  cloud_providers: ["api_key"],
  knowledge_bases: ["embedding_api_key", "rerank_api_key"],
};

/** 可能内嵌密钥的 JSON 列：剔除时按关键字抹掉其中的值。 */
export const SECRET_JSON_COLUMNS: Record<string, string[]> = {
  mcp_servers: ["headers", "env"],
};

/** JSON 里的疑似密钥字段名（不区分大小写、子串匹配）。 */
export const SECRET_JSON_FIELD_PATTERN = /(authorization|token|api[-_]?key|secret|password|bearer)/i;

export interface ClassifiedBackupPath {
  rootId: string;
  scope: BackupScopeId;
  /** 相对文件根本身的路径（归档内 `data/files/<rootId>/<relInRoot>`）。 */
  relInRoot: string;
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** 该路径是否落在（文件根内的）某个排除前缀下。 */
function isExcluded(relInRoot: string, excludes?: string[]): boolean {
  if (!excludes?.length) return false;
  return excludes.some((ex) => relInRoot === ex || relInRoot.startsWith(`${ex}/`));
}

/**
 * 把一个「相对数据目录的路径」归到文件根（含外部根，按 rootId 反推）。
 * 未命中任何文件根时返回 null —— 这类文件不参与备份。
 */
export function classifyBackupPath(relPath: string): ClassifiedBackupPath | null {
  const rel = normalizeRel(relPath);
  if (!rel) return null;
  const roots = [...BACKUP_FILE_ROOTS]
    .filter((r) => r.rel)
    .sort((a, b) => (b.rel as string).length - (a.rel as string).length);
  for (const root of roots) {
    const base = root.rel as string;
    if (rel !== base && !rel.startsWith(`${base}/`)) continue;
    const relInRoot = rel === base ? "" : rel.slice(base.length + 1);
    if (!relInRoot || isExcluded(relInRoot, root.exclude)) return null;
    return { rootId: root.id, scope: root.scope, relInRoot };
  }
  return null;
}

/** 归档内路径 → 文件根归属（恢复侧使用）。 */
export function classifyArchiveEntry(entry: string): ClassifiedBackupPath | null {
  const norm = normalizeRel(entry);
  if (!norm.startsWith(BACKUP_FILES_PREFIX)) return null;
  const rest = norm.slice(BACKUP_FILES_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const rootId = rest.slice(0, slash);
  const relInRoot = rest.slice(slash + 1);
  const root = BACKUP_FILE_ROOTS.find((r) => r.id === rootId);
  if (!root || !relInRoot) return null;
  if (isExcluded(relInRoot, root.exclude)) return null;
  return { rootId, scope: root.scope, relInRoot };
}

/** 需要密码时的错误文案特征：界面据此弹密码输入框，而不是当成失败报错。 */
export const BACKUP_PASSWORD_REQUIRED_HINT = "需要输入密码";

/** 备份文件名：`OmniStudio-<yyyyMMdd-HHmmss>.omnibackup`（本地时间，便于人工辨认）。 */
export function backupFileName(date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `OmniStudio-${stamp}.${BACKUP_FILE_EXT}`;
}

/** 作用域列表 → 表名并集（去重，保持作用域定义顺序）。 */
export function tablesForScopes(scopes: readonly BackupScopeId[]): string[] {
  const set = new Set<string>();
  for (const def of BACKUP_SCOPES) {
    if (!scopes.includes(def.id)) continue;
    for (const t of def.tables) set.add(t);
  }
  return [...set];
}

/** 校验外部输入的勾选值，未知 id 直接丢弃（webview / 控制通道的输入都不可信）。 */
export function sanitizeScopes(input: unknown): BackupScopeId[] {
  if (!Array.isArray(input)) return [];
  const known = new Set(BACKUP_SCOPES.map((s) => s.id));
  const out: BackupScopeId[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const id = raw as BackupScopeId;
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
