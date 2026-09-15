import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 执行轨迹的运行态 —— 这是"它还在干活吗"在界面上唯一的线索。
 *
 * 已发生的问题：跑动中的轨迹和跑完的轨迹长得一模一样（同样的标题、同样的绿点），
 * 中间几秒没有新事件时更是彻底静止，旁观者分不出它是还在执行还是已经收工。
 * 这里钉住四件事：
 *   1. 跑动中标题带「处理中 · N 秒」，且没有任何新事件时秒数自己往前走；
 *   2. 没有工具在跑时，轨迹末尾有一条"还在干活"的转圈行；
 *   3. 工具自己那行在转圈时不再叠加一条（同一时刻只留一处动画）；
 *   4. 跑完：标题变「已处理 · N 秒」，转圈全部消失。
 */

// happy-dom 提供真实 DOM（定时器 / 查询选择器都要用），afterAll 还原全局。
const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "CustomEvent", "Event"] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 渲染这条消息会连带加载 RPC 客户端（Electroview 需要浏览器环境），这里给个空壳：
// 本测试不点任何按钮，只要模块能加载即可。
mock.module("@lib/rpc", () => ({ rpcClient: {} }));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AgentAssistantMessage } = await import("./message");
const { useChatStore } = await import("@stores/chat");
const { translate } = await import("../../../shared/i18n");
type AgentEventRow = import("../../../bun/agent").AgentEventRow;
type ArtifactItem = import("../../../bun/agent-artifacts").ArtifactItem;

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);
const MESSAGE_ID = 10;
const CONVERSATION_ID = 1;

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

afterEach(async () => {
  // 必须卸载：计时器（秒数跳动）不停的话，React 的调度会在 DOM 全局被还原之后再跑一次。
  if (mounted) {
    const { root } = mounted;
    mounted = null;
    await act(async () => {
      root.unmount();
    });
  }
  for (const el of Array.from(document.body.children)) el.remove();
  useChatStore.getState().setActiveConversation(null);
});

/** 当前挂着的这棵树（afterEach 负责卸载）。 */
let mounted: { root: ReturnType<typeof createRoot>; container: HTMLElement } | null = null;

let nextEventId = 1;
function event(overrides: Partial<AgentEventRow> & { kind: AgentEventRow["kind"] }): AgentEventRow {
  return {
    id: nextEventId++,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    toolName: "bash",
    args: JSON.stringify({ command: "ls" }),
    output: "",
    isError: 0,
    subagentId: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

/** 跑动中的一轮：起点按第一条事件算（刷新窗口后就只有这一份时间可用）。 */
const startedAgo = (ms: number) => Date.now() - ms;

async function renderMessage({
  events = [],
  streaming,
  content = "",
  artifacts = [],
  artifactTotal = 0,
  onOpenArtifact = () => {},
  onOpenArtifacts,
}: {
  events?: AgentEventRow[];
  streaming: boolean;
  content?: string;
  artifacts?: ArtifactItem[];
  artifactTotal?: number;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenArtifacts?: () => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgentAssistantMessage, {
          message: {
            id: MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            role: "assistant" as const,
            content,
            createdAt: startedAgo(3000),
          },
          conversationId: CONVERSATION_ID,
          events,
          artifacts,
          artifactTotal,
          streaming,
          onOpenArtifact,
          onOpenArtifacts,
        }),
      ),
    );
  });
  return container;
}

const label = (container: HTMLElement) => container.querySelector(".tool-group-label")?.textContent ?? "";
/** 标题里的秒数（「处理中 · 3.0 秒」→ 3.0）。 */
function secondsOf(container: HTMLElement): number {
  const match = /·\s*([\d.]+)\s*/.exec(label(container));
  if (!match) throw new Error(`标题里没有秒数：${label(container)}`);
  return Number(match[1]);
}

