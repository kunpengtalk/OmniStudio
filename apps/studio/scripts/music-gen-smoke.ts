/**
 * 音乐生成冒烟测试：mock 两条云端上游（StepFun 异步提交+轮询 / MiniMax 同步长请求），
 * 端到端验证 提交 → 轮询或后台回填 → 落盘 → 记录/删除 全链路，外加
 * 协议分派、参数校验与「本地后端为预留位」这三块。
 * 跑法：bun scripts/music-gen-smoke.ts
 *
 * 注意：项目模块（含 db）必须在 OMNI_DATA_DIR 设置之后再动态 import，
 * 否则静态 import 被提升、env 未生效时会连到真实应用数据库。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type * as MusicGenT from "../src/bun/music-gen";
import { IMAGE_SERVER_HOST, IMAGE_SERVER_PORT } from "../src/shared/server-info";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "music-gen-smoke-"));
process.env.NODE_ENV = "production";

type MusicRecordRow = MusicGenT.MusicRecordRow;

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 假的 mp3 负载：内容无所谓，链路验的是"字节原样落盘"。 */
const FAKE_MP3 = new Uint8Array([
  ...Buffer.from("ID3fake-mp3-bytes-for-smoke-test"),
  ...Array.from({ length: 64 }, (_, i) => i & 0xff),
]);

// ---------------------------------------------------------------------------
// mock 上游服务
// ---------------------------------------------------------------------------

const seen: Record<string, unknown> = {};

/**
 * StepFun 阶跃星辰：异步协议。
 *
 * `/v1/audio/music/submit` 拿 task_id，`/v1/audio/music/query` 轮询。
 * 三种结果都要能造出来：正常完成、FAILED（带 stage）、以及"路径不存在"的纯文本 404。
 */
