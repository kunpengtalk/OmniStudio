/**
 * 用户此刻在看什么 —— webview 回传的「当前会话 + 窗口是否聚焦」。
 *
 * 为什么需要它：后台跑完的回合要不要打扰用户，只能在**回合结束的那一刻**判断，
 * 而那时只有主进程在场（前端切会话、切应用、窗口失焦都不会通知主进程）。
 * 没有这份状态时 `run_finished` 这类通知根本没法发 —— 发了就是"你正盯着看，
 * 它也弹一条"的噪音。
 *
 * 状态很轻：两个字段，webview 每次变化回传一次（`setViewState` RPC）。
 */

/** 当前会话的 id；null = 没在看任何会话（新任务页 / 切到了别的应用页）。 */
let conversationId: number | null = null;
/** 窗口是否聚焦。默认 true：刚启动时用户就在这个窗口上。 */
let focused = true;

export function setViewState(next: { conversationId?: number | null; focused?: boolean }): void {
  // 两个字段都是可选的部分更新：切会话不必重报焦点，反之亦然。
  if (next.conversationId !== undefined) conversationId = next.conversationId;
  if (next.focused !== undefined) focused = next.focused;
}

/**
 * 用户是否正看着这个会话。窗口在后台时一律算「没在看」——
 * 会话虽然还选着，但人已经切到别的应用了，跑完就该提醒。
 */
export function isViewing(id: number): boolean {
  return focused && conversationId === id;
}

/**
 * 回合跑完要不要发通知。
 *
 * 无人值守（自动化 / `omi agent run`）一律发：那本来就没人在看。
 * 交互式只在用户没看着这个会话时发 —— 盯着界面看的时候再弹一条纯属噪音。
 */
export function shouldNotifyTurnEnd(opts: { headless: boolean; conversationId: number }): boolean {
  return opts.headless || !isViewing(opts.conversationId);
}

/** 测试用：回到初始态。 */
export function resetViewState(): void {
  conversationId = null;
  focused = true;
}
