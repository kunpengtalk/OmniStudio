import { parseArgs, optBool } from "./args";
import { HELP_TEXT, helpFor } from "./help";
import {
  cmdRestart,
  cmdServer,
  cmdStart,
  cmdStatus,
  cmdStop,
} from "./commands/app";
import { cmdCloud, cmdModel, cmdModelInfo, cmdModels } from "./commands/models";
import { cmdLaunch } from "./commands/launch";
import { cmdServe } from "./commands/serve";
import { cmdInstall } from "./commands/install";
import { cmdUpdate, cmdVersion } from "./commands/meta";
import { cmdMemory } from "./commands/memory";
import { cmdGuide } from "./commands/guide";

type Handler = (parsed: ReturnType<typeof parseArgs>) => Promise<void>;

/** 命令表（导出供 scripts/omi-docs-smoke.ts 校验帮助文本与实现一致）。 */
export const COMMANDS: Record<string, Handler> = {
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  serve: cmdServe,
  launch: cmdLaunch,
  memory: cmdMemory,
  model: cmdModel,
  cloud: cmdCloud,
  models: cmdModels,
  "model-info": cmdModelInfo,
  status: cmdStatus,
  server: cmdServer,
  install: cmdInstall,
  guide: cmdGuide,
  version: cmdVersion,
  update: cmdUpdate,
};

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const [cmd, ...rest] = parsed.positionals;

  if (optBool(parsed.options, "version") || parsed.options.v === true) {
    await cmdVersion();
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

  const handler = COMMANDS[cmd];
  if (!handler) {
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
