import { create } from "zustand";

export type Route =
  | {
      path: "index";
    }
  | {
      path: "settings";
      /** 设置页内目标标签（如 "store" = 模型库）。省略时保持当前标签。 */
      tab?: string;
    }
  | {
      path: "server";
    }
  | {
      path: "stats";
    }
  | {
      path: "model-detail";
    }
  | {
      path: "chat";
    }
  | {
      path: "document";
      id: number;
    };
interface RouterState {
  route: Route;
  setRoute: (route: Route) => void;
}

export const useRouter = create<RouterState>((set) => ({
  route: { path: "chat" },
  setRoute: (route) => set({ route }),
}));
