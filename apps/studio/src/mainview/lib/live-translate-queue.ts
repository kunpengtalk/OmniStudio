/**
 * 同传「逐段 × 逐语言」翻译的派发计划。
 *
 * 为什么单独抽出来：这段逻辑原先直接写在 effect 里，对 segments × targets 一次性
 * `mutate`，只按 key 去重、**不限制在飞请求数**。10 段 × 5 个目标语言就是 50 个并发请求
 * 同时打向同一个推理服务器（每次调用的超时是 10 分钟），本地模型会被排队拖垮，
 * 界面则表现为"半天不出译文"。
 *
 * 规则（按顺序）：
 *   1. 空段跳过；
 *   2. 原文还在变（锚点不等于当前文本）→ 只回一个"更新锚点"的动作，等下一轮再翻；
 *   3. 已经有译文的语言跳过；
 *   4. 已经在飞的跳过；
 *   5. 剩下的按顺序派发，但**在飞 + 本次派发不超过 `limit`**。
 *
 * 派发完一个请求后组件会因状态更新重新跑一遍，队列于是自然往前走 —— 不需要额外的调度器。
 */

export type LiveTranslatePlan = {
  /** 原文变了：更新锚点并丢弃旧译文，本轮不翻译。 */
  resync: { key: string; text: string }[];
  /** 本轮要发起的翻译（数量受 limit 约束）。 */
  dispatch: { key: string; lang: string; text: string }[];
};

/** 默认在飞上限：本地推理服务器通常只有一个实例，3 个已经足够把流水线填满。 */
export const LIVE_TRANSLATE_CONCURRENCY = 3;

export function planLiveTranslations(input: {
  /** 当前段落（key + 已定稿的原文）。 */
  segments: { key: string; text: string }[];
  targets: string[];
  /** 已有译文：`translations[key][lang]` 非空即视为完成。 */
  translations: Record<string, Record<string, string> | undefined>;
  /** 各段已翻译的原文锚点。 */
  translatedFrom: Record<string, string | undefined>;
  /** 正在飞的请求键（`key|lang`）。 */
  pending: ReadonlySet<string>;
  limit?: number;
}): LiveTranslatePlan {
  const limit = input.limit ?? LIVE_TRANSLATE_CONCURRENCY;
  const plan: LiveTranslatePlan = { resync: [], dispatch: [] };
  if (input.targets.length === 0) return plan;

  // 在飞的先占额度：它们迟早会回来，本轮不要再往上叠。
  let budget = Math.max(0, limit - input.pending.size);

  for (const seg of input.segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const key = seg.key;
    if (input.translatedFrom[key] !== text) {
      plan.resync.push({ key, text });
      continue;
    }
    for (const lang of input.targets) {
      if (input.translations[key]?.[lang]) continue;
      const pid = `${key}|${lang}`;
      if (input.pending.has(pid)) continue;
      if (budget <= 0) return plan;
      plan.dispatch.push({ key, lang, text });
      budget--;
    }
  }
  return plan;
}
