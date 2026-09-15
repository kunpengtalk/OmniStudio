/**
 * 压缩流水线的**顺序**（收网 → 去重 → 摘要 → 裁剪）。
 *
 * 为什么单开一个文件钉这个：这几步的顺序错了，界面上看不出来 ——
 * `rewind`（探索收网）曾经在这里直接 `return`，于是收网过的会话从下一次请求起
 * 永远走不到去重 / 摘要 / 裁剪：历史重新涨过窗口时（8k 窗口下几轮就够）没有任何兜底，
 * 而收网那一刻又刚好把旧摘要作废了，等于"再也压不动"。表现只是"这个会话越用越卡"，
 * 没有报错、没有日志，回看历史也看不出哪里不对。
 */
import { afterEach, describe, expect, test } from "bun:test";

import { makeContextTransform, listAgentEvents, type CompactionHost } from "./agent";
import { estimateMessagesTokens } from "./agent-compaction";
import type { RewindState } from "./agent-checkpoint";
import { updateSettings } from "./db/settings";

/** 纯文本消息：内容足够长，好把 token 数顶过预算。 */
const text = (body: string) => ({ role: "user", content: [{ type: "text", text: body }] });

const filler = (tag: string, chars: number) => text(`${tag} ${"x".repeat(chars)}`);

const host = (over: Partial<CompactionHost> = {}): CompactionHost => ({
  workspace: "/tmp/omni-pipeline-ws",
  summary: null,
  compactedDropped: 0,
  ...over,
});

/** 摘要那一步要真调模型，这里全程只测确定性的裁剪路径。 */
const makeTransform = (h: CompactionHost, conversationId = 9001) =>
  makeContextTransform(h, conversationId, {} as never);

afterEach(() => {
  updateSettings({ AGENT_COMPACT_MODE: "trim", SERVER_CTX_SIZE: "8192" });
});

describe("压缩流水线", () => {
  test("收网之后照样走裁剪：上下文回到窗口之内（不是「收网完就再也不压了」）", async () => {
    const window = 512;
    updateSettings({ AGENT_COMPACT_MODE: "trim", SERVER_CTX_SIZE: String(window) });
    // 打点**之前**就已经很长了（读了半天资料才想到打点）：收网只替换打点之后的那段，
    // 剩下的历史本身仍然超过窗口 —— 这正是"收网完还要继续压"的场景。
    // 如果收网后直接 return，这份历史就永远压不下去（实测 3211 tokens 原样发给 512 窗口的
    // 模型），8k 窗口下几轮之后必然溢出。
    const beforeCheckpoint = Array.from({ length: 30 }, (_, i) => filler(`打点前 ${i}`, 400));
    const exploration = Array.from({ length: 5 }, (_, i) => filler(`探索 ${i}`, 400));
    const messages = [text("任务：找出崩溃原因"), ...beforeCheckpoint, ...exploration];
    const rewind: RewindState = {
      at: beforeCheckpoint.length + 1,
      report: "结论：问题在 a.ts:42",
      cutTo: null,
    };

    const tokensIn = estimateMessagesTokens(messages as never);
    const out = await makeTransform(host({ rewind }))(messages as never[]);
    const tokensOut = estimateMessagesTokens(out as never);

    // 硬约束是这个：发给模型的东西必须放得进窗口，否则这一轮直接失败。
    expect(tokensOut).toBeLessThanOrEqual(window);
    // 而且确实是被"压"下来的，不是本来就小。
    expect(tokensOut).toBeLessThan(tokensIn / 4);
    // 任务陈述与那份结论都还在（压缩的既定安全约束：结论是收网后唯一的成果）。
    const joined = JSON.stringify(out);
    expect(joined).toContain("找出崩溃原因");
    expect(joined).toContain("a.ts:42");
    // 打点之后的中间过程确实被拿掉了。
    expect(joined).not.toContain("探索 0");
  });

  test("收网只在执行轨迹里记一条（按步记会刷出一整列重复行）", async () => {
    updateSettings({ AGENT_COMPACT_MODE: "trim", SERVER_CTX_SIZE: "8192" });
    const messages = [text("任务"), filler("探索", 200)];
    const rewind: RewindState = { at: 1, report: "结论", cutTo: null };
    const conversationId = 9002;
    const transform = makeTransform(host({ rewind }), conversationId);

    await transform(messages as never[]);
    expect(rewind.logged).toBe(true);
    await transform(messages as never[]);
    await transform(messages as never[]);

    // 轨迹里的 rewind 行只有一条：transformContext 每一步都会被调一次，不记标志的话
    // 一个 10 步的回合就会在时间线上排出 10 条一模一样的"探索收网"。
    const rows = listAgentEvents(conversationId).filter((e) => e.toolName === "rewind");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.output).toContain("探索收网");

    // 结论消息也只放一条（反复重建上下文不会把结论叠起来）。
    const out = await transform(messages as never[]);
    const conclusionCount = JSON.stringify(out).split('"text":"（探索收网').length - 1;
    expect(conclusionCount).toBe(1);
  });

  test("收网之后新增的内容接在结论后面，再被后续裁剪正常处理", async () => {
    updateSettings({ AGENT_COMPACT_MODE: "trim", SERVER_CTX_SIZE: "8192" });
    const rewind: RewindState = { at: 1, report: "结论：问题在 a.ts:42", cutTo: null };
    const transform = makeTransform(host({ rewind }));

    await transform([text("任务"), filler("探索 A", 100), filler("探索 B", 100)] as never[]);
    // 收网之后模型接着干活：这些新消息不能被吞掉。
    const out = await transform([
      text("任务"),
      filler("探索 A", 100),
      filler("探索 B", 100),
      text("收网之后的新一步"),
    ] as never[]);

    const joined = JSON.stringify(out);
    expect(joined).toContain("收网之后的新一步");
    expect(joined).toContain("a.ts:42");
    expect(joined).not.toContain("探索 A");
  });
});
