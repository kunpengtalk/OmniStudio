import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 引导页「按机器推荐」的界面回归。
 *
 * 三件事串起来验：首屏把探测到的芯片 / 内存 / 预算摆出来并给一句推荐 → 模型列表按本机
 * 内存标适配级别 → 用户什么都不改直接往下走时，**默认选中的就是推荐的那个模型和量化档**
 * （最后一跳看的是真实的下载计划 repo，不是界面上的徽章）。
 *
 * getSetupEnvironment 是假的（真实探测见 bun/hardware.test.ts）：CI 上没有 Apple 芯片，
 * 界面这一层的用例不该依赖跑测试的那台机器。
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

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { engineInstallSupport } = await import("../../../shared/engines");
const { useEngineInstallStore } = await import("../../stores/engine-install");

/** 16GB 的 Apple 芯片机器：统一内存预算 12GB，llama-server 已安装、没装 mlx-lm。 */
const setupEnv = {
  platform: "darwin",
  arch: "arm64",
  appleSilicon: true,
  hasNvidiaGpu: false,
  hardware: {
    platform: "darwin",
    arch: "arm64",
    chipName: "Apple M3 Pro",
    chipVendor: "apple" as const,
    modelId: "Mac15,7",
    cpuCores: 11,
    cpuThreads: 11,
    gpu: { kind: "apple" as const, name: "Apple M3 Pro", vramBytes: null },
    totalMemoryBytes: 16e9,
    freeMemoryBytes: 6e9,
    budgetBytes: 12e9,
    budgetBasis: "unified" as const,
  },
  // 安装能力用真实判定（平台相关），别在测试里手写一份会漂的
  installSupport: {
    "llama.cpp": engineInstallSupport("llama.cpp", "darwin", "arm64"),
    vllm: engineInstallSupport("vllm", "darwin", "arm64"),
    sglang: engineInstallSupport("sglang", "darwin", "arm64"),
    mlx: engineInstallSupport("mlx", "darwin", "arm64"),
  },
  // 类型放宽：安装完成后这里会被写成版本号（见下面的 mock installInferenceEngine）
  installedVersions: {
    "llama.cpp": null as string | null,
    vllm: null as string | null,
    sglang: null as string | null,
    mlx: null as string | null,
  },
  // installing：主进程正在装的引擎（重载恢复用）
  installing: null as string | null,
  llama: { found: true, path: "/opt/homebrew/bin/llama-server" },
  vllm: { found: false },
  sglang: { found: false },
  mlx: { found: false },
};

/** 下载计划里最终用的仓库：断言它等于"推荐的那个模型 + 档位"。 */
const listedRepos: string[] = [];
/** 一键安装的调用记录。 */
const installCalls: string[] = [];


mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSetupEnvironment: async () => setupEnv,
    installInferenceEngine: async ({ engine }: { engine: string }) => {
      installCalls.push(engine);
      // 真实安装由主进程跑（bun/engine-install.test.ts 覆盖），这里只验界面接线：
      // 装作立刻装好，父组件会去重新检测。
      setupEnv.llama.found = true;
      setupEnv.installedVersions["llama.cpp"] = "b10976";
      return { ok: true, version: "b10976" };
    },
    listInstalledModels: async () => ({ models: [] }),
    listDownloads: async () => ({ tasks: [] }),
    listModelFiles: async ({ repo }: { repo: string }) => {
      listedRepos.push(repo);
      return {
        files: [
          {
            name: "Qwen3.5-9B-Q4_K_M.gguf",
            path: "Qwen3.5-9B-Q4_K_M.gguf",
            size: 5.7e9,
            isLfs: true,
            kind: "gguf" as const,
            isWeight: true,
          },
        ],
      };
    },
    startServer: async () => ({ ok: true }),
    updateSettings: async () => ({ settings: {} }),
  },
}));

const { LocalFlow } = await import("./local-flow");

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

