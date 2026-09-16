/**
 * omi diag —— 一条命令采集"这个 App 到底怎么了"的完整现场。
 *
 * 只为排查服务：全部只读，不改设置、不启动服务、不删文件；应用没运行也能跑
 * （这正是它和 `omi status` 的区别 —— 起不来 / 闪退的场景才是它最重要的用途）。
 *
 * 采集内容：
 *   1. 环境：版本 / 渠道 / 数据目录 / 数据库 / 平台；
 *   2. 应用是否在运行（控制 socket ping），推理服务器与网关状态、最后的错误；
 *   3. 统一日志 logs/app.log 里的 warn / error（按子系统归类）+ 日志文件清单；
 *   4. 媒体服务端口占用者的身份（serving / shared / blocked）；
 *   5. 数据库里最近失败的记录：生图 / 生视频 / 生音乐 / 语音 / 文档 / 基准 / 自动化 / Agent 事件；
 *   6. 相关配置是否就位（密钥只报"有没有"，不打印值）；
 *   7. 数据目录磁盘剩余空间（下载失败的常见原因）。
 *
 * 用法：
 *   bun run scripts/omni-diag.ts            人类可读报告
 *   bun run scripts/omni-diag.ts --json     机器可读（给 Agent / 工单用）
 *   bun run scripts/omni-diag.ts --logs 50  日志条数（默认 30）
 *
 * ⚠️ 报告可能含本地路径与提示词，贴到公开渠道前先过一眼。
 */
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from "fs";
import { Database } from "bun:sqlite";
import { homedir, tmpdir } from "os";
import path from "path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const logsIndex = args.indexOf("--logs");
const logLimit = logsIndex !== -1 ? Number(args[logsIndex + 1]) || 30 : 30;

const APP_IDENTIFIER = "omni-studio.kunpengtalk.com";
const MEDIA_PORT = 19782;

function dataDir(): string {
  if (process.env.OMNI_DATA_DIR) return process.env.OMNI_DATA_DIR;
  const channels = ["dev", "canary", "stable"];
  const base = path.join(homedir(), "Library", "Application Support", APP_IDENTIFIER);
  // 取最近使用过的渠道目录（与 CLI 的探测策略一致）。
  let best: { dir: string; mtime: number } | null = null;
  for (const channel of channels) {
    const dir = path.join(base, channel);
    try {
      const mtime = statSync(path.join(dir, "omni-studio.db")).mtimeMs;
      if (!best || mtime > best.mtime) best = { dir, mtime };
    } catch {
      // 该渠道没跑过
    }
  }
  return best?.dir ?? path.join(base, "dev");
}

const DATA_DIR = dataDir();
const DB_PATH = process.env.OMNI_DB_PATH ?? path.join(DATA_DIR, "omni-studio.db");
const LOG_DIR = path.join(DATA_DIR, "logs");
const SOCKET = process.env.OMNI_CONTROL_SOCKET ?? path.join(DATA_DIR, "omni-control.sock");

type Section = { title: string; lines: string[] };

async function control(cmd: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; data?: any; error?: string; connected: boolean }> {
  if (!existsSync(SOCKET)) return { ok: false, connected: false, error: "控制 socket 不存在（应用未运行）" };
  try {
    const res = await fetch("http://control", {
      unix: SOCKET,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd, payload }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
    return { ok: body.ok, data: body.data, error: body.error, connected: true };
  } catch (err) {
    return { ok: false, connected: false, error: String(err) };
  }
}

/** 读统一日志（应用没运行时直接读文件；与主进程 app-log.ts 同一格式）。 */
function readLogs(limit: number, level?: "warn" | "error"): { entries: any[]; files: string[] } {
  const rank: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const minRank = level ? rank[level]! : 0;
  const files = existsSync(LOG_DIR)
    ? readdirSync(LOG_DIR)
        .filter((n) => n === "app.log" || (n.startsWith("app-") && n.endsWith(".log")))
        .sort()
        .map((n) => path.join(LOG_DIR, n))
    : [];
  const entries: any[] = [];
  for (const file of [...files].reverse()) {
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if ((rank[entry.level] ?? 0) < minRank) continue;
        entries.push(entry);
      } catch {
        // 半行 / 手工编辑
      }
    }
    if (entries.length >= limit * 3) break;
  }
  entries.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
  return { entries: entries.slice(0, limit), files };
}

