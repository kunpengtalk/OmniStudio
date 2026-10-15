import { describe, expect, test } from "bun:test";

import {
  CANVAS_DEFAULT_VIEWPORT,
  CANVAS_LIMITS,
  type CanvasNodeData,
} from "../shared/canvas";
import { sqliteClient } from "./db";
import {
  createCanvasDoc,
  deleteCanvasDoc,
  getCanvasDoc,
  listCanvasDocs,
  saveCanvasDoc,
} from "./canvas";

/** 一个合法节点的模板，按用例覆盖字段。 */
function node(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    id: "n1",
    kind: "text",
    title: "文本",
    x: 10,
    y: 20,
    width: 320,
    height: 240,
    prompt: "写一首诗",
    status: "idle",
    ...overrides,
  };
}

describe("canvas doc persistence", () => {
  test("创建 → 保存 → 读取：整份载荷往返一致", () => {
    const doc = createCanvasDoc("测试画布");
    expect(doc.id).toBeGreaterThan(0);

    const nodes = [
      node(),
      node({ id: "n2", kind: "image", resultRef: "gen/abc.png", model: { source: "cloud", providerId: "p1", model: "gpt-image" } }),
    ];
    const connections = [{ id: "c1", fromId: "n1", toId: "n2" }];
    const saved = saveCanvasDoc(doc.id, { nodes, connections, viewport: { x: -40, y: 12, k: 0.8 } });
    expect(saved.ok).toBe(true);

    const loaded = getCanvasDoc(doc.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("测试画布");
    expect(loaded!.payload.nodes).toHaveLength(2);
    expect(loaded!.payload.nodes[1]!.kind).toBe("image");
    expect(loaded!.payload.nodes[1]!.resultRef).toBe("gen/abc.png");
    expect(loaded!.payload.connections).toEqual(connections);
    expect(loaded!.payload.viewport).toEqual({ x: -40, y: 12, k: 0.8 });

    const list = listCanvasDocs();
    expect(list.find((d) => d.id === doc.id)?.nodeCount).toBe(2);

    expect(deleteCanvasDoc(doc.id).ok).toBe(true);
    expect(getCanvasDoc(doc.id)).toBeNull();
  });

  test("坏载荷被修整而不是拒绝：非法 kind 丢弃、悬空连线剔除、ref 校验", () => {
    const doc = createCanvasDoc();
    const badNodes = [
      node({ id: "ok" }),
      node({ id: "bad-kind", kind: "hacker" as CanvasNodeData["kind"] }),
      node({ id: "bad-ref", resultRef: "../../etc/passwd" }),
      node({ id: "bad-ref2", resultRef: "abs/../../../evil" }),
      { ...node({ id: "huge-prompt" }), prompt: "x".repeat(CANVAS_LIMITS.promptChars + 5) },
    ];
    const badConnections = [
      { id: "c-ok", fromId: "ok", toId: "bad-ref" },
      { id: "c-dangling", fromId: "ok", toId: "ghost" },
      { id: "c-self", fromId: "ok", toId: "ok" },
    ];
    saveCanvasDoc(doc.id, { nodes: badNodes as unknown as CanvasNodeData[], connections: badConnections });

    const loaded = getCanvasDoc(doc.id)!;
    const ids = loaded.payload.nodes.map((n) => n.id);
    // kind 非法的节点被丢；ref 坏的节点保留但 ref 被清掉
    expect(ids).toContain("ok");
    expect(ids).not.toContain("bad-kind");
    expect(ids).toContain("bad-ref");
    expect(loaded.payload.nodes.find((n) => n.id === "bad-ref")?.resultRef).toBeUndefined();
    expect(loaded.payload.nodes.find((n) => n.id === "bad-ref2")?.resultRef).toBeUndefined();
    // 提示词截断到上限
    expect(loaded.payload.nodes.find((n) => n.id === "huge-prompt")!.prompt.length).toBeLessThanOrEqual(CANVAS_LIMITS.promptChars);
    // 悬空 / 自连连线剔除，合法连线保留
    const connIds = loaded.payload.connections.map((c) => c.id);
    expect(connIds).toEqual(["c-ok"]);

    deleteCanvasDoc(doc.id);
  });

  test("保存不存在的画布报错；标题超限截断", () => {
    expect(saveCanvasDoc(999999, { title: "x" }).ok).toBe(false);
    const doc = createCanvasDoc("x".repeat(CANVAS_LIMITS.titleChars + 9));
    expect(getCanvasDoc(doc.id)!.title.length).toBe(CANVAS_LIMITS.titleChars);
    deleteCanvasDoc(doc.id);
  });

  test("坏 JSON 文档以空画布打开（不崩）", () => {
    const doc = createCanvasDoc();
    // 直接用 saveCanvasDoc 写不进坏 JSON —— 用裸 SQL 模拟历史脏数据。
    sqliteClient.run("UPDATE canvas_docs SET nodes = '{not-json' WHERE id = ?", [doc.id]);
    const loaded = getCanvasDoc(doc.id)!;
    expect(loaded.payload.nodes).toEqual([]);
    expect(loaded.payload.connections).toEqual([]);
    expect(loaded.payload.viewport).toEqual(CANVAS_DEFAULT_VIEWPORT);
    deleteCanvasDoc(doc.id);
  });

  test("音乐节点往返：kind / instrumental / 上游歌词字段都保住", () => {
    const doc = createCanvasDoc("音乐画布");
    const musicNode = node({
      id: "m1",
      kind: "music",
      title: "音乐节点 1",
      prompt: "温暖的民谣，木吉他，男声",
      instrumental: true,
      status: "success",
      resultRef: "music/song-1.mp3",
      model: { source: "cloud", providerId: "stepfun", model: "step-1" },
    });
    saveCanvasDoc(doc.id, { nodes: [musicNode], connections: [] });

    const loaded = getCanvasDoc(doc.id)!;
    const saved = loaded.payload.nodes[0]!;
    expect(saved.kind).toBe("music");
    expect(saved.instrumental).toBe(true);
    expect(saved.resultRef).toBe("music/song-1.mp3");
    expect(saved.model).toEqual({ source: "cloud", providerId: "stepfun", model: "step-1" });

    // 非音乐节点不该凭空长出 instrumental
    saveCanvasDoc(doc.id, { nodes: [node({ id: "t1" })], connections: [] });
    expect(getCanvasDoc(doc.id)!.payload.nodes[0]!.instrumental).toBeUndefined();
    deleteCanvasDoc(doc.id);
  });
});
