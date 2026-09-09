import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const win = new Window({ url: "http://localhost/" });
// @ts-ignore
globalThis.window = win;
// @ts-ignore
globalThis.document = win.document;
// @ts-ignore
globalThis.navigator = win.navigator;
// @ts-ignore
globalThis.HTMLElement = win.HTMLElement;
// @ts-ignore
globalThis.Node = win.Node;
// @ts-ignore
globalThis.Element = win.Element;
// @ts-ignore
globalThis.DocumentFragment = win.DocumentFragment;
// @ts-ignore
globalThis.Event = win.Event;
// @ts-ignore
globalThis.PointerEvent = win.PointerEvent;
// @ts-ignore
globalThis.MouseEvent = win.MouseEvent;
// @ts-ignore
globalThis.CustomEvent = win.CustomEvent;
// @ts-ignore
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
// @ts-ignore
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
// @ts-ignore
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
// @ts-ignore
globalThis.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };

mock.module("./src/mainview/lib/rpc.ts", () => ({
  rpcClient: {
    getSettings: async () => ({ configured: true, settings: { UI_LANG: "zh" } }),
    listInstalledModels: async () => ({ models: [] }),
    updateSettings: async () => ({ ok: true }),
    setActiveModel: async () => ({ ok: true }),
    startServer: async () => ({ ok: true }),
    restartServer: async () => ({ ok: true }),
    getLaunchCommand: async () => ({ command: "", engine: "llama.cpp" }),
    listModelScopeFiles: async () => ({ files: [] }),
    startModelDownload: async () => ({ task: {} }),
    searchModelScope: async () => ({ models: [], total: 0 }),
    listChatModels: async () => ({ models: [] }),
  },
}));
const { ErrorBoundary } = await import("@/mainview/components/error-boundary");

function Boom() {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  test("catches a throwing child in a client render", async () => {
    const qc = new QueryClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container);
    root.render(
      <QueryClientProvider client={qc}>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 300));
    const text = container.textContent ?? "";
    expect(text).toContain("界面出现异常");
    expect(text).toContain("boom");
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});
