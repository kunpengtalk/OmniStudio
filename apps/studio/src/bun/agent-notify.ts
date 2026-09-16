/**
 * 外部通知回调（对齐 Codex 的 `notify`）。
 *
 * Codex 的配置里能写 `notify = ["notify-send", "Codex"]`：每有事件就把一段 JSON
 * 作为**最后一个参数**追加到命令后面执行。这样"跑完了 / 需要授权"就能接进用户自己的
 * 东西 —— 系统通知、手机推送、CI 钩子、日志管道，不需要我们为每种后端写适配。
 *
 * 我们的形态是设置项 `AGENT_NOTIFY_COMMAND`（shell 命令字符串），事件载荷给两处：
 * 追加为**最后一个参数**（与 Codex 一致，脚本里就是 `$1`），同时放进环境变量
 * `OMNI_NOTIFY_PAYLOAD`（shell 命令串里直接 `"$OMNI_NOTIFY_PAYLOAD"` 更好写）。
 * 两者都不做字符串拼接 —— 标题里带引号或分号也只是数据，不会被当命令执行。
 *
 * 触发点只有一个：`notifications.ts` 的 `notify()` —— 应用内通知中心收到的每一条
 * （回合跑完 / 需要授权 / 自动化结果 / 出错）都会顺带发出去，不重复埋点。
 *
 * 任何失败都只写统一日志：外部命令是用户自己的东西，不能反过来影响 Agent 运行。
 */
import { getSetting } from "./db/settings";
import { logEvent } from "./app-log";
import { resolveCommandShell } from "./shell";

/** 事件类型（对齐 Codex 的 "agent-turn-complete"，其余按我们的通知种类命名）。 */
export type ExternalNotifyType =
  | "agent-turn-complete"
  | "agent-permission-request"
  | "automation-finished"
  | "agent-error"
  | "info";

const TYPE_BY_KIND: Record<string, ExternalNotifyType> = {
  run_finished: "agent-turn-complete",
  permission: "agent-permission-request",
  automation: "automation-finished",
  error: "agent-error",
  info: "info",
};

export type ExternalNotifyPayload = {
  type: ExternalNotifyType;
  /** 应用内通知的种类，原样带上，方便用户的脚本按自己的规则分流。 */
  kind: string;
  title: string;
  body?: string;
  conversationId?: number | null;
  at: number;
};

/** 外部回调命令（设置项）；空字符串 = 未配置。 */
export function notifyCommand(): string {
  return getSetting("AGENT_NOTIFY_COMMAND").trim();
}

export function externalNotifyConfigured(): boolean {
  return notifyCommand().length > 0;
}

/**
 * 执行外部回调。返回 false 表示"没发出去"（未配置 / 启动失败），
 * 调用方不需要处理 —— 事件本身已经落库与进通知中心了。
 */
export function notifyExternal(input: { kind: string; title: string; body?: string; conversationId?: number | null }): boolean {
  const command = notifyCommand();
  if (!command) return false;

  const payload: ExternalNotifyPayload = {
    type: TYPE_BY_KIND[input.kind] ?? "info",
    kind: input.kind,
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    conversationId: input.conversationId ?? null,
    at: Date.now(),
  };

  const shell = resolveCommandShell();
  try {
    /**
     * POSIX shell 走 `sh -c '<用户的命令> "$1"' omni-notify '<JSON>'`：
     * - 用户的命令字符串原样进 sh（他写的是 shell 命令，这本来就该由 shell 解释）；
     * - 载荷走 "$1" 与环境变量，因此标题里的引号 / 分号 / 反引号都只是数据；
     * - detached + stdio ignore：不阻塞 Agent，也不把它的输出混进我们的日志。
     *
     * cmd.exe / PowerShell 没有等价的 `"$1"`，那边只保证 OMNI_NOTIFY_PAYLOAD 环境变量
     * （Windows 上别把 "$1" 写进通知命令）—— 关键是命令至少能跑起来，而不是 spawn 就 ENOENT。
     */
    const invocation = shell.posix ? `${command} "$1"` : command;
    const serialized = JSON.stringify(payload);
    const proc = Bun.spawn({
      cmd: shell.posix
        ? [...shell.commandArgs(invocation), "omni-notify", serialized]
        : shell.commandArgs(invocation),
      env: { ...process.env, OMNI_NOTIFY_PAYLOAD: serialized },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      detached: true,
    });
    proc.unref?.();
    return true;
  } catch (error) {
    logEvent({
      level: "warn",
      source: "agent",
      event: "agent.notify.failed",
      message: `外部通知命令启动失败：${error instanceof Error ? error.message : String(error)}`,
      detail: { command },
    });
    return false;
  }
}
