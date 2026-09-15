import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 「新建知识库」弹窗的回归测试。
 *
 * 曾经的线上白屏：弹窗里的两个下拉各有一个 `SelectItem value=""`（「不使用」），
 * 而 Radix 的 Select 在**关闭**状态下也会把 children 渲染进一个游离的
 * DocumentFragment（为了收集候选项文本），于是 `SelectItem` 一渲染就抛
 * "must have a value prop that is not an empty string"。这个弹窗在侧栏那份实例
 * 位于路由级 ErrorBoundary 之外，抛错直接把整棵树卸载 → 整个窗口白屏。
 *
 * 预填部分（探活门控）锁定四条规格：
 *   1. 探活可达 → 自动选中默认模型（候选外也显示），提交时把模型带给 kbCreate；
 *   2. 探活不可达 → 留空 + hint（含模型名）；未配置 → 与今天一致；
 *   3. 用户主权：任何手动选择（含「不使用」）永不被探活结果覆盖（touched 守卫，
 *      锁 snap-back 回环——v1 用 `!embeddingModel` 当守卫会把「不使用」穿透）；
 *   4. 重开弹窗 → 模型字段重置 + 重新探活 + 再次预填。
 */

// happy-dom 提供真实 DOM（Radix 的 Dialog / Portal 需要），afterAll 还原全局。
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

// RPC 层依赖 Electrobun webview，测试里换成固定实现。
const calls = { embedding: 0, rerank: 0, probe: 0, create: 0 };
/** kbCreate 收到的入参（快照断言用）。 */
const createCalls: Array<{
  name: string;
  embeddingModel?: string;
  rerankModel?: string;
  embedImage?: boolean;
  embedAudio?: boolean;
  embedVideo?: boolean;
}> = [];
/** 当前用例的探活桩：null = 挂起（resolve 存进 pendingProbeResolve，供「结论后到」时序用例）。 */
let probeStub: (() => unknown) | null = null;
/** 当前用例的 kbCreate 失败桩：非 null 时 kbCreate 抛该信息的 Error。 */
let createError: string | null = null;
/** 最近一次挂起探活的 resolve。 */
let pendingProbeResolve: ((value: unknown) => void) | null = null;