test("跑动中标题报「处理中 · N 秒」，静默期里秒数自己往前走", async () => {
  const container = await renderMessage({
    streaming: true,
    events: [
      event({ kind: "tool_start", createdAt: startedAgo(3000) }),
      event({ kind: "tool_end", createdAt: startedAgo(2500) }),
    ],
  });

  expect(label(container)).toContain(zh("chat.working.duration", { duration: "3.0 秒" }));

  // 什么都不发生（没有新事件、没有新正文）：秒数也得继续走 —— 等模型决定
  // 下一步的那几秒正是最像"卡死了"的时候。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  expect(secondsOf(container)).toBeGreaterThan(3);
  expect(label(container)).toContain(zh("chat.working.duration", { duration: `${secondsOf(container).toFixed(1)} 秒` }));
});

test("没有工具在跑：轨迹末尾有一条「正在工作中」的转圈行", async () => {
  const container = await renderMessage({
    streaming: true,
    events: [
      event({ kind: "tool_start", createdAt: startedAgo(3000) }),
      event({ kind: "tool_end", createdAt: startedAgo(2500) }),
    ],
  });

  const tail = container.querySelector(".working-indicator");
  expect(tail?.textContent).toContain(zh("agent.working"));
  expect(container.querySelectorAll(".tool-spinner").length).toBe(1); // 标题那一个
});

/**
 * 回合刚开跑：行已经建好，一个字、一条事件都还没有（建会话 / 起推理服务 / 模型加载中）。
 *
 * 这正是"点发送之后立刻要给出反馈"的那一屏 —— 界面此前要等第一个增量才建得出这条
 * 消息，这几十秒里屏幕上什么都没有，看着就是程序挂了。这一行必须有「处理中 · N 秒」
 * 与末尾的转圈行，且秒数自己在走。
 */
test("回合刚开跑（无正文无事件）：也有「处理中 · N 秒」和转圈行，秒数自己在走", async () => {
  const container = await renderMessage({ streaming: true });

  expect(container.querySelector(".run-status")).not.toBeNull();
  expect(label(container)).toContain(zh("chat.working.duration", { duration: "3.0 秒" }));
  expect(container.querySelector(".working-indicator")).not.toBeNull();

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  expect(secondsOf(container)).toBeGreaterThan(3);
});

test("工具自己那行在转圈时，不再叠加一条（同一时刻只有一处动画）", async () => {
  const container = await renderMessage({
    streaming: true,
    events: [event({ kind: "tool_start", createdAt: startedAgo(1000) })],
  });

  expect(container.querySelector(".working-indicator")).toBeNull();
  // 标题 + 那一行工具：转圈在工具行上
  expect(container.querySelectorAll(".tool-spinner").length).toBe(2);
});

test("跑完：标题变「已处理 · N 秒」，转圈全部消失", async () => {
  await act(async () => {
    useChatStore.getState().setActiveConversation(CONVERSATION_ID);
    useChatStore.getState().setMessageStats(CONVERSATION_ID, MESSAGE_ID, {
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      tokens: 120,
      tokensPerSec: 30,
      elapsedMs: 12_000,
      source: "estimate",
    });
  });

  const container = await renderMessage({
    streaming: false,
    content: "干完了",
    events: [
      event({ kind: "tool_start", createdAt: startedAgo(12_000) }),
      event({ kind: "tool_end", createdAt: startedAgo(11_000) }),
    ],
  });

  expect(label(container)).toBe(zh("chat.worked", { duration: "12.0 秒" }));
  expect(container.querySelectorAll(".tool-spinner").length).toBe(0);
  expect(container.querySelector(".working-indicator")).toBeNull();

  await act(async () => {
    useChatStore.getState().removeMessage(CONVERSATION_ID, MESSAGE_ID);
  });
});

/**
 * 产物区（消息底部）。
 *
 * 已发生的问题：产物的 `message_id` 是 NULL（工具回调拿的是建会话那一刻的消息 id），
 * 于是报告写完了、右侧面板里也有，消息底下却一张卡片都没有 —— 点回看以为它没产出。
 * 这里钉住"卡片在消息底部 + 点一下交给预览回调"，以及"这条消息没有卡片时，
 * 仍然留一个通往右侧产出物页签的入口"（会话里其他轮产出的东西不该只能靠翻面板找）。
 */
const artifactItem = (overrides: Partial<ArtifactItem> = {}): ArtifactItem => ({
  id: 7,
  conversationId: CONVERSATION_ID,
  messageId: null,
  path: "pr-review/PR-评审报告-2026-09-14.md",
  absPath: "/tmp/pr-review/PR-评审报告-2026-09-14.md",
  title: "PR-评审报告-2026-09-14.md",
  kind: "markdown",
  size: 7409,
  tool: "write_file",
  createdAt: 0,
  ...overrides,
});

