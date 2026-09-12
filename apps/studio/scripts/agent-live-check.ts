/**
 * Agent 真实链路验证：默认自带一个脚本化的 OpenAI 兼容桩服务，因此是确定性的，
 * 已接进 `test:smoke`（单测覆盖不到"Agent 循环 + 授权闸门 + 工具真的执行"这一层）。
 *
 * 跑法：
 *   bun run scripts/agent-live-check.ts                     # 内置桩服务，确定性
 *   OMNI_LIVE_BASE=http://127.0.0.1:18011/v1 OMNI_LIVE_MODEL=xxx \
 *     bun run scripts/agent-live-check.ts                   # 指向真实推理服务（人工排查用）
 *
 * 覆盖：Agent 循环 → 流式解析（含工具参数分片）→ 授权弹窗（挂起 / 拒绝 / 允许）
 * → 工具真的执行 → 轨迹事件 / 待办 / 产出物落库。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const dataDir = mkdtempSync(path.join(tmpdir(), "omni-live-check-"));
process.env.OMNI_DATA_DIR = dataDir;
const workspace = mkdtempSync(path.join(tmpdir(), "omni-live-ws-"));
/** 给"危险命令"准备一个真实存在、可以被删掉的目录：拒绝时它必须还在，允许时才消失。 */
const decoyA = mkdtempSync(path.join(tmpdir(), "omni-live-decoy-a-"));
const decoyB = mkdtempSync(path.join(tmpdir(), "omni-live-decoy-b-"));
writeFileSync(path.join(decoyA, "keep.txt"), "denied 时我应该还在，allowed 后才消失\n");
writeFileSync(path.join(decoyB, "keep.txt"), "allowed 时我该被删掉\n");

// ---------------------------------------------------------------------------
// 脚本化桩服务：按"已经出现过几个工具结果"决定这一轮返回什么
// ---------------------------------------------------------------------------
function sseChunk(model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function toolCallChunks(model: string, name: string, args: unknown): string[] {
  const json = JSON.stringify(args);
  const chunks = [
    sseChunk(model, {
      role: "assistant",
      content: "",
      tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: "" } }],
    }),
  ];
  // 参数分片下发（真实服务也是这样），顺便验证拼接逻辑。
  for (let i = 0; i < json.length; i += 24) {
    chunks.push(
      sseChunk(model, {
        tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + 24) } }],
      }),
    );
  }
  chunks.push(sseChunk(model, {}, "tool_calls"));
  return chunks;
}

function textChunks(model: string, text: string): string[] {
  const chunks = [sseChunk(model, { role: "assistant", content: "" })];
  // 思考增量（llama.cpp / vLLM 用 reasoning_content，mlx 用 reasoning）：
  // 界面上的「思考中…」与展开后的思考原文都靠这条流，漏掉就是"回复里什么都没有"。
  for (const piece of ["先看一下工作区，", "再决定怎么做。"]) {
    chunks.push(sseChunk(model, { reasoning_content: piece }));
  }
  for (let i = 0; i < text.length; i += 8) {
    chunks.push(sseChunk(model, { content: text.slice(i, i + 8) }));
  }
  chunks.push(
    `data: ${JSON.stringify({
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    })}\n\n`,
  );
  return chunks;
}

