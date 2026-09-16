import { useAppStore } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useImageStore } from "@stores/image";
import { useVideoStore } from "@stores/video";
import type { PromptRow } from "../../../bun/prompt-library";

export function usePromptNow(item: PromptRow) {
  const prompt = item.prompt || "";
  if (item.kind === "video") {
    useVideoStore.getState().setView("generate");
    useVideoStore.getState().setPendingPrompt(prompt);
    useAppStore.getState().setActiveApp("video");
    return;
  }
  if (item.kind === "image") {
    useImageStore.getState().setTool("generate");
    useImageStore.getState().setPendingPrompt(prompt);
    useAppStore.getState().setActiveApp("image");
  } else {
    useChatStore.getState().setPendingPrompt(prompt);
    useAppStore.getState().setActiveApp("chat");
  }
}

/** 图片/封面：云端直链 → 加载失败时惰性下载到本地缓存 → 渐变占位。 */
