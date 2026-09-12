import { describe, expect, test } from "bun:test";

import { KbSearchIndex, type IndexableChunk } from "./kb-index";

/** 造一个分块：docName 固定成不会与查询词撞车的值，避免干扰断言。 */
function chunk(id: number, content: string, extra: Partial<IndexableChunk> = {}): IndexableChunk {
  return {
    id,
    docId: extra.docId ?? 1,
    seq: extra.seq ?? id,
    content,
    headingPath: extra.headingPath ?? null,
    docName: extra.docName ?? "D",
    embedding: extra.embedding ?? null,
  };
}

function ids(ranked: { id: number }[]): number[] {
  return ranked.map((r) => r.id);
}

describe("KbSearchIndex 关键词侧", () => {
  test("只召回含查询词的分块", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "退款政策：七天内可申请无理由退款"));
    index.addChunk(chunk(2, "保修条款：整机保修一年"));
    expect(ids(index.bm25Rank("退款", 10))).toEqual([1]);
    expect(ids(index.bm25Rank("保修", 10))).toEqual([2]);
    expect(index.bm25Rank("完全无关的词", 10)).toHaveLength(0);
  });

  test("多子句查询：命中任一词都能排上来", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "部署说明：使用 bun 安装依赖"));
    index.addChunk(chunk(2, "部署说明：仅使用 npm"));
    const ranked = index.bm25Rank("bun npm", 10);
    expect(ids(ranked).sort()).toEqual([1, 2]);
  });

  test("标题路径参与加权：正文没写、标题写了也能命中", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "此处只有一段描述性文字，没有任何主题词", { headingPath: "退款政策" }));
    index.addChunk(chunk(2, "退款政策相关的一般性说明", { headingPath: null }));
    const ranked = index.bm25Rank("退款政策", 10);
    expect(ranked.length).toBeGreaterThan(0);
    // 两者都命中，但标题命中拿到加权，排在前面
    expect(ranked[0]!.id).toBe(1);
  });

  test("删除分块后不再被召回（墓碑 + 压缩路径都正确）", () => {
    const index = new KbSearchIndex();
    for (let i = 1; i <= 40; i++) index.addChunk(chunk(i, `第 ${i} 条：退款说明`, { docId: i }));
    expect(ids(index.bm25Rank("退款", 100)).length).toBe(40);
    for (let i = 1; i <= 39; i++) index.removeChunk(i);
    expect(ids(index.bm25Rank("退款", 100))).toEqual([40]);
    // 触发压缩阈值后仍正确
    for (let i = 41; i <= 200; i++) index.addChunk(chunk(i, `第 ${i} 条：退款说明`, { docId: i }));
    for (let i = 41; i <= 190; i++) index.removeChunk(i);
    expect(ids(index.bm25Rank("退款", 100)).sort((a, b) => a - b)).toEqual([40, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200]);
  });

  test("removeDoc 清掉整篇文档", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "退款说明 A", { docId: 7 }));
    index.addChunk(chunk(2, "退款说明 B", { docId: 7 }));
    index.addChunk(chunk(3, "退款说明 C", { docId: 8 }));
    index.removeDoc(7);
    expect(index.size).toBe(1);
    expect(ids(index.bm25Rank("退款", 10))).toEqual([3]);
  });

  test("replaceDoc 换成新分块", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "旧内容：退款", { docId: 3, seq: 1 }));
    index.replaceDoc(3, [chunk(9, "新内容：换货", { docId: 3, seq: 1 })]);
    expect(index.bm25Rank("退款", 10)).toHaveLength(0);
    expect(ids(index.bm25Rank("换货", 10))).toEqual([9]);
  });

  test("同一分块重复加入不会重复计数", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "退款说明"));
    const first = index.bm25Rank("退款", 10);
    index.addChunk(chunk(1, "退款说明"));
    const second = index.bm25Rank("退款", 10);
    expect(index.size).toBe(1);
    expect(second[0]!.score).toBeCloseTo(first[0]!.score, 10);
  });
});

describe("KbSearchIndex 向量侧", () => {
  const vec = (...values: number[]) => new Float32Array(values);

  test("余弦排序：点积越大越靠前（向量已归一化）", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "分块一", { embedding: vec(1, 0, 0) }));
    index.addChunk(chunk(2, "分块二", { embedding: vec(0.9, 0.1, 0) }));
    index.addChunk(chunk(3, "分块三", { embedding: vec(0, 1, 0) }));
    const ranked = index.vectorRank(vec(1, 0, 0), 10);
    expect(ids(ranked)).toEqual([1, 2, 3]);
    expect(ranked[0]!.score).toBeCloseTo(1, 6);
  });

  test("查询向量维度不符时返回空（不静默算错）", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "分块", { embedding: vec(1, 0, 0) }));
    expect(index.vectorRank(vec(1, 0), 10)).toHaveLength(0);
  });

  test("维度不一致的向量被忽略", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "分块一", { embedding: vec(1, 0, 0) }));
    index.addChunk(chunk(2, "分块二", { embedding: vec(1, 0) }));
    expect(index.vectorCount).toBe(1);
  });

  test("后补向量（补齐向量路径）能被检索到", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "分块一"));
    index.addChunk(chunk(2, "分块二", { embedding: vec(0, 1) }));
    expect(index.vectorCount).toBe(1);
    index.setVector(1, vec(1, 0));
    expect(index.vectorCount).toBe(2);
    // 查询向量与 1 完全同向、与 2 正交：1 必须排在最前
    expect(ids(index.vectorRank(vec(1, 0), 5))[0]).toBe(1);
    expect(ids(index.vectorRank(vec(1, 0), 5, 0.5))).toEqual([1]);
  });

  test("删除分块同时释放向量槽位", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "一", { embedding: vec(1, 0) }));
    index.addChunk(chunk(2, "二", { embedding: vec(0, 1) }));
    index.addChunk(chunk(3, "三", { embedding: vec(1, 1) }));
    index.removeChunk(1);
    expect(index.vectorCount).toBe(2);
    const ranked = index.vectorRank(vec(1, 0), 5);
    expect(ids(ranked).sort()).toEqual([2, 3]);
    // 槽位交换后 id 映射仍正确
    expect(ids(index.vectorRank(vec(0, 1), 1))).toEqual([2]);
  });

  test("零向量不入索引", () => {
    const index = new KbSearchIndex();
    index.addChunk(chunk(1, "一", { embedding: vec(0, 0, 0) }));
    expect(index.vectorCount).toBe(0);
  });
});
