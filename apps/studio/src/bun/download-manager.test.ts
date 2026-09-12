import { afterAll, expect, mock, test } from "bun:test";

/**
 * 下载队列的排序行为：小文件先下、显式点击插队、失败自动重试后才判死、
 * 老版本持久化的任务恢复后仍按体积重排。
 *
 * 只桩掉数据库设置与文件层（不联网、不碰用户数据目录），队列与状态机用的是
 * 下载管理器自己的实现。
 */

const settings = new Map<string, string>();
mock.module("./db/settings", () => ({
  getSetting: (key: string) => settings.get(key) ?? null,
  updateSettings: (patch: Record<string, string>) => {
    for (const [k, v] of Object.entries(patch)) settings.set(k, v);
  },
}));

mock.module("./model-store", () => ({
  setModelMeta: () => {},
}));

/** 磁盘上「已有数据」的文件名（决定恢复任务时是续传还是判失败）。 */
const existing = new Set<string>();
/** 前 N 次下载调用抛错（模拟 ModelScope 偶发 500）。 */
let failFirst = 0;
/** 已启动的下载（按启动顺序），每个都闸住直到测试放行。 */
const started: string[] = [];
let gates: Array<() => void> = [];

mock.module("./modelscope", () => ({
  modelDestPath: (repo: string, fileName: string) => `models/${repo.replace("/", "__")}/${fileName}`,
  removePartialFiles: () => {},
  partialBytesFor: () => 0,
  downloadFile: async (_repo: string, fileName: string) => {
    if (failFirst > 0) {
      failFirst -= 1;
      throw new Error("Download failed: 500");
    }
    const gate = new Promise<void>((resolve) => gates.push(resolve));
    started.push(fileName);
    await gate;
    return { path: `models/${fileName}`, size: 1 };
  },
  downloadHuggingFaceFile: async (_repo: string, fileName: string) => {
    const gate = new Promise<void>((resolve) => gates.push(resolve));
    started.push(fileName);
    await gate;
    return { path: `models/${fileName}`, size: 1 };
  },
}));

// 「磁盘上有没有部分数据」由 existsSync/statSync 决定，这里只认 existing 集合。
mock.module("fs", () => {
  const real = require("fs") as typeof import("fs");
  const fileNameOf = (p: unknown) => String(p).split("/").pop() ?? "";
  return {
    ...real,
    existsSync: (p: import("fs").PathLike) => existing.has(fileNameOf(p)) || real.existsSync(p),
    statSync: (p: import("fs").PathLike, ...rest: unknown[]) => {
      const name = fileNameOf(p);
      if (existing.has(name)) {
        return { size: 1024, isFile: () => true, isDirectory: () => false } as unknown as ReturnType<
          typeof real.statSync
        >;
      }
      return real.statSync(p, ...(rest as []));
    },
    readdirSync: (p: import("fs").PathLike, ...rest: unknown[]) => {
      const realEntries = real.existsSync(p) ? real.readdirSync(p, ...(rest as [])) : [];
      return [...realEntries, ...existing];
    },
  };
});

const { DownloadManager } = await import("./download-manager");

afterAll(() => {
  for (const release of gates) release();
});

function reset(seedFiles: string[] = [], failures = 0) {
  existing.clear();
  for (const name of seedFiles) existing.add(name);
  failFirst = failures;
  started.length = 0;
  gates = [];
}

async function waitFor(
  dm: InstanceType<typeof DownloadManager>,
  id: string,
  predicate: (task: import("./download-manager").DownloadTask) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = dm.list().find((t) => t.id === id);
  while (Date.now() < deadline) {
    last = dm.list().find((t) => t.id === id);
    if (last && predicate(last)) return { ...last };
    await Bun.sleep(10);
  }
  return last;
}

/** 等到至少 n 个下载被启动。 */
async function waitForCount(list: string[], n: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (list.length < n && Date.now() < deadline) await Bun.sleep(10);
}

/** 放掉被闸住的下载，等调度器把下一批跑起来。 */
async function releaseAll() {
  const pending = gates;
  gates = [];
  for (const release of pending) release();
  await Bun.sleep(30);
}

test("批量入队按体积升序出队：小文件先下，大权重排最后", async () => {
  reset();
  const dm = new DownloadManager();
  const repo = "some/repo";
  // 故意按「大 → 小」入队（市场列表就是权重优先、体积降序）。
  dm.start(repo, "model-00002-of-00002.safetensors", "chat", "modelscope", { size: 4_000_000_000 });
  dm.start(repo, "model-00001-of-00002.safetensors", "chat", "modelscope", { size: 3_000_000_000 });
  dm.start(repo, "tokenizer.json", "chat", "modelscope", { size: 1_800_000 });
  dm.start(repo, "config.json", "chat", "modelscope", { size: 900 });
  dm.start(repo, "model.safetensors.index.json", "chat", "modelscope", { size: 24_000 });

  await Bun.sleep(30);
  // 并发上限 2：先跑的必须是最小的两个。
  expect(started).toEqual(["config.json", "model.safetensors.index.json"]);

  await releaseAll();
  await waitForCount(started, 3);
  expect(started.slice(0, 3).sort()).toEqual([
    "config.json",
    "model.safetensors.index.json",
    "tokenizer.json",
  ]);

  await releaseAll();
  await releaseAll();
  await waitForCount(started, 5);
  expect(started.slice(3).sort()).toEqual([
    "model-00001-of-00002.safetensors",
    "model-00002-of-00002.safetensors",
  ]);

  await releaseAll();
});