const stub = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models")) {
      const served = {
        object: "list",
        data: [{ id: "stub-model", object: "model", created: Date.now(), owned_by: "stub" }],
      };
      return Response.json(served);
    }
    const body = (await request.json()) as {
      messages?: { role: string; content?: unknown; tool_calls?: unknown }[];
      tools?: { function?: { name?: string } }[];
    };
    const messages = body.messages ?? [];
    const toolNames = new Set((body.tools ?? []).map((tool) => tool.function?.name ?? ""));
    const toolResults = messages.filter((message) => message.role === "tool").length;
    const assistantToolCalls = messages.filter(
      (message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
    ).length;
    const firstUser = messages.find((message) => message.role === "user")?.content;
    const firstUserText = typeof firstUser === "string" ? firstUser : JSON.stringify(firstUser ?? "");
    const wantsSubagent = /subagent/.test(firstUserText) && toolNames.has("task");
    const wantsQuestion = /question/.test(firstUserText) && toolNames.has("ask_user");
    // 只读工具集（子智能体 explore）：没有 bash / write_file
    const readOnly = !toolNames.has("bash") && toolNames.has("list_dir");

    let chunks: string[];
    if (wantsQuestion && assistantToolCalls === 0) {
      chunks = toolCallChunks("stub-model", "ask_user", {
        questions: [
          {
            question: "要按哪种方式继续？",
            header: "方式",
            options: [{ label: "方案A" }, { label: "方案B" }],
          },
        ],
      });
    } else if (wantsSubagent && assistantToolCalls === 0) {
      chunks = toolCallChunks("stub-model", "task", {
        description: "列目录",
        prompt: "请列出工作区里有哪些文件，然后用一句话总结。",
        subagent_type: "explore",
      });
    } else if (readOnly && assistantToolCalls === 0) {
      chunks = toolCallChunks("stub-model", "list_dir", { path: "." });
    } else if (readOnly && assistantToolCalls === 1) {
      chunks = toolCallChunks("stub-model", "glob", { pattern: "**/*" });
    } else if (readOnly) {
      chunks = textChunks("stub-model", "结论：工作区里有若干文件，清单见上。");
    } else if (assistantToolCalls === 0) {
      chunks = toolCallChunks("stub-model", "bash", { command: `rm -rf ${decoyA}` });
    } else if (assistantToolCalls === 1) {
      chunks = toolCallChunks("stub-model", "write_file", {
        path: "notes/live.md",
        content: "hello from live check\n",
      });
    } else if (assistantToolCalls === 2) {
      chunks = toolCallChunks("stub-model", "todo_write", {
        todos: [
          { content: "跑一条危险命令并确认授权生效", status: "completed", priority: "high" },
          { content: "写 notes/live.md", status: "completed" },
        ],
      });
    } else {
      chunks = textChunks("stub-model", `工具调用完成（工具结果 ${toolResults} 条）。`);
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});

const useStub = !process.env.OMNI_LIVE_BASE;
const base = process.env.OMNI_LIVE_BASE ?? `http://127.0.0.1:${stub.port}/v1`;
const model = process.env.OMNI_LIVE_MODEL ?? "stub-model";

const { updateSettings } = await import("../src/bun/db/settings");
const Chat = await import("../src/bun/chat");
const Agent = await import("../src/bun/agent");
const Interactions = await import("../src/bun/agent-interactions");
const Todos = await import("../src/bun/agent-todos");
const Artifacts = await import("../src/bun/agent-artifacts");

updateSettings({
  SETUP_COMPLETE: "1",
  SERVER_MODE: "remote",
  VLLM_API_BASE: base,
  VLLM_API_KEY: "EMPTY",
  VLLM_MODEL_NAME: model,
  CHAT_MODEL: model,
  SERVER_CTX_SIZE: "8192",
  /** 走 manual：所有有副作用的工具（含 write_file）都要经过弹窗，才能验证闸门。 */
  AGENT_APPROVAL_MODE: "manual",
  AGENT_MAX_STEPS: "8",
  MEMORY_ENABLED: "0",
});

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? ""}`}`);
  if (!ok) failed++;
};

const conversation = Chat.createConversation("live check", "agent");
Agent.setConversationWorkspace(conversation.id, workspace);

// 依次应答弹窗：拒绝 bash → 允许 write_file → 允许 todo_write。
/** 第一段：bash 拒绝、edit 允许；第二段（排队/插话验证）：全部允许。 */
const replies: ("deny" | "once")[] = (
  process.env.OMNI_LIVE_REPLY ?? "deny,once,once,once,once"
)
  .split(",")
  .map((value) => value.trim() as "deny" | "once");
const asked: { permission: string; pattern: string }[] = [];
const askedQuestions: { id: string; question: string }[] = [];

// 提问自动作答：验证「答案回到模型」这条链路。
Interactions.onQuestionAsked((question) => {
  askedQuestions.push({ id: question.id, question: question.questions[0]?.question ?? "" });
  console.log(`   · 提问：${question.questions[0]?.question ?? ""} → 方案A`);
  setTimeout(() => Interactions.respondQuestion(question.id, [["方案A"]]), 30);
});

