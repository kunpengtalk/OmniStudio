/**
 * 生命周期 hooks（对齐 Codex 的 `[hooks]`：SessionStart / UserPromptSubmit）。
 *
 * Codex 的 hooks 让用户在自己的配置里挂脚本，在**回合的前后**插手：启动会话时注入环境信息、
 * 提交提示词前补上下文或直接拦下。我们照着做两个最有用的：
 *
 * - `session_start`：首次建立会话（或换了模式 / 工作区）时跑一次，
 *   它的输出作为「会话启动上下文」进系统提示 —— 比如把当前 git 分支、环境版本前置。
 * - `user_prompt_submit`：每次提交前跑，输出作为本轮任务描述的一部分交给模型；
 *   也可以 `{"decision":"block"}` 直接拦下这一轮（附原因，用户能在会话里看到）。
 *
 * 约定（与 Codex 一致：事件 JSON 走 **stdin**）：
 * - 命令通过用户的 shell 执行，事件 JSON 从**标准输入**读（`jq -r .prompt`、`cat` 都行），
 *   同时放在环境变量 `OMNI_HOOK_PAYLOAD` / `OMNI_HOOK_EVENT` 里；
 *   **不追加参数** —— 那样 `echo 一段话` 会把 JSON 一起打进上下文，噪声太大；
 * - stdout 是 JSON 就用 JSON（`decision` / `context` / `reason`），不是 JSON 就整段当上下文
 *   —— 于是 `cat NOTES.md` 这种最朴素的写法也能用；
 * - **失败不阻断**：非零退出 / 超时 / 输出乱码都只记一条警告（`decision: block` 才是明确的拦），
 *   hook 是用户自己的脚本，不能反过来把 Agent 卡死；
 * - 上下文体量有硬上限（单条 8KB、合计 16KB）：hook 的输出会进上下文窗口，
 *   本地模型窗口本来就不大。
 *
 * **安全边界**：hooks 只来自应用设置（`AGENT_HOOKS`），**绝不读工作区里的配置文件** ——
 * 仓库里的文件是模型能改的，把它当命令执行等于把 RCE 写进仓库（Codex 也是靠
 * managed hooks / 显式信任来防这一手）。
 */
import { killProcessTree } from "./runtimes/proc";
import { getSetting } from "./db/settings";
import { logEvent } from "./app-log";
import { resolveCommandShell } from "./shell";

/** 当前支持的事件（其余事件见 docs/codex-parity.md 的说明）。 */
export type HookEventName = "session_start" | "user_prompt_submit";

export const HOOK_EVENTS: HookEventName[] = ["session_start", "user_prompt_submit"];

export type HookConfig = {
  event: HookEventName;
  command: string;
  /** 超时（毫秒），默认 5000。 */
  timeoutMs: number;
};

export type HookOutcome = {
  /** 注入的上下文（按 hook 顺序）。 */
  context: string[];
  /** 被拦下（`decision: "block"`）。 */
  blocked: boolean;
  reason?: string;
  /** 失败 / 超时 / 输出不合法：记下来给日志与界面，但不动回合。 */
  errors: string[];
  /** 实际执行的 hook 数（0 = 没配置）。 */
  runs: number;
};

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CONTEXT_PER_HOOK = 8 * 1024;
const MAX_CONTEXT_TOTAL = 16 * 1024;
const MAX_STDERR_CHARS = 2000;
/** 超时后从 SIGTERM 升级到 SIGKILL 的宽限：给正常进程留出清理时间，又不至于卡住回合。 */
const HOOK_KILL_GRACE_MS = 2000;

/**
 * 事件名归一化：Codex 文档里是 `UserPromptSubmit`（PascalCase），
 * 我们的设置里写 `user_prompt_submit`，两边都认（粘贴过来不用改）。
 */
