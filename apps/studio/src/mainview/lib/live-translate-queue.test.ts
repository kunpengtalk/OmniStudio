import { expect, test } from "bun:test";

import { LIVE_TRANSLATE_CONCURRENCY, planLiveTranslations } from "./live-translate-queue";

const seg = (key: string, text: string) => ({ key, text });

test("一次性派发受在飞上限约束（10 段 × 5 语种不再打 50 个并发）", () => {
  const segments = Array.from({ length: 10 }, (_, i) => seg(`s${i}`, `第 ${i} 段`));
  const targets = ["zh-CN", "en", "ja", "ko", "fr"];
  const plan = planLiveTranslations({
    segments,
    targets,
    translations: {},
    translatedFrom: Object.fromEntries(segments.map((s) => [s.key, s.text])),
    pending: new Set(),
  });
  expect(plan.resync).toEqual([]);
  expect(plan.dispatch).toHaveLength(LIVE_TRANSLATE_CONCURRENCY);
  // 按段落顺序派发（先翻早说的那段）
  expect(plan.dispatch.map((d) => `${d.key}|${d.lang}`)).toEqual([
    "s0|zh-CN",
    "s0|en",
    "s0|ja",
  ]);
});

test("在飞的请求占额度：已有 2 个在飞时本轮只再发 1 个", () => {
  const plan = planLiveTranslations({
    segments: [seg("s0", "你好"), seg("s1", "世界")],
    targets: ["en", "ja"],
    translations: {},
    translatedFrom: { s0: "你好", s1: "世界" },
    pending: new Set(["s0|en", "s0|ja"]),
  });
  expect(plan.dispatch.map((d) => `${d.key}|${d.lang}`)).toEqual(["s1|en"]);
});

test("在飞已满时本轮不再派发（不叠加请求）", () => {
  const plan = planLiveTranslations({
    segments: [seg("s0", "你好")],
    targets: ["en"],
    translations: {},
    translatedFrom: { s0: "你好" },
    pending: new Set(["a|en", "b|en", "c|en"]),
  });
  expect(plan.dispatch).toEqual([]);
});

test("原文还在变的段落只更新锚点，本轮不翻", () => {
  const plan = planLiveTranslations({
    segments: [seg("s0", "识别中的半截"), seg("s1", "已定稿")],
    targets: ["en"],
    translations: {},
    translatedFrom: { s0: "上一轮的文本", s1: "已定稿" },
    pending: new Set(),
  });
  expect(plan.resync).toEqual([{ key: "s0", text: "识别中的半截" }]);
  expect(plan.dispatch.map((d) => d.key)).toEqual(["s1"]);
});

test("已有译文 / 空段跳过", () => {
  const plan = planLiveTranslations({
    segments: [seg("s0", "你好"), seg("s1", "   "), seg("s2", "世界")],
    targets: ["en", "ja"],
    translations: { s0: { en: "hello" }, s2: { en: "world", ja: "世界" } },
    translatedFrom: { s0: "你好", s1: "   ", s2: "世界" },
    pending: new Set(),
  });
  expect(plan.dispatch.map((d) => `${d.key}|${d.lang}`)).toEqual(["s0|ja"]);
});

test("没有目标语言时不派发任何请求", () => {
  const plan = planLiveTranslations({
    segments: [seg("s0", "你好")],
    targets: [],
    translations: {},
    translatedFrom: { s0: "你好" },
    pending: new Set(),
  });
  expect(plan.dispatch).toEqual([]);
  expect(plan.resync).toEqual([]);
});