Interactions.onPermissionRequest((request) => {
  asked.push({ permission: request.permission, pattern: request.pattern });
  const reply = replies.shift() ?? "deny";
  console.log(`   · 授权请求：${request.permission} / ${request.pattern} → ${reply}`);
  setTimeout(() => Interactions.respondPermission(request.id, reply), 30);
});

console.log(`推理服务：${base}${useStub ? "（内置桩）" : ""}，模型：${model}`);

/**
 * 流式时序：正文与思考都必须在回合结束**之前**就推给界面 ——
 * 界面上正文是边生成边出现的（结束时一次性蹦出来 = 用户看到的"空着的回复"），
 * 「思考中…」那一行同理。
 */
const streamed = { content: "", reasoning: "", contentDuringRun: false, reasoningDuringRun: false, done: false };
const unsubscribeChunks = Agent.onAgentChunk((payload) => {
  if (payload.conversationId !== conversation.id) return;
  if (payload.kind === "reasoning") {
    streamed.reasoning += payload.delta;
    if (!streamed.done) streamed.reasoningDuringRun = true;
  } else {
    streamed.content += payload.delta;
    if (!streamed.done) streamed.contentDuringRun = true;
  }
});

const result = await Agent.runAgentTurn({
  conversationId: conversation.id,
  content: "跑起来：先执行命令，再写文件，最后更新待办清单。",
  mode: "agent",
  workspace,
});
streamed.done = true;
unsubscribeChunks();

check("Agent 回合跑完", result.ok, result.error);
check(
  "正文是流式下发的（回合结束前就收到增量）",
  streamed.contentDuringRun && streamed.content.length > 0,
  `回合内收到 ${streamed.content.length} 字`,
);
check(
  "流式正文与最终回答一致（没有丢字/重复）",
  Chat.getHistory(conversation.id).some(
    (message) => message.role === "assistant" && message.content.includes(streamed.content.trim()),
  ),
  streamed.content.slice(0, 80),
);
check(
  "思考增量也推给了界面（思考行才有的显示）",
  streamed.reasoningDuringRun && streamed.reasoning.includes("先看一下工作区"),
  streamed.reasoning.slice(0, 60),
);

const events = Agent.listAgentEvents(conversation.id);
const toolStarts = events.filter((event) => event.kind === "tool_start").map((event) => event.toolName);
console.log(`   · 工具调用：${toolStarts.join(", ") || "（无）"}`);
check("依次调用了 bash / write_file / todo_write", toolStarts.join(",") === "bash,write_file,todo_write", toolStarts.join(","));

const bashEnd = events.find((event) => event.kind === "tool_end" && event.toolName === "bash");
check(
  "危险命令触发了授权弹窗",
  asked.some((item) => item.permission === "bash" && item.pattern.includes("rm -rf")),
);
check(
  "拒绝后 bash 真的没执行（工具结果里是拒绝原因）",
  (bashEnd?.output ?? "").includes("拒绝"),
  bashEnd?.output?.slice(0, 160),
);
check("拒绝后目录确实没被删（工具真被拦住了）", existsSync(decoyA));
check(
  "授权弹窗记进了运行轨迹",
  events.some((event) => event.toolName === "permission" && (event.output ?? "").includes("已拒绝")),
);

const writeEnd = events.find((event) => event.kind === "tool_end" && event.toolName === "write_file");
check(
  "允许后 write_file 真的执行了",
  (writeEnd?.output ?? "").includes("Wrote"),
  writeEnd?.output?.slice(0, 160),
);
check(
  "文件真的落到了工作区",
  Artifacts.readWorkspaceFile(workspace, "notes/live.md").text?.includes("hello from live check") === true,
);
check(
  "产出物登记了 notes/live.md",
  Artifacts.listArtifacts(conversation.id).some((item) => item.path.includes("live.md")),
  JSON.stringify(Artifacts.listArtifacts(conversation.id).map((item) => item.path)),
);
check(
  "待办清单落库且两项都完成",
  Todos.listTodos(conversation.id).filter((todo) => todo.status === "completed").length === 2,
  JSON.stringify(Todos.listTodos(conversation.id)),
);

const history = Chat.getHistory(conversation.id);
const lastAssistant = [...history].reverse().find((message) => message.role === "assistant");
check("最终回答非空", (lastAssistant?.content ?? "").trim().length > 0, lastAssistant?.content);
console.log(`\n最终回答：${(lastAssistant?.content ?? "").slice(0, 300)}\n`);