mock.module("@lib/rpc", () => ({
  rpcClient: {
    kbDefaultEmbeddingProbe: async () => {
      calls.probe += 1;
      if (probeStub === null) {
        // 挂起：探活在途（结论何时到由用例控制）
        return new Promise((resolve) => {
          pendingProbeResolve = resolve;
        });
      }
      return await probeStub();
    },
    kbEmbeddingModels: async () => {
      calls.embedding += 1;
      return {
        local: ["bge-m3"],
        remote: [],
        service: { base: "http://127.0.0.1:8123", kind: "local" },
        relaxed: false,
      };
    },
    kbRerankModels: async () => {
      calls.rerank += 1;
      return {
        local: ["bge-reranker-v2-m3"],
        remote: [],
        service: { base: "http://127.0.0.1:8123", kind: "local" },
        relaxed: false,
      };
    },
    kbCreate: async (params: { name: string; embeddingModel?: string; rerankModel?: string }) => {
      calls.create += 1;
      createCalls.push(params);
      if (createError !== null) throw new Error(createError);
      return { kb: { id: 1 } };
    },
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { KbCreateDialog } = await import("./index");
const { useKbStore } = await import("@stores/kb");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

beforeEach(() => {
  calls.probe = 0;
  calls.create = 0;
  createCalls.length = 0;
  pendingProbeResolve = null;
  createError = null;
  // 默认「未配置」：既有用例的基线语义（与今天一致 = 不预填、无 hint）
  probeStub = () => ({ configured: false });
});

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

/** 失败用例不再持有 DOM：卸载残留夹具，防孤儿弹窗把后续用例的 querySelector 带偏。 */
afterEach(async () => {
  while (openFixtures.length > 0) {
    const orphan = openFixtures[0]!;
    await orphan.unmount();
  }
});

/** 等探活 / 候选等内存异步链全部落定（几轮宏任务足够，桩全是内存 Promise）。 */
async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 常驻挂载的弹窗夹具：页面文本 / 开关弹窗 / 模拟在下拉里选一项 / 卸载。 */
type DialogFixture = {
  text: () => string;
  open: () => Promise<void>;
  close: () => Promise<void>;
  /** 重新发起探活（invalidate；配合桩=null 控制新一轮探活何时落定）。 */
  reprobe: () => Promise<void>;
  /** 打开嵌入下拉并选中含指定文案的项（模拟用户触碰字段）。 */
  pickEmbed: (label: string) => Promise<void>;
  /** 嵌入选择器触发器当前显示的文本（「不使用」或已选模型名）。 */
  embedTriggerText: () => string;
  errors: unknown[];
  unmount: () => Promise<void>;
};

/** 还未卸载的夹具（失败用例的孤儿弹窗会让后续用例查到上一例的 DOM，见 afterEach）。 */
const openFixtures: DialogFixture[] = [];

async function mountDialog(): Promise<DialogFixture> {
  const errors: unknown[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
    onRecoverableError: (error) => errors.push(error),
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(KbCreateDialog)));
  });

  const text = () => document.body.textContent ?? "";
  const open = async () => {
    await act(async () => {
      useKbStore.getState().setCreateOpen(true);
    });
    await flush();
  };
  const close = async () => {
    await act(async () => {
      useKbStore.getState().setCreateOpen(false);
    });
    await flush();
  };
  const reprobe = async () => {
    await act(async () => {
      // 不等 refetch 完成（新探活挂起时 invalidate 的 promise 不会 resolve）：
      void client.invalidateQueries({ queryKey: ["kb-default-embed-probe"] });
    });
    await flush();
  };
  const embedTriggerText = () => {
    const trigger = document.querySelector("#kb-embed-select");
    return trigger?.textContent ?? "";
  };
  const pickEmbed = async (label: string) => {
    const trigger = document.querySelector("#kb-embed-select") as HTMLButtonElement | null;
    if (!trigger) throw new Error("找不到嵌入下拉触发器");
    // Radix Select 触发器要求 pointerType === "mouse"（且 button 0 / 非 ctrl）才开下拉；
    // happy-dom 的 PointerEvent 默认 pointerType 为空，必须显式传。
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }));
    });
    await flush();
    const items = [...document.querySelectorAll('[role="option"]')];
    const target = items.find((el) => el.textContent?.includes(label));
    if (!target) throw new Error(`下拉里找不到「${label}」（现有：${items.map((i) => i.textContent).join("、")}）`);
    // 选项的 onPointerDown 先记下 pointerType，onPointerUp 才认 mouse 并触发选中。
    await act(async () => {
      target.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }));
      target.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }));
    });
    await flush();
  };
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useKbStore.getState().setCreateOpen(false);
    const idx = openFixtures.indexOf(fx);
    if (idx >= 0) openFixtures.splice(idx, 1);
  };

  const fx: DialogFixture = { text, open, close, reprobe, pickEmbed, embedTriggerText, errors, unmount };
  openFixtures.push(fx);
  return fx;
}

/** 打开弹窗渲染一轮再卸载（旧用例的形状保留：只看「有没有崩 / 文本有什么」）。 */
async function renderCreateDialog(): Promise<{ errors: unknown[]; text: string }> {
  const fx = await mountDialog();
  try {
    await fx.open();
    return { errors: fx.errors, text: fx.text() };
  } finally {
    await fx.unmount();
  }
}

test("新建知识库弹窗打开时不会崩（空选值不能用空字符串）", async () => {
  const { errors, text } = await renderCreateDialog();
  const radixError = errors.find((e) =>
    String(e instanceof Error ? e.message : e).includes("empty string"),
  );
  expect(radixError).toBeUndefined();
  expect(errors).toEqual([]);
  // 弹窗内容真的渲染出来了，且默认「不使用」占位在
  expect(text).toContain(zh("kb.create.title"));
  expect(text).toContain(zh("kb.create.embedding"));
  expect(text).toContain(zh("kb.create.notUse"));
  expect(text).not.toContain("kb.create.");
});

test("打开弹窗就拉嵌入 / 重排模型候选（候选项渲染进 Radix 游离 fragment，不进 DOM）", async () => {
  const fx = await mountDialog();
  calls.embedding = 0;
  calls.rerank = 0;
  await fx.open();
  expect(calls.embedding).toBeGreaterThan(0);
  expect(calls.rerank).toBeGreaterThan(0);
  // 当前值是空串 → 触发器显示哨兵对应的「不使用」，而不是把哨兵漏出来
  expect(fx.text()).toContain(zh("kb.create.notUse"));
  expect(fx.text()).not.toContain("__none__");
  await fx.unmount();
});

