/**
 * 全局备份 / 恢复内核。
 *
 * 设计约束（决定了这里的写法）：
 * - **可独立运行**：不 import `db/index.ts`（会连带跑迁移）、不 import electrobun，
 *   因此 `omi` CLI 可以在应用没运行、甚至应用起不来（迁移失败）时照样备份 / 恢复。
 * - **流式**：媒体文件按块进出，几个 GB 的音频 / 视频不会把主进程内存撑爆。
 * - **一致性**：数据库快照走 `VACUUM INTO`，WAL 下与应用同时读写也能拿到一致副本。
 * - **可见**：长任务必须报进度（阶段 + 字节 + 当前文件），并能取消。
 *
 * 归档布局（gzip 可选）：
 *   manifest.json                      清单：作用域、表行数、文件根统计
 *   data/omni-studio.db                数据库快照（未勾选的表已被裁掉）
 *   data/files/<文件根 id>/<相对路径>   选中的文件
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { getDataDir } from "../paths";
import { DEFAULT_CENTRAL_SKILLS_DIR } from "../../shared/skills";
import {
  BACKUP_DB_ENTRY,
  BACKUP_FILES_PREFIX,
  BACKUP_FORMAT,
  BACKUP_MANIFEST_ENTRY,
  BACKUP_FILE_EXT,
  BACKUP_FILE_ROOTS,
  BACKUP_SCOPES,
  BACKUP_VERSION,
  backupFileName,
  classifyArchiveEntry,

  isSecretSettingKey,
  sanitizeScopes,
  SECRET_COLUMNS,
  SECRET_JSON_COLUMNS,
  SECRET_JSON_FIELD_PATTERN,
  BACKUP_REMOTE_SETTING_KEYS,
  DEFAULT_REMOTE_CONFIG,
  tablesForScopes,
  type BackupCreateRequest,
  type BackupCreateResult,
  type BackupEstimate,
  type BackupFileRoot,
  type BackupInspectResult,
  type BackupManifest,
  type BackupPhase,
  type BackupProgress,
  type BackupRestoreRequest,
  type BackupRestoreResult,
  type BackupRootStat,
  type BackupScopeId,
  type BackupRemoteConfig,
  type BackupRemoteEntry,
  type BackupSummary,
  type BackupTaskKind,
  type BackupTaskResult,
} from "../../shared/backup";
import * as Remote from "./remote";
import { isInsideDir, safeBaseName, safeJoin } from "../path-safety";
import { openArchive, writeArchive, isBackupPasswordError, type TarSource } from "./archive";
import { isEncryptedFile } from "./crypto";

// ---------------------------------------------------------------------------
// 上下文与路径
// ---------------------------------------------------------------------------

export interface BackupContext {
  dataDir: string;
  dbPath: string;
  appVersion: string;
  /**
   * 应用内复用自己的 SQLite 连接：同一时刻只有一个写者，
   * 避免恢复时与运行中的应用抢锁。CLI 独立进程不传，由模块自建。
   */
  connection?: Database;
}

export function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.OMNI_DB_PATH) return process.env.OMNI_DB_PATH;
  const inDataDir = join(getDataDir(), "omni-studio.db");
  if (existsSync(inDataDir)) return inDataDir;
  // 开发模式：db/index.ts 在无 OMNI_DATA_DIR / OMNI_DB_PATH 时用 CWD 下的 sqlite.db。
  const devDb = join(process.cwd(), "sqlite.db");
  if (!process.env.OMNI_DATA_DIR && existsSync(devDb)) return devDb;
  return inDataDir;
}

export function currentBackupContext(overrides?: Partial<BackupContext>): BackupContext {
  const dataDir = overrides?.dataDir ?? getDataDir();
  return {
    dataDir,
    dbPath: overrides?.dbPath ?? resolveDbPath(),
    appVersion: overrides?.appVersion ?? "unknown",
    connection: overrides?.connection,
  };
}

