import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import * as fs from "fs";

/**
 * 全局默认嵌入配置（**快照语义**）单测。
 *
 * 这一层锁住的是「默认什么时候生效」这条规格：
 *   - 全局三键只有一个 bun 侧读取点（embeddings.globalEmbeddingDefaults），它**不参与**
 *     resolveEmbeddingBase 的层级 —— 设了全局地址不会让既有 KB 的端点漂移（②-8）；
 *   - 默认只在写入时落进 KB 行：新建 / 导入建库预填（②-3）、KB 设置页「启用向量检索」
 *     写入三字段并真的按入重嵌（②-4）；
 *   - 共享记忆在解析时读它（唯一没有「对象行」的消费方），哨兵 none/off 可显式关掉
 *     （②-6/②-7），清空全局默认后回到纯关键词。
 *
 * 桩法：临时库 + mock ./db；./db/settings 与 ./model-servers 都是**展开真实模块再覆盖**
 * 单个函数（bun 的 mock.module 会跨文件泄漏，残缺桩会让后评估的模块直接少导出而失败）。
 */

const tmpDb = `/tmp/embedding-defaults-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

// 展开真实模块再覆盖（mock-hygiene.test.ts 规矩）：只给 db 的话，main 侧新增的
// sqliteClient 等导出在别的模块 import "./db" 时会直接报缺导出。
const realDb = await import("./db");
mock.module("./db", () => ({ ...realDb, db }));

/** 设置表：读写落在同一个 Map 上（不碰真实数据目录）。 */
const SETTINGS: Record<string, string> = {};
const realSettings = await import("./db/settings");
mock.module("./db/settings", () => ({
  ...realSettings,
  getSetting: (key: string) => SETTINGS[key] ?? "",
  getNumericSetting: (key: string) => Number(SETTINGS[key] ?? 0) || 0,
  updateSettings: (patch: Record<string, string>) => {
    Object.assign(SETTINGS, patch);
  },
  getAllSettings: () => ({ ...SETTINGS }),
  getActiveServerPort: () => SETTINGS.SERVER_PORT ?? "18080",
  invalidateSettingsCache: () => {},
}));

// 注册表里没有运行中的嵌入实例：resolveEmbeddingBase 的兜底链固定落到聊天活动端口，
// ②-8 的「零漂移」断言才不会因为别处泄漏进来的实例桩而假绿。
const realModelServers = await import("./model-servers");
mock.module("./model-servers", () => ({ ...realModelServers, resolveEmbeddingBackend: () => null }));

const Embeddings = await import("./embeddings");
const Memory = await import("./memory");
const Knowledge = await import("./knowledge");
const Ingest = await import("./kb-ingest");
const { getKbIndex } = await import("./kb-index");
const { memories } = await import("./db/schema");

// ---------------------------------------------------------------------------
// 假嵌入 / 重排服务（记录请求落在哪个端口上）
// ---------------------------------------------------------------------------

/** 聊天活动端口（无嵌入实例时 resolveEmbeddingBase 的兜底目标）。 */
const CHAT_PORT = 18911;
/** 知识库自己的嵌入地址（②-4 写进 KB 行的 base）。 */
const KB_BASE_PORT = 18912;

const hits: { port: number; path: string }[] = [];
const servers: { stop: (closeAll: boolean) => void }[] = [];

function startFake(port: number) {
  const server = Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      hits.push({ port, path: url.pathname });
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "bge-m3" }] });
      if (url.pathname === "/v1/embeddings") {
        const body = (await req.json()) as { input?: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        // 32 维确定性向量：同一条文本每次一致，够跑通维度校验与余弦排序。
        const embedding = Array.from({ length: 32 }, (_, i) => (i % 4 === 0 ? 0.5 : 0.1));
        return Response.json({ data: inputs.map((_, index) => ({ index, embedding })) });
      }
      if (url.pathname === "/v1/rerank") {
        const body = (await req.json()) as { documents?: { id?: unknown }[] };
        const docs = body.documents ?? [];
        return Response.json({
          results: docs.map((d, index) => ({
            index,
            document: { id: d.id },
            relevance_score: Math.max(0, 1 - index * 0.2),
          })),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return server;
}

startFake(CHAT_PORT);
startFake(KB_BASE_PORT);

const createdKbs: number[] = [];

beforeEach(() => {
  for (const key of Object.keys(SETTINGS)) delete SETTINGS[key];
  SETTINGS.SERVER_MODE = "local";
  SETTINGS.SERVER_HOST = "127.0.0.1";
  SETTINGS.SERVER_PORT = String(CHAT_PORT);
  hits.length = 0;
  db.delete(memories).run();
});

afterEach(() => {
  for (const id of createdKbs) {
    try {
      Knowledge.deleteKb(id);
    } catch {
      // 已被用例删掉
    }
  }
  createdKbs.length = 0;
});

afterAll(() => {
  for (const server of servers) server.stop(true);
  try {
    sqlite.close();
    fs.rmSync(tmpDb, { force: true });
  } catch {
    // 忽略
  }
});

/** 建库并登记，用例结束统一回收（含内存索引）。 */
function makeKb(input: Parameters<typeof Knowledge.createKb>[0]) {
  const kb = Knowledge.createKb(input);
  createdKbs.push(kb.id);
  return kb;
}

/**
 * 给知识库加一篇够长的笔记，等摄取完成（纯关键词也能建出分块）。
 * 正文要长到切出**多个**都命中查询词的分块：重排只在候选 > 1 时才发起。
 */
async function seedDoc(kbId: number): Promise<void> {
  const body = [
    "# 退货政策",
    ...Array.from(
      { length: 16 },
      (_, i) => `第 ${i} 条：签收后七天内可申请无理由退货，退货需保持商品与包装完好。`,
    ),
    "# 物流说明",
    ...Array.from({ length: 8 }, (_, i) => `第 ${i} 条：默认顺丰发货，偏远地区三到五天送达。`),
  ].join("\n\n");
  Knowledge.addNoteDoc(kbId, "退货与物流", body);
  await Ingest.awaitKbIdle(kbId, 30_000);
}

// ---------------------------------------------------------------------------

describe("globalEmbeddingDefaults（唯一读取点）", () => {
  test("读取三键并去掉首尾空白", () => {
    SETTINGS.EMBEDDING_MODEL = "  bge-m3  ";
    SETTINGS.EMBEDDING_BASE = " http://127.0.0.1:18912/v1 ";
    SETTINGS.EMBEDDING_API_KEY = " sk-test ";
    expect(Embeddings.globalEmbeddingDefaults()).toEqual({
      model: "bge-m3",
      base: "http://127.0.0.1:18912/v1",
      apiKey: "sk-test",
    });
  });

  test("未设置时三键为空（默认不启用任何嵌入）", () => {
    expect(Embeddings.globalEmbeddingDefaults()).toEqual({ model: "", base: "", apiKey: "" });
  });
});

describe("memoryEmbeddingConfig 优先级（②-6）", () => {
  test("未配置任何嵌入 → null（既有兜底：纯关键词）", () => {
    expect(Memory.memoryEmbeddingConfig()).toBeNull();
  });

  test("未显式配置 → 回落全局默认的 model / base / key", () => {
    SETTINGS.EMBEDDING_MODEL = "global-embed";
    SETTINGS.EMBEDDING_BASE = "http://127.0.0.1:18912/v1";
    SETTINGS.EMBEDDING_API_KEY = "global-key";
    const cfg = Memory.memoryEmbeddingConfig();
    expect(cfg?.embeddingModel).toBe("global-embed");
    expect(cfg?.embeddingBase).toBe("http://127.0.0.1:18912/v1");
    expect(cfg?.embeddingApiKey).toBe("global-key");
  });

  test("显式值优先于全局默认", () => {
    SETTINGS.EMBEDDING_MODEL = "global-embed";
    SETTINGS.EMBEDDING_BASE = "http://127.0.0.1:18912/v1";
    SETTINGS.EMBEDDING_API_KEY = "global-key";
    SETTINGS.MEMORY_EMBEDDING_MODEL = "memory-embed";
    SETTINGS.MEMORY_EMBEDDING_BASE = "http://127.0.0.1:18999/v1";
    SETTINGS.MEMORY_EMBEDDING_API_KEY = "memory-key";
    const cfg = Memory.memoryEmbeddingConfig();
    expect(cfg?.embeddingModel).toBe("memory-embed");
    expect(cfg?.embeddingBase).toBe("http://127.0.0.1:18999/v1");
    expect(cfg?.embeddingApiKey).toBe("memory-key");
  });

  test("只填显式 base / key 时，model 仍回落全局", () => {
    SETTINGS.EMBEDDING_MODEL = "global-embed";
    SETTINGS.MEMORY_EMBEDDING_BASE = "http://127.0.0.1:18999/v1";
    const cfg = Memory.memoryEmbeddingConfig();
    expect(cfg?.embeddingModel).toBe("global-embed");
    expect(cfg?.embeddingBase).toBe("http://127.0.0.1:18999/v1");
  });

  test("哨兵 none / off（大小写不敏感）→ null，即使全局默认已设", () => {
    SETTINGS.EMBEDDING_MODEL = "global-embed";
    for (const sentinel of ["none", "off", "NONE", "Off"]) {
      SETTINGS.MEMORY_EMBEDDING_MODEL = sentinel;
      expect(Memory.memoryEmbeddingConfig()).toBeNull();
    }
  });

  test("哨兵只作用于 model：base 的字面值 none 是普通地址", () => {
    SETTINGS.MEMORY_EMBEDDING_MODEL = "memory-embed";
    SETTINGS.MEMORY_EMBEDDING_BASE = "none";
    expect(Memory.memoryEmbeddingConfig()?.embeddingBase).toBe("none");
  });

  test("清空全局默认后未显式配置的记忆回到纯关键词（②-7 守门）", () => {
    SETTINGS.EMBEDDING_MODEL = "global-embed";
    expect(Memory.memoryEmbeddingConfig()).not.toBeNull();
    SETTINGS.EMBEDDING_MODEL = "";
    SETTINGS.EMBEDDING_BASE = "";
    SETTINGS.EMBEDDING_API_KEY = "";
    expect(Memory.memoryEmbeddingConfig()).toBeNull();
  });
});

describe("共享记忆走向量（②-2 / ②-7）", () => {
  test("设全局默认 + 写入记忆 → 排空后真的补出向量", async () => {
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;
    Memory.saveMemory({ content: "用户偏好简洁的中文回复" });

    // 记忆向量化是后台定时任务（写入后 1.5s 防抖、每轮上限 200 条）：
    // 不显式排空就断言，会退化成「配置非空」这种恒真的检查。
    const embedded = await Memory.embedMissingMemories();
    expect(embedded).toBeGreaterThan(0);

    const row = db.select({ embedding: memories.embedding }).from(memories).get();
    expect(row?.embedding).not.toBeNull();
    expect(hits.some((h) => h.port === KB_BASE_PORT && h.path === "/v1/embeddings")).toBe(true);
  });

  test("清空全局默认后不再补向量（②-7）", async () => {
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;
    Memory.saveMemory({ content: "临时记忆：默认被清空后不应再向量化" });

    SETTINGS.EMBEDDING_MODEL = "";
    SETTINGS.EMBEDDING_BASE = "";
    expect(await Memory.embedMissingMemories()).toBe(0);
    expect(db.select({ embedding: memories.embedding }).from(memories).get()?.embedding).toBeNull();
  });
});

describe("createKb 写入时快照（②-3）", () => {
  test("没有全局默认时三字段为空：既有行为不变", () => {
    const kb = makeKb({ name: "关键词库" });
    expect(kb.embeddingModel).toBe("");
    expect(kb.embeddingBase).toBe("");
    expect(kb.embeddingApiKey).toBe("");
  });

  test("设了全局默认 → 建库预填 model / base / key，且 base 解析到全局地址", () => {
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;
    SETTINGS.EMBEDDING_API_KEY = "sk-global";

    const kb = makeKb({ name: "快照库" });
    expect(kb.embeddingModel).toBe("bge-m3");
    expect(kb.embeddingBase).toBe(`http://127.0.0.1:${KB_BASE_PORT}/v1`);
    expect(kb.embeddingApiKey).toBe("sk-global");
    expect(Embeddings.resolveEmbeddingBase({ embeddingBase: kb.embeddingBase })).toBe(
      `http://127.0.0.1:${KB_BASE_PORT}`,
    );
  });

  test("显式传入的模型优先，缺省才用快照", () => {
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;

    const kb = makeKb({ name: "显式库", embeddingModel: "custom-embed" });
    expect(kb.embeddingModel).toBe("custom-embed");
    // 地址仍按快照落库：库里没有第二份「显式地址」参数
    expect(kb.embeddingBase).toBe(`http://127.0.0.1:${KB_BASE_PORT}/v1`);
  });

  test("既有空配置 KB 在设了全局默认后仍是纯关键词（防静默切换）", async () => {
    const kb = makeKb({ name: "既有关键词库" });
    await seedDoc(kb.id);

    // 之后用户去「默认模型」里设了全局嵌入配置
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;

    const row = Knowledge.getKb(kb.id)!;
    expect(row.embeddingModel).toBe("");
    expect(row.embeddingBase).toBe("");
    // 没有被悄悄重嵌
    expect(Knowledge.listKnowledgeBases().find((k) => k.id === kb.id)?.embeddedCount).toBe(0);
  });

  test("导入路径同样快照：导出文件没带嵌入配置时保留全局默认", () => {
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;

    const imported = Knowledge.importKb({
      format: Knowledge.KB_EXPORT_FORMAT,
      version: Knowledge.KB_EXPORT_VERSION,
      kb: { name: "旧导出", embeddingModel: "", embeddingBase: "", embeddingDim: null },
      docs: [],
      chunks: [],
    });
    createdKbs.push(imported.kb.id);
    expect(imported.kb.embeddingModel).toBe("bge-m3");
    expect(imported.kb.embeddingBase).toBe(`http://127.0.0.1:${KB_BASE_PORT}/v1`);
  });

  test("导入路径：导出文件带了嵌入配置就以它为准", () => {
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;

    const imported = Knowledge.importKb({
      format: Knowledge.KB_EXPORT_FORMAT,
      version: Knowledge.KB_EXPORT_VERSION,
      kb: { name: "带配置导出", embeddingModel: "exported-embed", embeddingBase: "http://127.0.0.1:18888", embeddingDim: 768 },
      docs: [],
      chunks: [],
    });
    createdKbs.push(imported.kb.id);
    expect(imported.kb.embeddingModel).toBe("exported-embed");
    expect(imported.kb.embeddingBase).toBe("http://127.0.0.1:18888");
  });
});

