import { create } from "zustand";

type Route =
  | {
      path: "index";
    }
  | {
      path: "settings";
    }
  | {
      path: "server";
    }
  | {
      path: "stats";
    }
  | {
      path: "models";
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
