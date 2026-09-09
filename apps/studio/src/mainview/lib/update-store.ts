import { UpdateInfo } from "@/bun/updates";
import { create } from "zustand";

type UpdateStore = {
  updateState: UpdateInfo;
  setUpdateState: (updateState: UpdateInfo) => void;
};

export const useUpdateStore = create<UpdateStore>((set) => ({
  updateState: {
    status: "checking",
    currentVersion: "0.0.0",
  },
  setUpdateState: (updateState) => set({ updateState }),
}));