describe("probeDefaultEmbedding（新建弹窗预填的探活门控）", () => {
  test("未配置 → 短路返回 configured:false，不发起任何嵌入请求", async () => {
    // beforeEach 已清空 SETTINGS；假服务还挂着：若探活真的发了请求，hits 会记到
    expect(await Knowledge.probeDefaultEmbedding()).toEqual({ configured: false });
    expect(hits.filter((h) => h.path === "/v1/embeddings")).toEqual([]);
  });

  test("已配置 → 透传 testEmbedding 成功态（reachable / model / dim）", async () => {
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;
    const probe = await Knowledge.probeDefaultEmbedding();
    expect(probe).toEqual({ configured: true, reachable: true, model: "bge-m3", dim: 32 });
    // 请求真的落在全局默认的地址上（与建库后真实嵌入同一条解析链）
    expect(hits.some((h) => h.port === KB_BASE_PORT && h.path === "/v1/embeddings")).toBe(true);
  });

  test("已配置但端点不可达 → reachable:false + error（不抛异常）", async () => {
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = "http://127.0.0.1:19191/v1";
    const probe = await Knowledge.probeDefaultEmbedding();
    expect(probe).toEqual({
      configured: true,
      reachable: false,
      model: "bge-m3",
      error: expect.any(String),
    });
  });
});