test("产物：卡片挂在消息底部，点一下交给「在右侧打开预览」的回调", async () => {
  const opened: ArtifactItem[] = [];
  const container = await renderMessage({
    streaming: false,
    content: "报告写好了",
    artifacts: [artifactItem()],
    artifactTotal: 1,
    onOpenArtifact: (item) => opened.push(item),
  });

  const card = container.querySelector(".artifact-card");
  expect(card?.textContent).toContain("PR-评审报告-2026-09-14.md");
  expect(card?.textContent).toContain("7 KB"); // 类型 + 体积
  expect(container.querySelector(".artifact-more")?.textContent).toContain(
    zh("agent.artifacts.all", { count: "1" }),
  );

  await act(async () => {
    (card as HTMLElement).click();
  });
  expect(opened.map((item) => item.id)).toEqual([7]);
});

test("产物：这条消息没有卡片时，仍然留「查看所有产物」入口（点了开右侧页签）", async () => {
  let openedAll = 0;
  const container = await renderMessage({
    streaming: false,
    content: "这一轮没写文件",
    artifacts: [],
    artifactTotal: 3,
    onOpenArtifacts: () => {
      openedAll += 1;
    },
  });

  expect(container.querySelector(".artifact-card")).toBeNull();
  const more = container.querySelector(".artifact-more");
  expect(more?.textContent).toContain(zh("agent.artifacts.all", { count: "3" }));

  await act(async () => {
    (more as HTMLElement).click();
  });
  expect(openedAll).toBe(1);
});

test("产物：不是最后一条助手消息时只画自己的卡片，不带「查看所有产物」入口", async () => {
  let openedAll = 0;
  const container = await renderMessage({
    streaming: false,
    content: "早先那一轮",
    artifacts: [artifactItem()],
    // total 只由界面在最后一条助手消息上给：其余消息不该出现"所有产物"的入口。
    artifactTotal: 0,
    onOpenArtifacts: () => {
      openedAll += 1;
    },
  });

  expect(container.querySelector(".artifact-card")).not.toBeNull();
  expect(container.querySelector(".artifact-more")).toBeNull();
  expect(openedAll).toBe(0);
});

test("产物：会话里一个产物都没有时，不出现空的产物区", async () => {
  const container = await renderMessage({ streaming: false, content: "随便聊聊" });
  expect(container.querySelector(".artifact-section")).toBeNull();
});

/**
 * 工具行分组（同行里「查阅 · 2 搜索, 1 列表」那一行）。
 *
 * 已发生的问题：一次调研十几个 read / grep，一个调用占一行，时间轴被过程铺满 ——
 * 四十行工具里三十行是 read_file，模型说的话反而要翻半天。这里钉住：相邻同类
 * 收成一行并报出计数、不展开也能从 title 看到文件名、展开后每次调用都还在，
 * 而**单独一次**调用仍走带参数的那一行（收成「查阅 · 1 文件」是净损失）。
 */
const toolCall = (
  toolName: string,
  args: Record<string, unknown>,
  createdAt: number,
  output = "ok",
): AgentEventRow[] => [
  event({ kind: "tool_start", toolName, args: JSON.stringify(args), createdAt }),
  event({ kind: "tool_end", toolName, output, createdAt }),
];

test("分组行：相邻的读取 / 搜索收成一行，报出「2 文件, 1 搜索」", async () => {
  const container = await renderMessage({
    streaming: false,
    content: "看完了。",
    events: [
      ...toolCall("read_file", { path: "src/a.ts" }, startedAgo(4000)),
      ...toolCall("read_file", { path: "src/b.ts" }, startedAgo(3000)),
      ...toolCall("grep", { pattern: "useState" }, startedAgo(2000)),
    ],
  });

  const rows = Array.from(container.querySelectorAll(".msg-timeline .tool-row"));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.textContent).toContain(zh("agent.tool.family.browse"));
  expect(rows[0]!.textContent).toContain("2 文件, 1 搜索");
  // 不展开也知道读了哪些文件（title 里按行列出每次调用的参数）
  const title = rows[0]!.querySelector("button")?.getAttribute("title") ?? "";
  expect(title).toContain("a.ts");
  expect(title).toContain("b.ts");
  expect(title).toContain("useState");
});

