import { describe, expect, test } from "bun:test";

import { listAgentEvents } from "./agent";
import * as Chat from "./chat";
import { db } from "./db";
import { agentEvents } from "./db/schema";

/**
 * 轨迹的增量读取（`afterId`）。
 *
 * 界面在跑动中靠它追平推送丢掉的那几条（见 app/agent/conversation.tsx 的 tail 轮询）：只取
 * "比已知的最后一条更新"的事件。已发生的问题：轨迹只靠推送长，丢一条就永久缺一段，
 * 库里却有完整记录 —— 界面上就是"执行到一半记录加不上"且再也追不回来。
 * 这里钉住三件事：`afterId = 0` 是整份、增量只回新增、别的会话不会串进来。
 */

function addEvent(conversationId: number, toolName: string, kind: "tool_start" | "tool_end" = "tool_start") {
  return db
    .insert(agentEvents)
    .values({ conversationId, kind, toolName, output: toolName })
    .returning()
    .get() as { id: number };
}

describe("轨迹增量读取", () => {
  test("afterId = 0 拿整份；带上最后一条的 id 只拿新增的那几条", () => {
    const conversation = Chat.createConversation("轨迹增量", "agent");
    addEvent(conversation.id, "bash");
    addEvent(conversation.id, "bash", "tool_end");

    const full = listAgentEvents(conversation.id);
    expect(full).toHaveLength(2);
    // afterId 是"已知的最后一条"：它自己不能再回来（否则界面每追平一次就重渲染一遍旧行）。
    expect(listAgentEvents(conversation.id, full[full.length - 1]!.id)).toEqual([]);

    const added = addEvent(conversation.id, "read_file");
    const tail = listAgentEvents(conversation.id, full[full.length - 1]!.id);
    expect(tail.map((event) => event.id)).toEqual([added.id]);
    expect(tail[0]!.toolName).toBe("read_file");
    // 追平之后接着追：又回到空。
    expect(listAgentEvents(conversation.id, added.id)).toEqual([]);
  });

  test("别的会话的新事件不会被带出来", () => {
    const a = Chat.createConversation("轨迹 A", "agent");
    const b = Chat.createConversation("轨迹 B", "agent");
    addEvent(a.id, "bash");
    const eventsOfA = listAgentEvents(a.id);
    const lastOfA = eventsOfA[eventsOfA.length - 1]!.id;

    addEvent(b.id, "bash");
    expect(listAgentEvents(a.id, lastOfA)).toEqual([]);
    expect(listAgentEvents(a.id, 0)).toHaveLength(1);
  });
});