// 断言先失败时 cleanup 不会执行：不清一遍的话，上一个用例的 DOM 会留在 body 里，
// 后面的 clickButton 会点到已经卸载的那棵树上去（报出来的错还与真正的原因无关）。
afterEach(() => {
  document.body.innerHTML = "";
});

async function renderFlow() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(LocalFlow, { onComplete: () => {}, onSwitchToRemote: () => {} }),
      ),
    );
  });
  await settle();
  return {
    text: () => document.body.textContent ?? "",
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 一拍给查询解析，一拍给渲染（硬件信息是异步到位的）。 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickButton(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`找不到按钮：${label}`);
  return act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("首屏把芯片 / 内存 / 推理预算摆出来，并给一句按机器的推荐", async () => {
  const view = await renderFlow();
  const text = view.text();

  expect(text).toContain("Apple M3 Pro");
  expect(text).toContain("11 核");
  expect(text).toContain("16 GB · 当前空闲 6 GB");
  expect(text).toContain("12 GB（统一内存的 75%）");
  expect(text).toContain("内置 GPU · 统一内存，Metal 加速");
  // 16GB 的机器：9B 的 Q4_K_M 约 7.8GB，装着舒服但要退到 Q3 才装得下的 27B / 35B 不推
  expect(text).toContain("推荐 llama-server + Qwen3.5 9B（Q4_K_M · 约占 7.8 GB 内存）");
  await view.cleanup();
});

test("引擎步骤的「推荐」跟着机器走，并说明为什么", async () => {
  const view = await renderFlow();
  await clickButton("Next");

  const text = view.text();
  expect(text).toContain("Apple M3 Pro 的 GPU 走 Metal，装一个二进制就能跑");
  expect(text).toContain("推荐");
  await view.cleanup();
});

test("装了 mlx-lm 的 Apple 芯片：改推 MLX，模型页标出默认的 MLX 模型", async () => {
  setupEnv.mlx.found = true;
  try {
    const view = await renderFlow();
    expect(view.text()).toContain("推荐 MLX + DeepSeek V4.1 Flash (MLX 4/8bit)");

    await clickButton("Next"); // → 引擎
    expect(view.text()).toContain("已装 mlx-lm：Apple 芯片上同一份权重推理更快");

    await clickButton("Next"); // → 模型（MLX 预设）
    expect(view.text()).toContain("DeepSeek V4.1 Flash (MLX 4/8bit)");
    expect(view.text()).toContain("推荐");
    await view.cleanup();
  } finally {
    setupEnv.mlx.found = false;
  }
});

test("模型列表按本机内存标适配级别，超出内存的档位也标出来", async () => {
  const view = await renderFlow();
  await clickButton("Next"); // → 引擎
  await clickButton("Next"); // → 模型

  const text = view.text();
  expect(text).toContain("推理可用预算 12 GB");
  expect(text).toContain("按 8K 上下文");
  expect(text).toContain("本机可用"); // 9B
  expect(text).toContain("超出内存"); // 27B / 35B 在小机器上装不下
  await view.cleanup();
});

test("用户什么都不改时，下载的就是推荐的那个模型与量化档", async () => {
  listedRepos.length = 0;
  const view = await renderFlow();
  await clickButton("Next"); // → 引擎
  await clickButton("Next"); // → 模型
  await clickButton("Next"); // → 启动：解析下载计划
  await settle();

  expect(listedRepos).toEqual(["unsloth/Qwen3.5-9B-GGUF"]);
  // 计划卡片上写的就是这个仓库与这份量化文件
  expect(view.text()).toContain("unsloth/Qwen3.5-9B-GGUF");
  expect(view.text()).toContain("Qwen3.5-9B-Q4_K_M.gguf");
  await view.cleanup();
});

test("引擎没装：按钮就地点「一键安装」，装完自动重新检测并变成就绪", async () => {
  installCalls.length = 0;
  setupEnv.llama.found = false;
  try {
    const view = await renderFlow();
    await clickButton("Next"); // → 引擎

    expect(view.text()).toContain("未就绪");
    expect(view.text()).toContain("一键安装（约 25 MB）");
    // 手动安装作为备选留在旁边（网络受限的机器只给一键这条路也走不通）
    expect(view.text()).toContain("brew install llama.cpp");

    await clickButton("一键安装（约 25 MB）");
    await settle();

    expect(installCalls).toEqual(["llama.cpp"]);
    // 装完重新拉了一次 setup-env：llama.cpp 那一行变成就绪，并带上托管安装的版本号
    const row = document.querySelector('[data-engine="llama.cpp"]')!;
    expect(row.getAttribute("data-engine-ready")).toBe("1");
    expect(row.textContent).toContain("已安装 b10976");
    expect(row.textContent).not.toContain("未就绪");
    await view.cleanup();
  } finally {
    setupEnv.llama.found = true;
    setupEnv.installedVersions["llama.cpp"] = null;
  }
});

test("本平台装不了的引擎：说明原因，不给一个点下去必然失败的按钮", async () => {
  const view = await renderFlow();
  await clickButton("Next"); // → 引擎

  // macOS 上的 vLLM / SGLang：官方只发 Linux 的 CUDA 轮子 —— 给原因，不给按钮
  for (const engine of ["vllm", "sglang"]) {
    const row = document.querySelector(`[data-engine="${engine}"]`)!;
    expect(row.textContent).toContain("官方只发 Linux 的 CUDA 轮子");
    expect(row.querySelector("button")).toBeNull();
  }
  // 同一页上 mlx-lm 是能装的（Apple Silicon）→ 它有按钮，说明不是"整页都没按钮"
  const mlxRow = document.querySelector('[data-engine="mlx"]')!;
  expect(mlxRow.textContent).toContain("一键安装");
  expect(mlxRow.querySelector("button")).not.toBeNull();
  await view.cleanup();
});

test("安装过程中：阶段、进度与实时日志都在界面上", async () => {
  setupEnv.llama.found = false;
  try {
    const view = await renderFlow();
    await clickButton("Next"); // → 引擎

    await act(async () => {
      useEngineInstallStore.getState().setPhase({
        engine: "llama.cpp",
        phase: "downloading",
        message: "下载 llama.cpp（macOS arm64（Metal））",
        percent: 42,
      });
      useEngineInstallStore
        .getState()
        .appendLines(["准备安装 llama.cpp b10976\n", "下载 llama-b10976-bin-macos-arm64.tar.gz\n"]);
    });

    const text = view.text();
    expect(text).toContain("下载 llama.cpp（macOS arm64（Metal））");
    expect(text).toContain("42%");
    expect(text).toContain("查看日志（2）");

    // 终态后进度条退场（不留在界面上让人以为还在装）
    await act(async () => {
      useEngineInstallStore.getState().setPhase({
        engine: "llama.cpp",
        phase: "done",
        message: "安装完成：llama.cpp",
        percent: 100,
      });
    });
    expect(view.text()).not.toContain("下载 llama.cpp（macOS arm64（Metal））");
    await view.cleanup();
  } finally {
    setupEnv.llama.found = true;
    useEngineInstallStore.getState().clear();
  }
});

test("重载之后：主进程说还在装，界面就不能显示成「没在装」", async () => {
  setupEnv.llama.found = false;
  setupEnv.installing = "llama.cpp";
  try {
    const view = await renderFlow();
    await clickButton("Next"); // → 引擎

    // 推送过来的阶段随重载没了，但安装还在跑：这一行仍要有进度提示
    const row = document.querySelector('[data-engine="llama.cpp"]')!;
    expect(row.textContent).toContain("正在安装");
    expect(row.textContent).not.toContain("一键安装");
    await view.cleanup();
  } finally {
    setupEnv.llama.found = true;
    setupEnv.installing = null;
  }
});
