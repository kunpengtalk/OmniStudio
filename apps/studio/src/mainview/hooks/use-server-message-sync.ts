import { useEffect } from "react";

import type { ChatMessage } from "../../bun/chat";
import { useChatStore } from "@stores/chat";

/**
 * 服务端消息 → 会话 store 的同步规则。
 *
 * 这件事有两个**必须分开**的动作，写在一个 effect 里就会互相打架：
 *
 * 1. **切会话**才清流式运行态。`setStreaming(false)` 是"这个会话从头开始"的信号，
 *    它只该在 `conversationId` 变了的时候发生。
 * 2. **同会话内的任何一次重取只做合并**，不能整体替换。TanStack Query 会因为窗口
 *    重新聚焦、`invalidateQueries`、后台刷新等任何理由重取；整体替换的后果是——正在
 *    流式的助手消息被服务端那份"还没落库"的空内容（或半截内容）覆盖，用户看到正文
 *    突然被抹掉，输入框也跟着解锁。`stores/chat.test.ts:8-10` 专门钉过这条规则。
 *
 * 早前对话页把这两件事写在一个 `[conversationId, convQuery.data]` 的 effect 里，
 * 于是每次重取都执行一遍"清空 + 整体替换"；Agent 页当时是对的。现在两边共用本 hook，
 * 规则只有一份实现。
 */
export function useServerMessageSync(
  conversationId: number | null,
  data: { messages: ChatMessage[] } | undefined,
): void {
  useEffect(() => {
    useChatStore.getState().setStreaming(false);
  }, [conversationId]);

  useEffect(() => {
    if (data) useChatStore.getState().mergeServerMessages(data.messages);
  }, [data]);
}
