import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";

import { optBool, optString, type ParsedArgs } from "../args";
import { isAppRunning } from "../client";
import { resolveDataDir, rootVersion } from "../data-dir";
import { formatBytes, printTable } from "../format";
import { helpFor } from "../help";
import { isBackupPasswordError } from "../../bun/backup/archive";
import { translate } from "../../shared/i18n";
import {
  BACKUP_SCOPES,
  sanitizeScopes,
  type BackupProgress,
  type BackupScopeId,
} from "../../shared/backup";
import {
  createBackup,
  currentBackupContext,
  defaultBackupDir,
  deleteRemoteBackup,
  downloadRemoteBackup,
  inspectBackup,
  isRemoteConfigured,
  listBackups,
  listRemoteBackups,
  readRemoteConfig,
  resolveDbPath,
  restoreBackup,
  testRemote,
} from "../../bun/backup";

/**
 * `omi backup` — 全局备份 / 恢复的命令行入口。
 *
 * 与应用内「设置 → 数据 → 备份与恢复」共用同一个内核（src/bun/backup），
 * 但**不依赖应用运行**：备份内核刻意不 import 数据层（迁移）与 electrobun，
 * 所以应用没启动、甚至因迁移失败起不来时，依然能备份或把数据恢复回去。
 *
 * restore 是唯一要求"独占"的操作：应用在运行时写同一份数据库会互相踩，
 * 因此运行中就拒绝，提示先去应用里退出（或在应用内直接恢复）。
 */

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);
const scopeLabel = (id: BackupScopeId) => zh(`backup.scope.${id}.title`);

/** 独立进程的备份上下文：先钉住数据目录，模块内 getDataDir() 才会读同一处。 */
function backupContext() {
  const dataDir = process.env.OMNI_DATA_DIR ?? resolveDataDir();
  process.env.OMNI_DATA_DIR = dataDir;
  return { dataDir, dbPath: resolveDbPath(), appVersion: rootVersion() ?? "unknown" };
}

/** 进度：TTY 下原地刷新一行，非 TTY（管道 / CI）按阶段打行。 */
function progressPrinter() {
  let lastPhase: string | null = null;
  let lastPercent = -100;
  const tty = !!process.stderr.isTTY;
  return {
    onProgress: (p: Omit<BackupProgress, "taskId" | "kind">) => {
      const label = zh(`backup.phase.${p.phase}`);
      const percent = p.percent;
      const worthPrinting =
        p.phase !== lastPhase || (percent != null && percent - lastPercent >= 10);
      if (!worthPrinting) return;
      lastPhase = p.phase;
      if (percent != null) lastPercent = percent;
      const line = `${label}${percent != null ? ` ${percent}%` : ""}${p.current ? ` · ${p.current}` : ""}`;
      if (tty) process.stderr.write(`\r\x1b[2K${line}`);
      else console.error(line);
    },
    clear: () => {
      if (tty) process.stderr.write("\r\x1b[2K");
    },
  };
}

/** `--scopes a,b` → 作用域列表；未指定时用默认勾选项。 */
function parseScopes(parsed: ParsedArgs): { scopes: BackupScopeId[]; unknown: string[] } {
  const raw = optString(parsed.options, "scopes");
  if (raw === undefined) {
    return { scopes: BACKUP_SCOPES.filter((s) => s.defaultOn).map((s) => s.id), unknown: [] };
  }
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const known = new Set(BACKUP_SCOPES.map((s) => s.id as string));
  return {
    scopes: sanitizeScopes(wanted),
    unknown: wanted.filter((s) => !known.has(s)),
  };
}

function printScopeHelp(): void {
  console.log("可用的内容分组（--scopes，逗号分隔）：");
  for (const def of BACKUP_SCOPES) {
    console.log(`  ${def.id.padEnd(10)} ${scopeLabel(def.id)}${def.defaultOn ? "（默认包含）" : ""}`);
  }
}

/**
 * 密码来源：`--password <值>` 或 `--password-file <文件>`（后者不进 shell 历史）。
 * 都没有时返回 undefined，调用方在遇到加密归档时会提示。
 */
