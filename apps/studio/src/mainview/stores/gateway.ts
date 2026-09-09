import { create } from "zustand";
import type { GatewayStatus } from "../../bun/gateway";

interface GatewayState {
  status: GatewayStatus;
  setStatus: (status: GatewayStatus) => void;
}

export const useGatewayStore = create<GatewayState>((set) => ({
  status: "stopped",
  setStatus: (status) => set({ status }),
}));