test("分组行：点开是每一次调用，各自还能再展开看细节", async () => {
  const container = await renderMessage({
    streaming: false,
    content: "看完了。",
    events: [
      ...toolCall("read_file", { path: "src/a.ts" }, startedAgo(3000)),
      ...toolCall("read_file", { path: "src/b.ts" }, startedAgo(2000)),
    ],
  });

  const head = container.querySelector(".msg-timeline .tool-row-header") as HTMLElement;
  expect(container.querySelectorAll(".msg-timeline .tool-row")).toHaveLength(1);

  await act(async () => {
    head.click();
  });

  const rows = Array.from(container.querySelectorAll(".msg-timeline .tool-row"));
  expect(rows).toHaveLength(3); // 分组行 + 两条成员行
  const text = container.querySelector(".msg-timeline")?.textContent ?? "";
  expect(text).toContain("a.ts");
  expect(text).toContain("b.ts");
});

test("单独一次调用不成组：那一行仍带参数（读到哪个文件）", async () => {
  const container = await renderMessage({
    streaming: false,
    content: "看完了。",
    events: toolCall("read_file", { path: "src/a.ts" }, startedAgo(2000)),
  });

  expect(container.querySelector(".msg-timeline .tool-row-counts")).toBeNull();
  expect(container.querySelector(".msg-timeline")?.textContent).toContain("a.ts");
});

test("分组行：跑动中只要还有一次调用没结果，就还在转圈", async () => {
  const container = await renderMessage({
    streaming: true,
    content: "",
    events: [
      ...toolCall("read_file", { path: "src/a.ts" }, startedAgo(3000)),
      event({ kind: "tool_start", toolName: "grep", args: JSON.stringify({ pattern: "x" }), createdAt: startedAgo(1000) }),
    ],
  });

  const rows = Array.from(container.querySelectorAll(".msg-timeline .tool-row"));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.querySelector(".tool-spinner")).not.toBeNull();
});

/**
 * 子智能体那一行：类型与任务描述各占一格（「子智能体 探索 · 找配置」）。
 *
 * 已发生的问题：写入端在 `subagent_start` 的 output 里拼了 `探索：找配置`，界面上
 * 原样画出来，同一段信息里类型与描述糊在一起；这个前缀是**写入格式**，不该出现在
 * 界面上 —— 类型有结构化参数，老记录才回到前缀。
 */
test("子智能体一行：类型与描述分格，不把 `探索：` 前缀画到界面上", async () => {
  const container = await renderMessage({
    streaming: false,
    content: "调研完了。",
    events: [
      event({
        kind: "subagent_start",
        toolName: "task",
        subagentId: "s1",
        output: "探索：找配置",
        args: JSON.stringify({ subagent_type: "explore", description: "找配置" }),
      }),
      event({ kind: "tool_start", toolName: "grep", subagentId: "s1", args: '{"pattern":"x"}' }),
      event({ kind: "tool_end", toolName: "grep", subagentId: "s1", output: "hit" }),
      event({ kind: "subagent_end", toolName: "task", subagentId: "s1", output: "完成：配置在 a.ts" }),
    ],
  });

  const head = container.querySelector(".subagent-head");
  expect(head?.textContent).toContain(zh("agent.subagent.label"));
  expect(head?.textContent).toContain(zh("agent.subagent.type.explore"));
  expect(head?.textContent).toContain("找配置");
  expect(head?.textContent).not.toContain("探索：");
});

test("子智能体一行：老记录没有结构化参数时，从 `探索：…` 里切出描述与类型", async () => {
  const container = await renderMessage({
    streaming: false,
    content: "调研完了。",
    events: [
      event({ kind: "subagent_start", toolName: "task", subagentId: "s1", output: "审阅：看这批改动" }),
      event({ kind: "subagent_end", toolName: "task", subagentId: "s1", output: "完成" }),
    ],
  });

  const head = container.querySelector(".subagent-head");
  expect(head?.textContent).toContain(zh("agent.subagent.type.review"));
  expect(head?.textContent).toContain("看这批改动");
  expect(head?.textContent).not.toContain("审阅：");
});

