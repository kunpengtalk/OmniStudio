/**
 * 探索打点 / 收网（对齐 oh-my-pi 的 checkpoint · rewind）。
 *
 * 为什么需要：为定位一个问题读十几个文件是常态，但读完之后真正有用的只有三五句结论，
 * 那些中间过程会一直占着窗口 —— 本地 8k 窗口下，一次大范围调研就能把整轮对话挤爆。
 * 打点 → 探索 → `rewind` 交结论 = 把中间过程**整段换掉**。
 *
 * 和摘要式压缩的区别：不走模型、不做概括，留下的就是模型自己写的那份结论，
 * 因此没有"摘要写歪了"的漂移风险。代价是结论的质量取决于模型写得够不够自包含。
 *
 * 这里的 `applyRewind()` 是纯函数（有单测）：它决定"哪一段被结论替换"，一旦切错，
 * 要么把结论之前的任务描述一起吞掉，要么把收网之后的新内容也吞掉 —— 两种都很难被发现。
 */

/**
 * 一次进行中的收网。`cutTo` 在第一次应用时填上（见下）。
 *
 * 收网生效后这个状态**一直留着**（不是一次性的）：它描述的是"这段历史已经被结论替换过"
 * 这个不变事实，每次请求都要照着它重建上下文。因此里面的字段只增不减。
 */
export type RewindState = {
  at: number;
  report: string;
  cutTo: number | null;
  /** 已经往执行轨迹里记过一条了：轨迹是按步插入的，不记这个标志会一步一条重复行。 */
  logged?: boolean;
};

/**
 * 把打点之后的中间过程替换成结论。
 *
 * `at` 是打点那一刻的消息条数。第一次应用时把当时的条数记进 `cutTo`：
 * 之后新增的消息（模型看到结论后继续干的部分）要原样接在结论后面，
 * 否则收网会把收网之后的新内容一起吞掉。
 */
export function applyRewind<T>(messages: T[], rewind: RewindState): T[] {
  if (rewind.cutTo === null) rewind.cutTo = messages.length;
  const head = messages.slice(0, Math.max(0, Math.min(rewind.at, messages.length)));
  const tail = messages.slice(Math.min(rewind.cutTo, messages.length));
  return [...head, rewindReportMessage(rewind.report) as T, ...tail];
}

/** 收网结论替换掉中间过程时，放在上下文里的那条消息。 */
export function rewindReportMessage(report: string): {
  role: "user";
  content: { type: "text"; text: string }[];
  timestamp: number;
} {
  return {
    role: "user",
    content: [{ type: "text", text: rewindReportText(report) }],
    timestamp: Date.now(),
  };
}

/**
 * 必须写明"中间过程已经不在上下文里了"：否则模型会以为自己还能引用刚才读到的某个片段，
 * 然后凭记忆编出一段不存在的代码 —— 这比丢掉上下文更糟。
 */
export function rewindReportText(report: string): string {
  return [
    "（探索收网：你之前打的 checkpoint 已经收在这里。打点之后的查询与工具输出**已从上下文移除**，",
    "只留下下面这份结论。需要重新确认细节时再查一次，不要凭记忆复述。）",
    "",
    report.trim(),
  ].join("\n");
}

/** 打点还开着时的提醒：模型很容易探索完就去干别的，把中间过程一直挂在窗口里。 */
export function checkpointReminderText(goal: string): string {
  return (
    `<system-reminder>探索打点还开着（目标：${goal}）。调研做完后必须调用 rewind 交一份自包含的结论，` +
    "中间过程会被这份结论替换掉。不要留着打点直接结束任务。</system-reminder>"
  );
}
