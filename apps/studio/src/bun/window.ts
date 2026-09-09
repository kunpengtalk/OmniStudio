import { BrowserWindowWithRPC } from "./rpc";

let windowRef: BrowserWindowWithRPC | null = null;

export function setWindowRef(win: BrowserWindowWithRPC) {
  windowRef = win;
}

export function getWindowRef(): BrowserWindowWithRPC {
  return windowRef!;
}
