/**
 * 统一应用日志（app.log）—— 排查问题时**唯一**需要先看的地方。
 *
 * 在这之前，主进程的失败信息散在三处：推理服务器日志只在内存里（停止即丢）、
 * 媒体管线失败只有一句瞬时错误、语音通话调试写 `/tmp/omni-voicecall.log`。
 * 结果是"生图失败了"这种问题，事后没有任何现场可查。
 *
 * 这里把**事件级**记录收敛到一个地方：
 *   - 文件：`<数据目录>/logs/app.log`（JSONL，逐行一条，2MB 轮转，保留 5 份）
 *   - 内存：最近 2000 条环形缓冲（应用在跑时 RPC 读它，含文件写失败时的兜底）
 *
 * 设计约束：
 *   - 任何情况下都不抛错、不阻塞调用方（日志失败不能反过来搞崩业务）；
 *   - 只记事件，不搬运推理服务器的 stdout（那是每个实例 20 万字符的内存缓冲，
 *     stderr 逐行刷盘的代价不值得，需要时用 `omi server logs` 取）；
 *   - 密钥脱敏：key/token/secret/password/authorization 一律替换成 `***`。
 *
 * 读的入口见：RPC `getAppLogs`、控制 socket `logs`、`omi logs`、`omi diag`。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { getDataDir } from "./paths";
import { safeJoin, safeName } from "./path-safety";

export type AppLogLevel = "debug" | "info" | "warn" | "error";

/** 子系统标识（写入每条记录，`omi logs --source` 按它过滤）。 */
export type AppLogSource =
  | "app" // 主进程生命周期：启动、退出、未捕获异常
  | "client" // webview 侧：渲染错误、界面兜底提示
  | "agent" // Agent 运行
  | "chat" // 对话
  | "image" // 生图（云端 API / ComfyUI / MLX）
  | "video" // 生视频
  | "music" // 生音乐（StepFun 提交 + 轮询 / MiniMax 同步长请求 / 本地预留位）
  | "tts" // 语音合成
  | "asr" // 语音识别
  | "ocr" // OCR / 文档解析
  | "translate" // 翻译
  | "media-server" // 图片 / 音频预览服务
  | "server" // 推理服务器（llama.cpp / vLLM / SGLang / MLX）
  | "gateway" // OpenAI 兼容网关
  | "tunnel" // 内网穿透（Cloudflare 隧道：cloudflared 安装、启停、连接状态）
  | "download" // 模型下载
  | "skills" // 技能中心
  | "kb" // 知识库
  | "memory" // 共享记忆
  | "backup" // 备份 / 恢复
  | "settings" // 设置读取（凭据密文在本机解不开这类降级）
  | "mcp" // MCP 服务
  | "automation" // 自动化
  | "benchmark" // 基准测试（速度扫描 / 能力评测）
  | "miniapp" // 小应用（应用中心里的沙箱页面：能力探测、一次性补全、产物落盘）
  | "canvas" // 无限画布（文档持久化 / 节点生成）
  | "update" // 版本更新
  | "notice" // 通知中心落下的条目
  | "usage" // 用量账本（记录失败这类不影响业务的告警）
  | "systemone" // SystemOne / JEV 类型化判定（本地 laya-mlx 运行时 + 云端 TypeSafe）
  | "cli"; // CLI 侧动作（备份内核等独立进程）

export type AppLogEntry = {
  /** 进程内递增序号（重启后从头开始）。 */
  seq: number;
  ts: number;
  level: AppLogLevel;
  source: string;
  /** 机器可读事件名，点号分隔，如 `image.generate.failed`。 */
  event: string;
  message: string;
  /** 结构化上下文（已脱敏、已截断）。 */
  detail?: unknown;
  pid: number;
};

export type AppLogInput = {
  level?: AppLogLevel;
  source: AppLogSource;
  event: string;
  message: string;
  detail?: unknown;
};

