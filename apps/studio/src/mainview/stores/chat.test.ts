import { beforeEach, describe, expect, test } from "bun:test";

import { liveOutputTokens, liveTokensPerSec, useChatStore, type LiveTurnStats } from "./chat";
import type { ChatMessage } from "../../bun/chat";

/**
 * 流式期间的一次重取不能把正文抹成空白（界面上就是「回复里正文没输出」）。
 * 这里锁住 mergeServerMessages 的合并规则：服务端那份更短的以本地为准，
 * 服务端独有的消息补进来，本地乐观插入的用户消息不会被复制成两条。
 */

const user = (id: number, content: string): ChatMessage => ({
  id,
  conversationId: 1,
  role: "user",
  content,
  createdAt: id,
});

const assistant = (id: number, content: string, reasoning?: string): ChatMessage => ({
  id,
  conversationId: 1,
  role: "assistant",
  content,
  reasoning,
  createdAt: id,
});

function reset(messages: ChatMessage[]) {
  const store = useChatStore.getState();
  store.setActiveConversation(1);
  store.setActiveMessages(messages);
}

test("服务端还是空行时，正在流式的正文保留本地已累积的内容", () => {
  reset([user(1, "帮我写个落地页"), assistant(2, "正在生成的正文…")]);
  useChatStore.getState().setStreaming(true);

  // 重取回来：数据库里这条助手消息还是空的（内容要等回合结束才落库）。
  useChatStore.getState().mergeServerMessages([user(1, "帮我写个落地页"), assistant(2, "")]);

  const messages = useChatStore.getState().activeMessages;
  expect(messages.map((m) => m.content)).toEqual(["帮我写个落地页", "正在生成的正文…"]);
  // 运行态没有被重取打断
  expect(useChatStore.getState().streaming).toBe(true);
});

test("思考内容同样不会被服务端那份覆盖掉", () => {
  reset([assistant(3, "答案", "先想一下……")]);
  useChatStore.getState().mergeServerMessages([assistant(3, "答案")]);

  expect(useChatStore.getState().activeMessages[0]?.reasoning).toBe("先想一下……");
});

test("回合结束后以服务端为准：正文、思考都取服务端那份", () => {
  reset([assistant(4, "半截")]);
  useChatStore.getState().mergeServerMessages([assistant(4, "完整正文", "完整思考")]);

  const [message] = useChatStore.getState().activeMessages;
  expect(message?.content).toBe("完整正文");
  expect(message?.reasoning).toBe("完整思考");
});

test("本地乐观插入的用户消息：服务端收录后不重复，未收录时留在原位", () => {
  // 刚刚按下发送：用户消息还是本地那条（id 是时间戳）。
  reset([user(9_000, "新问题")]);
  useChatStore.getState().mergeServerMessages([user(1, "上一个问题"), assistant(2, "上一个回答")]);

  const messages = useChatStore.getState().activeMessages;
  expect(messages.map((m) => m.content)).toEqual(["上一个问题", "上一个回答", "新问题"]);

  // 服务端已经把它落库了：本地那条要丢掉，顺序按服务端来。
  useChatStore.getState().mergeServerMessages([
    user(1, "上一个问题"),
    assistant(2, "上一个回答"),
    user(3, "新问题"),
  ]);
  const after = useChatStore.getState().activeMessages;
  expect(after.map((m) => [m.id, m.content])).toEqual([
    [1, "上一个问题"],
    [2, "上一个回答"],
    [3, "新问题"],
  ]);
});

/**
 * 回合开跑时的占位行（后端 `chatMessageStarted` 推送 → beginAssistantMessage）。
 *
 * 这一行是"点发送之后立刻有反馈"的落点：首 token 之前的等待（模型加载 / 预填充 /
 * 检索）里，界面上靠它显示「生成中…」。它必须与后面真正流式写回的那一行是**同一条**，
 * 否则一次提问会挂出两个助手气泡。
 */
