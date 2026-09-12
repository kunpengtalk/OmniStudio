import { create } from "zustand";

import type { MediaSetupPayload } from "../../bun/media-setup";

/**
 * Agent 生图前的「需要用户介入」弹窗状态：payload 由主进程经 `mediaSetup` 消息推来，
 * 用户点确认 / 取消后通过 `rpcClient.resolveMediaSetup` 回传，主进程继续那次工具调用。
 */
type MediaSetupState = {
  request: MediaSetupPayload | null;
  setRequest: (request: MediaSetupPayload | null) => void;
};

export const useMediaSetupStore = create<MediaSetupState>((set) => ({
  request: null,
  setRequest: (request) => set({ request }),
}));