export type AppLogQuery = {
  /** 最低等级（含），如 `warn` 只回 warn + error。 */
  level?: AppLogLevel;
  source?: string | string[];
  /** 只看这个时间点之后（epoch ms 或可被 Date 解析的字符串）。 */
  since?: number | string;
  /** 事件名包含该子串（不区分大小写）。 */
  event?: string;
  /** 消息包含该子串（不区分大小写）。 */
  search?: string;
  /** 最多返回多少条（默认 100，上限 2000）。 */
  limit?: number;
  /** true = 时间正序（老的在前）；默认倒序（新的在前）。 */
  oldestFirst?: boolean;
  /**
   * 只读某一个日志文件（只能是 `appLogFiles()` 里的 basename，如 `app.log`
   * 或轮转出来的 `app-2026-….log`）—— 界面的「轮转文件」切换靠它翻历史。
   * 给了它就是「只看这份文件」，内存缓冲不参与。
   */
  file?: string;
  /**
   * 只读本进程内存环形缓冲。跟随最新时界面每秒轮询一次，seq 是进程内递增的，
   * 「比 since 新」的记录因此只可能在内存里；不这么标注的话每次轮询都会回落到
   * 磁盘整份读日志文件（2MB 上限），日志一大就把主进程拖住。
   * 与 `file` 同时给时以 `file` 为准（要的是那份文件，不是内存）。
   */
  memoryOnly?: boolean;
};

const APP_LOG_FILE = "app.log";
const APP_LOG_ROTATED_PREFIX = "app-";
/** 单条记录 detail 的上限，超出截断 —— 日志是给排查用的，不能变成数据转储。 */
const MAX_DETAIL_CHARS = 4000;
/** 单个文件上限，超过就轮转。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 轮转文件保留份数。 */
const KEEP_ROTATED_FILES = 5;
/** 内存环形缓冲条数。 */
const MAX_MEMORY_ENTRIES = 2000;

const LEVEL_RANK: Record<AppLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 需要脱敏的字段名（命中即整体替换，不看值）。
 *
 * 只看名字是不够的（见 `redactSecrets`），但名字这一层仍然要留着：它的成本是零，
 * 而且能盖住「值是密钥但形状看不出来」的情况。这里的补充是那几个以前漏掉的别名
 * —— `access_key` / `secret_key` / `credential` / `pat` —— 老规则用的是子串匹配，
 * 裸的 `key` 故意不收（`{ key: "SERVER_TEMP" }` 这种调试字段很常见，收掉反而丢信息）。
 */
const SECRET_KEY_PATTERN =
  /(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|token|secret|password|passwd|passphrase|authorization|cookie|credential)/i;

/**
 * 值里的密钥形状 —— 只脱敏「看起来就是密钥」的那一段。
 *
 * 为什么非要有这一层：日志里泄漏密钥的路径基本都不是 `{apiKey: "sk-…"}` 这种规整体，
 * 而是**字符串**里夹着 —— `curl -H "Authorization: Bearer sk-…"` 这样的命令行、
 * `?api_key=…` 这样的 URL、`api_key=…` 这样的环境变量转储。老实现只按字段名替换，
 * 这些一个都盖不住（字段名是 `command` / `url` / `args`，谁也没写在名单里）。
 *
 * 反过来，**不能**对所有字符串一刀切替换：日志的价值全在内容里。
 * 所以每条规则都要求一个明确的密钥形状（前缀、header、`key=` 赋值），
 * 宁可漏掉一个「长得不像密钥的密钥」，也不要把整份日志变成 `***`。
 */
