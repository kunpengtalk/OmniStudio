import { describe, expect, test } from "bun:test";

import { buildTimelineItems, flushedTextChars, toolLabel } from "./timeline-model";
import { translate } from "../../../shared/i18n";
import type { AgentEventRow } from "../../../bun/agent";

let nextId = 1;
function event(row: Partial<AgentEventRow> & Pick<AgentEventRow, "kind">): AgentEventRow {
  return {
    id: nextId++,
    conversationId: 1,
    messageId: 1,
    toolName: null,
    args: null,
    output: null,
    isError: 0,
    subagentId: null,
    createdAt: 0,
    ...row,
  };
}

describe("buildTimelineItems", () => {
  test("授权卡片插在工具调用中间时，工具行依然配到结果（不再永远转圈）", () => {
    const events = [
      event({ kind: "tool_start", toolName: "read_file", args: '{"path":"a.ts"}' }),
      event({ kind: "status", toolName: "permission_request", args: '{"id":"p1"}' }),
      event({
        kind: "status",
        toolName: "permission",
        args: '{"id":"p1","reply":"workspace"}',
        output: "已允许（写入工作区规则）",
      }),
      event({ kind: "tool_end", toolName: "read_file", output: "ok" }),
    ];

    const items = buildTimelineItems(events);
    const tool = items.find((item) => item.type === "tool") as Extract<
      (typeof items)[number],
      { type: "tool" }
    >;

    expect(tool).toBeDefined();
    expect(tool.end?.output).toBe("ok");
    // 授权卡片仍然成对展示（请求 + 结果）
    const permission = items.find((item) => item.type === "permission") as Extract<
      (typeof items)[number],
      { type: "permission" }
    >;
    expect(permission.settle?.output).toBe("已允许（写入工作区规则）");
  });

  test("status 行插在中间时同样能配对", () => {
    const events = [
      event({ kind: "tool_start", toolName: "bash", args: '{"command":"ls"}' }),
      event({ kind: "status", toolName: "compact", output: "上下文压缩" }),
      event({ kind: "tool_end", toolName: "bash", output: "done" }),
    ];

    const items = buildTimelineItems(events);
    const tools = items.filter((item) => item.type === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.end?.output).toBe("done");
    expect(items.filter((item) => item.type === "status")).toHaveLength(1);
  });

  test("同一批里并行调用同名工具时各自配对（后进先出）", () => {
    const events = [
      event({ kind: "tool_start", toolName: "bash", args: '{"command":"a"}' }),
      event({ kind: "tool_start", toolName: "bash", args: '{"command":"b"}' }),
      event({ kind: "tool_end", toolName: "bash", output: "b done" }),
      event({ kind: "tool_end", toolName: "bash", output: "a done" }),
    ];

    const items = buildTimelineItems(events);
    const tools = items.filter((item) => item.type === "tool") as Extract<
      (typeof items)[number],
      { type: "tool" }
    >[];

    expect(tools).toHaveLength(2);
    expect(tools[0]!.start.args).toBe('{"command":"a"}');
    expect(tools[0]!.end?.output).toBe("a done");
    expect(tools[1]!.start.args).toBe('{"command":"b"}');
    expect(tools[1]!.end?.output).toBe("b done");
  });

  test("没有对应 start 的 tool_end 单独成行（不吞掉结果）", () => {
    const items = buildTimelineItems([event({ kind: "tool_end", toolName: "bash", output: "x" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "tool" });
    expect((items[0] as { start: AgentEventRow }).start.kind).toBe("tool_end");
  });

  test("子智能体的事件收进分组，不混进主线", () => {
    const events = [
      event({ kind: "subagent_start", toolName: "task", subagentId: "s1", output: "探索：找配置" }),
      event({ kind: "tool_start", toolName: "grep", subagentId: "s1" }),
      event({ kind: "tool_end", toolName: "grep", subagentId: "s1", output: "hit" }),
      event({ kind: "subagent_end", toolName: "task", subagentId: "s1", output: "完成：…" }),
    ];

    const items = buildTimelineItems(events);
    expect(items).toHaveLength(1);
    const group = items[0] as Extract<(typeof items)[number], { type: "subagent" }>;
    expect(group.type).toBe("subagent");
    expect(group.children).toHaveLength(2);
  });
});

/**
 * 工具行分组：同家族的**相邻**调用收成一行「查阅 · 2 搜索, 1 列表」。
 *
 * 已发生的问题：一次调研十几个 read / grep，一个调用占一行，时间轴被过程铺满 ——
 * 真实会话里四十行工具里三十行是 read_file，模型说的话反而要翻半天。
 * 分组只并"同家族且相邻"：中间夹了正文、状态行、终端命令或子智能体就断成两组，
 * 顺序与因果都还读得出来；单独一次调用不成组（那一行带着参数，比计数有信息量）。
 */
describe("工具行分组", () => {
  /** 一次完整的调用（start + end）。 */
  const call = (toolName: string, args: string | null = null, output = "ok") => [
    event({ kind: "tool_start", toolName, args }),
    event({ kind: "tool_end", toolName, output }),
  ];

  test("相邻的读取 / 搜索收成一组（family = 查阅）", () => {
    const items = buildTimelineItems([
      ...call("read_file", '{"path":"a.ts"}'),
      ...call("grep", '{"pattern":"x"}'),
      ...call("list_dir", '{"path":"src"}'),
    ]);

    expect(items).toHaveLength(1);
    const group = items[0] as Extract<(typeof items)[number], { type: "toolGroup" }>;
    expect(group.type).toBe("toolGroup");
    expect(group.family).toBe("browse");
    expect(group.tools).toHaveLength(3);
    // 组内每一对 start/end 仍然配好（展开后每行还是原来那一行）
    expect(group.tools[0]!.end?.output).toBe("ok");
  });

  test("正文打断分组：说 → 读两次 → 说 → 读两次 = 两个组", () => {
    const items = buildTimelineItems([
      ...call("read_file"),
      ...call("read_file"),
      event({ kind: "text", output: "先看一眼。" }),
      ...call("grep"),
      ...call("grep"),
    ]);
    expect(items.map((item) => item.type)).toEqual(["toolGroup", "text", "toolGroup"]);
  });

  test("不同家族不并：读取 + 终端 + 读取 = 三行（终端每条命令自带信息）", () => {
    const items = buildTimelineItems([...call("read_file"), ...call("bash", '{"command":"ls"}'), ...call("read_file")]);
    expect(items.map((item) => item.type)).toEqual(["tool", "tool", "tool"]);
  });

  test("单独一次调用不成组：保留「动作名 + 参数」那一行", () => {
    const items = buildTimelineItems([...call("read_file", '{"path":"a.ts"}')]);
    expect(items.map((item) => item.type)).toEqual(["tool"]);
    expect((items[0] as { start: AgentEventRow }).start.args).toBe('{"path":"a.ts"}');
  });

  test("未知工具（MCP / 外部接入）不并进相邻的组里", () => {
    const items = buildTimelineItems([
      ...call("read_file"),
      ...call("mcp__github__search"),
      ...call("read_file"),
    ]);
    expect(items.map((item) => item.type)).toEqual(["tool", "tool", "tool"]);
  });

  test("授权卡片打断分组（并排的两个组各自成组）", () => {
    const items = buildTimelineItems([
      ...call("edit_file"),
      ...call("edit_file"),
      event({ kind: "status", toolName: "permission_request", args: '{"id":"p1"}' }),
      event({ kind: "status", toolName: "permission", args: '{"id":"p1"}', output: "已允许" }),
      ...call("edit_file"),
      ...call("edit_file"),
    ]);
    expect(items.map((item) => item.type)).toEqual(["toolGroup", "permission", "toolGroup"]);
  });

  test("编辑家族单独成族（写入 / 编辑 / 补丁 并在一组）", () => {
    const items = buildTimelineItems([...call("write_file"), ...call("apply_patch")]);
    const group = items[0] as Extract<(typeof items)[number], { type: "toolGroup" }>;
    expect(group.family).toBe("edit");
    expect(group.tools).toHaveLength(2);
  });

  test("子智能体的事件不进主线，它自己的调用收在自己的分组里", () => {
    const items = buildTimelineItems([
      ...call("read_file"),
      event({ kind: "subagent_start", toolName: "task", subagentId: "s1", output: "探索：找配置" }),
      event({ kind: "tool_start", toolName: "read_file", subagentId: "s1" }),
      event({ kind: "tool_end", toolName: "read_file", subagentId: "s1", output: "ok" }),
      event({ kind: "subagent_end", toolName: "task", subagentId: "s1", output: "完成" }),
      ...call("read_file"),
    ]);

    // 子智能体分组画在**最后**（既有行为：它自己的事件不进主线的顺序里）——
    // 于是主线上前后两次读取在渲染顺序上相邻，收成一组。
    expect(items.map((item) => item.type)).toEqual(["toolGroup", "subagent"]);
    expect((items[0] as Extract<(typeof items)[number], { type: "toolGroup" }>).tools).toHaveLength(2);
    // 子智能体那次读取收在它自己的分组里，没有被主线的组吞掉
    expect((items[1] as Extract<(typeof items)[number], { type: "subagent" }>).children).toHaveLength(2);
  });
});

/**
 * 工具行的动作名：缺词条时退回工具名，不把 key 画到界面上。
 *
 * 已发生的问题：记忆工具的行显示成 `agent.tool.memory_search`（截图里就是这一串）——
 * `t()` 缺键时返回 key，而 MCP / 外部工具永远不会有词条，所以这里必须兜住。
 */
describe("toolLabel", () => {
  test("有词条时用词条", () => {
    const t = (key: string) => translate("zh", key);
    expect(toolLabel(t, "agent.tool.bash", "bash")).toBe("bash"); // bash 走的是 terminal 词条
    expect(toolLabel(t, "agent.tool.terminal", "bash")).toBe("终端");
    expect(toolLabel(t, "agent.tool.memory_search", "memory_search")).toBe("检索记忆");
  });

  test("缺词条时退回工具名本身（MCP 工具不会画出 agent.tool.xxx）", () => {
    const missing = (key: string) => key; // 等价于 t() 在缺键时的返回值
    expect(toolLabel(missing, "agent.tool.mcp__github__search", "mcp__github__search")).toBe(
      "mcp__github__search",
    );
    expect(toolLabel(missing, "agent.tool.brand_new_tool", "brand_new_tool")).toBe("brand_new_tool");
  });
});

/**
 * 时间轴混排：模型说的话（`text` 事件）与工具调用同序，以及"尾巴切片"的长度。
 *
 * 顺序只能靠事件还原：一条助手消息的正文在库里是整轮拼接的一整块，
 * 没有"这句话说在哪次工具调用之前"的信息（见 agent.ts 的 flushStepText）。
 */
describe("时间轴混排", () => {
  test("text 事件按发生顺序与工具行交错", () => {
    const events = [
      event({ kind: "text", output: "先看一眼工作区。" }),
      event({ kind: "tool_start", toolName: "bash" }),
      event({ kind: "tool_end", toolName: "bash", output: "ok" }),
      event({ kind: "text", output: "看完了，目录就这些。" }),
    ];
    expect(buildTimelineItems(events).map((item) => item.type)).toEqual(["text", "tool", "text"]);
  });

  test("子智能体说的话不进主时间轴（它归在那个子任务分组里）", () => {
    const events = [
      event({ kind: "subagent_start", toolName: "task", subagentId: "s1" }),
      event({ kind: "text", output: "子智能体内部的自言自语", subagentId: "s1" }),
      event({ kind: "subagent_end", toolName: "task", subagentId: "s1", output: "结论" }),
    ];
    const items = buildTimelineItems(events);
    expect(items.map((item) => item.type)).toEqual(["subagent"]);
  });

  test("flushedTextChars：只算已落成事件的主线正文（尾巴切片的起点）", () => {
    expect(flushedTextChars([])).toBe(0);
    expect(
      flushedTextChars([
        event({ kind: "text", output: "abc" }),
        event({ kind: "tool_start", toolName: "bash" }),
        event({ kind: "text", output: "内部的话", subagentId: "s1" }),
      ]),
    ).toBe(3);
  });
});
