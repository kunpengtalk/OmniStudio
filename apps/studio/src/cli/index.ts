import { parseArgs, optBool } from "./args";
import { CMD_HELP, HELP_TEXT } from "./help";
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

type Handler = (parsed: ReturnType<typeof parseArgs>) => Promise<void>;

const COMMANDS: Record<string, Handler> = {
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  serve: cmdServe,
  launch: cmdLaunch,
  model: cmdModel,
  cloud: cmdCloud,
  models: cmdModels,
  "model-info": cmdModelInfo,
  status: cmdStatus,
  server: cmdServer,
  install: cmdInstall,
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
    const target = rest[0];
    console.log(target ? CMD_HELP[target] ?? HELP_TEXT : HELP_TEXT);
    return 0;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`未知命令：${cmd}\n`);
    console.log(HELP_TEXT);
    return 1;
  }

  // 子命令帮助：`omi <cmd> -h/--help` 优先于全局帮助
  if (optBool(parsed.options, "help") || parsed.options.h === true) {
    console.log(CMD_HELP[cmd] ?? HELP_TEXT);
    return 0;
  }

  try {
    // 命令处理函数里 positionals 从用户参数开始（不含命令名本身）。
    await handler({ ...parsed, positionals: rest });
    return 0;
  } catch (err) {
    console.error(`omi ${cmd} 执行出错：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// 直接运行入口（bin/omi.ts 会 import 本文件）
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
