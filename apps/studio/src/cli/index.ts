import { parseArgs, optBool } from "./args";
import { HELP_TEXT, helpFor } from "./help";

type Handler = (parsed: ReturnType<typeof parseArgs>) => Promise<void>;

/**
 * 命令表：值是一个「取处理函数」的异步工厂，真正 `import` 命令模块发生在
 * 执行该命令时，而不是解析参数时。
 *
 * 这样单个命令不会把别人的依赖一起拖进来 —— 尤其是数据层：`db/index.ts`
 * 在 import 阶段就会跑迁移，一旦迁移失败，整个 CLI 进程都会起不来。
 * 备份 / 恢复（`omi backup`）必须在这种时候还能用，所以它不能连带加载数据层。
 * 命令模块之间没有 import 期副作用依赖，按需加载是安全的。
 */
export const COMMANDS: Record<string, () => Promise<Handler>> = {
  start: async () => (await import("./commands/app")).cmdStart,
  stop: async () => (await import("./commands/app")).cmdStop,
  restart: async () => (await import("./commands/app")).cmdRestart,
  serve: async () => (await import("./commands/serve")).cmdServe,
  launch: async () => (await import("./commands/launch")).cmdLaunch,
  memory: async () => (await import("./commands/memory")).cmdMemory,
  backup: async () => (await import("./commands/backup")).cmdBackup,
  model: async () => (await import("./commands/models")).cmdModel,
  cloud: async () => (await import("./commands/models")).cmdCloud,
  models: async () => (await import("./commands/models")).cmdModels,
  "model-info": async () => (await import("./commands/models")).cmdModelInfo,
  status: async () => (await import("./commands/app")).cmdStatus,
  server: async () => (await import("./commands/app")).cmdServer,
  install: async () => (await import("./commands/install")).cmdInstall,
  guide: async () => (await import("./commands/guide")).cmdGuide,
  benchmark: async () => (await import("./commands/benchmark")).cmdBenchmark,
  version: async () => (await import("./commands/meta")).cmdVersion,
  update: async () => (await import("./commands/meta")).cmdUpdate,
};

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const [cmd, ...rest] = parsed.positionals;

  if (optBool(parsed.options, "version") || parsed.options.v === true) {
    await (await COMMANDS.version!())(parsed);
    return 0;
  }

  // 无命令 / help：主帮助
  if (!cmd) {
    console.log(HELP_TEXT);
    return 0;
  }
  if (cmd === "help") {
    console.log(helpFor(rest));
    return 0;
  }

  const load = COMMANDS[cmd];
  if (!load) {
    console.error(`未知命令：${cmd}\n`);
    console.log(HELP_TEXT);
    return 1;
  }

  // 子命令帮助：`omi <cmd> [子命令] -h/--help` 优先于全局帮助
  // （`omi memory add -h`、`omi help memory add`、`omi launch claude -h` 等价）。
  if (optBool(parsed.options, "help") || parsed.options.h === true) {
    console.log(helpFor([cmd, rest[0]]));
    return 0;
  }

  try {
    const handler = await load();
    // 命令处理函数里 positionals 从用户参数开始（不含命令名本身）。
    await handler({ ...parsed, positionals: rest });
    // 处理函数用 process.exitCode 标记「已打印错误、但参数解析本身成功」
    // （未知子命令等）；这里把它翻译成 main 的返回值，否则会被
    // bin/omi.ts 的 process.exit(0) 覆盖掉。
    return process.exitCode ? 1 : 0;
  } catch (err) {
    console.error(`omi ${cmd} 执行出错：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// 直接运行入口（bin/omi.ts 会 import 本文件）
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
