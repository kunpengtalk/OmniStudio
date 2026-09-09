import { create } from "zustand";
import type { ChatPreset, ModelScopeModel } from "../../shared/modelscope";

export type ModelDetailSource =
  | { kind: "preset"; preset: ChatPreset }
  | { kind: "search"; model: ModelScopeModel };

type ModelDetailState = {
  source: ModelDetailSource | null;
  setSource: (source: ModelDetailSource | null) => void;
};

export const useModelDetailStore = create<ModelDetailState>((set) => ({
  source: null,
  setSource: (source) => set({ source }),
}));