// ---------------------------------------------------------------------------
// 预填（探活门控）
// ---------------------------------------------------------------------------

const REACHABLE = () => ({ configured: true as const, reachable: true, model: "wemm-9b", dim: 4096 });
const UNREACHABLE = () => ({
  configured: true as const,
  reachable: false,
  model: "wemm-9b",
  error: "嵌入请求失败（HTTP 503）",
});

test("①探活可达 → 预填默认模型（候选外也显示），提交时带给 kbCreate", async () => {
  probeStub = REACHABLE;
  const fx = await mountDialog();
  await fx.open();
  // wemm-9b 不在候选（local 只有 bge-m3），预填后触发器也要显示它
  expect(fx.embedTriggerText()).toContain("wemm-9b");

  // 填名称并提交：kbCreate 收到预填的模型
  const nameInput = document.querySelector("#kb-name") as HTMLInputElement;
  // React 会跟踪 input.value：必须先走原生 setter，否则 onChange 认为值没变
  const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(nameInput, "预填库");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("kb.create.submit")),
  );
  expect(submit).toBeDefined();
  await act(async () => {
    submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();

  expect(calls.create).toBe(1);
  expect(createCalls[0]).toMatchObject({ name: "预填库", embeddingModel: "wemm-9b" });
  await fx.unmount();
});

test("②已配置但不可达 → 留空 + hint 含模型名", async () => {
  probeStub = UNREACHABLE;
  const fx = await mountDialog();
  await fx.open();
  expect(fx.embedTriggerText()).toContain(zh("kb.create.notUse"));
  const hint = zh("kb.create.embeddingDefaultUnreachable", { model: "wemm-9b" });
  expect(fx.text()).toContain(hint);
  await fx.unmount();
});

test("③未配置 → 无探活 hint、不预填（与今天一致）", async () => {
  probeStub = () => ({ configured: false });
  const fx = await mountDialog();
  await fx.open();
  expect(fx.embedTriggerText()).toContain(zh("kb.create.notUse"));
  // zh 文案的固定前缀不应出现（未配置 = 无探活提示）
  expect(fx.text()).not.toContain("已配置默认嵌入模型");
  await fx.unmount();
});

test("④用户先选 bge-m3，探活返回另一模型 → 不覆盖用户选择", async () => {
  // 探活挂起：用户先动，结论后到
  probeStub = null;
  const fx = await mountDialog();
  await fx.open();
  expect(calls.probe).toBeGreaterThan(0);

  await fx.pickEmbed("bge-m3");
  expect(fx.embedTriggerText()).toContain("bge-m3");

  // 结论此刻才到达：touched 守卫必须否决预填
  await resolveProbeWith(REACHABLE());
  await flush();

  expect(fx.embedTriggerText()).toContain("bge-m3");
  expect(fx.embedTriggerText()).not.toContain("wemm-9b");
  await fx.unmount();
});

/** 让当前挂起的探活 promise 以指定值落定。 */
async function resolveProbeWith(value: unknown) {
  if (!pendingProbeResolve) throw new Error("没有在途的探活 promise");
  await act(async () => {
    pendingProbeResolve!(value);
  });
}

test("⑤snap-back 回归：预填后用户改选「不使用」，新一轮探活可达也不回填", async () => {
  // Radix 受控 Select 对「选中已选中的值」不回调 onValueChange（useControllableState 去重），
  // 所以「显式选不使用」必须发生在值**不是**不使用的时候 —— 先预填，再改选「不使用」。
  probeStub = REACHABLE;
  const fx = await mountDialog();
  await fx.open();
  expect(fx.embedTriggerText()).toContain("wemm-9b");

  // 用户改选「不使用」：值变化 → onValueChange 触发 → touched 置位
  await fx.pickEmbed(zh("kb.create.notUse"));
  expect(fx.embedTriggerText()).toContain(zh("kb.create.notUse"));

  // 新一轮探活再返回可达：touched 守卫必须否决回填（snap-back 回环的回归）
  probeStub = null;
  await fx.reprobe();
  await resolveProbeWith(REACHABLE());
  await flush();

  // touched 守卫生效：可达结论落地也不回填
  expect(fx.embedTriggerText()).toContain(zh("kb.create.notUse"));
  expect(fx.embedTriggerText()).not.toContain("wemm-9b");
  await fx.unmount();
});

