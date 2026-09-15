import { useEffect } from "react";

import { rpcClient } from "@lib/rpc";
import { useAppStore } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useRouter } from "@stores/router";

/**
 * 把「用户此刻在看什么」回报给主进程：在看哪个会话 + 窗口是否聚焦。
 *
 * 主进程据此决定后台跑完的回合要不要发通知（`run_finished`）—— 这个判断只能在回合
 * 结束那一刻做，而主进程看不到界面状态。四件事都要重报，否则它手里是一份过期状态：
 *   1. 切会话；
 *   2. 切到别的应用页（对话还选着，但人已经去看图片 / 视频了 —— 这时才算"没在看"）；
 *   3. 走进设置 / 模型详情 / 文档这些跨应用页面（同上，会话还在选着但不在眼前）；
 *   4. 窗口失焦 / 回焦（人切到别的应用去了）。
 *
 * 挂载点：应用外壳（`main-layout`），一处就够 —— 它是所有页面的共同祖先。
 */
export function useViewStateReport(): void {
  const activeApp = useAppStore((s) => s.activeApp);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const routePath = useRouter((s) => s.route.path);
  // 只有「对话 / 智能体 + 会话路由」才算在开会话；其它页面一律报 null。
  const onThread =
    (activeApp === "chat" || activeApp === "agent") &&
    (routePath === "chat" || routePath === "index");
  const viewing = onThread ? activeConversationId : null;

  useEffect(() => {
    // 挂载时也报一次：webview 重载（HMR / 刷新）后主进程手里还是旧值。
    void rpcClient
      .setViewState({ conversationId: viewing, focused: document.hasFocus() })
      .catch(() => {});
  }, [viewing]);

  useEffect(() => {
    const report = () => {
      void rpcClient.setViewState({ focused: document.hasFocus() }).catch(() => {});
    };
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, []);
}
