import { describe, expect, test } from "bun:test";

import { bm25Rank, buildBm25Index, normalizeText, tokenContainment, tokenSet, tokenize } from "./text-search";

describe("tokenize", () => {
  test("拉丁与数字按词元切分并小写", () => {
    expect(tokenize("Deploy with Bun 1.2")).toEqual(["deploy", "with", "bun", "1", "2"]);
  });

  test("CJK 按二元组切分（单字退化为单字）", () => {
    expect(tokenize("部署")).toEqual(["部署"]);
    expect(tokenize("部署流程")).toEqual(["部署", "署流", "流程"]);
    expect(tokenize("好")).toEqual(["好"]);
  });

  test("中英混排各自切分", () => {
    expect(tokenize("用 bun 部署")).toEqual(["bun", "用", "部署"]);
  });
});

describe("normalizeText", () => {
  test("去掉标点空白与全角差异", () => {
    expect(normalizeText("用户偏好：中文，简洁。")).toBe("用户偏好中文简洁");
    expect(normalizeText("API  KEY = abc")).toBe("apikeyabc");
  });
});

describe("tokenContainment", () => {
  test("子集被完全包含时为 1", () => {
    expect(tokenContainment(tokenSet("中文"), tokenSet("用户偏好中文回复"))).toBe(1);
  });

  test("完全不相干为 0", () => {
    expect(tokenContainment(tokenSet("部署流程"), tokenSet("今天天气"))).toBe(0);
  });

  test("部分重叠落在 0..1 之间", () => {
    const v = tokenContainment(tokenSet("用户偏好简洁的中文回复"), tokenSet("用户偏好简洁的英文回复"));
    expect(v).toBeGreaterThan(0.5);
    expect(v).toBeLessThan(1);
  });

  test("空集合不判重（返回 0）", () => {
    expect(tokenContainment(new Set(), tokenSet("任意"))).toBe(0);
  });
});

describe("bm25Rank", () => {
  const index = buildBm25Index([
    { id: 1, text: "项目用 bun workspace 管理依赖", tags: ["build"] },
    { id: 2, text: "部署走 bun，不用 npm", tags: ["部署"] },
    { id: 3, text: "用户偏好简洁的中文回复", tags: ["偏好", "语言"] },
    { id: 4, text: "服务器在东京，延迟 30ms" },
  ]);

  test("命中正文的相关记忆全部召回", () => {
    const hits = bm25Rank(index, "bun", 10);
    expect(hits.map((h) => h.id).sort()).toEqual([1, 2]);
  });

  test("词频更高者排在前面", () => {
    const weighted = buildBm25Index([
      { id: 1, text: "部署脚本在 scripts 里" },
      { id: 2, text: "部署部署：部署流程与部署检查清单" },
    ]);
    expect(bm25Rank(weighted, "部署", 10).map((h) => h.id)).toEqual([2, 1]);
  });

  test("CJK 二元组匹配子串", () => {
    const hits = bm25Rank(index, "部署流程", 10);
    expect(hits.map((h) => h.id)).toContain(2);
  });

  test("标签命中加权：主题词优于正文偶现", () => {
    // 「偏好」只出现在 3 的正文与标签里，而「语言」只在标签里 —— 两者都应命中 3。
    const tagOnly = bm25Rank(index, "语言", 10);
    expect(tagOnly.map((h) => h.id)).toEqual([3]);
  });

  test("多子句取并集：任一子句命中即可召回", () => {
    const hits = bm25Rank(index, "东京 npm", 10);
    expect(hits.map((h) => h.id).sort()).toEqual([2, 4]);
  });

  test("无命中返回空数组", () => {
    expect(bm25Rank(index, "量子纠缠", 10)).toEqual([]);
  });

  test("空查询返回空数组", () => {
    expect(bm25Rank(index, "   ", 10)).toEqual([]);
  });

  test("按 limit 截断", () => {
    expect(bm25Rank(index, "bun", 1)).toHaveLength(1);
  });

  test("空索引不报错", () => {
    const empty = buildBm25Index([]);
    expect(bm25Rank(empty, "任意", 5)).toEqual([]);
  });
});
