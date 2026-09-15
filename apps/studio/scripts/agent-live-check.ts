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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
function sseChunk(
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
): string {
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
      tool_calls: [
        { index: 0, id: `call_${name}`, type: "function", function: { name, arguments: "" } },
      ],
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

/**
 * 一步里"先说一句、再调工具"（真实模型最常见的形态）：正文增量在前、工具调用在后，
 * 收尾是 `tool_calls` 而不是 `stop`。这是时间轴混排的基础形态 —— 界面上必须排成
 * "它说的话 → 这批工具"，而不是把这一轮所有工具挤到正文上面去。
 */
function sayThenToolChunks(model: string, text: string, name: string, args: unknown): string[] {
  const chunks = textChunks(model, text);
  // 这一步还没结束：去掉 textChunks 结尾的 stop，收尾交给工具调用那条。
  chunks.pop();
  const json = JSON.stringify(args);
  chunks.push(
    sseChunk(model, {
      role: "assistant",
      content: "",
      tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: "" } }],
    }),
  );
  for (let i = 0; i < json.length; i += 24) {
    chunks.push(sseChunk(model, { tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + 24) } }] }));
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

/** 每次请求收到的系统提示（去重后用于断言项目指令确实注入了）。 */
const capturedSystemPrompts: string[] = [];
/** 每次请求里最后一条 user 消息（用于断言 user_prompt_submit hook 的上下文确实注入了）。 */
const capturedUserPrompts: string[] = [];
/** 每次请求带的 model 字段（用于断言会话内换模型对下一轮生效）。 */
const capturedRequestModels: string[] = [];
/** 自愈场景的计数：瞬时 503 打回来几次、空回合出现过几次。 */
const selfHeal = { unavailable503: 0, retryNotices: 0, emptyTurns: 0, emptyNudges: 0 };

/**
 * 剧本进度 = **这个会话已经回答过几个请求**（单调递增）。
 *
 * 为什么不用"请求里的工具调用 / 工具结果条数"：上下文压缩会把中间的消息摘掉，
 * 那个数会**倒退** —— 桩会把已经演过的步骤再演一遍，长流程最后撞上步数上限
 * （真的发生过，而且只在把窗口调小的用例里出现，查起来很费劲）。
 *
 * 键用**会话第一条用户消息**：这是请求里唯一在压缩之后还能保持不变的东西
 * （裁剪会保留队首那条任务描述；摘要路径会连队首一起换掉，所以要避开它 ——
 * 需要"跨轮里程碑"的剧本另用 `emitted` 集合，见下）。
 */
const turnRequests = new Map<string, number>();

/**
 * 会话级"里程碑"（跨轮保留）：目标那类剧本必须记得"这条会话已经立过项 / 已经宣布完成"。
 * 只靠步数会被轮次边界切碎，只靠请求里的痕迹会被压缩擦掉。
 */
const emitted = new Map<string, Set<string>>();
function hasEmitted(key: string, name: string): boolean {
  return emitted.get(key)?.has(name) ?? false;
}
function markEmitted(key: string, name: string): void {
  const set = emitted.get(key) ?? new Set<string>();
  set.add(name);
  emitted.set(key, set);
}

/** 消息内容取纯文本：内容块数组（文本 + 图片）要拼起来，直接 JSON.stringify 会拿到 `[{"type":"text"...`。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block as { text?: string })?.text ?? "").join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/**
 * 会话标识：第一条用户消息的**第一段**。
 *
 * 两个坑都踩过：内容可能是内容块数组（直接 stringify 会让所有会话变成同一个键，
 * 进度互相污染）；首轮请求里那一段还带着本轮才挂上去的"当前日期时间…"与 hook 上下文
 * （它们不进历史），不剥掉的话同一场会话的首轮与后续轮对不上键。
 */
function conversationKey(firstUserContent: unknown): string {
  const raw = textOf(firstUserContent).replace(/^当前日期时间是[^\n]*\n+/, "");
  return raw.split("\n\n")[0]!.slice(0, 64);
}