export function normalizeHookEvent(raw: string): HookEventName | null {
  const normalized = raw
    .trim()
    .replace(/[-\s]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return (HOOK_EVENTS as string[]).includes(normalized) ? (normalized as HookEventName) : null;
}

/** 解析 `AGENT_HOOKS`（JSON 数组）；非法条目丢弃并给出原因，不影响其余 hook。 */
export function parseHookConfigs(raw: string): { hooks: HookConfig[]; errors: string[] } {
  const errors: string[] = [];
  if (!raw.trim()) return { hooks: [], errors };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { hooks: [], errors: [`AGENT_HOOKS 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!Array.isArray(parsed)) return { hooks: [], errors: ["AGENT_HOOKS 必须是数组"] };

  const hooks: HookConfig[] = [];
  parsed.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      errors.push(`第 ${index + 1} 条不是对象`);
      return;
    }
    const entry = item as Record<string, unknown>;
    const event = typeof entry.event === "string" ? normalizeHookEvent(entry.event) : null;
    if (!event) {
      errors.push(`第 ${index + 1} 条的事件名不认识（支持：${HOOK_EVENTS.join(" / ")}）`);
      return;
    }
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (!command) {
      errors.push(`第 ${index + 1} 条缺少 command`);
      return;
    }
    const rawTimeout = Number(entry.timeoutMs);
    hooks.push({
      event,
      command,
      timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(60_000, rawTimeout) : DEFAULT_TIMEOUT_MS,
    });
  });
  return { hooks, errors };
}

/** 当前生效的 hooks。 */
export function hookConfigs(): { hooks: HookConfig[]; errors: string[] } {
  return parseHookConfigs(getSetting("AGENT_HOOKS"));
}

export function hooksFor(event: HookEventName): HookConfig[] {
  return hookConfigs().hooks.filter((hook) => hook.event === event);
}

/** 打开设置页时看一眼：配了几条、有没有写错的。 */
export function hooksStatus(): { hooks: HookConfig[]; errors: string[] } {
  const { hooks, errors } = hookConfigs();
  return { hooks, errors };
}

type HookRunResult = { context?: string; blocked: boolean; reason?: string; error?: string };

/**
 * 跑一条 hook。**任何失败都只是 error，不会抛错、不会阻断回合**
 * （除了脚本明确写 `{"decision":"block"}`）。
 */
export async function runHook(
  hook: HookConfig,
  payload: Record<string, unknown>,
): Promise<HookRunResult> {
  const shell = resolveCommandShell();
  const serialized = JSON.stringify(payload);
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: shell.commandArgs(hook.command),
      env: {
        ...process.env,
        OMNI_HOOK_EVENT: hook.event,
        OMNI_HOOK_PAYLOAD: serialized,
      },
      cwd: typeof payload.workspace === "string" && payload.workspace ? payload.workspace : process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      detached: true,
    });
    // 事件 JSON 从 stdin 交给脚本（Codex 的 hook 也是这个契约）。
    proc.stdin.write(serialized);
    await proc.stdin.end();
  } catch (error) {
    return { blocked: false, error: `启动失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 超时标记由定时器自己置位，不能回头用"耗时 ≥ 超时且退出码非 0"去猜：
  // 一个本来就失败、又恰好跑过超时阈值的 hook 会被报成"超时（>Nms）"，
  // 把用户的注意力引到错误的方向（真实原因是脚本自己的错误）。
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      killProcessTree(proc);
    } catch {
      // 已经退出
    }
    // SIGTERM 拦得住正常的进程，拦不住 trap 了信号（或卡在不可中断等待）的：
    // 那种情况下 `proc.exited` 永远不 resolve，**整个 Agent 回合就卡死在这里**。
    // 宽限之后再补一刀 SIGKILL。
    killTimer = setTimeout(() => {
      try {
        killProcessTree(proc, "SIGKILL");
      } catch {
        // 同上
      }
    }, HOOK_KILL_GRACE_MS);
  }, hook.timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    if (timedOut) {
      return { blocked: false, error: `超时（>${hook.timeoutMs}ms）` };
    }
    if (exitCode !== 0) {
      const detail = stderr.trim().slice(0, MAX_STDERR_CHARS);
      return { blocked: false, error: `退出码 ${exitCode}${detail ? `：${detail}` : ""}` };
    }

    const text = stdout.trim();
    if (!text) return { blocked: false };

    // 先当 JSON 试：`{"decision":"block","reason":…}` / `{"context":…}`。
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const decision = typeof parsed.decision === "string" ? parsed.decision.toLowerCase() : "";
        if (decision === "block" || decision === "deny") {
          const reason =
            typeof parsed.reason === "string" && parsed.reason.trim()
              ? parsed.reason.trim()
              : "hook 拦下了这一轮（未给出原因）";
          return { blocked: true, reason };
        }
        if (typeof parsed.context === "string" && parsed.context.trim()) {
          return { blocked: false, context: parsed.context };
        }
        if (decision === "allow" || decision === "context" || decision === "inject") {
          return { blocked: false };
        }
        return {
          blocked: false,
          error:
            "stdout 是 JSON，但没有 decision / context 字段。" +
            '想输出上下文就写成 {"context": "..."}，或者直接打纯文本；别把输入原样打回来',
        };
      } catch {
        // 不是 JSON：当普通文本上下文（脚本里 cat 一个文件是最常见的写法）。
      }
    }
    return { blocked: false, context: text };
  } catch (error) {
    return { blocked: false, error: `执行失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
}

/** 事件名 → 事件里带的字段（给 README / 设置页的示例用）。 */
export function hookPayloadFor(
  event: HookEventName,
  input: {
    conversationId: number;
    workspace: string;
    mode: string;
    model?: string;
    prompt?: string;
  },
): Record<string, unknown> {
  const base = {
    event,
    conversationId: input.conversationId,
    workspace: input.workspace,
    mode: input.mode,
    model: input.model ?? "",
    at: Date.now(),
  };
  if (event === "user_prompt_submit") return { ...base, prompt: input.prompt ?? "" };
  return base;
}

/**
 * 按顺序跑某个事件的所有 hook，汇总上下文与拦截决定。
 * 上下文有总量上限：hook 的输出会进上下文窗口，本地模型窗口不大。
 */
export async function runHooks(
  event: HookEventName,
  input: {
    conversationId: number;
    workspace: string;
    mode: string;
    model?: string;
    prompt?: string;
  },
): Promise<HookOutcome> {
  const hooks = hooksFor(event);
  const outcome: HookOutcome = { context: [], blocked: false, errors: [], runs: 0 };
  if (!hooks.length) return outcome;

  const payload = hookPayloadFor(event, input);
  let budget = MAX_CONTEXT_TOTAL;
  for (const hook of hooks) {
    outcome.runs += 1;
    const result = await runHook(hook, payload);
    if (result.error) {
      outcome.errors.push(`${hook.command}: ${result.error}`);
      logEvent({
        level: "warn",
        source: "agent",
        event: "agent.hook.failed",
        message: `hook 执行失败（${event}）：${result.error}`,
        detail: { command: hook.command, conversationId: input.conversationId, workspace: input.workspace },
      });
      continue;
    }
    if (result.blocked) {
      // 第一个说"拦"的 hook 就拦下：后面的 hook 没有再跑的意义。
      outcome.blocked = true;
      outcome.reason = result.reason;
      logEvent({
        level: "info",
        source: "agent",
        event: "agent.hook.blocked",
        message: `hook 拦下了这一轮（${event}）：${result.reason}`,
        detail: { command: hook.command, conversationId: input.conversationId },
      });
      break;
    }
    if (result.context) {
      const text = result.context.trim();
      const slice = text.slice(0, Math.min(MAX_CONTEXT_PER_HOOK, budget));
      budget -= slice.length;
      if (slice) outcome.context.push(slice);
      if (!budget) break;
    }
  }
  return outcome;
}
