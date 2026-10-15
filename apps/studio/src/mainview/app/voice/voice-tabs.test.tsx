import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 左侧历史记录 → 右侧工作台的这条链路。
 *
 * 中间隔着 store、query 和标签页三层，任何一层断了都是"点了没反应"：左侧点了高亮、
 * 右边还是空工作台（或者反过来——右侧显示的是刚刚合成的那份，不是点开的那条）。
 * 所以这里直接渲染真的 `AsrTab` / `TtsTab`，只把 rpc 换成桩：
 *   1. 点开一条 ASR 记录 → 右侧是那条记录的稿子，采集控件让位；
 *   2. 点开一条 TTS 记录 → 右侧是那条记录的音频 + 说明条，「填入文案」把原文送回输入框；
 *   3. 「返回当前」把选中收回去。
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
  "HTMLTextAreaElement",
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

let records: Record<string, unknown>[] = [];

// 标签页会拉一堆引擎 / 模型列表：一律回空结果，这里看的是"选中哪条记录"。
mock.module("@lib/rpc", () => ({
  rpcClient: {
    listVoiceRecords: async (params?: { kind?: string }) => ({
      records: params?.kind ? records.filter((r) => r.kind === params.kind) : records,
    }),
    listVoiceClones: async () => ({ clones: [] }),
    listEdgeVoices: async () => ({ voices: [] }),
    listAsrModels: async () => ({ models: [] }),
    listAsrAudioCppModels: async () => ({ models: [] }),
    listAsrConfuciusModels: async () => ({ models: [] }),
    listTtsLocalModels: async () => ({ models: [] }),
    getAsrStatus: async () => ({ serverRunning: false }),
    getAsrAudioCppStatus: async () => ({ active: false }),
    getAsrConfuciusStatus: async () => ({ serverRunning: false }),
    getTtsLocalStatus: async () => ({ active: false }),
    getASRProviderConfig: async () => ({ config: { providerId: "", model: "" } }),
    getTTSProviderConfig: async () => ({ config: { providerId: "", model: "" } }),
    getSettings: async () => ({ settings: {} }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { AsrTab } = await import("./asr-tab");
const { TtsTab } = await import("./tts-tab");
const { useVoiceStore } = await import("@stores/voice");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

function record(overrides: Record<string, unknown>) {
  return {
    id: 1,
    kind: "tts",
    status: "done",
    source: "manual",
    model: "edge-tts",
    voice: "zh-CN-XiaoxiaoNeural",
    text: "",
    audioUrl: "http://127.0.0.1:1/images/audio/demo.mp3",
    audioPath: "audio/demo.mp3",
    refAudioPath: null,
    durationMs: null,
    error: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
  records = [];
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

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, element),
      ),
    );
  });
  // 记录是 useQuery 拉的：微任务不够，让宏任务也跑一轮。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const text = () => container.textContent ?? "";

async function click(label: string) {
  const el = [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (!el) throw new Error(`找不到可点元素：${label}`);
  await act(async () => {
    (el as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
});

test("点开一条 ASR 记录：右侧是那条记录的稿子，采集控件让位", async () => {
  records = [
    record({
      id: 41,
      kind: "asr",
      model: "whisper.cpp · large-v3-turbo",
      voice: null,
      text: "上一次转写的整段文字：账号体系接完了，共享提示词库也做完了。",
      audioPath: "audio/in/rec-41.wav",
    }),
  ];
  useVoiceStore.setState({ tab: "asr", focusRecordId: 41 });

  await render(createElement(AsrTab));

  expect(text()).toContain(zh("voice.records.history"));
  expect(text()).toContain("上一次转写的整段文字");
  expect(text()).toContain("whisper.cpp · large-v3-turbo");
  // 顶栏换成记录说明条：采集按钮此刻按下去是另起一份稿子，不该留在原位。
  expect(text()).not.toContain(zh("voice.asr.dictationStart"));

  await click(zh("voice.records.backToCurrent"));
  expect(useVoiceStore.getState().focusRecordId).toBeNull();
});

test("点开一条 TTS 记录：右侧是那条记录的音频，「填入文案」把原文送回输入框", async () => {
  records = [
    record({
      id: 31,
      model: "stepaudio-3-tts-max",
      voice: "cixingnansheng",
      text: "鲲鹏Talk 是一档把前沿 AI 讲成人话的栏目。",
    }),
  ];
  useVoiceStore.setState({ tab: "tts", focusRecordId: 31 });

  await render(createElement(TtsTab));

  expect(text()).toContain(zh("voice.records.history"));
  expect(text()).toContain("stepaudio-3-tts-max");
  expect(text()).not.toContain(zh("voice.tts.noResult"));

  await click(zh("voice.records.reuse"));
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
  expect(textarea?.value).toBe("鲲鹏Talk 是一档把前沿 AI 讲成人话的栏目。");

  // 「返回当前」回到刚合成的那份（这里还没合成过，所以是空状态）。
  await click(zh("voice.records.backToCurrent"));
  expect(useVoiceStore.getState().focusRecordId).toBeNull();
});

test("没有选中记录时右侧照旧显示当前成果（历史只在点开时才接管）", async () => {
  records = [record({ id: 31, text: "历史里的文案" })];
  useVoiceStore.setState({ tab: "tts", focusRecordId: null });

  await render(createElement(TtsTab));

  expect(text()).not.toContain(zh("voice.records.history"));
  expect(text()).not.toContain("历史里的文案");
  expect(text()).toContain(zh("voice.tts.noResult"));
});