/** 取"这个会话的第几个响应"并推进计数（0 = 这个会话的第一个响应）。 */
function takeStep(firstUserContent: unknown): number {
  const key = conversationKey(firstUserContent);
  const step = turnRequests.get(key) ?? 0;
  turnRequests.set(key, step + 1);
  return step;
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
      model?: string;
      messages?: { role: string; content?: unknown; tool_calls?: unknown }[];
      tools?: { function?: { name?: string } }[];
    };
    const messages = body.messages ?? [];
    // 每次请求发的是哪个模型：`/model` 换完必须对下一轮生效。
    if (typeof body.model === "string") capturedRequestModels.push(body.model);
    const toolNames = new Set((body.tools ?? []).map((tool) => tool.function?.name ?? ""));
    // 系统提示原文：用来验证项目指令（AGENTS.md）与 session_start hook 真的进了请求。
    const systemMessage = messages.find((message) => message.role === "system")?.content;
    if (typeof systemMessage === "string" && systemMessage.trim()) {
      capturedSystemPrompts.push(systemMessage);
    }
    // 最后一条 user 消息：hook 注入的上下文会随本轮任务描述一起发出去。
    const userMessages = messages.filter((message) => message.role === "user");
    const lastUser = userMessages[userMessages.length - 1]?.content;
    // 内容可能是纯文本，也可能是多段（文本 + 图片）：统一成字符串再断言。
    const lastUserText =
      typeof lastUser === "string" ? lastUser : lastUser ? JSON.stringify(lastUser) : "";
    if (lastUserText.trim()) capturedUserPrompts.push(lastUserText);
    const firstUser = messages.find((message) => message.role === "user")?.content;
    const firstUserText =
      typeof firstUser === "string" ? firstUser : JSON.stringify(firstUser ?? "");
    const toolResults = messages.filter((message) => message.role === "tool").length;
    /** 这个会话的进度（第几个响应）—— 见 `takeStep` 的说明。 */
    const step = takeStep(firstUser);
    const conversation = conversationKey(firstUser);
    const wantsSubagent = /subagent/.test(firstUserText) && toolNames.has("task");
    const wantsQuestion = /question/.test(firstUserText) && toolNames.has("ask_user");
    // 只读工具集（子智能体 explore）：没有 bash / write_file
    const readOnly = !toolNames.has("bash") && toolNames.has("list_dir");

    // Goal 模式的自动续跑：我们发出的续跑消息里带这个前缀，桩据此推进到"完成"。
    const isGoalContinuation = lastUserText.includes("系统自动继续");
    const wantsGoal = /goal-未完成/.test(firstUserText);
    const wantsPlan = /plan-写方案/.test(firstUserText);
    /**
     * 自愈场景一：传输层瞬时失败。
     * 前两次请求直接 503（本地推理服务"模型还在加载"的样子，带 `retry-after: 0`
     * 让退避不必真的等），第三次正常回答 —— 用户不该看到任何报错。
     */
    if (/transient-503/.test(firstUserText) && selfHeal.unavailable503 < 2) {
      selfHeal.unavailable503 += 1;
      return new Response("model is loading", {
        status: 503,
        headers: { "retry-after": "0" },
      });
    }
    // 自愈场景三：一直连不上 —— 重试必须有上限，最后如实报错而不是无限重试。
    if (/transient-503-always/.test(firstUserText)) {
      return new Response("model is loading", { status: 503, headers: { "retry-after": "0" } });
    }

    let chunks: string[];
    /**
     * 自愈场景二：空回合（既没正文也没工具调用）。
     * 服务端给出一个空消息（本地模型模板不匹配时的典型形态），回合层应当注入
     * 一条 harness 提醒并把这一轮救回来 —— 用户看到的不是空白气泡。
     */
    if (/empty-turn/.test(firstUserText) && selfHeal.emptyTurns === 0) {
      selfHeal.emptyTurns += 1;
      chunks = [sseChunk("stub-model", { role: "assistant", content: "" }, "stop")];
    } else if (/empty-turn/.test(firstUserText)) {
      chunks = textChunks("stub-model", "空回合被提醒之后，我把结论写出来了。");
    } else if (/big-output/.test(firstUserText) && step === 0) {
      // 工具输出转存：这条命令的输出远超单条工具结果的上限（约 10 万字符）。
      chunks = toolCallChunks("stub-model", "bash", { command: "seq 1 20000" });
    } else if (/big-output/.test(firstUserText)) {
      chunks = textChunks("stub-model", "长输出跑完了，细节我按提示去读原文。");
    } else if (wantsPlan && step === 0) {
      // Plan 模式：把方案写下来（这是它唯一能写的东西）。
      chunks = toolCallChunks("stub-model", "write_plan", {
        content:
          "## 目标\n把导出做完\n\n## 涉及文件\n- src/export.ts（新增）\n\n## 验证\n- 跑 bun test export",
      });
    } else if (wantsPlan) {
      chunks = textChunks("stub-model", "方案已写好，等你批准。");
    } else if (wantsGoal && !hasEmitted(conversation, "goal-create")) {
      markEmitted(conversation, "goal-create");
      chunks = toolCallChunks("stub-model", "goal", {
        op: "create",
        objective: "把导出功能做完",
        acceptance: "能导出 csv 且能用文本编辑器打开",
      });
    } else if (wantsGoal && isGoalContinuation && !hasEmitted(conversation, "goal-complete")) {
      markEmitted(conversation, "goal-complete");
      // 续跑轮：这一轮才宣布完成 —— 于是之后不该再有续跑。
      chunks = toolCallChunks("stub-model", "goal", {
        op: "complete",
        outcome: "导出已实现，验证：bun test export 全部通过（3 passed）。",
      });
    } else if (wantsGoal) {
      chunks = textChunks("stub-model", "第一步做完了，还没有全部达成。");
    } else if (wantsQuestion && step === 0) {
      chunks = toolCallChunks("stub-model", "ask_user", {
        questions: [
          {
            question: "要按哪种方式继续？",
            header: "方式",
            options: [{ label: "方案A" }, { label: "方案B" }],
          },
        ],
      });
    } else if (wantsSubagent && step === 0) {
      chunks = toolCallChunks("stub-model", "task", {
        description: "列目录",
        prompt: "请列出工作区里有哪些文件，然后用一句话总结。",
        subagent_type: "explore",
      });
    } else if (/timeline-混排/.test(firstUserText) && step === 0) {
      // 时间轴场景：先说一句、再调工具（顺序必须落进事件里）。
      chunks = sayThenToolChunks("stub-model", "先看一眼工作区里有什么。", "list_dir", { path: "." });
    } else if (/timeline-混排/.test(firstUserText)) {
      chunks = textChunks("stub-model", "看完了：目录就这些。");
    } else if (readOnly && step === 0) {
      chunks = toolCallChunks("stub-model", "list_dir", { path: "." });
    } else if (readOnly && step === 1) {
      chunks = toolCallChunks("stub-model", "glob", { pattern: "**/*" });
    } else if (readOnly) {
      chunks = textChunks("stub-model", "结论：工作区里有若干文件，清单见上。");
    } else if (step === 0) {
      chunks = toolCallChunks("stub-model", "bash", { command: `rm -rf ${decoyA}` });
    } else if (step === 1) {
      chunks = toolCallChunks("stub-model", "write_file", {
        path: "notes/live.md",
        content: "hello from live check\n",
      });
    } else if (step === 2) {
      chunks = toolCallChunks("stub-model", "todo_write", {
        todos: [
          { content: "跑一条危险命令并确认授权生效", status: "completed", priority: "high" },
          { content: "写 notes/live.md", status: "completed" },
        ],
      });
    } else if (step === 3) {
      // apply_patch：一次改两个文件（新增 + 改写工作区里已有的 AGENTS.md），
      // 验证补丁工具走通了授权、上下文定位与落盘。
      chunks = toolCallChunks("stub-model", "apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Add File: notes/patched.md",
          "+补丁写入的内容",
          "*** Update File: AGENTS.md",
          "@@",
          "-仓库约定：提交前跑 bun run lint。",
          "+仓库约定：提交前跑 bun run lint 与 typecheck。",
          "*** End Patch",
        ].join("\n"),
      });
    } else if (step === 4) {
      // 上下文余量：真实回合里也要能问出个数（本地小窗口靠它决定该不该继续读文件）。
      chunks = toolCallChunks("stub-model", "get_context_remaining", {});
    } else if (step === 5) {
      chunks = toolCallChunks("stub-model", "todo_write", {
        todos: [
          { content: "跑一条危险命令并确认授权生效", status: "completed", priority: "high" },
          { content: "写 notes/live.md", status: "completed" },
          { content: "用补丁改两个文件", status: "completed" },
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
const { getChatRequestModelId: currentRequestModelId } = await import("../src/bun/chat-model");
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

// 依次应答弹窗：拒绝 bash → 允许 write_file → 允许 todo_write → 允许 apply_patch。
/** 第一段：bash 拒绝、edit 允许；第二段（排队/插话验证）：全部允许。 */
const replies: ("deny" | "once")[] = (
  process.env.OMNI_LIVE_REPLY ?? "deny,once,once,once,once,once,once"
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
const statsSeen: { context: { source: string; usedTokens: number; percent: number } | null } = {
  context: null,
};
const unsubscribeStats = Agent.onAgentStats((payload) => {
  if (payload.conversationId !== conversation.id) return;
  statsSeen.context = payload.context
    ? {
        source: payload.context.source,
        usedTokens: payload.context.usedTokens,
        percent: payload.context.percent,
      }
    : null;
});
const streamed = {
  content: "",
  reasoning: "",
  contentDuringRun: false,
  reasoningDuringRun: false,
  done: false,
};
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

/**
 * 运行态推送：界面靠它显示"还在干活"（秒数在走、转圈、停止按钮）。
 * 光有前端自己的标记是不够的 —— 刷新窗口、切走再切回、自动化在后台起的那一轮都不
 * 经过发送按钮，后端不在开跑与收尾各推一条，界面就会把正在跑的会话显示成已收工。
 */
const runStates: boolean[] = [];
const unsubscribeRunState = Agent.onAgentRunState((payload) => {
  if (payload.conversationId !== conversation.id) return;
  runStates.push(payload.running);
});

// 项目指令（对齐 Codex 的 AGENTS.md）：写进工作区，断言它真的出现在发给模型的系统提示里。
writeFileSync(path.join(workspace, "AGENTS.md"), "仓库约定：提交前跑 bun run lint。\n");

const result = await Agent.runAgentTurn({
  conversationId: conversation.id,
  content: "跑起来：先执行命令，再写文件，最后更新待办清单。",
  mode: "agent",
  workspace,
});
streamed.done = true;
unsubscribeChunks();
unsubscribeStats();
unsubscribeRunState();

check("Agent 回合跑完", result.ok, result.error);
check(
  "运行态在开跑与收尾各推了一条（界面据此显示「还在干活」）",
  runStates[0] === true && runStates[runStates.length - 1] === false,
  runStates.map((state) => (state ? "运行中" : "已收尾")).join(" → "),
);
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
const toolStarts = events
  .filter((event) => event.kind === "tool_start")
  .map((event) => event.toolName);
console.log(`   · 工具调用：${toolStarts.join(", ") || "（无）"}`);
check(
  "依次调用了 bash / write_file / todo_write / apply_patch / get_context_remaining / todo_write",
  toolStarts.join(",") ===
    "bash,write_file,todo_write,apply_patch,get_context_remaining,todo_write",
  toolStarts.join(","),
);

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
  events.some(
    (event) => event.toolName === "permission" && (event.output ?? "").includes("已拒绝"),
  ),
);

const writeEnd = events.find(
  (event) => event.kind === "tool_end" && event.toolName === "write_file",
);
check(
  "允许后 write_file 真的执行了",
  (writeEnd?.output ?? "").includes("Wrote"),
  writeEnd?.output?.slice(0, 160),
);
check(
  "文件真的落到了工作区",
  Artifacts.readWorkspaceFile(workspace, "notes/live.md").text?.includes(
    "hello from live check",
  ) === true,
);
check(
  "产出物登记了 notes/live.md",
  Artifacts.listArtifacts(conversation.id).some((item) => item.path.includes("live.md")),
  JSON.stringify(Artifacts.listArtifacts(conversation.id).map((item) => item.path)),
);
/**
 * 产出物必须挂在**本轮**的助手消息上。
 *
 * 这个字段决定界面把卡片画在哪条消息底下：挂空（或挂到上一轮的消息）时，右侧面板里
 * 看得到、消息下面一张卡片都没有 —— 用户以为它什么都没产出。曾经的实现是在建会话
 * 那一刻取消息 id，而第一轮里助手消息还没建出来（自动化跑的那一轮同样如此），
 * 于是产出物全挂在了 NULL 上。这里让真实回合把它钉死。
 */
const turnArtifacts = Artifacts.listArtifacts(conversation.id);
const assistantHistory = Chat.getHistory(conversation.id).filter(
  (message) => message.role === "assistant",
);
const turnAssistant = assistantHistory[assistantHistory.length - 1];
check(
  "产出物挂在本轮助手消息上（挂空了消息底下就没有卡片）",
  turnArtifacts.length > 0 && turnArtifacts.every((item) => item.messageId === turnAssistant?.id),
  JSON.stringify({
    assistantId: turnAssistant?.id,
    artifacts: turnArtifacts.map((item) => ({ path: item.path, messageId: item.messageId })),
  }),
);
check(
  "待办清单落库且三项都完成",
  Todos.listTodos(conversation.id).filter((todo) => todo.status === "completed").length === 3,
  JSON.stringify(Todos.listTodos(conversation.id)),
);

// apply_patch：授权放行后两个文件都真的改了，且产出物登记齐全。
const patchEnd = events.find(
  (event) => event.kind === "tool_end" && event.toolName === "apply_patch",
);
check(
  "apply_patch 授权后真的执行了（返回 A/M 摘要）",
  (patchEnd?.output ?? "").includes("A notes/patched.md") &&
    (patchEnd?.output ?? "").includes("M AGENTS.md"),
  patchEnd?.output?.slice(0, 200),
);
check(
  "补丁新增的文件真的落盘",
  Artifacts.readWorkspaceFile(workspace, "notes/patched.md").text?.includes("补丁写入的内容") ===
    true,
);
check(
  "补丁按上下文改写了已有文件",
  Artifacts.readWorkspaceFile(workspace, "AGENTS.md").text?.includes("lint 与 typecheck") === true,
);
check(
  "两个文件都登记成了产出物",
  ["patched.md", "AGENTS.md"].every((name) =>
    Artifacts.listArtifacts(conversation.id).some((item) => item.path.endsWith(name)),
  ),
  JSON.stringify(Artifacts.listArtifacts(conversation.id).map((item) => item.path)),
);

// 上下文占用：工具结果要给出剩余量，统计事件要带回占用（输入框上的占用条用它）。
const contextEnd = events.find(
  (event) => event.kind === "tool_end" && event.toolName === "get_context_remaining",
);
check(
  "get_context_remaining 在真实回合里返回剩余上下文",
  (contextEnd?.output ?? "").includes("剩余约"),
  contextEnd?.output?.slice(0, 160),
);
check(
  "回合结束的统计事件带回上下文占用（来源是实测用量）",
  statsSeen.context !== null &&
    statsSeen.context.source === "usage" &&
    statsSeen.context.usedTokens > 0,
  JSON.stringify(statsSeen.context),
);

// 项目指令：只有走内置桩时才拿得到系统提示原文（接真实服务时跳过）。
if (useStub) {
  check(
    "项目指令（AGENTS.md）真的进了发给模型的系统提示",
    capturedSystemPrompts.some((prompt) => prompt.includes("提交前跑 bun run lint")),
    `捕获到 ${capturedSystemPrompts.length} 份系统提示`,
  );
}

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
const direct = await Agent.followUpAgentMessage({
  conversationId: second.id,
  content: "直接跑一次",
});
check(
  "没在运行时 followUp 就是直接开跑",
  direct.ok && direct.queued === false,
  JSON.stringify(direct),
);

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
const queued = await Agent.followUpAgentMessage({
  conversationId: second.id,
  content: "第二轮：再写一次文件",
});
const steered = await Agent.followUpAgentMessage({
  conversationId: second.id,
  content: "插话：先说结论",
  mode: "steer",
});
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
check(
  "主线调用了 task 工具",
  thirdEvents.some((event) => event.kind === "tool_start" && event.toolName === "task"),
);
const subagentStart = thirdEvents.find((event) => event.kind === "subagent_start");
const subagentEnd = thirdEvents.find((event) => event.kind === "subagent_end");
check("子智能体有自己的运行区间（start/end 成对）", Boolean(subagentStart && subagentEnd));
check(
  "子智能体在内部跑了工具（不是空手而归）",
  thirdEvents.some(
    (event) => event.kind === "tool_start" && event.subagentId && event.toolName === "list_dir",
  ),
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
    (
      Chat.getHistory(fourth.id)
        .reverse()
        .find((message) => message.role === "assistant")?.content ?? ""
    ).length > 0,
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
const answerId = answerEvent
  ? (JSON.parse(answerEvent.args ?? "{}") as { id?: string }).id
  : undefined;
check(
  "请求与答案是同一条记录（按 id 配对）",
  Boolean(askId) && askId === answerId,
  `${askId} vs ${answerId}`,
);
check(
  "答案内容进了会话流",
  (answerEvent?.output ?? "").includes("方案A"),
  answerEvent?.output ?? undefined,
);
const askToolResult = fifthEvents.find(
  (event) => event.kind === "tool_end" && event.toolName === "ask_user",
);
check(
  "答案也回到了模型（工具结果里有选项）",
  (askToolResult?.output ?? "").includes("方案A"),
  askToolResult?.output?.slice(0, 120),
);

// 授权同样要能回看：请求 + 结果两条事件，id 配对
const firstAsk = Agent.listAgentEvents(conversation.id).find(
  (event) => event.toolName === "permission_request",
);
const firstAnswer = Agent.listAgentEvents(conversation.id).find(
  (event) => event.toolName === "permission",
);
check("授权请求也落成了会话事件", Boolean(firstAsk), firstAsk?.output ?? undefined);
check(
  "授权结果与请求按 id 配对，且记录了用户的选择",
  Boolean(firstAnswer?.output?.includes("拒绝")),
  firstAnswer?.output ?? undefined,
);

// ---------------------------------------------------------------------------
// /compact 与 /status（对齐 Codex 的同名命令）：手动收紧上下文 + 会话配置速览
// ---------------------------------------------------------------------------
const compacted = Chat.createConversation("live check compact now", "agent");
Agent.setConversationWorkspace(compacted.id, workspace);
/**
 * 先塞一段有分量的历史再跑第一轮 —— 会话是在第一轮时从库里装载的，
 * 所以"长历史"必须在那之前就躺在库里（这就是真实用户跑了一下午的样子）。
 * 同时把窗口调小，否则 8k 窗口下这点内容根本够不到压缩线（测不出剪辑行为）。
 */
updateSettings({ SERVER_CTX_SIZE: "1500" });
{
  const { db: liveDb } = await import("../src/bun/db");
  const { messages: liveMessages } = await import("../src/bun/db/schema");
  for (let index = 0; index < 6; index += 1) {
    liveDb
      .insert(liveMessages)
      .values({
        conversationId: compacted.id,
        role: index % 2 === 0 ? "user" : "assistant",
        content:
          `第 ${index + 1} 段历史：这是一段用来把上下文撑起来的说明，读文件、跑命令、再总结一遍。`.repeat(
            6,
          ),
      })
      .run();
  }
}
await Agent.runAgentTurn({
  conversationId: compacted.id,
  content: "先跑一轮，把会话建起来（历史已在库里）。",
  mode: "agent",
  workspace,
});
const statusBefore = Agent.describeAgentSession(compacted.id);
check(
  "/status：会话配置速览给出模型 / 窗口 / 预算 / 审批与沙箱档位",
  statusBefore.model.length > 0 &&
    statusBefore.contextWindow === 1500 &&
    statusBefore.contextBudget === Math.floor(1500 * 0.6) &&
    ["smart", "manual", "auto", "strict"].includes(statusBefore.approvalMode) &&
    ["off", "workspace-write", "read-only"].includes(statusBefore.sandboxMode),
  JSON.stringify(statusBefore),
);
check(
  "/status：占用数字与占用条同源（实测优先）",
  statusBefore.usedTokens > 0 && statusBefore.percent >= 0 && statusBefore.percent <= 100,
  `${statusBefore.usedTokens} / ${statusBefore.contextBudget}（${statusBefore.usageSource}）`,
);

// 手动压缩：预算按自动预算的一半裁（"多留点余量"）。
const compactResult = Agent.compactConversationNow(compacted.id);
check(
  "/compact：按更紧的预算真的裁掉了一批历史",
  compactResult.ok &&
    compactResult.dropped > 0 &&
    compactResult.tokensAfter < compactResult.tokensBefore,
  JSON.stringify(compactResult),
);
check(
  "/compact：手动预算 = 自动预算的一半（买余量，而不是等顶到线才裁）",
  compactResult.budgetTokens === Math.floor(Math.floor(1500 * 0.6) / 2),
  `${compactResult.budgetTokens}`,
);
check(
  "/compact：压缩落进会话轨迹（回看能看到上下文被收紧过）",
  Agent.listAgentEvents(compacted.id).some(
    (event) => event.toolName === "compact" && (event.output ?? "").includes("手动压缩"),
  ),
);
check(
  "/compact：库里的历史一条不删（回看会话仍是完整的）",
  Chat.getHistory(compacted.id).length >= 2,
);
// 压缩之后还能继续跑 —— 这是这个功能最要紧的性质。
const afterCompact = await Agent.runAgentTurn({
  conversationId: compacted.id,
  content: "压缩之后再跑一轮。",
  mode: "agent",
  workspace,
});
check("压缩之后继续跑不受影响", afterCompact.ok, afterCompact.error);
const statusAfter = Agent.describeAgentSession(compacted.id);
check(
  "/status 能看到累计压缩条数（droppedSoFar）",
  statusAfter.droppedSoFar >= compactResult.dropped,
  `${statusAfter.droppedSoFar} vs ${compactResult.dropped}`,
);
// 上下文本来就很小的会话：如实说"不需要压缩"并给出原因，而不是假装裁了 0 条就完事。
const quiet = Chat.createConversation("live check compact quiet", "agent");
Agent.setConversationWorkspace(quiet.id, workspace);
await Agent.runAgentTurn({
  conversationId: quiet.id,
  content: "短会话，跑一轮。",
  mode: "agent",
  workspace,
});
const quietCompact = Agent.compactConversationNow(quiet.id);
check(
  "上下文很小时如实说明无需裁剪（并说清为什么）",
  quietCompact.ok && quietCompact.dropped === 0 && (quietCompact.reason ?? "").includes("没超过"),
  JSON.stringify(quietCompact),
);
// 没跑过的会话：明确报错而不是给出假数字。
const neverRun = Chat.createConversation("live check compact empty", "agent");
const emptyCompact = Agent.compactConversationNow(neverRun.id);
check(
  "没跑过的会话不给假结果（明确说没有可压缩的上下文）",
  !emptyCompact.ok && (emptyCompact.reason ?? "").includes("还没跑过"),
  JSON.stringify(emptyCompact),
);
// 复位窗口，别影响后面的用例。
updateSettings({ SERVER_CTX_SIZE: "8192" });

// ---------------------------------------------------------------------------
// 会话内换模型（对齐 Codex 的 /model）：换了要立刻对下一轮生效，且历史不能丢
// ---------------------------------------------------------------------------
const switched = Chat.createConversation("live check model switch", "agent");
Agent.setConversationWorkspace(switched.id, workspace);
const modelBefore = currentRequestModelId();
capturedRequestModels.length = 0;
await Agent.runAgentTurn({
  conversationId: switched.id,
  content: "换模型之前先跑一轮。",
  mode: "agent",
  workspace,
});
check(
  "会话第一轮用当前模型（桩服务收到的 model 与设置一致）",
  capturedRequestModels.every((model) => model === modelBefore),
  `${capturedRequestModels.join(",")} vs ${modelBefore}`,
);

// 换模型：模拟界面 /model 选完之后设置被改写（selectChatModel 落的就是这些键）。
const newModel = "stub-model-switched";
updateSettings({ SERVER_MODE: "remote", VLLM_MODEL_NAME: newModel, CHAT_MODEL: newModel });
capturedRequestModels.length = 0;
await Agent.runAgentTurn({
  conversationId: switched.id,
  content: "换模型之后再跑一轮。",
  mode: "agent",
  workspace,
});
check(
  "回合内换模型对**同一会话的下一轮**立刻生效",
  capturedRequestModels.length > 0 && capturedRequestModels.every((model) => model === newModel),
  `${capturedRequestModels.join(",")} vs ${newModel}`,
);
check(
  "换模型不丢上下文：历史照旧发过去（第一轮的内容还在请求里）",
  capturedUserPrompts.some((prompt) => prompt.includes("换模型之前先跑一轮")),
  `捕获 ${capturedUserPrompts.length} 条用户消息`,
);
const switchEvents = Agent.listAgentEvents(switched.id);
check(
  "换模型在会话轨迹里留痕（模型已切换：A → B）",
  switchEvents.some(
    (event) => event.toolName === "model" && (event.output ?? "").includes("模型已切换"),
  ),
  JSON.stringify(
    switchEvents.filter((event) => event.toolName === "model").map((event) => event.output),
  ),
);
// 复位，别影响后面的用例
updateSettings({ SERVER_MODE: "remote", VLLM_MODEL_NAME: model, CHAT_MODEL: model });

// ---------------------------------------------------------------------------
// 无头执行（对齐 Codex 的 codex exec）：一次调用拿到结果 + NDJSON 事件流
// ---------------------------------------------------------------------------
const Headless = await import("../src/bun/agent-headless");
const headlessLines: { type?: string }[] = [];
const headlessResult = await Headless.runHeadlessAgent({
  prompt: "无头跑一次：列出工作区里的文件。",
  workspace,
  mode: "agent",
  onLine: (line) => headlessLines.push(line as { type?: string }),
  includeChunks: true,
});
check(
  "无头执行跑完并拿到最终回答",
  headlessResult.ok && headlessResult.text.trim().length > 0,
  headlessResult.error ?? headlessResult.text.slice(0, 60),
);
check(
  "无头执行会新建会话并落库（跑完能在界面里继续追问）",
  headlessResult.conversationId > 0 && Chat.getHistory(headlessResult.conversationId).length >= 2,
  `conversationId=${headlessResult.conversationId}`,
);
check(
  "事件流有 start / event / result 三类行（脚本能边跑边消费）",
  headlessLines.some((line) => line.type === "start") &&
    headlessLines.some((line) => line.type === "event") &&
    headlessLines[headlessLines.length - 1]?.type === "result",
  JSON.stringify(headlessLines.map((line) => line.type)),
);
check(
  "轨迹事件带工具名与状态（jq 能直接筛出来）",
  headlessLines.some((line) => {
    const event = (line as { event?: { toolName?: string | null; kind?: string } }).event;
    return line.type === "event" && Boolean(event?.toolName) && event?.kind === "tool_start";
  }),
  JSON.stringify(
    headlessLines
      .filter((line) => line.type === "event")
      .slice(0, 4)
      .map((line) => (line as { event?: { toolName?: string } }).event?.toolName ?? "?"),
  ),
);
check(
  "result 行自带会话 id 与正文（脚本不用再去别处查）",
  (() => {
    const result = headlessLines[headlessLines.length - 1] as {
      type?: string;
      conversationId?: number;
      text?: string;
    };
    return (
      result.type === "result" &&
      result.conversationId === headlessResult.conversationId &&
      Boolean(result.text)
    );
  })(),
);
const headlessMode = await Headless.runHeadlessAgent({
  prompt: "无头 plan 模式跑一次。",
  workspace,
  mode: "plan",
});
check("无头执行支持模式参数（plan 只读）", headlessMode.ok, headlessMode.error);
check(
  "mode 参数校验：不在 agent / plan / goal 里就直接拒绝",
  Headless.isHeadlessMode("plan") && !Headless.isHeadlessMode("nope"),
);
// 会话 id 写错时脚本要立刻拿到明确报错，而不是一条莫名其妙的空结果。
let missingConversationError = "";
try {
  await Headless.runHeadlessAgent({ prompt: "跑一次", conversationId: 999_999 });
} catch (error) {
  missingConversationError = error instanceof Error ? error.message : String(error);
}
check(
  "指定不存在的会话时明确报错",
  missingConversationError.includes("会话不存在"),
  missingConversationError,
);

// ---------------------------------------------------------------------------
// 生命周期 hooks（对齐 Codex 的 SessionStart / UserPromptSubmit）
// ---------------------------------------------------------------------------
const Hooks = await import("../src/bun/agent-hooks");
check(
  "事件名两种写法都认（Codex 文档里的 PascalCase 可直接粘）",
  Hooks.normalizeHookEvent("UserPromptSubmit") === "user_prompt_submit" &&
    Hooks.normalizeHookEvent("SessionStart") === "session_start",
);

const hooked = Chat.createConversation("live check hooks", "agent");
Agent.setConversationWorkspace(hooked.id, workspace);
updateSettings({
  AGENT_HOOKS: JSON.stringify([
    { event: "SessionStart", command: "echo HOOK-启动上下文：当前分支 main" },
    { event: "user_prompt_submit", command: "echo HOOK-提交上下文：注意别动生产配置" },
  ]),
});
capturedSystemPrompts.length = 0;
capturedUserPrompts.length = 0;
await Agent.runAgentTurn({
  conversationId: hooked.id,
  content: "跑一次带 hook 的回合。",
  mode: "agent",
  workspace,
});
check(
  "session_start hook 的输出进了系统提示",
  capturedSystemPrompts.some((prompt) => prompt.includes("HOOK-启动上下文")),
  `捕获到 ${capturedSystemPrompts.length} 份系统提示`,
);
check(
  "user_prompt_submit hook 的输出随本轮任务描述发给了模型",
  capturedUserPrompts.some((prompt) => prompt.includes("HOOK-提交上下文")),
  `捕获到 ${capturedUserPrompts.length} 条用户消息`,
);
const hookEvents = Agent.listAgentEvents(hooked.id).filter((event) => event.toolName === "hook");
check(
  "hook 的执行情况落进了会话轨迹（回看能看到注入了什么）",
  hookEvents.length >= 2 &&
    hookEvents.some((event) => (event.output ?? "").includes("session_start")),
  JSON.stringify(hookEvents.map((event) => event.output)),
);

// 拦截：hook 返回 block 时这一轮不发给模型，但用户看得到原因。
const blockedConversation = Chat.createConversation("live check hook block", "agent");
Agent.setConversationWorkspace(blockedConversation.id, workspace);
updateSettings({
  AGENT_HOOKS: JSON.stringify([
    {
      event: "user_prompt_submit",
      command: 'echo \'{"decision":"block","reason":"提示词里疑似有密钥，请移除后重试"}\'',
    },
  ]),
});
capturedUserPrompts.length = 0;
const blockedResult = await Agent.runAgentTurn({
  conversationId: blockedConversation.id,
  content: "把这把 key 用起来：sk-abcdef123456",
  mode: "agent",
  workspace,
});
check(
  "hook 拦下时回合返回失败与原因",
  !blockedResult.ok && (blockedResult.error ?? "").includes("疑似有密钥"),
  blockedResult.error,
);
check(
  "被拦下的提示词没有发给模型",
  capturedUserPrompts.length === 0,
  `捕获到 ${capturedUserPrompts.length} 条用户消息`,
);
const blockedHistory = Chat.getHistory(blockedConversation.id);
check(
  "用户在会话里看得到为什么被拦（不是空白气泡）",
  blockedHistory.some(
    (message) => message.role === "assistant" && message.content.includes("疑似有密钥"),
  ),
  JSON.stringify(blockedHistory.map((message) => message.content.slice(0, 40))),
);
updateSettings({ AGENT_HOOKS: "[]" });

// ---------------------------------------------------------------------------
// 回合快照与回退：把第一轮的改动整体撤掉（对齐 Codex 的回合安全网）
// ---------------------------------------------------------------------------
const Snapshots = await import("../src/bun/agent-snapshots");
const firstSnapshot = Snapshots.listTurnSnapshots(conversation.id)[0];
check(
  "每轮都留下了快照，并挂在对应的助手消息上（界面据此显示「撤销本轮」）",
  Boolean(firstSnapshot) && firstSnapshot!.messageId != null,
  JSON.stringify(firstSnapshot ?? null),
);
const livePath = path.join(workspace, "notes", "live.md");
const patchedPath = path.join(workspace, "notes", "patched.md");
check(
  "回退前：这一轮写的文件确实在工作区里",
  existsSync(livePath) && existsSync(patchedPath),
  `${existsSync(livePath)} / ${existsSync(patchedPath)}`,
);

const reverted = firstSnapshot
  ? Snapshots.revertToSnapshot(firstSnapshot.id)
  : { ok: false as const, error: "no snapshot" };
check("回退这一轮成功", reverted.ok, !reverted.ok ? reverted.error : undefined);
check(
  "回退删掉了这一轮新建的文件",
  !existsSync(livePath) && !existsSync(patchedPath),
  `live=${existsSync(livePath)} patched=${existsSync(patchedPath)}`,
);
check(
  "回退把补丁改过的 AGENTS.md 还原了",
  readFileSync(path.join(workspace, "AGENTS.md"), "utf8").includes("提交前跑 bun run lint。") &&
    !readFileSync(path.join(workspace, "AGENTS.md"), "utf8").includes("typecheck"),
);
check("回退不碰工作区之外的目录", existsSync(decoyB));

// ---------------------------------------------------------------------------
// Goal 模式：立项 → 回合结束后**自己接着跑** → 宣布完成 → 不再续跑
// ---------------------------------------------------------------------------
const Goals = await import("../src/bun/agent-goals");
const goalConversation = Chat.createConversation("live check goal", "agent");
Agent.setConversationWorkspace(goalConversation.id, workspace);
updateSettings({
  AGENT_MODE: "goal",
  AGENT_GOAL_MAX_CONTINUATIONS: "6",
  AGENT_GOAL_TOKEN_BUDGET: "0",
});

await Agent.runAgentTurn({
  conversationId: goalConversation.id,
  content: "goal-未完成：先把导出功能的骨架搭起来。",
  mode: "goal",
  workspace,
});
check(
  "Goal：目标立项并落库（含验收标准）",
  Goals.getGoal(goalConversation.id)?.acceptance?.includes("csv") === true,
  JSON.stringify(Goals.getGoal(goalConversation.id)),
);

// 续跑是异步接着开的（不阻塞本轮返回），所以这里等一下 —— 等的条件是"目标进入终态"。
const waitUntil = async (predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};
const completed = await waitUntil(() => Goals.getGoal(goalConversation.id)?.status === "complete");
const goalAfter = Goals.getGoal(goalConversation.id);
check("Goal：回合结束后自动续跑，并在模型宣布完成时收尾", completed, JSON.stringify(goalAfter));
check(
  "Goal：完成时留下了证据（不是一句「做完了」）",
  (goalAfter?.outcome ?? "").includes("bun test"),
  goalAfter?.outcome ?? "(无)",
);
const goalHistory = Chat.getHistory(goalConversation.id);
check(
  "Goal：续跑消息写明了是系统自动继续（用户滚回去看得懂它为什么又跑了一轮）",
  goalHistory.some(
    (message) => message.role === "user" && message.content.startsWith("（系统自动继续"),
  ),
  JSON.stringify(goalHistory.map((message) => message.content.slice(0, 24))),
);
check(
  "Goal：目标会计入 token 消耗（账本是续跑的刹车）",
  (goalAfter?.tokensUsed ?? 0) > 0,
  `${goalAfter?.tokensUsed ?? 0} tokens`,
);
const turnsAfterComplete = goalHistory.filter((message) => message.role === "assistant").length;
await new Promise((resolve) => setTimeout(resolve, 400));
check(
  "Goal：完成之后不再自动续跑（不能没完没了地跑）",
  Chat.getHistory(goalConversation.id).filter((message) => message.role === "assistant").length ===
    turnsAfterComplete,
  `${turnsAfterComplete} → ${Chat.getHistory(goalConversation.id).filter((m) => m.role === "assistant").length}`,
);

// 用户按停止 → 目标暂停，且恢复由用户的下一条消息驱动。
Goals.setGoalStatus(goalConversation.id, "paused", "用户中断了本轮，目标暂停");
check("Goal：用户按停止后目标转为暂停", Goals.getGoal(goalConversation.id)?.status === "paused");
await Agent.runAgentTurn({
  conversationId: goalConversation.id,
  content: "goal-未完成：继续吧。",
  mode: "goal",
  workspace,
});
check(
  "Goal：用户再发话时暂停的目标自动恢复推进",
  Goals.getGoal(goalConversation.id)?.status !== "paused",
  Goals.getGoal(goalConversation.id)?.status ?? "(无)",
);
await waitUntil(() => Goals.getGoal(goalConversation.id)?.status === "complete");

// ---------------------------------------------------------------------------
// 失败自愈：瞬时 503 与空回合都不该让用户重发一次
// ---------------------------------------------------------------------------
const transientConversation = Chat.createConversation("live check transient", "agent");
Agent.setConversationWorkspace(transientConversation.id, workspace);
const transientTurn = await Agent.runAgentTurn({
  conversationId: transientConversation.id,
  content: "transient-503：先被 503 打回来，然后照常回答。",
  mode: "agent",
  workspace,
});
check("瞬时 503：回合照常跑完（传输层自己重试掉了）", transientTurn.ok, transientTurn.error);
check(
  "瞬时 503：桩服务确实打回过 503（不是碰巧没触发）",
  selfHeal.unavailable503 === 2,
  String(selfHeal.unavailable503),
);
const transientAnswer =
  Chat.getHistory(transientConversation.id)
    .reverse()
    .find((message) => message.role === "assistant")?.content ?? "";
check(
  "瞬时 503：重试成功后拿到了正常回答（没有把错误写进气泡）",
  transientAnswer.length > 0 && !transientAnswer.includes("503"),
  transientAnswer.slice(0, 120),
);

const emptyConversation = Chat.createConversation("live check empty turn", "agent");
Agent.setConversationWorkspace(emptyConversation.id, workspace);
await Agent.runAgentTurn({
  conversationId: emptyConversation.id,
  content: "empty-turn：先说一句空话。",
  mode: "agent",
  workspace,
});
const emptyTurnResult = selfHeal.emptyTurns;
check("空回合：桩服务确实给过一次空消息", emptyTurnResult === 1, String(emptyTurnResult));
const emptyEvents = Agent.listAgentEvents(emptyConversation.id);
check(
  "空回合：轨迹里留下了「已提醒它继续」",
  emptyEvents.some((event) => (event.output ?? "").includes("已提醒它继续")),
  JSON.stringify(emptyEvents.filter((e) => (e.output ?? "").includes("提醒")).map((e) => e.output)),
);
const emptyAnswer =
  Chat.getHistory(emptyConversation.id)
    .reverse()
    .find((message) => message.role === "assistant")?.content ?? "";
check(
  "空回合：提醒之后模型答上了（界面不是空白气泡）",
  emptyAnswer.includes("空回合被提醒之后"),
  emptyAnswer.slice(0, 120),
);
/** 关掉自愈之后同样的场景应当如实报告空回合 —— 否则这个开关就是装饰。 */
updateSettings({ AGENT_RETRY_MAX: "0" });
const noHealConversation = Chat.createConversation("live check no heal", "agent");
Agent.setConversationWorkspace(noHealConversation.id, workspace);
selfHeal.emptyTurns = 0;
await Agent.runAgentTurn({
  conversationId: noHealConversation.id,
  content: "empty-turn：关掉自愈之后不该再提醒。",
  mode: "agent",
  workspace,
});
const noHealAnswer =
  Chat.getHistory(noHealConversation.id)
    .reverse()
    .find((message) => message.role === "assistant")?.content ?? "";
check(
  "关掉自愈（AGENT_RETRY_MAX=0）：不再提醒，如实说明是空回合",
  noHealAnswer.includes("没有给出正文") && !noHealAnswer.includes("空回合被提醒之后"),
  noHealAnswer.slice(0, 160),
);
updateSettings({ AGENT_RETRY_MAX: "2" });

/** 一直失败：重试到上限就如实报错，不能让用户对着一个空白气泡等。 */
const hopelessConversation = Chat.createConversation("live check retry exhausted", "agent");
Agent.setConversationWorkspace(hopelessConversation.id, workspace);
updateSettings({ AGENT_RETRY_MAX: "1" });
await Agent.runAgentTurn({
  conversationId: hopelessConversation.id,
  content: "transient-503-always：这个后端一直连不上。",
  mode: "agent",
  workspace,
});
updateSettings({ AGENT_RETRY_MAX: "2" });
const hopelessEvents = Agent.listAgentEvents(hopelessConversation.id);
check(
  "重试有上限：轨迹里能看到第 1/1 次自动重试",
  hopelessEvents.some((event) => (event.output ?? "").includes("第 1/1 次自动重试")),
  JSON.stringify(hopelessEvents.filter((e) => e.toolName === "retry").map((e) => e.output)),
);
const hopelessAnswer =
  Chat.getHistory(hopelessConversation.id)
    .reverse()
    .find((message) => message.role === "assistant")?.content ?? "";
check(
  "重试用尽之后如实报错（不是空白气泡，也不谎称完成）",
  hopelessAnswer.includes("⚠️"),
  hopelessAnswer.slice(0, 160),
);

// ---------------------------------------------------------------------------
// 工具输出转存：超限的输出要能"截断给模型看 + 落盘给模型读回来"
// ---------------------------------------------------------------------------
// 这一段要跑真命令，授权改成 auto（其余场景仍然走 manual 的弹窗验证）。
updateSettings({ AGENT_APPROVAL_MODE: "auto" });
const bigOutputConversation = Chat.createConversation("live check spill", "agent");
Agent.setConversationWorkspace(bigOutputConversation.id, workspace);
await Agent.runAgentTurn({
  conversationId: bigOutputConversation.id,
  content: "big-output：跑一条输出很长的命令。",
  mode: "agent",
  workspace,
});
updateSettings({ AGENT_APPROVAL_MODE: "manual" });
const bigEnd = Agent.listAgentEvents(bigOutputConversation.id).find(
  (event) => event.kind === "tool_end" && event.toolName === "bash",
);
const bigOutput = bigEnd?.output ?? "";
check(
  "超限输出：进入上下文的是截断版（写明被截了、还差多少、别当完整内容）",
  bigOutput.includes("输出被截断") && bigOutput.includes("不要"),
  bigOutput.slice(0, 200),
);
const spillPath = /完整输出已经存到 (\S+?)，/.exec(bigOutput)?.[1];
check("超限输出：提示里给出了转存文件的绝对路径", Boolean(spillPath), bigOutput.slice(-260));
check(
  "超限输出：转存文件真的落盘（不在工作区里）",
  Boolean(spillPath) && existsSync(spillPath!),
  spillPath ?? "(无)",
);
check("超限输出：工作区没有被转存文件污染", !existsSync(path.join(workspace, "tool-output")));
if (spillPath) {
  // 关键一步：模型要能用 read_file 把原文读回来 —— 数据目录本来在黑名单里（存着 API Key），
  // 转存目录是唯一的窄口子，这里验证它确实是通的。
  const { buildAgentTools } = await import("../src/bun/agent-tools");
  const readTool = buildAgentTools({
    workspace,
    allowShell: false,
    conversationId: bigOutputConversation.id,
    messageId: null,
  }).find((tool) => tool.name === "read_file");
  const readBack = await readTool!.execute("call_spill", {
    path: spillPath,
    offset: 19_990,
    limit: 20,
  });
  const readText = JSON.stringify(readBack.content);
  check(
    "超限输出：read_file 能把转存文件读回来（分页读到最后一万九千多行）",
    readText.includes("20000"),
    readText.slice(0, 200),
  );
  const direct = await readTool!.execute("call_spill_denied", {
    path: path.join(dataDir, "omni-studio.db"),
  });
  const directText = JSON.stringify(direct.content);
  check(
    "转存目录之外的数据目录仍然读不到（口子没有开大）",
    directText.includes("failed") &&
      !directText.includes("SQLite") &&
      (directText.includes("授权") || directText.includes("credential")),
    directText.slice(0, 200),
  );
}

// ---------------------------------------------------------------------------
// Plan 模式：方案落盘 → 批准 → 交给执行
// ---------------------------------------------------------------------------
const Plans = await import("../src/bun/agent-plans");
const planConversation = Chat.createConversation("live check plan", "agent");
Agent.setConversationWorkspace(planConversation.id, workspace);
const planTurn = await Agent.runAgentTurn({
  conversationId: planConversation.id,
  content: "plan-写方案：导出功能该怎么做？",
  mode: "plan",
  workspace,
});
check("Plan：只读模式下也能写出方案（write_plan 是唯一可写通道）", planTurn.ok, planTurn.error);
const savedPlan = Plans.getPlan(planConversation.id);
check(
  "Plan：方案落库",
  (savedPlan?.content ?? "").includes("src/export.ts"),
  savedPlan?.content ?? "(无)",
);
check(
  "Plan：方案同时落到数据目录（切回 Agent 模式后还找得到）",
  Boolean(savedPlan?.filePath) && existsSync(savedPlan!.filePath!),
  savedPlan?.filePath ?? "(无)",
);
check(
  "Plan：方案登记成产出物（右侧面板能看到）",
  Artifacts.listArtifacts(planConversation.id).some(
    (artifact) => artifact.absPath === savedPlan?.filePath,
  ),
);
check(
  "Plan：批准之前拿不到「已批准方案」",
  Plans.approvedPlanContent(planConversation.id) === null,
);
const approved = Plans.approvePlan(planConversation.id);
check("Plan：批准成功", approved.ok, approved.error);
check(
  "Plan：批准后方案可交给执行者（子智能体也会带上它）",
  (Plans.planHandoffSection(planConversation.id) ?? "").includes("src/export.ts"),
);
// 改过方案 → 上一次的批准必须作废（不能批准 A 却执行 B）。
Plans.savePlan(planConversation.id, { content: "## 目标\n换了做法" });
check(
  "Plan：方案被改过之后批准作废（避免批准 A 执行 B）",
  Plans.approvedPlanContent(planConversation.id) === null,
  JSON.stringify(Plans.getPlan(planConversation.id)?.approvedAt),
);
Plans.clearPlan(planConversation.id);

// ---------------------------------------------------------------------------
// 时间轴混排：模型说的话与工具调用按发生顺序落成事件（界面据此混排，而不是
// "所有工具在上、所有正文在下"）。顺序只有事件能给：正文在库里是整轮拼接的一块。
// ---------------------------------------------------------------------------
const timelineConversation = Chat.createConversation("时间轴混排", "agent");
Agent.setConversationWorkspace(timelineConversation.id, workspace);
await Agent.runAgentTurn({
  conversationId: timelineConversation.id,
  content: "timeline-混排：先说一句，再看一眼工作区，最后给结论。",
  mode: "agent",
  workspace,
});
const timelineEvents = Agent.listAgentEvents(timelineConversation.id);
const timelineShape = timelineEvents
  .map((event) =>
    event.kind === "text" ? "text" : event.kind === "tool_start" ? "tool" : event.kind === "tool_end" ? null : null,
  )
  .filter(Boolean);
check(
  "时间轴：正文段与工具调用按发生顺序交错落库（说 → 做 → 说）",
  JSON.stringify(timelineShape) === JSON.stringify(["text", "tool", "text"]),
  JSON.stringify(timelineShape),
);
const timelineHistory = Chat.getHistory(timelineConversation.id).filter((m) => m.role === "assistant");
const timelineAnswer = timelineHistory[timelineHistory.length - 1]?.content ?? "";
const flushed = timelineEvents
  .filter((event) => event.kind === "text")
  .map((event) => event.output ?? "")
  .join("");
check(
  "时间轴：text 事件拼起来正是正文的前缀（界面靠它算「还没进时间轴的尾巴」）",
  flushed.length > 0 && timelineAnswer.startsWith(flushed),
  JSON.stringify({ flushed: flushed.slice(0, 40), answer: timelineAnswer.slice(0, 60) }),
);
check(
  "时间轴：最后一段正文也落了事件（跑完尾巴为空，不会与时间轴重复渲染）",
  flushed === timelineAnswer,
  JSON.stringify({ flushed: flushed.length, answer: timelineAnswer.length }),
);

Interactions.cancelPendingForConversation(timelineConversation.id);
Interactions.cancelPendingForConversation(fifth.id);
Interactions.cancelPendingForConversation(third.id);
Interactions.cancelPendingForConversation(fourth.id);
Interactions.cancelPendingForConversation(second.id);
Interactions.cancelPendingForConversation(conversation.id);
Interactions.cancelPendingForConversation(goalConversation.id);
Interactions.cancelPendingForConversation(planConversation.id);
Interactions.cancelPendingForConversation(transientConversation.id);
Interactions.cancelPendingForConversation(emptyConversation.id);
Interactions.cancelPendingForConversation(noHealConversation.id);
Interactions.cancelPendingForConversation(hopelessConversation.id);
Goals.clearGoal(goalConversation.id);
stub.stop(true);
rmSync(dataDir, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
rmSync(decoyA, { recursive: true, force: true });

if (failed > 0) {
  console.error(`live check: ${failed} 项失败`);
  process.exit(1);
}
console.log("live check 全部通过");