const SECRET_VALUE_RULES: { pattern: RegExp; replacement: string }[] = [
  {
    // 头名字后面可能先来一个引号（`"x-api-key": "…"` 这种 JSON / 对象字面量形态），
    // 所以引号要放在冒号左边而不是值里面。
    // 值里可能还带一个协议词（`Bearer sk-…`），一起吃掉 —— 只吃 Bearer 会留下
    // `Authorization: *** ***` 这种既没了信息又看不出原来是什么的结果。
    pattern: /\b(authorization|x-api-key|api-key)\b"?\s*[:=]\s*"?(?:(?:bearer|basic)\s+)?[^\s"',;)]+/gi,
    replacement: "$1: ***",
  },
  // 没有头名字的裸协议词：`token rejected: Bearer sk-…`。
  { pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=+-]{8,}/gi, replacement: "$1 ***" },
  // 各家有固定前缀的密钥：认前缀最准，也不会误伤普通词。
  {
    pattern: /\b(?:sk|osk|hf|ghp|gho|ghs|ghr|glpat|xoxb|xoxp|pplx|r8)[-_][A-Za-z0-9_-]{12,}/g,
    replacement: "***",
  },
  // 赋值形态，分两类。先说明为什么要分：
  // `api_key` / `password` 这类名字本身就是「这是密钥」的信号，出现在 `IMG_API_KEY=…`
  // 里时前面还顶着 `IMG_`，所以**不能**要求前面是空白或行首；
  // 而 `key` / `token` / `secret` 这类名字单独看是有歧义的（`cache_key`、`max_tokens`），
  // 必须要求一个明确的分隔符，否则会把正常字段一起吞掉。
  {
    // 名字前面**不加** `\b`：`IMG_API_KEY=…` 里 `API` 前面是 `_`，两个都是词字符，
    // 加了 `\b` 反而匹配不上 —— 而前缀带厂商名（IMG_ / OPENAI_）恰恰是最常见的形态。
    pattern:
      /(api[-_]?key|apikey|access[-_]?key|secret[-_]?key|private[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?token|password|passwd|passphrase)\b"?\s*[:=]\s*"?([^\s"'`,;&)\]}]{8,})/gi,
    replacement: "$1=***",
  },
  {
    pattern:
      /((?:^|[?&\s"'`,\[(])(?:key|token|secret|credential|pat)\b"?\s*[:=]\s*"?)([^\s"'`,;&)\]}]{8,})/gi,
    replacement: "$1***",
  },
  // CLI 形态：`--password hunter2`、`--api-key abc…`（空格分隔，不是赋值）。
  {
    pattern: /(--?[a-z-]*(?:password|passwd|token|api-key|api_key|secret))\s+\S{8,}/gi,
    replacement: "$1 ***",
  },
  // URL 里的 userinfo：`https://user:pass@host`（备份远端、代理、webhook 都长这样）。
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
    replacement: "$1***$2",
  },
];

/**
 * 扫一遍文本，把里面看得出来的密钥换成 `***`。
 *
 * 纯函数、不抛异常：它跑在写日志的路径上，自己的失败不能反过来把日志写坏。
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of SECRET_VALUE_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

const memory: AppLogEntry[] = [];
let seq = 0;
let writesSinceRotateCheck = 0;

export function appLogDir(): string {
  return getDataDir("logs");
}

export function appLogPath(): string {
  return join(appLogDir(), APP_LOG_FILE);
}

// ---------------------------------------------------------------------------
// 脱敏 / 序列化
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断 ${text.length - max} 字符）`;
}

function errorToDetail(err: Error, depth: number): unknown {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack ? truncate(err.stack.split("\n").slice(0, 6).join("\n"), 2000) : undefined,
    ...(err.cause != null && depth < 3 ? { cause: sanitizeValue(err.cause, depth + 1) } : {}),
  };
}

/**
 * 把任意值整理成可安全写盘的形态：脱敏、截断、去环。
 * 导出是为了让测试直接盯住脱敏规则（日志泄漏密钥比没有日志更糟）。
 */
export function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (value instanceof Error) return errorToDetail(value, depth);
  // 字符串先按内容脱敏再截断：密钥可能恰好落在截断线上，先截就漏了。
  if (typeof value === "string") return truncate(redactSecrets(value), 2000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return String(value);
  if (depth >= 4) return "[深度截断]";
  if (typeof value === "object") {
    const obj = value as object;
    if (seen.has(obj)) return "[循环引用]";
    seen.add(obj);
    if (Array.isArray(value)) {
      const items = value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1, seen));
      if (value.length > 50) items.push(`…（共 ${value.length} 项）`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = val ? "***" : val;
        continue;
      }
      out[key] = sanitizeValue(val, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

/** 拼出 `{...}` 形态的 detail，保证写盘体积可控。 */
function normalizeDetail(detail: unknown): unknown {
  if (detail == null) return undefined;
  const clean = sanitizeValue(detail);
  try {
    const json = JSON.stringify(clean);
    if (json && json.length > MAX_DETAIL_CHARS) {
      return { _truncated: true, preview: truncate(json, MAX_DETAIL_CHARS) };
    }
  } catch {
    return { _unserializable: true };
  }
  return clean;
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

function rotateIfNeeded(): void {
  const file = appLogPath();
  if (!existsSync(file)) return;
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_FILE_BYTES) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    const dir = appLogDir();
    const rotated = join(dir, `${APP_LOG_ROTATED_PREFIX}${stamp}.log`);
    // 原子改名：append 每次写完即关句柄，改名后下一条自然重建 app.log，中途不丢记录。
    renameSync(file, rotated);
    const stale = readdirSync(dir)
      .filter((n) => n.startsWith(APP_LOG_ROTATED_PREFIX) && n.endsWith(".log"))
      .sort();
    for (const name of stale.slice(0, Math.max(0, stale.length - KEEP_ROTATED_FILES))) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // ignore
      }
    }
  } catch {
    // 轮转失败不阻断写入（继续往原文件追加）
  }
}

function writeToFile(entry: AppLogEntry): void {
  try {
    const dir = appLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writesSinceRotateCheck++;
    if (writesSinceRotateCheck >= 32) {
      writesSinceRotateCheck = 0;
      rotateIfNeeded();
    }
    appendFileSync(appLogPath(), `${JSON.stringify(entry)}\n`);
  } catch {
    // 落盘失败（只读盘 / 空间不足）时内存缓冲仍然可用，不向上抛。
  }
}

/**
 * 记一条日志。永不抛错、永不阻塞。
 * 应用在跑时同时进内存环形缓冲与 `logs/app.log`。
 */
export function logEvent(input: AppLogInput): AppLogEntry {
  const entry: AppLogEntry = {
    seq: ++seq,
    ts: Date.now(),
    level: input.level ?? "info",
    source: input.source,
    event: input.event,
    // message 也要扫：失败原因里最常见的就是「把整条命令行 / URL 抄进来」，
    // 而命令行与 URL 里带着密钥的情况比 detail 里多得多。
    message: truncate(redactSecrets(String(input.message ?? "")), 2000),
    detail: normalizeDetail(input.detail),
    pid: process.pid,
  };
  memory.push(entry);
  if (memory.length > MAX_MEMORY_ENTRIES) memory.splice(0, memory.length - MAX_MEMORY_ENTRIES);
  writeToFile(entry);
  return entry;
}

/** 便捷包装：`log.error({...})` 等。 */
export const log = {
  debug: (input: Omit<AppLogInput, "level">) => logEvent({ ...input, level: "debug" }),
  info: (input: Omit<AppLogInput, "level">) => logEvent({ ...input, level: "info" }),
  warn: (input: Omit<AppLogInput, "level">) => logEvent({ ...input, level: "warn" }),
  error: (input: Omit<AppLogInput, "level">) => logEvent({ ...input, level: "error" }),
};

/**
 * 把 console.warn / console.error 镜像进统一日志。
 *
 * 打包应用里主进程的 stdout 是看不见的（从 Finder 启动时没人接），所以默认只兜
 * **warn / error** —— 它们是"出事了"的兜底网；info 级别的进度打印不进日志，
 * 否则正常的业务日志会被日常噪音淹掉。结构化失败仍应显式调用 logEvent
 * （事件名稳定、带 detail），镜像条目只作为兜底，事件名为 `console.warn` / `console.error`。
 */
export function mirrorConsole(source: AppLogSource = "app"): void {
  const wrap = (level: AppLogLevel, event: string, original: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      original(...args);
      const [first, ...rest] = args;
      logEvent({
        level,
        source,
        event,
        message: first instanceof Error ? first.message : String(first ?? ""),
        detail: rest.length || first instanceof Error ? { args: rest, error: first } : undefined,
      });
    };
  };
  console.warn = wrap("warn", "console.warn", console.warn.bind(console)) as typeof console.warn;
  console.error = wrap(
    "error",
    "console.error",
    console.error.bind(console),
  ) as typeof console.error;
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

function normalizeSince(since: AppLogQuery["since"]): number | undefined {
  if (since == null) return undefined;
  if (typeof since === "number") return Number.isFinite(since) ? since : undefined;
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function matches(entry: AppLogEntry, query: AppLogQuery, minRank: number): boolean {
  if (LEVEL_RANK[entry.level] < minRank) return false;
  if (query.source) {
    const wanted = Array.isArray(query.source) ? query.source : [query.source];
    if (!wanted.includes(entry.source)) return false;
  }
  if (query.event && !entry.event.toLowerCase().includes(query.event.toLowerCase())) return false;
  if (query.search) {
    const needle = query.search.toLowerCase();
    // 事件名也算在内：用户搜 "builtin" / "generate.failed" 时想找的就是事件，
    // 只搜 message 会让人以为"没有这条日志"。
    const haystack =
      `${entry.event} ${entry.message} ${JSON.stringify(entry.detail ?? "")}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function sortAndLimit(entries: AppLogEntry[], query: AppLogQuery, limit: number): AppLogEntry[] {
  // 先选出**最新**的 limit 条，再按请求的方向排序。
  // 反过来（先按 oldestFirst 排序再切前 limit 条）会把返回窗口挪到最老的那一头 ——
  // `omi logs --limit 4` 会显示上上次启动的记录，而真正的现场被丢掉。
  entries.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
  const picked = entries.slice(0, limit);
  return query.oldestFirst ? picked.reverse() : picked;
}

/** 当前进程内存里的日志（应用运行时 RPC 走这条，最快）。 */
export function readAppLogsInMemory(query: AppLogQuery = {}): AppLogEntry[] {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_MEMORY_ENTRIES);
  const minRank = query.level ? LEVEL_RANK[query.level] : 0;
  const since = normalizeSince(query.since);
  const hits = memory.filter(
    (entry) => (since == null || entry.ts >= since) && matches(entry, query, minRank),
  );
  return sortAndLimit(hits, query, limit);
}

export function appLogFiles(): { path: string; size: number; rotated: boolean }[] {
  const dir = appLogDir();
  try {
    return readdirSync(dir)
      .filter(
        (n) => n === APP_LOG_FILE || (n.startsWith(APP_LOG_ROTATED_PREFIX) && n.endsWith(".log")),
      )
      .sort()
      .map((name) => {
        const full = join(dir, name);
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          // ignore
        }
        return { path: full, size, rotated: name !== APP_LOG_FILE };
      });
  } catch {
    return [];
  }
}

/** 同一个坏名字只报一次：坏客户端每秒轮询一次时不能把日志刷满。 */
const rejectedFiles = new Set<string>();

function reportRejectedFile(name: string): void {
  if (rejectedFiles.has(name)) return;
  rejectedFiles.add(name);
  logEvent({
    level: "warn",
    source: "app",
    event: "app_log.file.rejected",
    message: `拒绝读取日志目录之外的文件：${truncate(name, 200)}`,
  });
}

/**
 * 把查询里的 `file` 收敛成日志目录里的一个真实文件；不合法返回 null。
 *
 * 这个值来自 webview / 控制 socket（用户可构造），所以**不能**拼完再用：
 * 只认 `appLogFiles()` 里出现过的名字（那一层已经限定 `app.log` / `app-*.log`），
 * 带分隔符、`..`、绝对路径的写法在 safeName 那一步就被拒掉，
 * 即使真有人在日志目录里放了软链接，safeJoin 也会把它挡在目录之外。
 * 返回的路径永远来自 `appLogFiles()`，不来自入参。
 */
export function resolveAppLogFile(name: unknown): string | null {
  if (typeof name !== "string" || name !== safeName(name)) {
    reportRejectedFile(String(name));
    return null;
  }
  const joined = safeJoin(appLogDir(), name);
  const hit = joined ? appLogFiles().find((f) => f.path === joined) : undefined;
  if (!hit) {
    reportRejectedFile(name);
    return null;
  }
  return hit.path;
}

/**
 * 从磁盘读日志（应用没运行、或要看上次运行留下的记录时用）。
 * 轮转文件按文件名排序（时间戳即顺序），老的在前；`file` 指定时只读那一份。
 */
export function readAppLogFiles(query: AppLogQuery = {}): AppLogEntry[] {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 5000);
  const minRank = query.level ? LEVEL_RANK[query.level] : 0;
  const since = normalizeSince(query.since);
  const selected = query.file == null ? null : resolveAppLogFile(query.file);
  if (query.file != null && selected == null) return [];
  const files = (selected ? appLogFiles().filter((f) => f.path === selected) : appLogFiles()).sort(
    (a, b) => (a.rotated === b.rotated ? a.path.localeCompare(b.path) : a.rotated ? -1 : 1),
  );
  const entries: AppLogEntry[] = [];
  // 从最新往前读，凑够 limit 就停 —— 日志文件可能很大，不整份载入。
  for (const file of [...files].reverse()) {
    let lines: string[];
    try {
      lines = readFileSync(file.path, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: AppLogEntry;
      try {
        entry = JSON.parse(trimmed) as AppLogEntry;
      } catch {
        continue; // 半行写入 / 手工编辑，跳过
      }
      if (since != null && entry.ts < since) continue;
      if (!matches(entry, query, minRank)) continue;
      entries.push(entry);
    }
    if (entries.length >= limit * 2) break;
  }
  return sortAndLimit(entries, query, limit);
}

/**
 * 应用在跑时用这个：优先内存（含本条进程的全部事件），
 * 不够 limit 时再补磁盘上更早的记录（跨重启连续看）。
 *
 * 两个例外：
 *   - `file`：只要那一份历史文件（内存里的记录不属于它）；
 *   - `memoryOnly`：只要本进程内存（跟随最新的轮询，见 AppLogQuery 的注释）。
 */
export function readAppLogs(query: AppLogQuery = {}): AppLogEntry[] {
  if (query.file != null) return readAppLogFiles(query);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 5000);
  if (query.memoryOnly) return readAppLogsInMemory({ ...query, limit });
  const inMemory = readAppLogsInMemory({ ...query, limit });
  if (inMemory.length >= limit) return inMemory;
  const oldestInMemory = inMemory.length
    ? Math.min(...inMemory.map((e) => e.ts))
    : Number.POSITIVE_INFINITY;
  const fromFiles = readAppLogFiles({ ...query, limit }).filter(
    (entry) => entry.ts < oldestInMemory,
  );
  const merged = [...inMemory, ...fromFiles];
  return sortAndLimit(merged, query, limit);
}

/** 清空当前日志文件与内存缓冲（轮转的历史文件保留）。 */
export function clearAppLog(): { cleared: number } {
  const cleared = memory.length;
  memory.length = 0;
  try {
    if (existsSync(appLogPath())) unlinkSync(appLogPath());
  } catch {
    // ignore
  }
  return { cleared };
}

/** 供诊断脚本 / 测试使用：不依赖 RPC 也能拿到日志落点。 */
export function appLogInfo(): {
  dir: string;
  path: string;
  memoryEntries: number;
  files: { path: string; size: number; rotated: boolean }[];
} {
  return {
    dir: appLogDir(),
    path: appLogPath(),
    memoryEntries: memory.length,
    files: appLogFiles(),
  };
}
