import { create } from "zustand";
import type { ChatPreset, MarketModel } from "../../shared/modelscope";

export type ModelDetailSource =
  | { kind: "preset"; preset: ChatPreset }
  /** 市场检索结果：`model.source` 决定详情页从哪个平台列文件、下载。 */
  | { kind: "search"; model: MarketModel };

type ModelDetailState = {
  source: ModelDetailSource | null;
  setSource: (source: ModelDetailSource | null) => void;
};

export const useModelDetailStore = create<ModelDetailState>((set) => ({
  source: null,
  setSource: (source) => set({ source }),
}));
