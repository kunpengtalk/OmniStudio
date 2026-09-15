import type { ParsedArgs } from "../args";
import { optBool, optString } from "../args";
import { controlRequest } from "../client";
import { resolveControlSocket } from "../data-dir";
import { existsSync } from "fs";

/**
 * `omi agent run` —— 无头跑一个 Agent 回合（对齐 Codex 的 `codex exec`）。
 *
 * 从 CI、编辑器插件或任何脚本里"跑一次并拿到结果"的入口：
 * - 默认打印最终回答；
 * - `--json` 边跑边吐 NDJSON（轨迹事件 / 正文增量 / 最终结果各一行），给外部程序消费；
 * - 会话会照常落库（标题取提示词前 40 字），跑完可以在界面里打开继续追问。
 *
 * 为什么不是"一条命令跑完再打印"：脚本要能实时看到工具在干什么
 * （比如 CI 里把"它正在跑测试"打进日志），所以控制通道为它开了 NDJSON 流式响应。
 */

const MODES = ["agent", "plan", "goal"] as const;
type Mode = (typeof MODES)[number];

function usage(): never {
  console.error(`用法：omi agent run <提示词> [选项]

选项：
  --json                 把事件流按 NDJSON 输出（每行一个 JSON），供脚本消费
  --chunks               在 --json 里连正文增量一起输出（默认只给轨迹事件与结果）
  --workspace <目录>      指定工作区（默认用应用里配置的那个）
  --mode <模式>           agent（默认）| plan | goal
  --conversation <id>    在已有会话里接着跑（默认新建一条）
  --timeout <毫秒>        等待上限（默认 600000）

示例：
  omi agent run "把 README 里的安装步骤补全"
  omi agent run "跑一遍测试并总结失败原因" --json | jq -r 'select(.type=="event") | .event.toolName'
  omi agent run "继续" --conversation 12 --mode plan`);
  process.exit(1);
}

/** 把 `agentRun` 的流式响应读出成 NDJSON 行（逐行回调，边到边处理）。 */
async function streamAgentRun(
  socketPath: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  onLine: (line: Record<string, unknown>) => void,
): Promise<boolean> {
  const res = await fetch("http://control", {
    unix: socketPath,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "agentRun", payload: { ...payload, stream: true } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) {
    console.error(`控制服务返回 HTTP ${res.status}`);
    return false;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ok = true;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type === "result" && parsed.ok === false) ok = false;
          onLine(parsed);
        } catch {
          // 半行 / 非 JSON：忽略（协议本身是 NDJSON，出现在这里只可能是截断）
        }
      }
      index = buffer.indexOf("\n");
    }
  }
  return ok;
}

export async function cmdAgent(parsed: ParsedArgs): Promise<void> {
  const [sub, ...rest] = parsed.positionals;
  if (sub !== "run") {
    console.error(`未知子命令：${sub ?? "(空)"}（目前只有 run）\n`);
    usage();
  }
  // `omi agent run "提示词"`：提示词是位置参数；没写的话允许从 stdin 读（管道友好）。
  let prompt = rest.join(" ").trim();
  if (!prompt && !process.stdin.isTTY) {
    prompt = (await new Response(Bun.stdin.stream()).text()).trim();
  }
  if (!prompt) usage();

  const mode = optString(parsed.options, "mode");
  if (mode !== undefined && !(MODES as readonly string[]).includes(mode)) {
    console.error(`--mode 只能是 ${MODES.join(" / ")}`);
    process.exit(1);
  }
  const timeoutMs = Number(optString(parsed.options, "timeout")) || 600_000;
  const payload: Record<string, unknown> = {
    prompt,
    mode: (mode as Mode | undefined) ?? "agent",
    ...(optString(parsed.options, "workspace") ? { workspace: optString(parsed.options, "workspace") } : {}),
    ...(optString(parsed.options, "conversation")
      ? { conversationId: Number(optString(parsed.options, "conversation")) }
      : {}),
  };
  const json = optBool(parsed.options, "json");
  if (json && optBool(parsed.options, "chunks")) payload.chunks = true;

  const socketPath = await resolveControlSocket();
  if (!socketPath || !existsSync(socketPath)) {
    console.error("应用未运行。先 `omi start`（脚本里可以用 `omi start --server` 一并起推理服务）。");
    process.exit(1);
  }

  if (!json) {
    const result = await controlRequest("agentRun", payload, timeoutMs);
    if (!result.connected) {
      console.error(result.error ?? "应用未运行");
      process.exit(1);
    }
    const data = result.data as { ok?: boolean; text?: string; conversationId?: number; error?: string } | undefined;
    if (data?.text) console.log(data.text);
    if (!result.ok || data?.ok === false) {
      console.error(data?.error ?? result.error ?? "无头执行失败");
      if (data?.conversationId) console.error(`会话：${data.conversationId}`);
      process.exit(1);
    }
    return;
  }

  const ok = await streamAgentRun(socketPath, payload, timeoutMs, (line) => {
    // 默认只输出事件与结果；正文增量在流式响应里本来就是给 --chunks 用的。
    if (line.type === "chunk" && !payload.chunks) return;
    process.stdout.write(`${JSON.stringify(line)}\n`);
  });
  if (!ok) process.exit(1);
}