const stepfunQueryCounts = { ok: 0 };
const stepfun = Bun.serve({
  port: 0,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/audio/music/submit") {
      const body = (await req.json()) as Record<string, unknown>;
      seen.stepfunSubmit = body;
      // 按 caption 决定这个任务最后是成功还是失败，方便一个 mock 覆盖两条分支。
      const taskId = String(body.caption).includes("会失败") ? "sf-fail" : "sf-1";
      if (taskId === "sf-fail") seen.stepfunFailSubmit = body;
      return Response.json({ task_id: taskId });
    }
    if (req.method === "POST" && url.pathname === "/v1/audio/music/query") {
      const body = (await req.json()) as { task_id?: string };
      if (body.task_id === "sf-fail") {
        return Response.json({
          status: "FAILED",
          task: "text_to_music",
          error: { stage: "censor", message: "lyrics rejected" },
        });
      }
      // 先给一次 PENDING（验证"非终态不会被当成成功"），之后 SUCCESS。
      if (stepfunQueryCounts.ok === 0) {
        stepfunQueryCounts.ok++;
        return Response.json({ status: "PENDING", task: "text_to_music" });
      }
      return Response.json({
        status: "SUCCESS",
        task: "text_to_music",
        caption: "test",
        lyrics: "[Verse 1]\n测试歌词",
        response_format: "mp3",
        sample_rate: 48000,
        audio: Buffer.from(FAKE_MP3).toString("base64"),
        rewritten_caption: "A test song, female vocal, D minor",
        rewritten_lyrics: "[Verse 1]\n重写后的歌词",
      });
    }
    // 模拟"这家地址根本没有音乐接口"：网关回的纯文本 404。
    if (url.pathname === "/v1/audio/music/query" && seen.force404) {
      return new Response("404 page not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
});

/**
 * MiniMax：同步协议。一次 POST 直接回音频，音频是 **hex**（不是 base64）。
 * 另外造一条业务错误：HTTP 200 + base_resp.status_code !== 0（只看 res.ok 会漏掉）。
 */
const minimax = Bun.serve({
  port: 0,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/music_generation") {
      const body = (await req.json()) as Record<string, unknown>;
      seen.minimaxSubmit = body;
      if (String(body.prompt).includes("鉴权失败")) {
        // 真机行为：鉴权失败也是 HTTP 200，业务码在 base_resp 里。
        return Response.json({ base_resp: { status_code: 1004, status_msg: "login fail" } });
      }
      return Response.json({
        data: { audio: Buffer.from(FAKE_MP3).toString("hex"), status: 2 },
        extra_info: { music_sample_rate: 44100, music_duration: 12000 },
        base_resp: { status_code: 0, status_msg: "success" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

// ---------------------------------------------------------------------------
// 跑链路（env 就绪后再加载项目模块）
// ---------------------------------------------------------------------------

/** 一直轮询到记录离开 processing（同步协议靠它在后台回填后收敛）。 */
async function pollUntilDone(MusicGen: typeof MusicGenT, id: number): Promise<MusicRecordRow> {
  for (let i = 0; i < 60; i++) {
    const [row] = await MusicGen.pollMusicRecords([id]);
    if (row && row.status !== "processing") return row;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`record ${id} still processing after timeout`);
}

// env 就绪后由 main() 动态注入（项目模块必须在 OMNI_DATA_DIR 设置之后再加载）。
let getImagesBaseDir: () => string = () => {
  throw new Error("getImagesBaseDir not ready");
};

const MEDIA_BASE = `http://${IMAGE_SERVER_HOST}:${IMAGE_SERVER_PORT}/`;

function assertAudioOk(row: MusicRecordRow, label: string) {
  check(`${label}: status=done`, row.status === "done", `got ${row.status} ${row.error ?? ""}`);
  check(`${label}: audioUrl 指向本地媒体服务`, !!row.audioUrl?.startsWith(`${MEDIA_BASE}music/`), row.audioUrl ?? "");
  const ref = row.audioUrl!.replace(MEDIA_BASE, "");
  const abs = path.join(getImagesBaseDir(), ref);
  check(`${label}: 音频已落盘`, existsSync(abs));
  check(
    `${label}: 落盘内容与上游字节一致`,
    existsSync(abs) && Buffer.compare(readFileSync(abs), Buffer.from(FAKE_MP3)) === 0,
  );
}

/**
 * 云端生音乐的配置方式是「厂商 + 模型 + 协议」：这里建两行服务商
 * （stepfun / minimax 协议各一），后面换厂商只需要把 MUSIC_PROVIDER_ID 指过去。
 */
async function seedCloudProvider(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
  musicApi: "stepfun" | "minimax";
  model: string;
}): Promise<string> {
  const CloudProviders = await import("../src/bun/cloud-providers");
  const created = CloudProviders.createCloudProvider({ name: input.name, baseUrl: input.baseUrl });
  const id = created.id!;
  CloudProviders.updateCloudProvider(id, {
    apiKey: input.apiKey,
    musicApi: input.musicApi,
    models: [{ id: input.model, type: "music" }],
  });
  return id;
}

async function main() {
  const MusicGen = (await import("../src/bun/music-gen")) as typeof MusicGenT;
  const { updateSettings } = await import("../src/bun/db/settings");
  const imageServer = await import("../src/bun/image-server");
  getImagesBaseDir = imageServer.getImagesBaseDir;

  // ---------- 厂商行 ----------
  // 故意把 stepfun 的地址写成**带 /v1**（预设就是这么给的），验证地址规整：
  // 直接拼会得到 /v1/v1/audio/music/submit。
  const stepfunProvider = await seedCloudProvider({
    name: "StepFun（冒烟）",
    baseUrl: `http://localhost:${stepfun.port}/v1`,
    apiKey: "sk-step-test",
    musicApi: "stepfun",
    model: "stepaudio-3-music-preview",
  });
  const minimaxProvider = await seedCloudProvider({
    name: "MiniMax（冒烟）",
    baseUrl: `http://localhost:${minimax.port}`,
    apiKey: "sk-mm-test",
    musicApi: "minimax",
    model: "music-3.0",
  });

  // ---------- 协议分派：模型清单按协议给 ----------
  console.log("协议分派：");
  {
    const stepfunModels = MusicGen.listMusicGenModels({ providerId: stepfunProvider });
    const minimaxModels = MusicGen.listMusicGenModels({ providerId: minimaxProvider });
    check(
      "stepfun 协议给出 StepFun 模型",
      stepfunModels.models.includes("stepaudio-3-music-preview"),
      JSON.stringify(stepfunModels),
    );
    check("minimax 协议给出 MiniMax 模型", minimaxModels.models.includes("music-3.0"), JSON.stringify(minimaxModels));
    check("两种协议的模型清单不同", stepfunModels.models[0] !== minimaxModels.models[0]);
    // 没配协议的厂商不能用来生音乐。
    const CloudProviders = await import("../src/bun/cloud-providers");
    const plain = CloudProviders.createCloudProvider({ name: "没协议（冒烟）", baseUrl: "http://localhost:1" });
    const noProtocol = MusicGen.listMusicGenModels({ providerId: plain.id! });
    check("没配协议的厂商给出可读错误", !!noProtocol.error && noProtocol.models.length === 0, noProtocol.error ?? "");
  }

  // ---------- 地址规整 ----------
  console.log("地址规整：");
  {
    check("剥掉尾部 /v1", MusicGen.apiRoot("https://api.stepfun.com/v1") === "https://api.stepfun.com");
    check("根地址原样保留", MusicGen.apiRoot("https://api.stepfun.com") === "https://api.stepfun.com");
    check("连写版本段也剥干净", MusicGen.apiRoot("https://x.test/v1/v2/") === "https://x.test");
  }

  // ---------- StepFun 链路（异步：提交 + 轮询） ----------
  console.log("StepFun 链路：");
  updateSettings({
    MUSIC_BACKEND: "cloud",
    MUSIC_PROVIDER_ID: stepfunProvider,
    MUSIC_MODEL: "stepaudio-3-music-preview",
  });
  {
    const r = await MusicGen.submitMusicGeneration({
      caption: "雨后的城市夜景，轻快的 City Pop，女声主唱，D 小调",
      lyrics: "[Verse 1]\n青椒还沾着晨露",
      title: "雨后的菜场",
    });
    check("提交成功并返回 processing 记录", !!r.record && r.record.status === "processing", r.error);
    check("记录里存了提交时的协议", r.record?.musicApi === "stepfun", String(r.record?.musicApi));
    check("记录里存了上游 task_id", r.record?.taskId === "sf-1", String(r.record?.taskId));

    const submit = seen.stepfunSubmit as Record<string, unknown>;
    check("请求体 task=text_to_music", submit.task === "text_to_music");
    check("请求体 model_id 用选中的模型", submit.model_id === "stepaudio-3-music-preview");
    check("caption 透传", submit.caption === "雨后的城市夜景，轻快的 City Pop，女声主唱，D 小调");
    check("lyrics 透传", submit.lyrics === "[Verse 1]\n青椒还沾着晨露");
    check("非器乐场景不传 instrumental", submit.instrumental === false, JSON.stringify(submit.instrumental));

    const row = await pollUntilDone(MusicGen, r.record!.id);
    assertAudioOk(row, "StepFun");
    check("SUCCESS 后回填改写后的歌词", row.rewrittenLyrics === "[Verse 1]\n重写后的歌词", String(row.rewrittenLyrics));
    check(
      "SUCCESS 后回填改写后的风格描述",
      row.rewrittenCaption === "A test song, female vocal, D minor",
      String(row.rewrittenCaption),
    );
    check("recordId 记录了样本率", row.sampleRate === 48000, String(row.sampleRate));
  }

  // ---------- StepFun 器乐：不能带歌词 ----------
  console.log("StepFun 器乐：");
  {
    const r = await MusicGen.submitMusicGeneration({
      caption: "流行风格古筝曲，穿插长笛和箫声",
      instrumental: true,
    });
    check("器乐提交成功", !!r.record && r.record.status === "processing", r.error);
    const submit = seen.stepfunSubmit as Record<string, unknown>;
    check("请求体 instrumental=true", submit.instrumental === true);
    check("器乐不传 lyrics（文档禁止同时传）", submit.lyrics === undefined, JSON.stringify(submit.lyrics));
    const row = await pollUntilDone(MusicGen, r.record!.id);
    check("器乐任务能完成", row.status === "done", row.error ?? "");
  }

  // ---------- 参数校验：器乐 + 歌词互斥 ----------
  console.log("参数校验：");
  {
    const r = await MusicGen.submitMusicGeneration({
      caption: "随便",
      lyrics: "有歌词",
      instrumental: true,
    });
    check("器乐 + 歌词被拦下", !!r.error && !r.record, r.error ?? "（没有报错）");
  }

  // ---------- StepFun 失败路径（FAILED + stage） ----------
  console.log("StepFun 失败路径：");
  {
    const r = await MusicGen.submitMusicGeneration({ caption: "会失败的任务" });
    check("提交成功", !!r.record && r.record.status === "processing", r.error);
    const submit = seen.stepfunFailSubmit as Record<string, unknown>;
    check("失败任务也走同一套请求体", submit.task === "text_to_music");
    const row = await pollUntilDone(MusicGen, r.record!.id);
    check("上游 FAILED → 记录 failed", row.status === "failed", row.status);
    check("失败原因带上 stage", (row.error ?? "").includes("censor"), row.error ?? "");
    check("失败原因带上可读建议", (row.error ?? "").includes("安全审核"), row.error ?? "");
  }

  // ---------- MiniMax 链路（同步：后台任务回填） ----------
  console.log("MiniMax 链路：");
  updateSettings({
    MUSIC_BACKEND: "cloud",
    MUSIC_PROVIDER_ID: minimaxProvider,
    MUSIC_MODEL: "music-3.0",
  });
  {
    const r = await MusicGen.submitMusicGeneration({
      caption: "Vibrant dance-pop with uplifting R&B influences",
      lyrics: "[Verse 1]\nmove with me",
      title: "Dance",
    });
    // 同步协议的关键：submit 必须**立刻**返回，不能等那 30~120 秒。
    check("提交立刻返回 processing 记录", !!r.record && r.record.status === "processing", r.error);
    check("同步协议没有 task_id", r.record?.taskId == null, String(r.record?.taskId));

    const row = await pollUntilDone(MusicGen, r.record!.id);
    assertAudioOk(row, "MiniMax");
    const submit = seen.minimaxSubmit as Record<string, unknown>;
    check("请求体用 prompt（不是 caption）", submit.prompt === "Vibrant dance-pop with uplifting R&B influences");
    check("请求体 output_format=hex", submit.output_format === "hex");
    check("请求体 model=music-3.0", submit.model === "music-3.0");
    const audioSetting = submit.audio_setting as { format?: string; sample_rate?: number };
    check("audio_setting.format 透传", audioSetting?.format === "mp3", JSON.stringify(audioSetting));
    check("hex 解码后字节正确（不是 base64）", row.status === "done" && row.durationMs !== null);
  }

  // ---------- MiniMax 输出格式收敛 ----------
  console.log("MiniMax 格式收敛：");
  {
    // MiniMax 不支持 flac / opus（StepFun 支持）——传了要收敛回合法档位。
    const r = await MusicGen.submitMusicGeneration({
      caption: "格式收敛测试",
      lyrics: "[Verse 1]\nx",
      responseFormat: "flac",
    });
    check("提交成功", !!r.record, r.error);
    const submit = seen.minimaxSubmit as Record<string, unknown>;
    const audioSetting = submit.audio_setting as { format?: string };
    check("flac 被收敛成 mp3", audioSetting?.format === "mp3", String(audioSetting?.format));
    await pollUntilDone(MusicGen, r.record!.id);
  }

  // ---------- MiniMax 业务错误（HTTP 200 + base_resp） ----------
  console.log("MiniMax 业务错误：");
  {
    updateSettings({ MUSIC_MODEL: "music-3.0" });
    const r = await MusicGen.submitMusicGeneration({ caption: "鉴权失败的任务", lyrics: "[Verse 1]\nx" });
    // 同步协议的提交阶段不会抛（请求在后台跑），错误落在记录里。
    check("提交阶段仍返回 processing 记录", !!r.record, r.error);
    const row = await pollUntilDone(MusicGen, r.record!.id);
    check("base_resp.status_code=1004 → failed", row.status === "failed", row.status);
    check("错误消息带上业务码", (row.error ?? "").includes("1004"), row.error ?? "");
    check("错误消息给出可读建议", (row.error ?? "").includes("API Key"), row.error ?? "");
  }

  // ---------- 本地后端：预留位必须如实报错 ----------
  console.log("本地后端（预留位）：");
  {
    const r = await MusicGen.submitMusicGeneration({
      caption: "本地生成的尝试",
      config: { backend: "local" },
    });
    check("本地后端不假装成功", !!r.error && !r.record, r.error ?? "（竟然成功了）");
    check("错误说明是预留位", (r.error ?? "").includes("预留"), r.error ?? "");
    check("错误指向云端可用的做法", (r.error ?? "").includes("模型云服务"), r.error ?? "");

    const models = MusicGen.listMusicGenModels({ backend: "local" });
    check("本地后端给不出模型清单且说明原因", models.models.length === 0 && !!models.error, models.error ?? "");

    // 预留位是配置问题，不是一次生成尝试 —— 不该在创作记录里留下一条注定失败的条目。
    const localRows = MusicGen.listMusicRecords().filter((r) => r.backend === "local");
    check("本地未接入不落失败记录", localRows.length === 0, JSON.stringify(localRows.map((r) => r.error)));

    updateSettings({ MUSIC_BACKEND: "cloud" });
  }

  // ---------- 记录列表与删除 ----------
  console.log("记录管理：");
  {
    const list = MusicGen.listMusicRecords();
    const done = list.filter((r) => r.status === "done");
    const failedRows = list.filter((r) => r.status === "failed");
    check("列表里没有残留的 processing", list.every((r) => r.status !== "processing"), `${list.length} 条`);
    check("成功 4 条（StepFun 歌曲 + 器乐 + MiniMax 歌曲 + 格式收敛）", done.length === 4, String(done.length));
    // 只有"真的提交到上游"的失败才落记录：StepFun 内容审核 + MiniMax 鉴权被拒。
    // 参数校验失败与"本地后端未接入"都在落库前就返回了，不占创作记录。
    check("失败 2 条", failedRows.length === 2, String(failedRows.length));

    const target = done[0]!;
    const ref = target.audioUrl!.replace(MEDIA_BASE, "");
    const abs = path.join(getImagesBaseDir(), ref);
    MusicGen.deleteMusicRecord(target.id);
    check("删除后文件清理", !existsSync(abs));
    check("删除后列表减少", MusicGen.listMusicRecords().length === list.length - 1);
  }

  stepfun.stop(true);
  minimax.stop(true);

  if (failed > 0) {
    console.error(`\n${failed} 项检查未通过`);
    process.exit(1);
  }
  console.log("\n全部通过 ✓");
  rmSync(process.env.OMNI_DATA_DIR!, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