/** 媒体服务身份探测：区分「本实例 / 同数据的另一个实例 / 别的数据目录」。 */
async function probeMediaServer(): Promise<{ state: string; detail: string }> {
  const expected = createHash("sha1").update(path.resolve(path.join(DATA_DIR, "images"))).digest("hex").slice(0, 12);
  try {
    const res = await fetch(`http://127.0.0.1:${MEDIA_PORT}/__omni/media-id`, { signal: AbortSignal.timeout(2500) });
    const body = (await res.json()) as { id?: string; pid?: number };
    if (body.id === expected) return { state: "serving", detail: `本实例正在服务（pid ${body.pid ?? "?"}）` };
    return {
      state: "blocked",
      detail: `端口被另一个数据目录的实例占用（对方 id ${body.id}，本实例应为 ${expected}）—— 图片/音频预览会失败或串数据`,
    };
  } catch {
    return { state: "down", detail: `127.0.0.1:${MEDIA_PORT} 上没有可用的媒体服务（应用没运行？）` };
  }
}

/** 只读查库：失败记录 + 配置就位情况。 */
function readDb(): { sections: Section[]; warnings: string[] } {
  const sections: Section[] = [];
  const warnings: string[] = [];
  if (!existsSync(DB_PATH)) {
    warnings.push(`数据库不存在：${DB_PATH}`);
    return { sections, warnings };
  }
  let sqlite: Database;
  try {
    // 只读打开：诊断脚本绝不能改动用户数据（WAL 下也可以安全并发读）。
    sqlite = new Database(DB_PATH, { readonly: true });
  } catch (err) {
    warnings.push(`打不开数据库（可能被迁移中 / 权限问题）：${String(err)}`);
    return { sections, warnings };
  }

  const query = (sql: string): any[] => {
    try {
      return sqlite.query(sql).all();
    } catch (err) {
      // 表结构与版本有关（旧库缺列）：跳过而不是让整份报告失败。
      return [{ _error: String(err) }];
    }
  };

  // 查询失败时第一行会带 _error（旧库表结构不符），报告里说清楚而不是当成"没有失败记录"。
  const show = (rows: any[], format: (row: any) => string): string[] => {
    if (!rows.length) return ["（无）"];
    if (rows[0]?._error) return [`（查询失败，可能是旧库表结构：${String(rows[0]._error).slice(0, 120)}）`];
    return rows.map(format);
  };

  const images = query(
    "select id, backend, model, substr(coalesce(prompt,''),1,60) as prompt, error, datetime(created_at/1000,'unixepoch','localtime') as at from image_records where status='failed' order by id desc limit 5",
  );
  const videos = query(
    "select id, backend, substr(coalesce(prompt,''),1,60) as prompt, error, datetime(created_at/1000,'unixepoch','localtime') as at from video_records where status='failed' order by id desc limit 5",
  );
  const musics = query(
    "select id, backend, music_api, substr(coalesce(caption,''),1,60) as caption, error, datetime(created_at/1000,'unixepoch','localtime') as at from music_records where status='failed' order by id desc limit 5",
  );
  const docs = query(
    "select id, path, status, error from documents where status='failed' order by id desc limit 5",
  );
  const benches = query(
    "select id, model, status, error from benchmark_records where status='error' order by id desc limit 5",
  );
  const runs = query(
    "select id, automation_id, status, error, datetime(coalesce(finished_at,started_at)/1000,'unixepoch','localtime') as at from automation_runs where status='failed' order by id desc limit 5",
  );
  // 文档失败时 documents.error 常为空，真正的错误在 pages.error（逐页 OCR）。
  const failedPages = query(
    "select document_id, page_number, status, substr(coalesce(error,''),1,160) as error from pages where status='failed' order by id desc limit 5",
  );
  const agentErrors = query(
    "select id, conversation_id, tool_name, substr(coalesce(output,''),1,140) as output, datetime(created_at/1000,'unixepoch','localtime') as at from agent_events where kind='error' order by id desc limit 5",
  );
  // 语音：TTS / ASR 失败目前不进 status（见 tts-local.ts / asr.ts 的错误抛出路径），
  // 所以这里列"最近几条记录"，用"有没有产出"判断链路是否走通。
  const voices = query(
    "select id, kind, status, model, audio_path, error, datetime(created_at/1000,'unixepoch','localtime') as at from voice_records order by id desc limit 5",
  );

  sections.push({
    title: "最近失败：生图（image_records）",
    lines: show(images, (r) => `#${r.id} [${r.backend}] ${r.model ?? "-"} ${r.at}\n    ${r.error}`),
  });
  sections.push({
    title: "最近失败：生视频（video_records）",
    lines: show(videos, (r) => `#${r.id} [${r.backend}] ${r.at}\n    ${r.error}`),
  });
  sections.push({
    title: "最近失败：生音乐（music_records）",
    // music_api 要一起打出来：同一张表里躺着两种执行模型（stepfun 异步 / minimax 同步），
    // 排查时第一件事就是确认这条走的是哪条协议。
    lines: show(musics, (r) => `#${r.id} [${r.backend}/${r.music_api ?? "-"}] ${r.at}\n    ${r.error}`),
  });
  sections.push({
    title: "最近失败：文档解析（documents）",
    lines: show(docs, (r) => `#${r.id} ${path.basename(String(r.path ?? ""))} ${r.status}\n    ${r.error}`),
  });
  if (failedPages.length && !failedPages[0]?._error) {
    sections.push({
      title: "最近失败：文档逐页（pages，documents.error 为空时看这里）",
      lines: failedPages.map((r: any) => `文档 #${r.document_id} 第 ${r.page_number} 页\n    ${r.error}`),
    });
  }
  sections.push({
    title: "最近失败：基准（benchmark_records）",
    lines: show(benches, (r) => `#${r.id} ${r.model} ${r.status}\n    ${r.error}`),
  });
  sections.push({
    title: "最近失败：自动化（automation_runs）",
    lines: show(runs, (r) => `#${r.id} automation ${r.automation_id} ${r.at}\n    ${r.error}`),
  });
  sections.push({
    title: "最近 Agent 错误事件（agent_events）",
    lines: show(agentErrors, (r) => `#${r.id} 会话 ${r.conversation_id} ${r.tool_name ?? ""} ${r.at}\n    ${r.output}`),
  });
  sections.push({
    title: "最近语音记录（voice_records：TTS / ASR / 克隆）",
    lines: show(
      voices,
      (r) => `#${r.id} ${r.kind} ${r.status} ${r.at}${r.audio_path ? `\n    产出：${r.audio_path}` : "（无产出文件）"}${r.error ? `\n    ${r.error}` : ""}`,
    ),
  });

  // 配置就位情况：只报「有没有」，不打印值（密钥不进报告）。
  const settings = query("select key, value from settings");
  const map = new Map<string, string>();
  if (!(settings.length === 1 && settings[0]?._error)) {
    for (const row of settings) map.set(row.key, row.value);
  }
  // 各功能页只记「厂商 id」：地址 / 密钥统一在 cloud_providers 表（下面单独列）。
  const need: [string, string, boolean?][] = [
    ["SERVER_MODE", "运行模式（local / remote）"],
    ["INFERENCE_ENGINE", "推理引擎"],
    ["IMG_BACKEND", "生图后端（api / comfyui / mlx）"],
    ["IMG_PROVIDER_ID", "生图云厂商"],
    ["IMG_MODEL", "生图模型"],
    ["VIDEO_BACKEND", "生视频后端（cloud / comfyui）"],
    ["VIDEO_PROVIDER_ID", "生视频云厂商"],
    ["VIDEO_MODEL", "生视频模型"],
    ["MUSIC_BACKEND", "生音乐后端（cloud / local 预留）"],
    ["MUSIC_PROVIDER_ID", "生音乐云厂商"],
    ["MUSIC_MODEL", "生音乐模型"],
    ["MUSIC_LOCAL_API", "本地生音乐协议（预留）"],
    ["TTS_LOCAL_ENGINE", "本地 TTS 引擎"],
    ["TTS_PROVIDER_ID", "三方 TTS 云厂商"],
    ["ASR_ENGINE", "ASR 引擎"],
    ["ASR_PROVIDER_ID", "三方 ASR 云厂商"],
    ["OCR_ENGINE", "OCR 引擎"],
    ["OCR_PROVIDER_ID", "VLM OCR 云厂商"],
    ["AGENT_ALLOW_SHELL", "Agent 允许 shell"],
  ];
  sections.push({
    title: "关键配置（密钥只报有无）",
    lines: need.map(([key, label, secret]) => {
      const value = map.get(key) ?? "";
      if (secret) return `${key}（${label}）：${value ? "已配置" : "未配置"}`;
      return `${key}（${label}）：${value || "未设置（用默认值）"}`;
    }),
  });

  // 云厂商：功能页选的就是这里的行。「启动」过（enabled=1）才会出现在各功能页。
  const providers = query(
    "select id, name, base_url, api_key, video_api, enabled, models from cloud_providers order by created_at",
  );
  sections.push({
    title: "云服务商（设置 → 模型云服务）",
    lines: show(providers, (p) => {
      let modelCount = 0;
      try {
        const parsed = JSON.parse(String(p.models ?? "[]"));
        modelCount = Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        modelCount = -1;
      }
      const flags = [
        p.enabled === 1 ? "已启动" : "未启动",
        p.api_key ? "有密钥" : "无密钥",
        p.video_api ? `视频接口=${p.video_api}` : "",
      ]
        .filter(Boolean)
        .join(" / ");
      return `${p.id}（${p.name}）：${flags}，模型 ${modelCount >= 0 ? modelCount : "解析失败"} 个\n    ${p.base_url || "（无地址）"}`;
    }),
  });

  // 表行数概览：判断"没反应"是没数据还是坏了。
  const counts: string[] = [];
  for (const [label, table] of [
    ["会话", "conversations"],
    ["消息", "messages"],
    ["生图记录", "image_records"],
    ["视频记录", "video_records"],
    ["音乐记录", "music_records"],
    ["语音记录", "voice_records"],
    ["文档", "documents"],
    ["技能", "skills"],
  ] as const) {
    const rows = query(`select count(*) as c from ${table}`);
    const bad = rows.length === 1 && rows[0]?._error;
    counts.push(`${label}：${bad ? "查询失败（表结构不符）" : rows[0]?.c}`);
  }
  sections.push({ title: "数据规模", lines: counts });

  try {
    sqlite.close();
  } catch {
    // ignore
  }
  return { sections, warnings };
}

