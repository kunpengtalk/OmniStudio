import { describe, expect, test } from "bun:test";

import { artifactsByMessage, lastAssistantMessageId } from "./artifact-meta";
import type { ArtifactItem } from "../../../bun/agent-artifacts";

/**
 * 产物挂在哪条消息下面。
 *
 * 已发生的问题：自动化跑出来的报告在库里 `message_id` 是 NULL（工具回调拿的是建会话
 * 那一刻的消息 id），右侧面板里看得到、消息底下却一张卡片都没有 —— 回看时以为它
 * 什么都没写。这里钉住兜底规则：没有归属的一律挂到最后一条**助手**消息下面，
 * 不能让用户为了找产物去翻右侧面板。
 */

let nextId = 1;
function artifact(overrides: Partial<ArtifactItem> & { messageId: number | null }): ArtifactItem {
  const id = nextId++;
  return {
    id,
    conversationId: 1,
    path: `out/file-${id}.md`,
    absPath: `/tmp/out/file-${id}.md`,
    title: `file-${id}.md`,
    kind: "markdown",
    size: 10,
    tool: "write_file",
    createdAt: 0,
    ...overrides,
  };
}

const user = (id: number) => ({ id, role: "user" });
const assistant = (id: number) => ({ id, role: "assistant" });
const idsOf = (map: Map<number, ArtifactItem[]>, messageId: number) =>
  (map.get(messageId) ?? []).map((item) => item.id);

describe("产物归属", () => {
  test("归属某条消息的产物归它自己", () => {
    const own = artifact({ messageId: 3 });
    const map = artifactsByMessage([own], [user(2), assistant(3)]);
    expect(idsOf(map, 3)).toEqual([own.id]);
  });

  test("没有归属的产物挂到最后一条助手消息，排在它自己的产物后面", () => {
    const earlier = artifact({ messageId: null });
    const own = artifact({ messageId: 3 });
    const later = artifact({ messageId: null });
    // 传进来的顺序是乱的：结果按类型分组 + 兜底按 id 升序，与入参顺序无关。
    const map = artifactsByMessage([later, own, earlier], [user(2), assistant(3)]);
    expect(idsOf(map, 3)).toEqual([own.id, earlier.id, later.id]);
  });

  test("归属的消息已经不在这一屏（重跑 / 删除过）也算没有归属", () => {
    const gone = artifact({ messageId: 99 });
    const map = artifactsByMessage([gone], [user(2), assistant(3)]);
    expect(idsOf(map, 3)).toEqual([gone.id]);
  });

  test("最后一条是用户消息时，兜底挂在助手消息上（不是用户那条）", () => {
    const orphan = artifact({ messageId: null });
    const map = artifactsByMessage([orphan], [user(2), assistant(3), user(4)]);
    expect(map.get(4)).toBeUndefined();
    expect(idsOf(map, 3)).toEqual([orphan.id]);
  });

  test("一条助手消息都没有时原样返回（不硬塞给用户消息）", () => {
    const orphan = artifact({ messageId: null });
    const map = artifactsByMessage([orphan], [user(2)]);
    expect(map.size).toBe(0);
  });

  test("最后一条助手消息的取法：跳过末尾的用户消息", () => {
    expect(lastAssistantMessageId([user(2), assistant(3), user(4)])).toBe(3);
    expect(lastAssistantMessageId([user(2)])).toBeNull();
  });
});
