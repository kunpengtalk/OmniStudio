import { expect, test } from "bun:test";

import { useChatStore } from "./chat";
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
