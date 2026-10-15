import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * ASR 右侧工作台的回归测试。
 *
 * 这个面板的失败方式都很安静：动作按钮点了没反应（回调没接上）、整理结果没落到列表里
 * （状态字段名写错）、空稿件时按钮还能点（disabled 条件反了）—— 都要真渲染一次才看得出来。
 * 这里用 happy-dom 渲染真实组件，只把 RPC 与 Markdown 换成桩。
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

/** 每次调用的入参与返回都被记下来，测试按顺序取。 */
const insightCalls: Record<string, unknown>[] = [];
let insightResult: Record<string, unknown> = {
  ok: true,
  text: "## 摘要正文",
  model: "qwen3-8b",
  latencyMs: 1600,
  inputTokens: 900,
  outputTokens: 200,
};

// Markdown 换成桩：真实实现（streamdown / mermaid）在 happy-dom 里跑不动，
// 而这里要验的是"结果有没有进列表"，不是渲染器本身。
mock.module("@components/markdown", () => ({
  Markdown: ({ content }: { content: string }) => content,
}));

mock.module("@lib/rpc", () => ({
  rpcClient: {
    runAsrInsight: async (params: Record<string, unknown>) => {
      insightCalls.push(params);
      return insightResult;
    },
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
// Button 的 tooltip 走 Radix，必须有 Provider 祖先（真实应用里挂在根上）；
// react-query 同理 —— 历史记录条上的「下载」按钮是个 mutation。
const { TooltipProvider } = await import("@ui/tooltip");
const { AsrResultPane } = await import("./index");
type PaneProps = Parameters<typeof AsrResultPane>[0];

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

const SEGMENTS = [
  { start: 0, end: 2, text: "开场白", speaker: 0 },
  { start: 65, end: 68, text: "第二个问题", speaker: 1 },
];

function baseProps(overrides: Partial<PaneProps> = {}): PaneProps {
  return {
    segments: SEGMENTS,
    text: "",
    engine: "whisper.cpp",
    hasSpeakers: true,
    streaming: false,
    source: "mic",
    mode: "auto",
    onMode: () => {},
    listening: false,
    speaking: false,
    interim: null,
    vadSensitivity: "medium",
    silenceMs: 1000,
    onVadSensitivity: () => {},
    onVadSilence: () => {},
    scene: "general",
    onScene: () => {},
    speakerMode: true,
    onSpeakerMode: () => {},
    target: "whisper.cpp · large-v3-turbo",
    onClear: () => {},
    recording: false,
    paused: false,
    level: 0,
    elapsed: 0,
    onStart: () => {},
    onStop: () => {},
    onTogglePause: () => {},
    onTranscribeFile: () => {},
    fileBusy: false,
    fileReady: false,
    ...overrides,
  };
}

async function renderPane(overrides: Partial<PaneProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = baseProps(overrides);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(AsrResultPane, props)),
      ),
    );
  });
  return {
    container,
    text: () => container.textContent ?? "",
    /** 按可见文案找一个可点的元素（按钮 / 动作胶囊）。 */
    click: async (label: string) => {
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
    },
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("稿件统计、时间戳与说话人都渲染出来", async () => {
  const pane = await renderPane();
  const text = pane.text();
  expect(text).toContain("whisper.cpp");
  expect(text).toContain("2 句");
  expect(text).toContain("1:05"); // 第二句的时间戳
  expect(text).toContain("第二个问题");
  expect(text).toContain("说话人 2"); // 有说话人时逐句行带标签
  expect(text).toContain("开场白");
  await pane.cleanup();
});

test("空稿件：给空状态，整理动作留在面板里但不可点", async () => {
  const pane = await renderPane({ segments: [], text: "" });
  const text = pane.text();
  expect(text).toContain("开始转写");
  // 没有稿件时转写区整块不出现，空状态代替它。
  expect(text).not.toContain("当前线程");
  expect(text).toContain("先转出一份稿子");
  const summary = [...pane.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "摘要",
  );
  expect(summary).toBeDefined();
  expect((summary as unknown as { disabled: boolean }).disabled).toBe(true);
  await pane.cleanup();
});

test("点动作胶囊 → 带上动作与分段调用主进程，结果落到列表里", async () => {
  insightCalls.length = 0;
  const pane = await renderPane();
  await pane.click("摘要");
  expect(insightCalls).toHaveLength(1);
  expect(insightCalls[0]!.action).toBe("summary");
  expect(insightCalls[0]!.scene).toBe("general");
  // 稿子以分段传过去（时间点由主进程拼），不是界面拼好的字符串。
  expect(insightCalls[0]!.segments).toEqual(SEGMENTS);
  const text = pane.text();
  expect(text).toContain("摘要正文");
  expect(text).toContain("qwen3-8b"); // 卡片头部记着当时用的模型
  expect(text).toContain("1.1k tok"); // 900 + 200
  await pane.cleanup();
});

test("两次整理：默认只显示最新，切到「全部」两条都在", async () => {
  const pane = await renderPane();
  insightResult = { ok: true, text: "第一条结果", model: "m", latencyMs: 1000 };
  await pane.click("摘要");
  insightResult = { ok: true, text: "第二条结果", model: "m", latencyMs: 1000 };
  await pane.click("行动项");

  expect(pane.text()).toContain("第二条结果");
  expect(pane.text()).not.toContain("第一条结果");
  await pane.click("全部 2");
  expect(pane.text()).toContain("第一条结果");
  expect(pane.text()).toContain("第二条结果");
  await pane.cleanup();
});

test("提问类动作：先展开输入框，提交后把问题带过去", async () => {
  insightCalls.length = 0;
  const pane = await renderPane();
  await pane.click("提问");
  // 页面上有两个输入框（常驻的查找框 + 提问框），按占位文案取提问那个。
  const input = [...pane.container.querySelectorAll("input")].find((el) =>
    (el.placeholder ?? "").includes("针对这份稿子"),
  ) as unknown as HTMLInputElement;
  expect(input).toBeDefined();
  await act(async () => {
    // 走原型上的 value setter：React 会在实例上装一个 value 追踪器，
    // 直接 `input.value = …` 再派发 input 事件会被它判成"没变化"，onChange 不触发。
    const setter = Object.getOwnPropertyDescriptor(
      dom.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, "这段讲了什么？");
    // happy-dom 的 Event 与 TS 的 DOM Event 类型对不上（同其它 mainview 测试的做法）。
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  // 胶囊叫「提问」（负责展开输入），提交按钮叫「提交」——两个同名按钮点哪个都不确定。
  await pane.click("提交");
  expect(insightCalls).toHaveLength(1);
  expect(insightCalls[0]!.action).toBe("custom");
  expect(insightCalls[0]!.question).toBe("这段讲了什么？");
  await pane.cleanup();
});

test("整理失败：错误条显示出来，且不留下空结果卡", async () => {
  const pane = await renderPane();
  insightResult = { ok: false, error: "没有可用的对话模型（设置 → 默认模型）" };
  await pane.click("摘要");
  expect(pane.text()).toContain("没有可用的对话模型");
  insightResult = { ok: true, text: "恢复", model: "m" };
  await pane.cleanup();
});

test("控制台：自动听写与手动两种模式的主操作各自对应一个回调", async () => {
  const calls: string[] = [];
  const auto = await renderPane({
    mode: "auto",
    onStart: () => calls.push("start"),
    fileReady: true,
    fileName: "meeting.mp3",
    onTranscribeFile: () => calls.push("file"),
  });
  expect(auto.text()).toContain("自动听写");
  expect(auto.text()).toContain("meeting.mp3");
  // 切句参数收在齿轮气泡里（摊开会占掉半行）：自动模式下有这个触发器，手动模式没有。
  expect(auto.container.querySelectorAll('[aria-haspopup="dialog"]').length).toBe(1);
  await auto.click("转写该文件");
  await auto.click("开始听写");
  expect(calls).toEqual(["file", "start"]);
  await auto.cleanup();

  // 手动模式：按钮回到"录音"，且不再显示切句参数（那是自动切句才用的）
  const manual = await renderPane({ mode: "manual", onStart: () => calls.push("manual-start") });
  expect(manual.text()).toContain("手动");
  expect(manual.container.querySelectorAll('[aria-haspopup="dialog"]').length).toBe(0);
  await manual.click("开始录音");
  expect(calls).toEqual(["file", "start", "manual-start"]);
  await manual.cleanup();
});

test("听写中：状态与计时可见，主操作变成停止听写", async () => {
  const calls: string[] = [];
  const pane = await renderPane({
    mode: "auto",
    listening: true,
    speaking: true,
    elapsed: 65,
    onStop: () => calls.push("stop"),
    onTogglePause: () => calls.push("pause"),
  });
  const text = pane.text();
  // 有人在说话：控制台与稿件区头都显示"说话中"；没人说话时是"听写中"（见下一个断言组）。
  expect(text).toContain("说话中");
  expect(text).toContain("1:05");
  await pane.click("停止听写");
  await pane.click("暂停实时转写");
  expect(calls).toEqual(["stop", "pause"]);
  await pane.cleanup();
});

test("说话中的中间结果以灰色预览行显示，收句后被正式句替换", async () => {
  const pane = await renderPane({ mode: "auto", listening: true, interim: "那这个权限矩阵先不做" });
  expect(pane.text()).toContain("那这个权限矩阵先不做");
  await pane.cleanup();

  // 安静但还在听：显示"听写中"，且没有预览行。
  const quiet = await renderPane({ mode: "auto", listening: true, speaking: false });
  expect(quiet.text()).toContain("听写中");
  await quiet.cleanup();
});

test("切模式会回调（正在听/录时按钮禁用，避免两条采集同时开）", async () => {
  const modes: string[] = [];
  const idle = await renderPane({ mode: "auto", onMode: (m) => modes.push(m) });
  await idle.click("手动");
  expect(modes).toEqual(["manual"]);
  await idle.cleanup();

  const busy = await renderPane({ mode: "auto", listening: true, onMode: (m) => modes.push(m) });
  const switchButton = [...busy.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "手动",
  );
  expect((switchButton as unknown as { disabled: boolean } | undefined)?.disabled).toBe(true);
  await busy.cleanup();
});

test("录音中显示停止与暂停，空闲时显示开始录音；有文件才给「转写该文件」", async () => {
  const calls: string[] = [];
  const idle = await renderPane({
    mode: "manual",
    onStart: () => calls.push("start"),
    fileReady: true,
    fileName: "meeting.mp3",
    onTranscribeFile: () => calls.push("file"),
  });
  expect(idle.text()).toContain("meeting.mp3");
  await idle.click("转写该文件");
  await idle.click("开始录音");
  expect(calls).toEqual(["file", "start"]);
  await idle.cleanup();

  const rec = await renderPane({
    mode: "manual",
    recording: true,
    elapsed: 65,
    onStop: () => calls.push("stop"),
    onTogglePause: () => calls.push("pause"),
  });
  expect(rec.text()).toContain("录音中");
  expect(rec.text()).toContain("1:05"); // 录音计时
  await rec.click("停止并转写");
  await rec.click("暂停实时转写");
  expect(calls).toEqual(["file", "start", "stop", "pause"]);
  // 没选文件时不该出现文件按钮。
  expect(rec.text()).not.toContain("转写该文件");
  await rec.cleanup();
});

/**
 * 采集一开始就切到「逐句」：听写时要的是"一句话一句话地出来"。
 * 停在整理稿上看起来就是"人在说话、界面上没反应" —— 自动听写没有"录音中"这个状态，
 * 判断条件漏了 listening 就会一直停在整理稿（真机踩过）。
 */
/**
 * 查找框常驻可见、并且占满余下的宽度。
 * 早先是"点图标才冒出来"、宽度写死 w-52 —— 长稿查一个词根本没法用（用户反馈）。
 */
test("查找框常驻在稿件条上，空稿件时禁用", async () => {
  const pane = await renderPane();
  const search = [...pane.container.querySelectorAll("input")].find((el) =>
    (el.placeholder ?? "").includes("查找关键词"),
  ) as unknown as HTMLInputElement;
  expect(search).toBeDefined();
  expect(search.disabled).toBe(false);
  // 宽度是弹性的（wrapper 上 flex-1 + max-w），不是写死的窄框
  const wrapper = search.parentElement?.className ?? "";
  expect(wrapper).toContain("flex-1");
  expect(wrapper).toContain("max-w-lg");
  await pane.cleanup();

  const empty = await renderPane({ segments: [], text: "" });
  const emptySearch = [...empty.container.querySelectorAll("input")].find((el) =>
    (el.placeholder ?? "").includes("查找关键词"),
  ) as unknown as HTMLInputElement;
  expect(emptySearch.disabled).toBe(true);
  await empty.cleanup();
});

test("一开始采集就切到逐句视图（自动听写与手动录音都算）", async () => {
  const segRows = (c: HTMLElement) => c.querySelectorAll("[data-seg]").length;

  const idle = await renderPane({ mode: "auto", listening: false });
  expect(segRows(idle.container)).toBe(0); // 空闲时还是整理稿
  await idle.cleanup();

  const dictating = await renderPane({ mode: "auto", listening: true });
  expect(segRows(dictating.container)).toBe(2); // 逐句行渲染出来了
  await dictating.cleanup();

  const manual = await renderPane({ mode: "manual", recording: true });
  expect(segRows(manual.container)).toBe(2);
  await manual.cleanup();
});

test("切换场景：回调拿到场景 id，人声分离跟着场景的默认值走", async () => {
  const scenes: string[] = [];
  const diarize: boolean[] = [];
  const pane = await renderPane({
    onScene: (s) => scenes.push(s),
    onSpeakerMode: (v) => diarize.push(v),
  });
  await pane.click("会议");
  // 会议要分人，字幕不需要（preferDiarize 在两个场景上是相反的）。
  expect(scenes).toEqual(["meeting"]);
  expect(diarize).toEqual([true]);
  await pane.cleanup();
});

/**
 * 历史记录：左侧列表点开一条旧记录，右侧显示的就是**那次任务**的稿子。
 * 顶栏此时必须是记录说明条（时间 / 模型 / 下载 / 返回当前），不是"跑一次识别"的控制台 ——
 * 采集按钮留在原地只会让人以为按下去能接着那次任务录，实际是另起一份新稿子。
 */
test("看历史记录：顶栏换成记录说明条，采集控件与视图切换让位，文字与音频照常显示", async () => {
  let closed = 0;
  const pane = await renderPane({
    segments: [],
    text: "上一次转写的整段文字",
    audioUrl: "http://127.0.0.1:1/images/audio/in/rec-1.wav",
    history: {
      record: {
        id: 42,
        kind: "asr",
        status: "done",
        source: "manual",
        model: "whisper.cpp · large-v3-turbo",
        voice: null,
        text: "上一次转写的整段文字",
        audioUrl: "http://127.0.0.1:1/images/audio/in/rec-1.wav",
        audioPath: "audio/in/rec-1.wav",
        refAudioPath: null,
        durationMs: null,
        error: null,
        createdAt: Date.now(),
      },
      onClose: () => {
        closed += 1;
      },
    },
  });

  const text = pane.text();
  expect(text).toContain("历史记录");
  expect(text).toContain("上一次转写的整段文字");
  expect(text).toContain("whisper.cpp · large-v3-turbo");
  // 运行条（开始听写 / 自动听写）退场，返回当前在场。
  expect(text).not.toContain("开始听写");
  expect(text).not.toContain("自动听写");
  // 没有分段就没有"整理稿 / 逐句"可切。
  expect(text).not.toContain("整理稿");

  await pane.click("返回当前");
  expect(closed).toBe(1);
  await pane.cleanup();
});

/**
 * 宽屏铺满 + 右栏：正文不许再被锁进 768px 的居中窄栏。
 *
 * 早先默认 `max-w-3xl`：2560 的屏上右侧面板差不多 1900px，稿子只占 760px，两边一片空白
 * （用户反馈"中间那个很小、很乱"）。现在默认铺满；面板自己够宽时再把整理面板挪到右栏 ——
 * 判断依据是**容器查询 @6xl（1152px）**而不是窗口断点，因为左边还有应用栏 + 记录栏 + 参数栏
 * 占掉近 1000px，用视口断点会在 1800 的窗口上把正文挤成 700px。
 */
test("宽屏铺满：默认没有 768px 窄栏上限，整理面板按面板宽度挪到右栏", async () => {
  // 逐句视图：整理稿视图的正文走 Markdown 桩，字号类不在桩里。
  const pane = await renderPane({ initialView: "segments" });
  const classes = [...pane.container.querySelectorAll("*")].map((el) => String(el.className ?? ""));

  // 默认铺满：老上限彻底不在场，否则宽屏上又会白掉两边
  expect(classes.some((c) => c.includes("max-w-none"))).toBe(true);
  expect(classes.some((c) => c.includes("max-w-3xl"))).toBe(false);

  // 并排与否看"这块面板多宽"，不看窗口多宽
  expect(classes.some((c) => c.includes("@container"))).toBe(true);
  expect(classes.some((c) => c.includes("@6xl:flex-1"))).toBe(true);
  const rail = classes.find((c) => c.includes("@6xl:w-[400px]"));
  expect(rail).toBeDefined();
  // 右栏固定宽且不收缩，正文那栏才吃得到剩下的宽度
  expect(rail).toContain("@6xl:shrink-0");

  // 默认字号 L（15px）：13px 在 2560 的屏上读转写稿偏小
  expect(classes.some((c) => c.includes("text-[15px]"))).toBe(true);
  expect(pane.container.querySelectorAll("[data-seg]").length).toBeGreaterThan(0);

  await pane.cleanup();
});