describe("回合开跑的占位行", () => {
  beforeEach(() => {
    useChatStore.setState({
      activeConversationId: 1,
      activeMessages: [],
      streaming: false,
      messageStats: {},
      liveStats: {},
      runStartedAt: null,
    });
  });

  test("行一建好就进消息流，首 token 之前也有东西可看", () => {
    useChatStore.getState().setActiveMessages([user(9_000, "新问题")]);
    useChatStore.getState().setStreaming(true);
    useChatStore.getState().beginAssistantMessage(1, 42);

    const messages = useChatStore.getState().activeMessages;
    expect(messages.map((m) => [m.id, m.role, m.content])).toEqual([
      [9_000, "user", "新问题"],
      [42, "assistant", ""],
    ]);
  });

  test("同一个 id 重复推送 / 增量先到，都不会插出第二条", () => {
    useChatStore.getState().beginAssistantMessage(1, 42);
    useChatStore.getState().beginAssistantMessage(1, 42);

    expect(useChatStore.getState().activeMessages).toHaveLength(1);
  });

  test("首字到达后写进这一行，而不是另起一条", () => {
    useChatStore.getState().setStreaming(true);
    useChatStore.getState().beginAssistantMessage(1, 42);
    useChatStore.getState().appendChunk(1, 42, "你好");

    const messages = useChatStore.getState().activeMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 42, role: "assistant", content: "你好" });
  });

  test("别的会话的行不进当前列表（后台会话由打开时整份取回）", () => {
    useChatStore.getState().beginAssistantMessage(999, 42);

    expect(useChatStore.getState().activeMessages).toHaveLength(0);
  });

  test("还没拿到真实 id 就失败：报错填进那一行，不再挂一条空回复", () => {
    useChatStore.getState().setActiveMessages([user(9_000, "新问题")]);
    useChatStore.getState().setStreaming(true);
    useChatStore.getState().beginAssistantMessage(1, 42);
    // RPC 抛错 / 后端回 ok:false 时调用方用时间戳兜底（拿不到真实 id）。
    useChatStore.getState().finalizeMessage(1, Date.now(), "⚠️ 模型没起来");

    const messages = useChatStore.getState().activeMessages;
    expect(messages.map((m) => m.content)).toEqual(["新问题", "⚠️ 模型没起来"]);
    expect(messages[1]?.id).toBe(42);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  test("末尾那条不是空助手行时不顶替它（上一轮的回复不能被报错吃掉）", () => {
    useChatStore.getState().setActiveMessages([assistant(7, "上一轮的回答")]);
    useChatStore.getState().setStreaming(true);
    useChatStore.getState().finalizeMessage(1, Date.now(), "⚠️ 失败");

    expect(useChatStore.getState().activeMessages.map((m) => m.content)).toEqual([
      "上一轮的回答",
      "⚠️ 失败",
    ]);
  });
});

/**
 * 生成中的实时速度（底部胶囊那行跳动的 token/秒）。
 * 这部分不碰 React，直接对 store 断言比渲染整棵聊天树稳定得多。
 */