/** 备份文件默认存放目录（数据目录下，随数据目录一起被用户找到）。 */
export function defaultBackupDir(dataDir = getDataDir()): string {
  return join(dataDir, "backups");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function readSettingValue(conn: Database | null, key: string): string | null {
  if (!conn) return null;
  try {
    const row = conn.query("select value from settings where key = ?").get(key) as { value?: string } | null;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

/** 外部文件根（技能中央库）的落地目录；与 `skills/central-repo.ts` 同规则。 */
function resolveExternalRoot(root: BackupFileRoot, conn: Database | null): string | null {
  if (root.external !== "skillsRepo") return null;
  const override = (readSettingValue(conn, "SKILLS_CENTRAL_PATH") ?? "").trim();
  return override ? resolve(expandHome(override)) : join(homedir(), DEFAULT_CENTRAL_SKILLS_DIR);
}

/** 文件根 → 实际目录（不存在返回 null）。 */
function rootDirOf(root: BackupFileRoot, ctx: BackupContext, conn: Database | null): string | null {
  const dir = root.rel ? join(ctx.dataDir, root.rel) : resolveExternalRoot(root, conn);
  if (!dir) return null;
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * 恢复时先钉住「外部根落在哪」——只认**恢复前**本机设置里的 SKILLS_CENTRAL_PATH。
 *
 * 外部根是唯一一个目录不受数据目录约束的文件根，而恢复后的 settings 表来自归档
 * （外部输入）。若拿恢复后的值当落地目录，一个做过手脚的备份只要把
 * SKILLS_CENTRAL_PATH 指到 $HOME、再带上 `data/files/skills-repo/.zshrc`，就能在
 * 用户从未授权的位置覆盖任意文件（连 ~/Library/LaunchAgents 都行）。
 *
 * 因此把「路径从哪来」钉死在本机原有配置上：归档只能决定**写哪些文件**，
 * 不能决定**写到哪个根**。跨机器恢复仍然成立 —— 落地目录是本机当前配置的技能库
 * （用户本来就在用的那个），而不是归档里那一台机器的路径。
 */
function captureExternalRootDirs(ctx: BackupContext, conn: Database | null): Map<string, string | null> {
  const own = conn ? null : existsSync(ctx.dbPath) ? new Database(ctx.dbPath, { readonly: true }) : null;
  const src = conn ?? own;
  const out = new Map<string, string | null>();
  try {
    for (const root of BACKUP_FILE_ROOTS) {
      if (root.rel) continue;
      const dir = resolveExternalRoot(root, src);
      let usable: string | null = null;
      if (dir) {
        try {
          usable = statSync(dir).isDirectory() ? dir : null;
        } catch {
          usable = null;
        }
      }
      out.set(root.id, usable);
    }
  } finally {
    own?.close();
  }
  return out;
}

/**
 * 归档把外部根指向了别处时给出提示。
 *
 * 不阻止恢复（设置本身是用户数据，恢复它就该生效），但要让人知道"文件写到的
 * 位置"和"恢复后设置里的位置"已经不是同一个，否则下次备份会从新设置里去找文件
 * 却找不到。
 */
function warnIfExternalRootMoved(
  liveConn: Database | null,
  pinned: Map<string, string | null>,
  warnings: string[],
): void {
  for (const root of BACKUP_FILE_ROOTS) {
    if (root.rel || !root.external) continue;
    const now = resolveExternalRoot(root, liveConn);
    const before = pinned.get(root.id);
    if (now && before && resolve(now) !== resolve(before)) {
      warnings.push(
        `备份里的技能库位置（${now}）与本机原有位置（${before}）不一致：文件已写入原有位置，请在设置里确认技能库路径`,
      );
    } else if (now && !before) {
      warnings.push(`备份把技能库指向 ${now}，但该目录当前不可用：文件未能写入，请检查设置`);
    }
  }
}

// ---------------------------------------------------------------------------
// 进度事件与任务注册
// ---------------------------------------------------------------------------

export type BackupEvent =
  | { type: "progress"; progress: BackupProgress }
  | {
      type: "finished";
      taskId: string;
      kind: BackupTaskKind;
      ok: boolean;
      canceled?: boolean;
      result?: BackupTaskResult;
      error?: string;
    };

const listeners = new Set<(e: BackupEvent) => void>();
/** 进度节流：每个文件都推一次会把 webview 拖垮，120ms 一批足够顺滑。 */
const PROGRESS_THROTTLE_MS = 120;

interface ActiveTask {
  taskId: string;
  kind: BackupTaskKind;
  controller: AbortController;
  startedAt: number;
  progress: BackupProgress;
}

const activeTasks = new Map<string, ActiveTask>();

export function subscribeBackupEvents(cb: (e: BackupEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function broadcast(event: BackupEvent): void {
  for (const cb of listeners) {
    try {
      cb(event);
    } catch {
      // 单个订阅者出错不影响备份本身
    }
  }
}

export function activeBackupTask(): BackupProgress | null {
  const first = activeTasks.values().next().value as ActiveTask | undefined;
  return first ? first.progress : null;
}

export function cancelBackupTask(taskId: string): boolean {
  const task = activeTasks.get(taskId);
  if (!task) return false;
  task.controller.abort();
  return true;
}

/** 进度回调（内部节流；阶段变化与终态一定送达）。 */
function makeProgressSink(
  task: ActiveTask | undefined,
  taskId: string,
  kind: BackupTaskKind,
  extra?: (p: BackupProgress) => BackupProgress,
): (p: Omit<BackupProgress, "taskId" | "kind">) => void {
  let lastAt = 0;
  let lastPhase: BackupPhase | null = null;
  let last = 0;
  return (patch) => {
    const now = Date.now();
    const phaseChanged = patch.phase !== lastPhase;
    const terminal = patch.phase === "done" || patch.phase === "error";
    // 文件循环里每 N 个文件才推进一次，靠节流把事件量压到 UI 跟得上的量级。
    const samePhaseDone = last > 0 && (patch.processedItems ?? 0) <= last && patch.phase !== "done";
    if (!phaseChanged && !terminal && now - lastAt < PROGRESS_THROTTLE_MS) return;
    if (!phaseChanged && !terminal && samePhaseDone) return;
    lastAt = now;
    lastPhase = patch.phase;
    last = patch.processedItems ?? last;
    let progress: BackupProgress = { taskId, kind, ...patch };
    if (extra) progress = extra(progress);
    if (task) task.progress = progress;
    broadcast({ type: "progress", progress });
  };
}

/**
 * 跑一个备份任务：立即返回 taskId，结果通过 `finished` 事件送达。
 * 备份可能跑几分钟，不能挂在一次 RPC 请求上。
 */
function runTask(
  kind: BackupTaskKind,
  run: (signal: AbortSignal, sink: (p: Omit<BackupProgress, "taskId" | "kind">) => void) => Promise<BackupTaskResult>,
): { taskId: string } {
  // 同一时刻只允许一个备份 / 恢复任务：并发写同一份数据库没有好处。
  const existing = activeTasks.values().next().value as ActiveTask | undefined;
  if (existing) throw new Error("已有备份 / 恢复任务在进行中");

  const taskId = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const task: ActiveTask = {
    taskId,
    kind,
    controller,
    startedAt: Date.now(),
    progress: { taskId, kind, phase: "scan", percent: 0 },
  };
  activeTasks.set(taskId, task);
  const sink = makeProgressSink(task, taskId, kind);

  void (async () => {
    try {
      const result = await run(controller.signal, sink);
      sink({ phase: "done", percent: 100 });
      broadcast({ type: "finished", taskId, kind, ok: true, result });
    } catch (err) {
      const canceled = controller.signal.aborted;
      const message = errText(err);
      sink({ phase: "error", percent: null, message });
      broadcast({ type: "finished", taskId, kind, ok: false, canceled, error: message });
    } finally {
      activeTasks.delete(taskId);
    }
  })();

  return { taskId };
}

// ---------------------------------------------------------------------------
// 文件遍历
// ---------------------------------------------------------------------------

interface ScannedFile {
  /** 相对文件根的路径（归档内用 / 分隔）。 */
  rel: string;
  size: number;
  mtimeMs: number;
}

function isExcludedRel(rel: string, excludes?: string[]): boolean {
  if (!excludes?.length) return false;
  return excludes.some((ex) => rel === ex || rel.startsWith(`${ex}${sep}`) || rel.startsWith(`${ex}/`));
}

/** 估算遍历的上限：目录规模异常时不至于把内存 / 时间拖垮。 */
const WALK_BUDGET_FILES = 300_000;

/**
 * 递归收集文件。软链接一律跳过：技能目录里大量「部署到各 CLI」的链接都指向
 * 中央库，跟着走会把同一份内容重复打包、还可能成环。
 */
async function walkRoot(
  dir: string,
  opts?: { excludes?: string[]; signal?: AbortSignal; budget?: { files: number; bytes: number } },
): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  const seen = new Set<string>();
  const overBudget = () => !!opts?.budget && opts.budget.files > WALK_BUDGET_FILES;
  async function visit(current: string, relBase: string): Promise<void> {
    if (opts?.signal?.aborted) throw new Error("已取消");
    if (overBudget()) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (opts?.signal?.aborted) throw new Error("已取消");
      if (overBudget()) return;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (isExcludedRel(rel, opts?.excludes)) continue;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // 防御性：极深的目录树（用户把项目目录塞进技能仓库）不追下去。
        if (relBase.split("/").length > 24) continue;
        await visit(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.size > 0) {
        const key = `${st.dev}:${st.ino}`;
        if (seen.has(key)) continue; // 硬链接去重
        seen.add(key);
      }
      out.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      if (opts?.budget) {
        opts.budget.files += 1;
        opts.budget.bytes += st.size;
      }
    }
  }
  await visit(dir, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** 目录总占用（跳过软链接）。用于"数据目录 vs 备份体积"的对比展示。 */
async function dirSize(dir: string): Promise<number> {
  const budget = { files: 0, bytes: 0 };
  try {
    await walkRoot(dir, { budget });
  } catch {
    // 读不了的目录按已知累计返回
  }
  return budget.bytes;
}

// ---------------------------------------------------------------------------
// 数据库快照 / 裁剪 / 密钥剔除
// ---------------------------------------------------------------------------

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function listTables(conn: Database): string[] {
  return conn
    .query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .all()
    .map((r) => String((r as { name: string }).name));
}

function countRows(conn: Database, table: string): number {
  try {
    const row = conn.query(`select count(*) as c from "${table}"`).get() as { c: number } | null;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

/** 生成一致快照；打开的是源库的临时只读连接，WAL 下与应用同时读写也安全。 */
function snapshotDatabase(dbPath: string, destPath: string): void {
  const src = new Database(dbPath, { readonly: true });
  try {
    src.exec(`VACUUM INTO ${quoteSqlLiteral(destPath)}`);
  } finally {
    src.close();
  }
}

/**
 * 裁掉未勾选的表：备份里不该出现用户明确没选的数据（体积与隐私都算）。
 *
 * 打开 `secure_delete` 再删：SQLite 默认只把页标记为空闲，旧的聊天正文 / 密钥
 * 仍残留在文件里，跟着归档一起被打包出去 —— 那就等于"没选也备了"。
 */
function pruneSnapshot(snapshotPath: string, keepTables: Set<string>): void {
  const conn = new Database(snapshotPath);
  try {
    conn.exec("pragma secure_delete = on");
    const all = listTables(conn);
    let removed = 0;
    conn.exec("begin");
    for (const table of all) {
      if (keepTables.has(table) || table.startsWith("__drizzle")) continue;
      conn.exec(`delete from "${table}"`);
      removed += 1;
    }
    conn.exec("commit");
    if (removed > 0) conn.exec("vacuum");
  } finally {
    conn.close();
  }
}

/** 「剔除密钥」：把明文 API Key / Token 抹成空值，便于把备份发给别人排错。 */
function redactSecretsInSnapshot(snapshotPath: string): number {
  const conn = new Database(snapshotPath);
  let touched = 0;
  try {
    // 同 pruneSnapshot：不用 secure_delete 的话，被覆盖的密钥仍留在空闲页里。
    conn.exec("pragma secure_delete = on");
    conn.exec("begin");
    const settingRows = conn.query("select key from settings").all() as { key: string }[];
    const del = conn.prepare("update settings set value = '' where key = ?");
    for (const row of settingRows) {
      if (!isSecretSettingKey(row.key)) continue;
      del.run(row.key);
      touched += 1;
    }
    for (const [table, columns] of Object.entries(SECRET_COLUMNS)) {
      if (!listTables(conn).includes(table)) continue;
      for (const column of columns) {
        conn.exec(`update "${table}" set "${column}" = '' where "${column}" is not null and "${column}" <> ''`);
        touched += 1;
      }
    }
    for (const [table, columns] of Object.entries(SECRET_JSON_COLUMNS)) {
      if (!listTables(conn).includes(table)) continue;
      for (const column of columns) {
        const rows = conn
          .query(`select rowid as rid, "${column}" as value from "${table}" where "${column}" is not null`)
          .all() as { rid: number; value: string }[];
        const update = conn.prepare(`update "${table}" set "${column}" = ? where rowid = ?`);
        for (const row of rows) {
          const scrubbed = scrubSecretJson(row.value);
          if (scrubbed !== row.value) {
            update.run(scrubbed, row.rid);
            touched += 1;
          }
        }
      }
    }
    conn.exec("commit");
  } catch {
    conn.exec("rollback");
  } finally {
    conn.close();
  }
  if (touched > 0) {
    const vacuum = new Database(snapshotPath);
    try {
      vacuum.exec("vacuum");
    } finally {
      vacuum.close();
    }
  }
  return touched;
}

/** 抹掉 JSON 里疑似密钥字段的值，保留其他配置。 */
function scrubSecretJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = SECRET_JSON_FIELD_PATTERN.test(key) ? "" : value;
    }
    return JSON.stringify(out);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// 远端存储（S3 / WebDAV）
// ---------------------------------------------------------------------------

/**
 * 读远端配置。
 *
 * 直接读写 settings 表而不经过扩展层：备份内核要保持"不依赖应用数据层"，
 * CLI 在应用没运行时也得能拿到同一份配置。
 */
export function readRemoteConfig(ctx?: Partial<BackupContext>): BackupRemoteConfig {
  const resolved = currentBackupContext(ctx);
  if (!existsSync(resolved.dbPath)) return { ...DEFAULT_REMOTE_CONFIG };
  const conn = new Database(resolved.dbPath, { readonly: true });
  try {
    const text = (key: string) => readSettingValue(conn, key) ?? "";
    const flag = (key: string, fallback: boolean) => {
      const raw = readSettingValue(conn, key);
      if (raw === null || raw === "") return fallback;
      return raw === "1" || raw === "true";
    };
    const kind = text(BACKUP_REMOTE_SETTING_KEYS.kind) === "webdav" ? "webdav" : "s3";
    return {
      kind,
      enabled: flag(BACKUP_REMOTE_SETTING_KEYS.enabled, false),
      endpoint: text(BACKUP_REMOTE_SETTING_KEYS.endpoint),
      bucket: text(BACKUP_REMOTE_SETTING_KEYS.bucket),
      region: text(BACKUP_REMOTE_SETTING_KEYS.region) || "us-east-1",
      accessKey: text(BACKUP_REMOTE_SETTING_KEYS.accessKey),
      secretKey: text(BACKUP_REMOTE_SETTING_KEYS.secretKey),
      prefix: text(BACKUP_REMOTE_SETTING_KEYS.prefix),
      forcePathStyle: flag(BACKUP_REMOTE_SETTING_KEYS.pathStyle, true),
      autoUpload: flag(BACKUP_REMOTE_SETTING_KEYS.autoUpload, false),
      deleteLocalAfterUpload: flag(BACKUP_REMOTE_SETTING_KEYS.deleteLocal, false),
    };
  } finally {
    conn.close();
  }
}

export function writeRemoteConfig(config: BackupRemoteConfig, ctx?: Partial<BackupContext>): void {
  const resolved = currentBackupContext(ctx);
  const conn = new Database(resolved.dbPath);
  try {
    const upsert = conn.prepare(
      "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
    );
    const put = (key: string, value: string) => upsert.run(key, value);
    put(BACKUP_REMOTE_SETTING_KEYS.kind, config.kind);
    put(BACKUP_REMOTE_SETTING_KEYS.enabled, config.enabled ? "1" : "0");
    put(BACKUP_REMOTE_SETTING_KEYS.endpoint, config.endpoint.trim());
    put(BACKUP_REMOTE_SETTING_KEYS.bucket, config.bucket.trim());
    put(BACKUP_REMOTE_SETTING_KEYS.region, config.region.trim() || "us-east-1");
    put(BACKUP_REMOTE_SETTING_KEYS.accessKey, config.accessKey.trim());
    put(BACKUP_REMOTE_SETTING_KEYS.secretKey, config.secretKey);
    put(BACKUP_REMOTE_SETTING_KEYS.prefix, config.prefix.trim());
    put(BACKUP_REMOTE_SETTING_KEYS.pathStyle, config.forcePathStyle ? "1" : "0");
    put(BACKUP_REMOTE_SETTING_KEYS.autoUpload, config.autoUpload ? "1" : "0");
    put(BACKUP_REMOTE_SETTING_KEYS.deleteLocal, config.deleteLocalAfterUpload ? "1" : "0");
  } finally {
    conn.close();
  }
}

/** 配置是否完整到可以上传 / 列取。 */
export function isRemoteConfigured(config: BackupRemoteConfig): boolean {
  return config.enabled && Remote.validateRemoteConfig(config).ok;
}

/** 删除远端的一份备份。 */
export async function deleteRemoteBackup(fileName: string, ctx?: Partial<BackupContext>): Promise<void> {
  const config = readRemoteConfig(ctx);
  if (!config.enabled) throw new Error("远端备份未启用");
  const safe = safeBaseName(fileName);
  if (!safe || !safe.endsWith(".omnibackup")) throw new Error("备份文件名不合法");
  await Remote.deleteRemoteBackup({ config, fileName: safe });
}

/** 测试远端连通性（列一次目录）。 */
export async function testRemote(ctx?: Partial<BackupContext>): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const config = readRemoteConfig(ctx);
  return Remote.testRemote({ config });
}

/** 列出远端已有的备份。 */
export async function listRemoteBackups(ctx?: Partial<BackupContext>): Promise<BackupRemoteEntry[]> {
  const config = readRemoteConfig(ctx);
  if (!config.enabled) throw new Error("远端备份未启用");
  return Remote.listRemoteBackups({ config });
}

/** 把远端的一份备份下载到本地备份目录，返回本地路径（随后走常规的预览 / 恢复流程）。 */
export async function downloadRemoteBackup(params: {
  ctx?: Partial<BackupContext>;
  fileName: string;
  onProgress?: (p: Omit<BackupProgress, "taskId" | "kind">) => void;
  signal?: AbortSignal;
}): Promise<{ path: string; bytes: number }> {
  const config = readRemoteConfig(params.ctx);
  if (!config.enabled) throw new Error("远端备份未启用");
  const safe = safeBaseName(params.fileName);
  if (!safe || !safe.endsWith(".omnibackup")) throw new Error("备份文件名不合法");
  const dir = defaultBackupDir(params.ctx?.dataDir);
  await mkdir(dir, { recursive: true });
  const dest = join(dir, safe);
  const report = params.onProgress ?? (() => {});
  report({ phase: "download", percent: 0, current: safe });
  const { bytes } = await Remote.downloadBackup({
    config,
    fileName: safe,
    destPath: dest,
    onProgress: (p) =>
      report({ phase: "download", percent: p.percent, processedBytes: p.transferred, totalBytes: p.total, current: safe }),
    signal: params.signal,
  });
  return { path: dest, bytes };
}

// ---------------------------------------------------------------------------
// 估算
// ---------------------------------------------------------------------------

export async function estimateBackup(params?: {
  ctx?: Partial<BackupContext>;
  signal?: AbortSignal;
}): Promise<BackupEstimate> {
  const ctx = currentBackupContext(params?.ctx);
  const conn = existsSync(ctx.dbPath) ? new Database(ctx.dbPath, { readonly: true }) : null;
  try {
    const roots: BackupEstimate["roots"] = [];
    for (const root of BACKUP_FILE_ROOTS) {
      const dir = rootDirOf(root, ctx, conn);
      const stat = { bytes: 0, files: 0 };
      if (dir) {
        const budget = { files: 0, bytes: 0 };
        await walkRoot(dir, { excludes: root.exclude, signal: params?.signal, budget });
        stat.bytes = budget.bytes;
        stat.files = budget.files;
      }
      roots.push({ rootId: root.id, scope: root.scope, dir: dir ?? "", bytes: stat.bytes, files: stat.files, exists: !!dir });
    }

    const scopes = BACKUP_SCOPES.map((def) => {
      const mine = roots.filter((r) => r.scope === def.id && rootIncluded(def.id, r.rootId));
      return {
        scope: def.id,
        bytes: mine.reduce((sum, r) => sum + r.bytes, 0),
        files: mine.reduce((sum, r) => sum + r.files, 0),
        rows: conn ? def.tables.reduce((sum, t) => sum + countRows(conn, t), 0) : 0,
      };
    });

    const dir = defaultBackupDir(ctx.dataDir);
    let freeBytes: number | null = null;
    try {
      await mkdir(dir, { recursive: true });
      const fsStat = await statfs(dir);
      freeBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
    } catch {
      freeBytes = null;
    }

    return {
      scopes,
      roots,
      dataDirBytes: await dirSize(ctx.dataDir),
      dbBytes: existsSync(ctx.dbPath) ? statSync(ctx.dbPath).size : 0,
      freeBytes,
    };
  } finally {
    conn?.close();
  }
}

/** 文件根是否随作用域一起打包：作用域被勾选 + 该根默认参与。 */
function rootIncluded(scope: BackupScopeId, rootId: string): boolean {
  const root = BACKUP_FILE_ROOTS.find((r) => r.id === rootId);
  if (!root || root.scope !== scope) return false;
  return root.defaultOn;
}

// ---------------------------------------------------------------------------
// 创建备份
// ---------------------------------------------------------------------------

export interface CreateBackupParams extends BackupCreateRequest {
  ctx?: Partial<BackupContext>;
  onProgress?: (p: Omit<BackupProgress, "taskId" | "kind">) => void;
  signal?: AbortSignal;
  /**
   * 跳过「创建后自动上传」设置。
   *
   * 恢复前自动生成的 pre-restore 回退点用它：那份快照是就地兜底用的，
   * 把它推到远端既不符合用户预期，也会让恢复多受一次网络波动的影响
   * （上传失败会直接中断恢复）。
   */
  skipAutoUpload?: boolean;
}

export async function createBackup(params: CreateBackupParams): Promise<BackupCreateResult> {
  const ctx = currentBackupContext(params.ctx);
  const scopes = sanitizeScopes(params.scopes);
  if (!scopes.length) throw new Error("请至少选择一个要备份的内容");
  const signal = params.signal;
  const report = params.onProgress ?? (() => {});
  const aborted = () => {
    if (signal?.aborted) throw new Error("已取消");
  };

  const destDir = params.destinationDir ? resolve(expandHome(params.destinationDir)) : defaultBackupDir(ctx.dataDir);
  // fileName 来自 webview / CLI：`../../x` 会越过 destinationDir 写到别处，只取 basename。
  const fileName = safeBaseName(params.fileName?.trim() || "") ?? backupFileName();
  const outPath = join(destDir, fileName.endsWith(".omnibackup") ? fileName : `${fileName}.omnibackup`);
  const tmpDir = join(defaultBackupDir(ctx.dataDir), `.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  report({ phase: "scan", percent: 0 });
  try {
    await mkdir(tmpDir, { recursive: true });
    const conn = existsSync(ctx.dbPath) ? new Database(ctx.dbPath, { readonly: true }) : null;
    const keepTables = new Set(tablesForScopes(scopes));
    let filePlan: { root: BackupFileRoot; dir: string; files: ScannedFile[]; bytes: number }[] = [];
    try {
      // 1. 扫描文件（先拿到总体积，后面才能给出百分比）
      for (const root of BACKUP_FILE_ROOTS) {
        aborted();
        if (!scopes.includes(root.scope) || !root.defaultOn) continue;
        const dir = rootDirOf(root, ctx, conn);
        if (!dir) continue;
        report({ phase: "scan", percent: null, current: root.id, message: dir });
        const files = await walkRoot(dir, { excludes: root.exclude, signal });
        const bytes = files.reduce((sum, f) => sum + f.size, 0);
        filePlan.push({ root, dir, files, bytes });
      }

      const filesBytes = filePlan.reduce((sum, r) => sum + r.bytes, 0);
      const fileCount = filePlan.reduce((sum, r) => sum + r.files.length, 0);

      // 2. 数据库快照 → 裁剪 →（可选）剔除密钥
      aborted();
      report({ phase: "snapshot", percent: 2, message: ctx.dbPath });
      const dbSnapshot = join(tmpDir, "omni-studio.db");
      if (existsSync(ctx.dbPath)) snapshotDatabase(ctx.dbPath, dbSnapshot);

      if (existsSync(dbSnapshot)) {
        report({ phase: "prune", percent: 4, message: `${keepTables.size} 张表` });
        pruneSnapshot(dbSnapshot, keepTables);
        if (params.redactSecrets) {
          const touched = redactSecretsInSnapshot(dbSnapshot);
          report({ phase: "prune", percent: 5, message: `已剔除 ${touched} 处密钥` });
        }
      }

      const dbBytes = existsSync(dbSnapshot) ? statSync(dbSnapshot).size : 0;
      const tables: Record<string, number> = {};
      if (existsSync(dbSnapshot)) {
        const snap = new Database(dbSnapshot, { readonly: true });
        try {
          for (const table of keepTables) {
            if (listTables(snap).includes(table)) tables[table] = countRows(snap, table);
          }
        } finally {
          snap.close();
        }
      }

      // 3. 清单（放在归档最前面：列表 / 预览只需读这一个条目）
      const fileStats: BackupRootStat[] = filePlan.map((plan) => ({
        rootId: plan.root.id,
        scope: plan.root.scope,
        dir: plan.dir,
        count: plan.files.length,
        bytes: plan.bytes,
      }));
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        appVersion: ctx.appVersion,
        createdAt: Date.now(),
        platform: `${process.platform}-${process.arch}`,
        sourceDataDir: ctx.dataDir,
        redacted: !!params.redactSecrets,
        encrypted: !!params.password,
        scopes,
        db: { entry: BACKUP_DB_ENTRY, bytes: dbBytes, tables },
        files: fileStats,
        totals: { files: fileCount, filesBytes, bytes: dbBytes + filesBytes },
        note: params.note?.trim() || undefined,
      };

      // 4. 打包（进度由 writeArchive 的 onBytes 统一汇报，避免与实际写入量脱节）
      const totalBytes = Math.max(1, manifest.totals.bytes);
      let written = 0;
      report({ phase: "pack", percent: 5, processedBytes: 0, totalBytes, totalItems: fileCount + 1 });
      const entries = async function* (): AsyncGenerator<TarSource> {
        yield { name: BACKUP_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest, null, 2)) };
        if (existsSync(dbSnapshot)) {
          yield { name: BACKUP_DB_ENTRY, source: dbSnapshot, size: dbBytes, mtimeMs: Date.now() };
        }
        let processed = 1;
        for (const plan of filePlan) {
          for (const file of plan.files) {
            aborted();
            yield {
              name: `${BACKUP_FILES_PREFIX}${plan.root.id}/${file.rel}`,
              source: join(plan.dir, file.rel),
              size: file.size,
              mtimeMs: file.mtimeMs,
            };
            report({
              phase: "pack",
              percent: Math.min(99, 5 + Math.round((written / totalBytes) * 94)),
              processedBytes: written,
              totalBytes,
              processedItems: ++processed,
              totalItems: fileCount + 1,
              current: `${plan.root.id}/${file.rel}`,
            });
          }
        }
      };

      const { bytes } = await writeArchive(outPath, entries(), {
        gzip: params.compress !== false,
        password: params.password || undefined,
        signal,
        onBytes: (n) => {
          written += n;
          report({
            phase: "pack",
            percent: Math.min(99, Math.round((written / totalBytes) * 94)),
            processedBytes: written,
            totalBytes,
          });
        },
      });

      // 5. 上传到远端（可选）
      let uploaded: BackupCreateResult["uploaded"];
      let localDeleted = false;
      // 「创建后自动上传」是设置里的常开开关：勾了它就不用每次在创建表单里再勾一次。
      const remoteConfig = readRemoteConfig(ctx);
      const autoUpload = !params.skipAutoUpload && remoteConfig.enabled && remoteConfig.autoUpload;
      if (params.upload || autoUpload) {
        aborted();
        if (!remoteConfig.enabled) throw new Error("已勾选上传，但远端备份未启用或未配置完整");
        report({ phase: "upload", percent: 0, current: basename(outPath), totalBytes: bytes });
        const result = await Remote.uploadBackup({
          config: remoteConfig,
          filePath: outPath,
          fileName: basename(outPath),
          onProgress: (p) =>
            report({
              phase: "upload",
              percent: p.percent,
              processedBytes: p.transferred,
              totalBytes: p.total,
              current: basename(outPath),
            }),
          signal,
        });
        uploaded = result;
        if (remoteConfig.deleteLocalAfterUpload && uploaded) {
          await rm(outPath, { force: true });
          localDeleted = true;
        }
      }

      report({ phase: "cleanup", percent: 99 });
      return { path: outPath, name: fileName, bytes, manifest, uploaded, localDeleted };
    } finally {
      conn?.close();
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    // 失败 / 取消都不留下半截文件：writeArchive 已清理 .part，这里再兜底一次。
    await rm(`${outPath}.part`, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 预览归档
// ---------------------------------------------------------------------------

export interface InspectBackupResult extends BackupInspectResult {}

export async function inspectBackup(params: {
  path: string;
  /** 加密备份必须提供，否则抛 BackupPasswordError。 */
  password?: string;
  signal?: AbortSignal;
}): Promise<BackupInspectResult> {
  const path = resolve(expandHome(params.path));
  if (!existsSync(path)) throw new Error("备份文件不存在");
  let manifest: BackupManifest | null = null;
  for await (const entry of openArchive(path, { password: params.password, signal: params.signal })) {
    if (entry.name === BACKUP_MANIFEST_ENTRY) {
      manifest = JSON.parse((await entry.read()).toString("utf8")) as BackupManifest;
      break;
    }
    await entry.discard();
  }
  if (!manifest) throw new Error("不是有效的 OmniStudio 备份：缺少 manifest.json");
  if (manifest.format !== BACKUP_FORMAT) throw new Error(`备份格式不匹配：${manifest.format}`);
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new Error("备份清单里的版本号不合法（文件可能已损坏）");
  }
  if (manifest.version > BACKUP_VERSION) {
    throw new Error(`备份由更新版本的应用创建（v${manifest.version}），请先升级 OmniStudio`);
  }
  // 清单是归档里的 JSON：字段可能缺失或类型不对。这里一次挡掉，
  // 免得 `manifest.db.tables` 这种取值在恢复页渲染时变成 TypeError（整页白屏）。
  if (!manifest.db || typeof manifest.db !== "object" || typeof manifest.db.entry !== "string") {
    throw new Error("备份清单缺少数据库条目信息（文件可能已损坏）");
  }
  if (manifest.db.tables !== undefined && (typeof manifest.db.tables !== "object" || manifest.db.tables === null)) {
    throw new Error("备份清单里的表统计不合法（文件可能已损坏）");
  }
  if (!Array.isArray(manifest.scopes)) throw new Error("备份清单缺少内容分组信息（文件可能已损坏）");
  const warnings: string[] = [];
  if (manifest.sourceDataDir && resolve(manifest.sourceDataDir) !== resolve(getDataDir())) {
    warnings.push(
      `该备份来自另一台机器或另一个数据目录（${manifest.sourceDataDir}）；路径类设置、文档原文件位置可能需要重新确认`,
    );
  }
  if (manifest.redacted) warnings.push("该备份已剔除明文密钥，恢复后需要重新填写 API Key");
  return {
    manifest,
    scopes: sanitizeScopes(manifest.scopes),
    path,
    bytes: existsSync(path) ? statSync(path).size : 0,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

export interface RestoreBackupParams extends BackupRestoreRequest {
  ctx?: Partial<BackupContext>;
  onProgress?: (p: Omit<BackupProgress, "taskId" | "kind">) => void;
  signal?: AbortSignal;
}

function tableColumns(conn: Database, table: string): string[] {
  try {
    return (conn.query(`pragma table_info("${table}")`).all() as { name: string }[]).map((r) => r.name);
  } catch {
    return [];
  }
}

/** 整表替换：删除当前行 → 从快照灌入（列取交集，兼容老版本备份）。 */function replaceTable(dst: Database, src: Database, table: string): number {
  const dstCols = tableColumns(dst, table);
  const srcCols = new Set(tableColumns(src, table));
  const cols = dstCols.filter((c) => srcCols.has(c));
  if (!cols.length) return -1;
  const list = cols.map((c) => `"${c}"`).join(", ");
  dst.exec(`delete from "${table}"`);
  const insert = dst.prepare(`insert into "${table}" (${list}) values (${cols.map(() => "?").join(", ")})`);
  let rows = 0;
  const cursor = src.query(`select ${list} from "${table}"`).iterate() as Iterable<Record<string, unknown>>;
  for (const row of cursor) {
    insert.run(...(cols.map((c) => (row[c] ?? null) as SQLQueryBindings)));
    rows += 1;
  }
  return rows;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 目标库是否已经有应用表结构。
 *
 * 恢复只做「整表替换」，不建表（内核刻意不 import 数据层，所以拿不到那批迁移）。
 * 数据库还不存在时（新机器、重装后应用从未启动过），替换会对每张表都判定
 * 「本机没有表」并跳过 —— 结果是一次「成功」的恢复，写回 0 条记录 0 个文件，
 * 用户却以为数据回来了。这是备份功能里最不能出错的一条路，宁可明确拒绝。
 */
function hasAppSchema(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  try {
    const conn = new Database(dbPath, { readonly: true });
    try {
      const row = conn.query("select name from sqlite_master where type = 'table' and name = 'settings'").get();
      return Boolean(row);
    } finally {
      conn.close();
    }
  } catch {
    return false;
  }
}

/**
 * 把暂存文件搬到目标路径（恢复语义：同名覆盖）。
 *
 * `rename` 失败只有 EXDEV（暂存目录与目标不在同一文件系统）才值得退回复制。
 * 目标是个目录（EISDIR）或源文件已被前一条重复条目搬走（ENOENT）时复制一样失败，
 * 而那时数据库事务已经提交，会把整次恢复变成「数据回来了但文件一个没写」。
 */
async function writeBackFile(stagedPath: string, dest: string): Promise<void> {
  try {
    await rename(stagedPath, dest);
    return;
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "EXDEV") throw err;
  }
  await copyFile(stagedPath, dest);
  await unlink(stagedPath).catch(() => {});
}

export async function restoreBackup(params: RestoreBackupParams): Promise<BackupRestoreResult> {
  const ctx = currentBackupContext(params.ctx);
  const signal = params.signal;
  const report = params.onProgress ?? (() => {});
  const aborted = () => {
    if (signal?.aborted) throw new Error("已取消");
  };
  const warnings: string[] = [];

  const info = await inspectBackup({ path: params.path, password: params.password, signal });
  const wanted = sanitizeScopes(params.scopes?.length ? params.scopes : info.manifest.scopes);
  const available = wanted.filter((s) => info.scopes.includes(s));
  if (!available.length) throw new Error("所选作用域在该备份里不存在");

  // 外部根（技能库）在数据库被覆盖前先钉住落地目录 —— 见 captureExternalRootDirs。
  const pinnedExternalRoots = captureExternalRootDirs(ctx, ctx.connection ?? null);

  if (!ctx.connection && !hasAppSchema(ctx.dbPath)) {
    throw new Error(
      "本机还没有 OmniStudio 数据库，恢复无法建表（它只做整表替换）。\n" +
        "请先启动一次 OmniStudio 让它在本地初始化数据库，退出后再恢复；" +
        "或直接在应用内「设置 → 数据 → 备份与恢复」里恢复。",
    );
  }

  const staging = join(defaultBackupDir(ctx.dataDir), `.restore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  let stagedDb: string | null = null;
  let restoredFiles = 0;
  let restoredBytes = 0;
  const restoredTables: { table: string; rows: number }[] = [];

  try {
    // 1. 安全备份：恢复是破坏性操作，先留一份"回到现在"的副本。
    let safetyPath: string | undefined;
    if (params.safety !== false) {
      report({ phase: "safety", percent: 0 });
      const safety = await createBackup({
        ctx,
        scopes: available,
        fileName: `pre-restore-${backupFileName()}`,
        note: `恢复前自动备份（来源：${info.path}）`,
        skipAutoUpload: true,
        onProgress: (p) => report({ ...p, phase: "safety", message: "恢复前自动备份当前数据" }),
        signal,
      });
      safetyPath = safety.path;
    }

    // 2. 解包：只取选中的作用域，其余条目直接跳过（不落盘）。
    aborted();
    report({ phase: "unpack", percent: 0, totalBytes: info.bytes });
    await mkdir(staging, { recursive: true });
    const stagedFiles: { root: BackupFileRoot; relInRoot: string; stagedPath: string }[] = [];
    const seenStaged = new Set<string>();
    const dbEntry = info.manifest.db.entry || BACKUP_DB_ENTRY;
    let read = 0;

    for await (const entry of openArchive(info.path, { password: params.password, signal })) {
      read += entry.size;
      if (entry.name === dbEntry) {
        stagedDb = join(staging, "omni-studio.db");
        await entry.saveTo(stagedDb);
        continue;
      }
      const classified = classifyArchiveEntry(entry.name);
      if (!classified || !available.includes(classified.scope)) {
        await entry.discard();
        continue;
      }
      const root = BACKUP_FILE_ROOTS.find((r) => r.id === classified.rootId);
      if (!root) {
        await entry.discard();
        continue;
      }
      // 归档来自外部输入：落盘路径必须过一遍越界校验，避免 `../` 写到数据目录外。
      const stagedPath = safeJoin(join(staging, "files"), `${root.id}/${classified.relInRoot}`);
      if (!stagedPath) {
        await entry.discard();
        warnings.push(`已跳过可疑路径：${entry.name}`);
        continue;
      }
      // `a/../b` 与 `b` 归一化到同一个暂存路径：后者会让先落盘的文件被覆盖、
      // 写回时 rename 又找不到源文件，整次恢复在数据库已提交后半途失败。
      if (seenStaged.has(stagedPath)) {
        await entry.discard();
        warnings.push(`归档里有重复条目，已跳过：${entry.name}`);
        continue;
      }
      seenStaged.add(stagedPath);
      await entry.saveTo(stagedPath);
      stagedFiles.push({ root, relInRoot: classified.relInRoot, stagedPath });
      restoredBytes += entry.size;
      report({
        phase: "unpack",
        percent: Math.min(40, Math.round((read / Math.max(1, info.bytes)) * 40)),
        current: entry.name,
        processedItems: stagedFiles.length,
      });
    }

    // 3. 写回数据库
    if (stagedDb) {
      aborted();
      report({ phase: "database", percent: 45, message: "打开快照" });
      const snapshot = new Database(stagedDb, { readonly: true });
      const ownConn = ctx.connection ? null : new Database(ctx.dbPath);
      const dst = ctx.connection ?? ownConn!;
      try {
        const keep = new Set(tablesForScopes(available));
        const manifestTables = Object.keys(info.manifest.db.tables ?? {});
        dst.exec("begin immediate");
        try {
          for (const table of keep) {
            aborted();
            if (!manifestTables.includes(table)) continue;
            if (!tableColumns(dst, table).length) {
              warnings.push(`本机没有表 ${table}，已跳过（应用版本差异）`);
              continue;
            }
            report({ phase: "database", percent: 50, current: table });
            const rows = replaceTable(dst, snapshot, table);
            if (rows >= 0) restoredTables.push({ table, rows });
          }
          dst.exec("commit");
        } catch (err) {
          dst.exec("rollback");
          throw err;
        }
        rewriteAbsolutePaths(dst, info.manifest.sourceDataDir, ctx.dataDir, warnings);
      } finally {
        snapshot.close();
        ownConn?.close();
      }
      report({ phase: "database", percent: 70, processedItems: restoredTables.length });
    }

    // 4. 写回文件（同名覆盖，不删除备份里没有的文件 —— 恢复不该顺手删东西）
    aborted();
    if (stagedFiles.length) {
      report({ phase: "files", percent: 72, totalItems: stagedFiles.length });
      // 数据目录内的根按当前数据目录拼；外部根用恢复前钉住的目录（不看归档里的设置）。
      const liveConn = existsSync(ctx.dbPath) ? new Database(ctx.dbPath, { readonly: true }) : null;
      let done = 0;
      try {
        const dirCache = new Map<string, string | null>();
        const resolveRootDir = (root: BackupFileRoot): string | null =>
          root.rel ? rootDirOf(root, ctx, null) : (pinnedExternalRoots.get(root.id) ?? null);
        for (const item of stagedFiles) {
          aborted();
          if (!dirCache.has(item.root.id)) dirCache.set(item.root.id, resolveRootDir(item.root));
          const rootDir = dirCache.get(item.root.id);
          if (!rootDir) {
            if (!warnings.includes(`目标目录不存在，已跳过：${item.root.id}`)) {
              warnings.push(`目标目录不存在，已跳过：${item.root.id}`);
            }
            continue;
          }
          const dest = safeJoin(rootDir, item.relInRoot);
          if (!dest || !isInsideDir(rootDir, dest)) {
            warnings.push(`已跳过可疑路径：${item.root.id}/${item.relInRoot}`);
            continue;
          }
          await mkdir(dirname(dest), { recursive: true });
          try {
            await writeBackFile(item.stagedPath, dest);
          } catch (err) {
            // 数据库事务此时已提交，单个文件写不进去不该让整次恢复失败；
            // 如实报出来，用户至少知道哪个文件没落盘。
            warnings.push(`文件写入失败，已跳过：${item.root.id}/${item.relInRoot}（${errText(err)}）`);
            continue;
          }
          restoredFiles += 1;
          report({
            phase: "files",
            percent: Math.min(99, 72 + Math.round((done / stagedFiles.length) * 27)),
            processedItems: ++done,
            totalItems: stagedFiles.length,
            current: `${item.root.id}/${item.relInRoot}`,
          });
        }
      } finally {
        warnIfExternalRootMoved(liveConn, pinnedExternalRoots, warnings);
        liveConn?.close();
      }
    }

    report({ phase: "cleanup", percent: 99 });
    return {
      path: info.path,
      scopes: available,
      tables: restoredTables,
      files: restoredFiles,
      bytes: restoredBytes,
      safetyPath,
      warnings,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 跨机器恢复时数据库里存的绝对路径会指向旧数据目录。
 * 这里只改「本应用自己生成的」这一类（抽取页图片目录），
 * 用户自己的源文件路径（documents.path / knowledge_docs.source_path）不做改动。
 */
function rewriteAbsolutePaths(
  dst: Database,
  sourceDataDir: string,
  dataDir: string,
  warnings: string[],
): void {
  if (!sourceDataDir || resolve(sourceDataDir) === resolve(dataDir)) return;
  try {
    if (!tableColumns(dst, "documents").includes("images_dir")) return;
    const rows = dst
      .query("select id, images_dir as dir from documents where images_dir is not null and images_dir <> ''")
      .all() as { id: number; dir: string }[];
    const update = dst.prepare("update documents set images_dir = ? where id = ?");
    let fixed = 0;
    for (const row of rows) {
      if (!row.dir.startsWith(sourceDataDir)) continue;
      const rel = relative(sourceDataDir, row.dir);
      if (!rel || rel.startsWith("..")) continue;
      update.run(join(dataDir, rel), row.id);
      fixed += 1;
    }
    if (fixed > 0) warnings.push(`已把 ${fixed} 条文档图片目录指向当前数据目录`);
  } catch {
    // 表结构差异等情况：不改动，也不阻断恢复
  }
}

// ---------------------------------------------------------------------------
// 列表 / 删除
// ---------------------------------------------------------------------------

export async function listBackups(params?: { dir?: string; password?: string }): Promise<{ dir: string; backups: BackupSummary[] }> {
  const dir = params?.dir ? resolve(expandHome(params.dir)) : defaultBackupDir();
  if (!existsSync(dir)) return { dir, backups: [] };
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".omnibackup"));
  } catch {
    return { dir, backups: [] };
  }
  const backups: BackupSummary[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const encrypted = await isEncryptedFile(path);
    const summary: BackupSummary = {
      path,
      name,
      bytes: existsSync(path) ? statSync(path).size : 0,
      createdAt: 0,
      appVersion: "",
      scopes: [],
      redacted: false,
      encrypted,
      totals: { files: 0, filesBytes: 0, bytes: 0 },
    };
    try {
      // 加密备份不带密码时读不到清单：列表只显示"已加密"，不算损坏。
      const info = await inspectBackup({ path, password: params?.password });
      summary.createdAt = info.manifest.createdAt;
      summary.appVersion = info.manifest.appVersion;
      summary.scopes = info.scopes;
      summary.redacted = info.manifest.redacted;
      summary.note = info.manifest.note;
      summary.totals = info.manifest.totals;
    } catch (err) {
      if (!encrypted || !isBackupPasswordError(err)) {
        summary.error = errText(err);
      }
      summary.createdAt = summary.bytes ? statSync(path).mtimeMs : 0;
    }
    backups.push(summary);
  }
  backups.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
  return { dir, backups };
}

/**
 * 这个文件是不是一份备份归档 —— 删除前必须确认。
 *
 * 只校验「在不在调用方给的目录里」没有意义：`dir` 与 `path` 来自同一个调用方
 * （webview / 控制通道），把任意文件的父目录当 dir 传进来就绕过了。真正的护栏是
 * 「文件本身必须是备份」：扩展名 + 备份魔数（明文 gzip / 加密容器）都对才允许删。
 */
async function isBackupArchive(path: string): Promise<boolean> {
  if (!path.endsWith(`.${BACKUP_FILE_EXT}`)) return false;
  if (await isEncryptedFile(path)) return true;
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    return bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

export async function deleteBackup(params: { path: string; dir?: string }): Promise<{ ok: boolean; error?: string }> {
  const path = resolve(expandHome(params.path));
  // 路径来自 webview / 控制通道，不可信：先看目录边界，再确认它确实是备份文件。
  const dir = params.dir ? resolve(expandHome(params.dir)) : defaultBackupDir();
  if (!isInsideDir(dir, path)) return { ok: false, error: "只能删除备份目录内的文件" };
  if (!(await isBackupArchive(path))) return { ok: false, error: "只能删除备份文件（*.omnibackup）" };
  try {
    await rm(path, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// 任务式（非阻塞）入口：RPC / UI 用
// ---------------------------------------------------------------------------

export function startCreateBackup(params: Omit<CreateBackupParams, "onProgress" | "signal">): { taskId: string } {
  return runTask("create", (signal, sink) =>
    createBackup({ ...params, onProgress: sink, signal }),
  );
}

export function startRestoreBackup(params: Omit<RestoreBackupParams, "onProgress" | "signal">): { taskId: string } {
  return runTask("restore", (signal, sink) =>
    restoreBackup({ ...params, onProgress: sink, signal }),
  );
}

/** 从远端下载一份备份到本地备份目录（随后走常规的预览 / 恢复流程）。 */
export function startDownloadRemoteBackup(params: {
  ctx?: Partial<BackupContext>;
  fileName: string;
}): { taskId: string } {
  return runTask("download", async (signal, sink) => {
    const result = await downloadRemoteBackup({
      ctx: params.ctx,
      fileName: params.fileName,
      onProgress: sink,
      signal,
    });
    return { ...result, name: params.fileName };
  });
}

/** 备份目录的可写自检（选自定义目录后调用，提前暴露权限问题）。 */
export async function checkWritableDir(dir: string): Promise<{ ok: boolean; error?: string; freeBytes?: number }> {
  const target = resolve(expandHome(dir));
  try {
    await mkdir(target, { recursive: true });
    const probe = join(target, `.omni-write-test-${Date.now().toString(36)}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    const fsStat = await statfs(target);
    return { ok: true, freeBytes: Number(fsStat.bavail) * Number(fsStat.bsize) };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/** 供 UI 展示：当前这份备份会不会包含某类文件（作用域 → 文件根）。 */
export function rootsForScope(scope: BackupScopeId): BackupFileRoot[] {
  return BACKUP_FILE_ROOTS.filter((r) => r.scope === scope && r.defaultOn);
}