test("显式点击的任务插队，优先于批量小文件", async () => {
  reset();
  const dm = new DownloadManager();
  const repo = "some/repo";
  // 批量：最小的先跑，大文件一个跑一个排队。
  dm.start(repo, "big-a.safetensors", "chat", "modelscope", { size: 8_000_000_000 });
  dm.start(repo, "big-b.safetensors", "chat", "modelscope", { size: 7_000_000_000 });
  dm.start(repo, "small.json", "chat", "modelscope", { size: 100 });
  await waitForCount(started, 2);
  expect(started.slice().sort()).toEqual(["big-b.safetensors", "small.json"]);
  expect(dm.list().find((t) => t.fileName === "big-a.safetensors")?.status).toBe("queued");

  // 用户单独点了这个文件 → 它要排在 small.json 前面（哪怕体积大得多）。
  dm.start(repo, "user-pick.gguf", "chat", "modelscope", {
    size: 9_000_000_000,
    explicit: true,
  });

  await releaseAll();
  // 释放一个并发位后，下一个启动的必须是用户点的那个。
  expect(started[2]).toBe("user-pick.gguf");
  await releaseAll();
  await releaseAll();
});

test("下载失败会自动重试，重试成功则不标记失败", async () => {
  reset([], 1); // 第一次调用失败
  const dm = new DownloadManager();
  const task = dm.start("some/repo", "retry.bin", "chat", "modelscope", { size: 512 });

  // 第一次失败后排入重试（带次数与提示），不是直接 failed。
  const afterFail = await waitFor(dm, task.id, (t) => (t.retries ?? 0) >= 1);
  // 已经排入重试（可能已经重新在下了），关键是没被判死、并保留了重试次数与提示。
  expect(afterFail?.status).not.toBe("failed");
  expect(afterFail?.retries).toBe(1);
  expect(afterFail?.error).toContain("自动重试");

  // 退避 3s 后自动重来一次；这次服务端正常，放行后应圆满完成。
  await waitForCount(started, 1, 6_000);
  await releaseAll();
  const done = await waitFor(dm, task.id, (t) => t.status === "completed", 3_000);
  expect(done?.status).toBe("completed");
  expect(done?.retries).toBe(0);
  expect(done?.error).toBeUndefined();
}, 15_000);

test("老版本持久化的任务（没有 order/size）恢复后按体积续传", async () => {
  settings.set(
    "MODEL_DOWNLOADS",
    JSON.stringify([
      {
        id: "old-big",
        repo: "some/repo",
        fileName: "old-big.safetensors",
        source: "modelscope",
        status: "paused",
        received: 10,
        total: 9_000,
        percent: 1,
        speed: 0,
        createdAt: 1,
      },
      {
        id: "old-small",
        repo: "some/repo",
        fileName: "old-small.json",
        source: "modelscope",
        status: "paused",
        received: 1,
        total: 12,
        percent: 5,
        speed: 0,
        createdAt: 2,
      },
    ]),
  );
  // 这两个文件磁盘上都还有部分数据 → 恢复成 queued 续传。
  reset(["old-big.safetensors", "old-small.json"]);
  const dm = new DownloadManager();

  const big = dm.list().find((t) => t.id === "old-big");
  const small = dm.list().find((t) => t.id === "old-small");
  // 恢复出来的任务会立刻开始跑（下载被闸住 → 停在 downloading），两者都能续传。
  expect(big?.status === "queued" || big?.status === "downloading").toBe(true);
  expect(small?.status === "queued" || small?.status === "downloading").toBe(true);
  // 老任务缺 size：用已探测的 total 兜底，保证排序仍然正确。
  expect(big?.size).toBe(9_000);
  expect(small?.size).toBe(12);
  expect(typeof big?.order).toBe("number");

  await Bun.sleep(30);
  expect(started).toEqual(["old-small.json", "old-big.safetensors"]);
  await releaseAll();
});

test("重试用尽后标记失败，错误信息保留最终原因", async () => {
  reset([], 99); // 永远失败
  const dm = new DownloadManager();
  const task = dm.start("some/repo", "always-fails.bin", "chat", "modelscope", { size: 256 });

  // 第一次失败 → 排队重试；第二次（退避 3s 后）再失败 → 判死。
  await Bun.sleep(4_000);
  const done = dm.list().find((t) => t.id === task.id);
  expect(done?.status).toBe("failed");
  expect(done?.error).toContain("500");
  await releaseAll();
}, 15_000);