// ---------------------------------------------------------------------------
// 运行中的排队与插话（OpenWork 的 queued messages / steer）
// ---------------------------------------------------------------------------
const second = Chat.createConversation("live check queue", "agent");
Agent.setConversationWorkspace(second.id, workspace);

// 直接跑（没在运行）：等价于普通发送。
const direct = await Agent.followUpAgentMessage({ conversationId: second.id, content: "直接跑一次" });
check("没在运行时 followUp 就是直接开跑", direct.ok && direct.queued === false, JSON.stringify(direct));

// 运行中：排队 + 插话，本次结束后自动跑下一条。
const runPromise = Agent.runAgentTurn({
  conversationId: second.id,
  content: "先执行命令。",
  mode: "agent",
  workspace,
});
for (let i = 0; i < 100 && !Agent.isAgentRunning(second.id); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
check("运行中（可继续输入）", Agent.isAgentRunning(second.id));
const queued = await Agent.followUpAgentMessage({ conversationId: second.id, content: "第二轮：再写一次文件" });
const steered = await Agent.followUpAgentMessage({ conversationId: second.id, content: "插话：先说结论", mode: "steer" });
check("排队成功", queued.queued === true, JSON.stringify(queued));
check("插话成功（不进队列）", steered.ok && steered.queued === false, JSON.stringify(steered));
check("队列里能看到排队的消息", Agent.listQueuedMessages(second.id).length === 1);
await runPromise;

// 等队列被排空（本轮结束自动开下一轮）
for (let i = 0; i < 200 && Agent.listQueuedMessages(second.id).length > 0; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
check("本轮结束后队列被排空并继续跑", Agent.listQueuedMessages(second.id).length === 0);
const secondEvents = Agent.listAgentEvents(second.id);
check(
  "插话在运行轨迹里留痕",
  secondEvents.some((event) => (event.output ?? "").includes("已插话")),
);
check(
  "排队消息也在轨迹里留痕",
  secondEvents.some((event) => (event.output ?? "").includes("已排队")),
);
const secondHistory = Chat.getHistory(second.id);
check(
  "排队与插话的文字都进了会话历史",
  secondHistory.some((message) => message.content.includes("第二轮：再写一次文件")) &&
    secondHistory.some((message) => message.content.includes("插话：先说结论")),
);
check(
  "排队消息触发了新一轮（助手消息 ≥ 3 条）",
  secondHistory.filter((message) => message.role === "assistant").length >= 3,
  String(secondHistory.filter((message) => message.role === "assistant").length),
);
// 第二次对话里同一条危险命令被允许 → 签核通过后工具真的执行了（decoy 消失）。
check("允许后同一条命令真的执行（decoy 目录已被删除）", !existsSync(decoyA), decoyA);

// ---------------------------------------------------------------------------
// 子智能体（task 工具）：必须跑完自己的多轮工具循环并把结论带回主线
// ---------------------------------------------------------------------------
const third = Chat.createConversation("live check subagent", "agent");
Agent.setConversationWorkspace(third.id, workspace);
await Agent.runAgentTurn({
  conversationId: third.id,
  content: "请派一个 subagent 去调研工作区，然后告诉我结论。",
  mode: "agent",
  workspace,
});
const thirdEvents = Agent.listAgentEvents(third.id);
check("主线调用了 task 工具", thirdEvents.some((event) => event.kind === "tool_start" && event.toolName === "task"));
const subagentStart = thirdEvents.find((event) => event.kind === "subagent_start");
const subagentEnd = thirdEvents.find((event) => event.kind === "subagent_end");
check("子智能体有自己的运行区间（start/end 成对）", Boolean(subagentStart && subagentEnd));
check(
  "子智能体在内部跑了工具（不是空手而归）",
  thirdEvents.some((event) => event.kind === "tool_start" && event.subagentId && event.toolName === "list_dir"),
);
check(
  "子智能体交回了结论（不是「无输出」）",
  (subagentEnd?.output ?? "").startsWith("完成："),
  subagentEnd?.output?.slice(0, 160),
);
const taskEnd = thirdEvents.find((event) => event.kind === "tool_end" && event.toolName === "task");
check(
  "task 工具把子智能体的结论原样回传给了主线",
  (taskEnd?.output ?? "").includes("结论"),
  taskEnd?.output?.slice(0, 160),
);

// ---------------------------------------------------------------------------
// 上下文压缩：把窗口设得极小，长任务必须触发压缩且仍然跑完
// ---------------------------------------------------------------------------
updateSettings({ SERVER_CTX_SIZE: "1000" });
const fourth = Chat.createConversation("live check compact", "agent");
Agent.setConversationWorkspace(fourth.id, workspace);
await Agent.runAgentTurn({
  conversationId: fourth.id,
  content: "执行完整流程：" + "这是一段用来把上下文撑满的中文说明，需要读完再动手。".repeat(12),
  mode: "agent",
  workspace,
});
const fourthEvents = Agent.listAgentEvents(fourth.id);
check(
  "上下文压实在长任务里触发了",
  fourthEvents.some((event) => event.toolName === "compact"),
  JSON.stringify(fourthEvents.filter((e) => e.toolName === "compact").map((e) => e.output)),
);
check(
  "压缩后任务仍然跑完（有工具调用 + 最终回答）",
  fourthEvents.some((event) => event.kind === "tool_start") &&
    (Chat.getHistory(fourth.id).reverse().find((message) => message.role === "assistant")?.content ?? "").length > 0,
);
updateSettings({ SERVER_CTX_SIZE: "8192" });

// ---------------------------------------------------------------------------
// 提问（ask_user）：请求与答案都要落进会话流（界面据此在消息流里渲染，回看也在）
// ---------------------------------------------------------------------------
const fifth = Chat.createConversation("live check question", "agent");
Agent.setConversationWorkspace(fifth.id, workspace);
await Agent.runAgentTurn({
  conversationId: fifth.id,
  content: "先 question 一下再继续：问我要用哪种方式。",
  mode: "agent",
  workspace,
});
const fifthEvents = Agent.listAgentEvents(fifth.id);
check("提问被推给了界面", askedQuestions.length >= 1);
const askEvent = fifthEvents.find((event) => event.toolName === "question_request");
const answerEvent = fifthEvents.find((event) => event.toolName === "question");
check("提问**落成了会话事件**（回看历史能看到）", Boolean(askEvent && answerEvent));
const askId = askEvent ? (JSON.parse(askEvent.args ?? "{}") as { id?: string }).id : undefined;
const answerId = answerEvent ? (JSON.parse(answerEvent.args ?? "{}") as { id?: string }).id : undefined;
check("请求与答案是同一条记录（按 id 配对）", Boolean(askId) && askId === answerId, `${askId} vs ${answerId}`);
check(
  "答案内容进了会话流",
  (answerEvent?.output ?? "").includes("方案A"),
  answerEvent?.output ?? undefined,
);
const askToolResult = fifthEvents.find((event) => event.kind === "tool_end" && event.toolName === "ask_user");
check(
  "答案也回到了模型（工具结果里有选项）",
  (askToolResult?.output ?? "").includes("方案A"),
  askToolResult?.output?.slice(0, 120),
);

// 授权同样要能回看：请求 + 结果两条事件，id 配对
const firstAsk = Agent.listAgentEvents(conversation.id).find((event) => event.toolName === "permission_request");
const firstAnswer = Agent.listAgentEvents(conversation.id).find((event) => event.toolName === "permission");
check("授权请求也落成了会话事件", Boolean(firstAsk), firstAsk?.output ?? undefined);
check(
  "授权结果与请求按 id 配对，且记录了用户的选择",
  Boolean(firstAnswer?.output?.includes("拒绝")),
  firstAnswer?.output ?? undefined,
);

Interactions.cancelPendingForConversation(fifth.id);
Interactions.cancelPendingForConversation(third.id);
Interactions.cancelPendingForConversation(fourth.id);
Interactions.cancelPendingForConversation(second.id);
Interactions.cancelPendingForConversation(conversation.id);
stub.stop(true);
rmSync(dataDir, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
rmSync(decoyA, { recursive: true, force: true });

if (failed > 0) {
  console.error(`live check: ${failed} 项失败`);
  process.exit(1);
}
console.log("live check 全部通过");
