/**
 * 画布手势的"物理包含"守卫。
 *
 * React 的 Portal 事件**沿组件树冒泡**：Radix 的下拉选项渲染到 `document.body`，
 * 但它的 pointerdown / dblclick 仍会流到节点框与画布容器的处理器上。若照单全收：
 * 节点会 `setPointerCapture` 抢走指针，Radix 的 item 只认自己的 `pointerup`
 * （mouse 型）来提交选择 —— 下拉从此收不到 pointerup，**点选项毫无反应、列表也不关**，
 * 而 store 里那个节点的 model 永远是空（2026-09 的真实故障，数据库里 nodes JSON
 * 的 model 全为 null 是最直接的证据）。
 *
 * 所以每个画布手势入口都要先问一句：事件目标真的在我自己的 DOM 里吗？
 * `currentTarget.contains(target)` 对 Portal 里的元素为 false，正好把浮层事件放行。
 */
export function eventInsideDom(currentTarget: EventTarget | null, target: EventTarget | null): boolean {
  if (!(currentTarget instanceof Node) || !(target instanceof Node)) return false;
  return currentTarget.contains(target);
}
