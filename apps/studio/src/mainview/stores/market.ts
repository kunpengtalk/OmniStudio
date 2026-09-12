import { create } from "zustand";
import type { ModelSource, SearchFormat } from "../../shared/modelscope";

/** 格式筛选：跟随当前引擎（默认）/ 全部 / 指定格式。 */
export type MarketFormatFilter = "auto" | "all" | SearchFormat;

type MarketState = {
  /** 检索平台：打到 ModelScope 还是 Hugging Face。 */
  source: ModelSource;
  format: MarketFormatFilter;
  setSource: (source: ModelSource) => void;
  setFormat: (format: MarketFormatFilter) => void;
};

/**
 * 在线模型市场的检索偏好。放在 store 里而不是组件 state：
 * 打开某个模型的详情页再返回时，平台/格式/关键词都还在。
 */
export const useMarketStore = create<MarketState>((set) => ({
  source: "modelscope",
  format: "auto",
  setSource: (source) => set({ source }),
  setFormat: (format) => set({ format }),
}));
