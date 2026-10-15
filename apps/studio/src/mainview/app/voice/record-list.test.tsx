import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 语音侧栏的记录列表。
 *
 * 一行记录在这里同时是两件事：**任务记录**（点开在右侧还原那次任务）和**素材**
 * （试听 / 下载 / 删除）。三件事容易互相踩，所以写成测试钉住：
 *   1. 点整行 → 记下选中的记录 id（右侧据此显示）；
 *   2. 点行里那颗 20px 的播放键**不算**"打开"，选中不能跟着变（录制/合成过的音频，
 *      十有八九只是想听一耳朵）；
 *   3. 删除先弹确认框，删掉的正好是选中那条时选中一起收回；
 *   4. 有音频的行才有下载按钮，走 `saveAudioToFolder`。
 */
const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLAudioElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "SVGElement",
  "DOMRect",
  "CustomElementRegistry",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "InputEvent",
  "MutationObserver",
  "ResizeObserver",
  "NodeFilter",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "matchMedia",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const deleted: number[] = [];
const saved: { url: string; filename: string }[] = [];
let records: unknown[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    listVoiceRecords: async () => ({ records }),
    deleteVoiceRecord: async ({ id }: { id: number }) => {
      deleted.push(id);
      return { ok: true };
    },
    saveAudioToFolder: async (params: { url: string; filename: string }) => {
      saved.push(params);
      return { ok: true, path: `/tmp/Downloads/${params.filename}` };
    },
  },
}));

// 确认框走 Radix Portal（挂到 document.body）。全量跑时同一个进程里有别的测试文件在动
// 全局 document、也有文件先导入了 `react-dom/server`（那之后 createPortal 就不再落 DOM），
// 于是"单跑通过、全量失败"。这里把 Dialog 换成一个内联实现，只保留 open/onOpenChange 语义：
// 要验的是"点垃圾桶先问一句、确认才真删"，不是 Radix 的 portal 实现（那层由
// `components/record-actions.tsx` 的调用方 media-record-lists.test.tsx 覆盖）。
mock.module("@ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: unknown }) =>
    open ? createElement("div", null, children as never) : null,
  DialogContent: ({ children }: { children?: unknown }) =>
    createElement("div", { role: "dialog" }, children as never),
  DialogHeader: ({ children }: { children?: unknown }) => createElement("div", null, children as never),
  DialogTitle: ({ children }: { children?: unknown }) => createElement("h2", null, children as never),
  DialogDescription: ({ children }: { children?: unknown }) =>
    createElement("p", null, children as never),
  DialogFooter: ({ children }: { children?: unknown }) => createElement("div", null, children as never),
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { SidebarProvider } = await import("@ui/sidebar");
const { VoiceRecordList } = await import("./record-list");
const { useVoiceStore } = await import("@stores/voice");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);
const OPEN = zh("voice.records.open");
const PLAY = zh("voice.records.play");
const DOWNLOAD = zh("voice.download");
const DELETE = zh("common.delete");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    kind: "tts",
    status: "done",
    source: "manual",
    model: "edge-tts",
    voice: "zh-CN-XiaoxiaoNeural",
    text: "大家好，这是公众号的第一段语音。",
    audioUrl: "http://127.0.0.1:1/images/audio/tts-1.mp3",
    audioPath: "audio/tts-1.mp3",
    refAudioPath: null,
    durationMs: 1240,
    error: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

async function settle() {
  // useQuery 自己排了一拍调度：微任务不够，得让宏任务也跑一轮。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
  deleted.length = 0;
  saved.length = 0;
  useVoiceStore.setState({ tab: "tts", focusRecordId: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(SidebarProvider, null, createElement(VoiceRecordList))),
      ),
    );
  });
  await settle();
}

const rows = () => [...container.querySelectorAll<HTMLElement>(`[title="${OPEN}"]`)];
const byLabel = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
});

test("点整行 → 选中这条记录（右侧据此还原那次任务）", async () => {
  records = [row({ id: 5 }), row({ id: 6, text: "第二条" })];
  await render();

  expect(rows().length).toBe(2);
  await act(async () => rows()[1]!.click());
  expect(useVoiceStore.getState().focusRecordId).toBe(6);
});

test("点行里的播放键不算打开：选中不变", async () => {
  records = [row({ id: 9 })];
  await render();

  const play = byLabel(PLAY)!;
  expect(play).toBeDefined();
  await act(async () => play.click());
  expect(useVoiceStore.getState().focusRecordId).toBeNull();
});

/**
 * 删除：先弹确认框，确认才真的删。
 * 确认框是内联渲染的（见文件开头对 `@ui/dialog` 的桩），所以它就在本容器里。
 */
test("删除先弹确认框；删的是选中那条时选中一起收回", async () => {
  records = [row({ id: 7 })];
  useVoiceStore.setState({ focusRecordId: 7 });
  await render();

  const trash = container.querySelector<HTMLElement>(`[title="${DELETE}"]`)!;
  expect(trash).toBeDefined();
  act(() => trash.click());
  expect(deleted).toEqual([]);
  expect(container.textContent).toContain(zh("voice.records.deleteTitle"));

  const confirm = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === DELETE,
  )!;
  act(() => confirm.click());
  // 确认后的断言只看 RPC 调用与 store，让出一拍等 mutation 回调。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(deleted).toEqual([7]);
  expect(useVoiceStore.getState().focusRecordId).toBeNull();
});
test("有音频的行能下载，文件名带上模型 / 音色", async () => {
  records = [row({ id: 11, audioUrl: "http://127.0.0.1:1/images/audio/tts-11.mp3" })];
  await render();

  await act(async () => {
    byLabel(DOWNLOAD)!.click();
    await Promise.resolve();
  });

  expect(saved.length).toBe(1);
  expect(saved[0]!.url).toBe("http://127.0.0.1:1/images/audio/tts-11.mp3");
  expect(saved[0]!.filename).toContain("edge-tts");
});

test("失败的记录：没有音频就没有播放键与下载键，错误就地写出来", async () => {
  records = [
    row({ id: 13, status: "failed", audioUrl: null, audioPath: null, error: "上游返回 500" }),
  ];
  await render();

  expect(byLabel(PLAY)).toBeNull();
  expect(byLabel(DOWNLOAD)).toBeNull();
  expect(container.textContent).toContain("上游返回 500");
});