/**
 * 时间轴混排：模型说的话与工具调用**按发生顺序**交替。
 *
 * 已发生的问题：一条助手消息的正文在库里是整轮拼接的一整块，界面于是画成
 * "所有工具在上、所有正文在下" —— 看的人根本读不出"它先说了一句、再调工具、
 * 再接着说"这条线。顺序只能靠 `text` 事件还原（见 agent.ts 的 flushStepText），
 * 这里钉住渲染顺序与"尾巴不重复渲染"。
 */
const textEvent = (output: string, overrides: Partial<AgentEventRow> = {}) =>
  event({ kind: "text", toolName: null, output, ...overrides });
const timelineShape = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".msg-timeline > *")).map((el) =>
    el.classList.contains("timeline-detail") ? "detail" : "text",
  );

test("时间轴：正文 → 工具 → 正文，按发生顺序排（不再工具全在上、正文全在下）", async () => {
  const container = await renderMessage({
    streaming: false,
    content: "先看一眼工作区。看完了，目录就这些。",
    events: [
      textEvent("先看一眼工作区。"),
      event({ kind: "tool_start", toolName: "bash", args: JSON.stringify({ command: "ls" }) }),
      event({ kind: "tool_end", output: "a.ts" }),
      textEvent("看完了，目录就这些。"),
    ],
  });

  // DOM 顺序 = 时间顺序，而不是"所有工具 / 所有正文"两堆。
  expect(timelineShape(container)).toEqual(["text", "detail", "text"]);
  const blocks = Array.from(container.querySelectorAll(".msg-timeline > *"));
  expect(blocks[0]!.textContent).toContain("先看一眼工作区。");
  expect(blocks[1]!.textContent).toContain("ls");
  expect(blocks[2]!.textContent).toContain("看完了，目录就这些。");
});

test("时间轴：还没落成事件的正文当尾巴渲染，且不与事件里的那段重复", async () => {
  const first = "第一步：先看目录。";
  const streaming = "第二步正在写";
  const container = await renderMessage({
    streaming: true,
    content: first + streaming,
    events: [textEvent(first), event({ kind: "tool_start", toolName: "list_dir" }), event({ kind: "tool_end" })],
  });

  const text = container.querySelector(".msg-timeline")?.textContent ?? "";
  expect(text).toContain(first);
  expect(text).toContain(streaming);
  // 同一句话出现两次 = 事件与尾巴重复渲染（正是要避免的）。
  expect(text.split(first).length - 1).toBe(1);
});

test("时间轴：老消息没有 text 事件时，整条正文照旧渲染（不受混排改动影响）", async () => {
  const container = await renderMessage({
    streaming: false,
    content: "老消息的正文",
    events: [event({ kind: "tool_start" }), event({ kind: "tool_end" })],
  });
  expect(container.querySelector(".msg-timeline")?.textContent).toContain("老消息的正文");
});

test("状态行：跑完显示「已处理 · N 秒」与工具调用次数，工具行按发生顺序在时间轴上", async () => {
  await act(async () => {
    useChatStore.getState().setActiveConversation(CONVERSATION_ID);
    useChatStore.getState().setMessageStats(CONVERSATION_ID, MESSAGE_ID, {
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      tokens: 120,
      tokensPerSec: 30,
      elapsedMs: 12_000,
      source: "estimate",
    });
  });

  const container = await renderMessage({
    streaming: false,
    content: "干完了",
    events: [
      textEvent("先看一眼。"),
      event({ kind: "tool_start", createdAt: startedAgo(11_000) }),
      event({ kind: "tool_end", createdAt: startedAgo(10_000) }),
      textEvent("干完了"),
    ],
  });

  expect(label(container)).toBe(zh("chat.worked", { duration: "12.0 秒" }));
  expect(container.querySelector(".run-status")?.textContent).toContain(
    zh("agent.trace.tools", { count: "1" }),
  );

  await act(async () => {
    useChatStore.getState().removeMessage(CONVERSATION_ID, MESSAGE_ID);
  });
});
