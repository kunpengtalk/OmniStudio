/**
 * 「现在是几点」的唯一来源。
 *
 * 模型自身不知道今天是哪天：不注入的话，涉及「今天 / 最新 / 最近」的问题会按训练数据
 * 里的旧日期回答（报出两年前的股价是典型症状）。对话与 Agent 都要注入这件事，但注入
 * 的**位置**不同 —— 对话放在请求最前面的 system 消息里，Agent 拼在任务描述里。
 *
 * 以前两边各自把 date/time/timeZone 的格式化抄了一遍：同一件事两处实现，改口径
 * （比如换掉 `zh-CN` 的字面格式）时必然漏掉一处，而漏掉的那边只会表现为"偶发答错日期"，
 * 看不出是代码分叉。这里只留「现在是什么时候」，怎么措辞交给各自的调用方。
 */
export type CurrentTime = {
  /** 例：`2026年09月14日星期日`。 */
  date: string;
  /** 例：`19:48`（24 小时制）。 */
  time: string;
  /** IANA 时区名，例：`Asia/Shanghai`。 */
  tz: string;
};

export function currentTime(now: Date = new Date()): CurrentTime {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    date: now.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      timeZone: tz,
    }),
    time: now.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }),
    tz,
  };
}