describe("流式实时统计", () => {
  beforeEach(() => {
    useChatStore.setState({
      activeConversationId: 1,
      activeMessages: [],
      streaming: false,
      messageStats: {},
      liveStats: {},
      runStartedAt: null,
    });
  });

  test("按增量累计字符，token 数不因多次取整而虚高", () => {
    useChatStore.getState().setStreaming(true);
    const store = useChatStore.getState();
    // 20 个 "ab " 增量 = 60 个字符 = 15 tokens；
    // 若每个增量各自 ceil 会得到 20 —— 必须按累计值折算。
    for (let i = 0; i < 20; i += 1) store.appendChunk(1, 42, "ab ");
    const live = useChatStore.getState().liveStats[42]!;
    expect(liveOutputTokens(live)).toBe(15);
  });

  test("思考增量单独记，也算进输出总量", () => {
    useChatStore.getState().setStreaming(true);
    const store = useChatStore.getState();
    store.appendChunk(1, 7, "你好", "reasoning");
    store.appendChunk(1, 7, "abcd");
    const live = useChatStore.getState().liveStats[7]!;
    expect(live.reasoningCjk).toBe(2);
    expect(live.contentOther).toBe(4);
    expect(liveOutputTokens(live)).toBe(3); // 2 + ceil(4/4)
  });

  test("速度按首 token 之后的窗口算，没有首 token 时不报速度", () => {
    const live: LiveTurnStats = {
      startedAt: 1000,
      firstTokenAt: 2000,
      contentCjk: 0,
      contentOther: 400, // 100 tokens
      reasoningCjk: 0,
      reasoningOther: 0,
    };
    expect(liveTokensPerSec(live, 4000)).toBe(50);
    expect(liveTokensPerSec({ ...live, firstTokenAt: null }, 4000)).toBe(0);
    // 窗口为 0 也不能除零。
    expect(Number.isFinite(liveTokensPerSec(live, 2000))).toBe(true);
  });

  test("收尾后清掉实时进度，交给实测统计", () => {
    useChatStore.getState().setStreaming(true);
    useChatStore.getState().appendChunk(1, 9, "hello");
    expect(useChatStore.getState().liveStats[9]).toBeDefined();
    useChatStore.getState().finalizeMessage(1, 9, "hello");
    expect(useChatStore.getState().liveStats[9]).toBeUndefined();
    expect(useChatStore.getState().streaming).toBe(false);
  });

  test("切走会话时不留下别的会话的实时进度", () => {
    useChatStore.getState().setStreaming(true);
    useChatStore.getState().appendChunk(1, 5, "abc");
    useChatStore.getState().setActiveMessages([assistant(6, "x")]);
    expect(useChatStore.getState().liveStats[5]).toBeUndefined();
  });

  test("会话不匹配的增量被忽略（切会话竞态）", () => {
    useChatStore.getState().setStreaming(true);
    useChatStore.getState().appendChunk(999, 1, "nope");
    expect(useChatStore.getState().liveStats[1]).toBeUndefined();
    expect(useChatStore.getState().activeMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 兜底收尾的幂等性。
//
// 踩过的坑：后端"没模型 / 服务器没起来"这类早退也会推一条带 error 的 chatDone，
// 而调用方（composer / 对话页）在拿到 `ok:false` 时又自己 finalize 一次 ——
// 界面上就是两个内容相同的 ⚠️ 气泡，看起来像"报错报了两次"。
// ---------------------------------------------------------------------------
test("finalizeTurnIfPending：这一轮已经收过尾时不再补第二条", () => {
  reset([user(1, "你好")]);
  // 正常路径：chatDone 先到，落成一条有内容的助手消息
  useChatStore.getState().finalizeMessage(1, 2, "⚠️ No model configured");
  const before = useChatStore.getState().activeMessages.length;

  // 兜底后到：不应再补
  useChatStore.getState().finalizeTurnIfPending(1, "⚠️ No model configured");
  const after = useChatStore.getState().activeMessages;
  expect(after).toHaveLength(before);
  expect(after.filter((m) => m.content.includes("No model configured"))).toHaveLength(1);
});

test("finalizeTurnIfPending：末尾是空助手行（没人收过尾）时照常补一条", () => {
  reset([user(1, "你好"), assistant(2, "")]);
  useChatStore.getState().setStreaming(true);

  useChatStore.getState().finalizeTurnIfPending(1, "⚠️ Request failed");
  const messages = useChatStore.getState().activeMessages;
  // 复用那条空行，而不是另起一条
  expect(messages).toHaveLength(2);
  expect(messages[1]!.content).toBe("⚠️ Request failed");
  expect(useChatStore.getState().streaming).toBe(false);
});