describe("probeDefaultEmbedding 快照中立", () => {
  test("显式传 embeddingModel=defaults.model 与不传 → createKb 落库三字段逐一相同", () => {
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;
    SETTINGS.EMBEDDING_API_KEY = "sk-global";

    // 预填只改变 RPC 入参形态（隐式 undefined → 显式同名值），不改变落库行为：
    // 快照的 base / key 都来自 globalEmbeddingDefaults，与 model 从哪来无关。
    const explicit = makeKb({ name: "显式传默认模型", embeddingModel: "bge-m3" });
    const omitted = makeKb({ name: "不传（预填等价形态）" });
    expect(explicit.embeddingModel).toBe(omitted.embeddingModel);
    expect(explicit.embeddingBase).toBe(omitted.embeddingBase);
    expect(explicit.embeddingApiKey).toBe(omitted.embeddingApiKey);
    expect(explicit.embeddingModel).toBe("bge-m3");
  });
});

describe("既有 KB 端点零漂移（②-8）", () => {
  test("显式 model + 空 base：设全局 EMBEDDING_BASE 前后解析结果逐字节一致", () => {
    const kb = makeKb({ name: "既有库", embeddingModel: "bge-m3" });
    const before = Embeddings.resolveEmbeddingBase({ embeddingBase: kb.embeddingBase });
    expect(before).toBe(`http://127.0.0.1:${CHAT_PORT}`);

    // 用户后来设了全局嵌入地址：resolveEmbeddingBase 没被改动，所以既有行完全不受影响。
    SETTINGS.EMBEDDING_MODEL = "bge-m3";
    SETTINGS.EMBEDDING_BASE = `http://127.0.0.1:${KB_BASE_PORT}/v1`;

    const row = Knowledge.getKb(kb.id)!;
    expect(row.embeddingBase).toBe("");
    expect(Embeddings.resolveEmbeddingBase({ embeddingBase: row.embeddingBase })).toBe(before);
  });
});