test("⑥重开弹窗：模型字段重置 + 重新探活 + 再次预填", async () => {
  probeStub = REACHABLE;
  const fx = await mountDialog();
  await fx.open();
  expect(fx.embedTriggerText()).toContain("wemm-9b");
  const firstProbes = calls.probe;

  // 提交一次（kbCreate 成功后弹窗自动关）
  const nameInput = document.querySelector("#kb-name") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(nameInput, "重开库");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("kb.create.submit")),
  );
  await act(async () => {
    submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(calls.create).toBe(1);

  // 重开：探活重新发起（挂起期间旧值已重置为「不使用」）
  probeStub = null;
  await fx.open();
  expect(calls.probe).toBeGreaterThan(firstProbes);
  expect(fx.embedTriggerText()).toContain(zh("kb.create.notUse"));

  // 探活落定 → 再次预填
  await resolveProbeWith(REACHABLE());
  await flush();
  expect(fx.embedTriggerText()).toContain("wemm-9b");
  await fx.unmount();
});

test("⑦探活 pending：渲染不崩、值为空", async () => {
  probeStub = null; // 永不落定
  const fx = await mountDialog();
  await fx.open();
  expect(fx.errors).toEqual([]);
  expect(fx.embedTriggerText()).toContain(zh("kb.create.notUse"));
  expect(fx.text()).not.toContain("已配置默认嵌入模型");
  await fx.unmount();
});

// ---------------------------------------------------------------------------
// 模态能力三勾选（图片/语音/视频）：默认 false、提交透传、hint 常驻、重开重置
// ---------------------------------------------------------------------------

test("模态三勾选默认 false，勾选后提交原样透传 kbCreate", async () => {
  probeStub = () => ({ configured: false });
  const fx = await mountDialog();
  await fx.open();
  const boxes = () => [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  expect(boxes().length).toBe(3);
  expect(boxes().every((b) => !b.checked)).toBe(true);

  // 勾「图片」「视频」（语音保持 false）→ 提交 → 三布尔原样带出
  await act(async () => {
    boxes()[0]!.click();
    boxes()[2]!.click();
  });
  const nameInput = document.querySelector("#kb-name") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(nameInput, "多模态库");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("kb.create.submit")),
  );
  expect(submit).toBeDefined();
  await act(async () => {
    submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();

  expect(calls.create).toBe(1);
  expect(createCalls[0]).toMatchObject({
    name: "多模态库",
    embedImage: true,
    embedAudio: false,
    embedVideo: true,
  });
  await fx.unmount();
});

test("语音/视频静态 hint 常驻可见；重开弹窗三勾选重置为 false", async () => {
  probeStub = () => ({ configured: false });
  const fx = await mountDialog();
  await fx.open();
  expect(fx.text()).toContain(zh("kb.create.embedLocalOnlyHint"));

  // 勾选后关闭 → 重开：reset-on-open 把三值归零（与模型字段同一 useEffect）
  await act(async () => {
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  });
  await fx.close();
  await fx.open();
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  expect(boxes.length).toBe(3);
  expect(boxes.every((b) => !b.checked)).toBe(true);
  await fx.unmount();
});

// ---------------------------------------------------------------------------
// 创建失败反馈：mutation 曾只有 onSuccess，RPC 拒绝时界面零反馈（线上
// 「点击新建无响应」的直接帮凶 —— 迁移缺列让 kbCreate 必败，而弹窗毫无动静）
// ---------------------------------------------------------------------------

test("kbCreate 失败 → 错误文案可见、弹窗保持打开（不再静默无响应）", async () => {
  probeStub = () => ({ configured: false });
  createError = "no such column: embed_image";
  const fx = await mountDialog();
  await fx.open();

  const nameInput = document.querySelector("#kb-name") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(nameInput, "会失败的库");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("kb.create.submit")),
  );
  expect(submit).toBeDefined();
  await act(async () => {
    submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();

  expect(calls.create).toBe(1);
  // 错误原文案带出来（而不是无声失败），弹窗还开着等用户处置
  expect(fx.text()).toContain(zh("kb.create.error", { message: "no such column: embed_image" }));
  expect(fx.text()).toContain(zh("kb.create.title"));
  await fx.unmount();
});