async function readPassword(parsed: ParsedArgs): Promise<string | undefined> {
  const file = optString(parsed.options, "password-file");
  if (file) {
    if (!existsSync(file)) {
      console.error(`密码文件不存在：${file}`);
      process.exitCode = 1;
      return undefined;
    }
    return (await Bun.file(file).text()).trim();
  }
  return optString(parsed.options, "password");
}

const t = (key: string, params?: Record<string, string>) => translate("zh", key, params);

/** 需要密码时补一次交互输入（TTY 才有），避免用户重跑一遍长命令。 */
async function askPassword(reason: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${reason}密码：`);
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}

function requireFile(parsed: ParsedArgs): string | null {
  const file = parsed.positionals[1]?.trim();
  if (!file) {
    console.error("缺少备份文件路径。用法：omi backup inspect <file.omnibackup>");
    process.exitCode = 1;
    return null;
  }
  if (!existsSync(file)) {
    console.error(`文件不存在：${file}`);
    process.exitCode = 1;
    return null;
  }
  return file;
}

async function cmdList(parsed: ParsedArgs): Promise<void> {
  const ctx = backupContext();
  const dir = optString(parsed.options, "dir");
  const { dir: used, backups } = await listBackups({ dir });
  if (optBool(parsed.options, "json")) {
    console.log(JSON.stringify({ dir: used, backups }, null, 2));
    return;
  }
  console.log(`备份目录：${used}${used === defaultBackupDir(ctx.dataDir) ? "（默认）" : ""}`);
  if (backups.length === 0) {
    console.log("还没有备份。用 'omi backup create' 创建一个。");
    return;
  }
  printTable(
    ["文件", "创建时间", "大小", "内容", "备注"],
    backups.map((b) => [
      b.name,
      b.createdAt ? new Date(b.createdAt).toLocaleString() : "—",
      formatBytes(b.bytes),
      b.error ? "（无法解析）" : b.scopes.map(scopeLabel).join("、"),
      b.error ?? b.note ?? "",
    ]),
  );
}

async function cmdCreate(parsed: ParsedArgs): Promise<void> {
  const ctx = backupContext();
  const { scopes, unknown } = parseScopes(parsed);
  if (unknown.length > 0) {
    console.error(`未知的内容分组：${unknown.join(", ")}`);
    printScopeHelp();
    process.exitCode = 1;
    return;
  }
  if (scopes.length === 0) {
    console.error("至少要选择一个内容分组。");
    printScopeHelp();
    process.exitCode = 1;
    return;
  }

  const out = optString(parsed.options, "out");
  const upload = optBool(parsed.options, "upload");
  const remote = readRemoteConfig(ctx);
  if (upload && !isRemoteConfigured(remote)) {
    console.error("已指定 --upload，但远端存储未启用或配置不完整。先在应用内「设置 → 数据 → 备份与恢复 → 远端存储」配置。");
    process.exitCode = 1;
    return;
  }
  const password = await readPassword(parsed);
  const printer = progressPrinter();
  console.error(`开始备份（${scopes.map(scopeLabel).join("、")}）${password ? "，已加密" : ""}${upload ? "，完成后上传" : ""}…`);
  const result = await createBackup({
    ctx,
    scopes,
    destinationDir: out,
    fileName: optString(parsed.options, "name"),
    note: optString(parsed.options, "note"),
    redactSecrets: optBool(parsed.options, "redact"),
    compress: !optBool(parsed.options, "no-compress"),
    password,
    upload,
    onProgress: printer.onProgress,
  });
  printer.clear();

  if (optBool(parsed.options, "json")) {
    console.log(
      JSON.stringify(
        {
          path: result.path,
          bytes: result.bytes,
          manifest: result.manifest,
          uploaded: result.uploaded,
          localDeleted: result.localDeleted,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (result.localDeleted) {
    console.log(`✓ 备份已上传（本地文件已按设置删除）：${result.uploaded?.location}`);
  } else {
    console.log(`✓ 备份已创建：${result.path}`);
  }
  if (result.uploaded && !result.localDeleted) console.log(`  已上传到：${result.uploaded.location}`);
  console.log(`  大小：${formatBytes(result.bytes)} · 数据库快照 ${formatBytes(result.manifest.db.bytes)}`);
  console.log(
    `  内容：${result.manifest.scopes.map(scopeLabel).join("、")}（${result.manifest.totals.files} 个文件）`,
  );
  if (result.manifest.redacted) console.log("  已剔除明文 API Key：恢复后需要重新填写。");
  if (result.manifest.encrypted) console.log("  已加密：恢复时需要密码（--password / --password-file）。");
  if (!result.localDeleted) console.log(`  恢复：omi backup restore "${result.path}"`);
}

async function cmdInspect(parsed: ParsedArgs): Promise<void> {
  const file = requireFile(parsed);
  if (!file) return;
  let info;
  try {
    info = await inspectBackup({ path: file, password: await readPassword(parsed) });
  } catch (err) {
    if (isBackupPasswordError(err)) {
      const password = await askPassword(`${(err as Error).message}，请输入`);
      if (!password) {
        console.error(`${(err as Error).message}。用 --password 或 --password-file 提供密码。`);
        process.exitCode = 1;
        return;
      }
      info = await inspectBackup({ path: file, password });
    } else {
      throw err;
    }
  }
  if (optBool(parsed.options, "json")) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  const m = info.manifest;
  console.log(`备份文件：${info.path}`);
  console.log(`  大小：${formatBytes(info.bytes)} · 创建于 ${new Date(m.createdAt).toLocaleString()}`);
  console.log(`  来源：应用版本 ${m.appVersion} · ${m.platform} · 数据目录 ${m.sourceDataDir}`);
  console.log(`  备注：${m.note ?? "（无）"}`);
  console.log(`  含：${info.scopes.map(scopeLabel).join("、")}`);
  console.log(`  数据记录：${Object.values(m.db.tables).reduce((a, b) => a + b, 0)} 条 · ${m.totals.files} 个文件`);
  printTable(
    ["内容分组", "表", "记录数"],
    Object.entries(m.db.tables)
      .filter(([, rows]) => rows > 0)
      .map(([table, rows]) => [
        BACKUP_SCOPES.find((s) => s.tables.includes(table))?.id ?? "—",
        table,
        String(rows),
      ]),
  );
  for (const warning of info.warnings) console.log(`  ⚠ ${warning}`);
}

async function cmdRestore(parsed: ParsedArgs): Promise<void> {
  const file = requireFile(parsed);
  if (!file) return;
  if (await isAppRunning()) {
    console.error(
      "OmniStudio 正在运行，恢复需要独占数据库。\n" +
        "请先退出应用，或直接在应用内「设置 → 数据 → 备份与恢复」中恢复（那里可以看进度、跑完自动刷新界面）。",
    );
    process.exitCode = 1;
    return;
  }

  const ctx = backupContext();
  const password = await readPassword(parsed);
  let info;
  try {
    info = await inspectBackup({ path: file, password });
  } catch (err) {
    if (isBackupPasswordError(err)) {
      const prompt = await askPassword(`${(err as Error).message}，请输入`);
      if (!prompt) {
        console.error(`${(err as Error).message}。用 --password 或 --password-file 提供密码。`);
        process.exitCode = 1;
        return;
      }
      info = await inspectBackup({ path: file, password: prompt });
    } else {
      throw err;
    }
  }
  const effectivePassword = password ?? (await readPassword(parsed));
  const raw = optString(parsed.options, "scopes");
  let scopes = info.scopes;
  if (raw !== undefined) {
    const wanted = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const picked = sanitizeScopes(wanted).filter((s) => info.scopes.includes(s));
    if (picked.length === 0) {
      console.error(`备份里没有这些内容分组：${wanted.join(", ")}`);
      console.error(`备份包含：${info.scopes.map((s) => `${s}（${scopeLabel(s)}）`).join("、")}`);
      process.exitCode = 1;
      return;
    }
    scopes = picked;
  }
  const safety = !optBool(parsed.options, "no-safety");

  if (!optBool(parsed.options, "yes")) {
    console.log(`将用备份里的数据覆盖以下内容：${scopes.map(scopeLabel).join("、")}`);
    console.log(`数据来源：${info.path}（${new Date(info.manifest.createdAt).toLocaleString()}）`);
    if (safety) console.log("恢复前会自动备份当前数据（--no-safety 可关闭）。");
    if (!process.stdin.isTTY) {
      console.error("非交互环境：确认后请加 --yes 重跑。");
      process.exitCode = 1;
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("确认恢复？[y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("已取消。");
      return;
    }
  }

  const printer = progressPrinter();
  const result = await restoreBackup({
    ctx,
    path: file,
    password,
    scopes,
    safety,
    onProgress: printer.onProgress,
  });
  printer.clear();

  if (optBool(parsed.options, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const rows = result.tables.reduce((sum, x) => sum + x.rows, 0);
  console.log(`✓ 恢复完成：写回 ${rows} 条记录、${result.files} 个文件`);
  if (result.safetyPath) console.log(`  恢复前的数据已备份到：${result.safetyPath}`);
  for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
  console.log("  部分设置需要重启应用后生效。");
}

/** `omi backup remote <list|test|download>`：远端存储（S3 / WebDAV）。 */
async function cmdRemote(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1];
  const ctx = backupContext();
  const config = readRemoteConfig(ctx);
  if (!isRemoteConfigured(config)) {
    console.error("远端存储未启用或配置不完整。请在应用内「设置 → 数据 → 备份与恢复 → 远端存储」配置（类型 / 地址 / 凭据）。");
    process.exitCode = 1;
    return;
  }

  switch (sub) {
    case "list": {
      const entries = await listRemoteBackups(ctx);
      if (optBool(parsed.options, "json")) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log(`远端还没有备份（${config.kind === "s3" ? config.bucket : config.endpoint}）。`);
        return;
      }
      printTable(
        ["文件", "修改时间", "大小"],
        entries.map((e) => [
          e.name,
          e.modifiedAt ? new Date(e.modifiedAt).toLocaleString() : "—",
          formatBytes(e.bytes),
        ]),
      );
      return;
    }
    case "test": {
      const result = await testRemote(ctx);
      if (result.ok) {
        console.log(`✓ 远端可访问：${result.detail ?? ""}`);
        return;
      }
      console.error(`✗ ${result.error ?? "连接失败"}`);
      process.exitCode = 1;
      return;
    }
    case "download": {
      const name = parsed.positionals[2]?.trim();
      if (!name) {
        console.error("缺少文件名。用法：omi backup remote download <file.omnibackup>");
        process.exitCode = 1;
        return;
      }
      const printer = progressPrinter();
      const { path, bytes } = await downloadRemoteBackup({
        ctx,
        fileName: name,
        onProgress: printer.onProgress,
      });
      printer.clear();
      console.log(`✓ 已下载到 ${path}（${formatBytes(bytes)}）`);
      console.log(`  恢复：omi backup restore "${path}"`);
      return;
    }
    case "help":
      console.log(helpFor(["backup", "remote"]));
      return;
    default:
      console.error(sub ? `未知子命令：backup remote ${sub}` : "缺少子命令：backup remote <list|test|download>");
      console.log(helpFor(["backup"]));
      process.exitCode = 1;
      return;
  }
}

export async function cmdBackup(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[0];
  switch (sub) {
    case "list":
    case "ls":
      return cmdList(parsed);
    case "create":
      return cmdCreate(parsed);
    case "inspect":
      return cmdInspect(parsed);
    case "restore":
      return cmdRestore(parsed);
    case "remote":
      return cmdRemote(parsed);
    case "help":
      console.log(helpFor(["backup", parsed.positionals[1]]));
      return;
    default:
      console.error(sub ? `未知子命令：backup ${sub}` : "缺少子命令：backup <list|create|inspect|restore|remote>");
      console.log(helpFor(["backup"]));
      process.exitCode = 1;
      return;
  }
}