function diskFree(dir: string): string {
  try {
    const fsStat = statfsSync(dir);
    const freeGb = (Number(fsStat.bavail) * Number(fsStat.bsize)) / 1024 ** 3;
    const totalGb = (Number(fsStat.blocks) * Number(fsStat.bsize)) / 1024 ** 3;
    return `${freeGb.toFixed(1)} GB 可用 / 共 ${totalGb.toFixed(1)} GB`;
  } catch (err) {
    return `（读不到：${String(err)}）`;
  }
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {};
  const sections: Section[] = [];
  const warnings: string[] = [];

  const version = await control("ping");
  const running = version.connected && version.ok;
  report.app = {
    running,
    version: running ? version.data?.version : null,
    pid: running ? version.data?.pid : null,
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    logPath: path.join(LOG_DIR, "app.log"),
    socket: SOCKET,
    platform: `${process.platform}/${process.arch}`,
    bun: Bun.version,
  };

  sections.push({
    title: "环境",
    lines: [
      `应用：${running ? `运行中（v${version.data?.version}，pid ${version.data?.pid}）` : "未运行"}`,
      `数据目录：${DATA_DIR}`,
      `数据库：${DB_PATH}${existsSync(DB_PATH) ? `（${(statSync(DB_PATH).size / 1024 ** 2).toFixed(1)} MB）` : "（不存在）"}`,
      `统一日志：${path.join(LOG_DIR, "app.log")}`,
      `控制 socket：${SOCKET}`,
      `平台：${process.platform}/${process.arch} · bun ${Bun.version}`,
      `磁盘（数据目录所在卷）：${diskFree(existsSync(DATA_DIR) ? DATA_DIR : tmpdir())}`,
    ],
  });

  // 推理服务器 / 网关
  if (running) {
    const status = await control("status");
    const server = status.data?.server ?? {};
    const gateway = status.data?.gateway ?? {};
    report.server = server;
    report.gateway = gateway;
    const lines = [
      `推理服务器：${server.status ?? "-"}（引擎 ${server.engine ?? "-"}，${server.host ?? "-"}:${server.port ?? "-"}，pid ${server.pid ?? "-"}）`,
    ];
    if (server.error) lines.push(`  ⚠️ 最后错误：${server.error}`);
    lines.push(`网关：${gateway.status ?? "-"} ${gateway.url ? `(${gateway.url})` : ""}`);
    if (gateway.error) lines.push(`  ⚠️ 网关错误：${gateway.error}`);
    if (gateway.notice) lines.push(`  网关提示：${gateway.notice}`);
    if (server.logs) {
      const tail = String(server.logs).split("\n").filter(Boolean).slice(-15);
      lines.push(`  服务器日志尾部（完整：omi server logs）：`, ...tail.map((l: string) => `    ${l}`));
    }
    sections.push({ title: "推理服务器 / 网关", lines });

    const models = await control("models");
    if (models.ok) {
      const installed = models.data?.installed ?? [];
      sections.push({
        title: "模型",
        lines: [
          `已安装：${installed.length} 个`,
          ...installed.slice(0, 10).map((m: any) => `  ${m.isActive ? "●" : "○"} ${m.fileName}${m.servedName ? `（${m.servedName}）` : ""}`),
          `当前活动模型：${models.data?.activePath ?? "（未设置）"}`,
        ],
      });
    }
  } else {
    warnings.push("应用没在运行：服务器 / 网关的实时状态读不到，只能看磁盘上的历史记录。");
  }

  // 统一日志
  const errors = readLogs(logLimit, "warn");
  report.recentLogs = errors.entries;
  report.logFiles = errors.files;
  const bySource = new Map<string, number>();
  for (const entry of errors.entries) bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1);
  sections.push({
    title: `统一日志：最近的 warn / error（共 ${errors.entries.length} 条；完整：omi logs --level warn）`,
    lines: errors.entries.length
      ? [
          `按子系统：${[...bySource.entries()].map(([s, n]) => `${s}×${n}`).join("，")}`,
          ...errors.entries.map(
            (e) =>
              `[${new Date(e.ts).toLocaleString()}] ${e.level.toUpperCase()} ${e.source} · ${e.event}\n    ${e.message}` +
              (e.detail ? `\n    ${JSON.stringify(e.detail).slice(0, 500)}` : ""),
          ),
        ]
      : ["（最近没有 warn / error 记录）"],
  });
  if (existsSync(LOG_DIR)) {
    const files = readdirSync(LOG_DIR).filter((n) => n.startsWith("app"));
    sections.push({
      title: "logs/ 目录",
      lines: files.length ? files.map((n) => `  ${n}（${(statSync(path.join(LOG_DIR, n)).size / 1024).toFixed(1)} KB）`) : ["（空）"],
    });
  }

  // 媒体服务
  const media = await probeMediaServer();
  report.mediaServer = media;
  sections.push({ title: "媒体服务（127.0.0.1:19782）", lines: [`${media.state}：${media.detail}`] });
  if (media.state === "blocked") warnings.push("媒体服务端口被另一个数据目录的实例占用：图片 / 音频预览会失败。");

  // 数据库
  const db = readDb();
  sections.push(...db.sections);
  warnings.push(...db.warnings);

  if (asJson) {
    console.log(JSON.stringify({ ...report, warnings, sections }, null, 2));
    return;
  }

  console.log("=".repeat(72));
  console.log("OmniStudio 诊断报告（只读采集）");
  console.log("=".repeat(72));
  if (warnings.length) {
    console.log("\n⚠️ 需要注意");
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
  for (const section of sections) {
    console.log(`\n## ${section.title}`);
    for (const line of section.lines) console.log(`  ${line}`);
  }
  console.log("\n" + "=".repeat(72));
  console.log("下一步：omi logs --level error --limit 50 -v 看完整现场；");
  console.log("       生图 / 生视频 / 生音乐 / 语音等问题见技能 .agents/skills/omni-doctor/。");
  console.log("=".repeat(72));
}

await main();