describe("「启用向量检索」后端链路（②-4 / ②-10）", () => {
  test("写入三字段并重嵌：排空后 embeddedCount > 0 且索引里有向量", async () => {
    const kb = makeKb({ name: "待启用库", rerankModel: "bge-reranker-v2-m3" });
    await seedDoc(kb.id);
    expect(Knowledge.listKnowledgeBases().find((k) => k.id === kb.id)?.embeddedCount).toBe(0);

    // 按钮动作：先 kbUpdate 写入三字段（webview 从 settings 读到的全局默认），再 kbEmbedMissing。
    Knowledge.updateKb(kb.id, {
      embeddingModel: "bge-m3",
      embeddingBase: `http://127.0.0.1:${KB_BASE_PORT}/v1`,
      embeddingApiKey: "",
    });
    const res = await Knowledge.embedMissing(kb.id);
    expect(res.ok).toBe(true);

    const view = Knowledge.listKnowledgeBases().find((k) => k.id === kb.id)!;
    expect(view.embeddingModel).toBe("bge-m3");
    expect(view.embeddingBase).toBe(`http://127.0.0.1:${KB_BASE_PORT}/v1`);
    expect(view.embeddedCount).toBeGreaterThan(0);
    expect(getKbIndex(kb.id)!.index.vectorCount).toBeGreaterThan(0);
  });

  test("被触碰的 KB：rerank base 随之落到它的 embedding base（②-10，明确接受）", async () => {
    const kb = makeKb({ name: "重排连带库", rerankModel: "bge-reranker-v2-m3" });
    await seedDoc(kb.id);

    // 启用前：没有单独配 rerank base，resolveRerankBase 回落 embeddingBase（空）→
    // 再回落聊天活动端口 —— 那里既没有嵌入也没有重排服务，正是问题所在。
    await Knowledge.recall([kb.id], "退货政策");
    const before = hits.filter((h) => h.path === "/v1/rerank");
    expect(before.length).toBeGreaterThan(0);
    expect(before[before.length - 1]!.port).toBe(CHAT_PORT);

    // 启用（②-4）：embeddingBase 落库 → rerank 的回落目标随之变成这个 KB 的嵌入地址。
    Knowledge.updateKb(kb.id, {
      embeddingModel: "bge-m3",
      embeddingBase: `http://127.0.0.1:${KB_BASE_PORT}/v1`,
    });
    await Knowledge.embedMissing(kb.id);

    hits.length = 0;
    await Knowledge.recall([kb.id], "退货政策");
    const after = hits.filter((h) => h.path === "/v1/rerank");
    expect(after.length).toBeGreaterThan(0);
    expect(after[after.length - 1]!.port).toBe(KB_BASE_PORT);
  });
});
