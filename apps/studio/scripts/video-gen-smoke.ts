/**
 * 视频生成冒烟测试：mock 三条上游（MiniMax / Seedance / ComfyUI），
 * 端到端验证 提交 → 轮询 → 下载落盘 → 记录/删除 全链路。
 * 跑法：bun scripts/video-gen-smoke.ts
 *
 * 注意：项目模块（含 db）必须在 OMNI_DATA_DIR 设置之后再动态 import，
 * 否则静态 import 被提升、env 未生效时会连到真实应用数据库。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type * as VideoGenT from "../src/bun/video-gen";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "video-gen-smoke-"));
process.env.NODE_ENV = "production";

type VideoRecordRow = VideoGenT.VideoRecordRow;

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const FAKE_MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...Buffer.from("fake-video-bytes-for-smoke-test")]);

// ---------------------------------------------------------------------------
// mock 上游服务
// ---------------------------------------------------------------------------

const seen: Record<string, unknown> = {};

const minimax = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v2/video_generation") {
      seen.minimaxSubmit = await req.json();
      minimaxQueries.posts++;
      // 第二次提交返回会失败的任务，走轮询的失败分支。
      const taskId = minimaxQueries.posts === 2 ? "mm-fail" : "mm-1";
      return Response.json({ task_id: taskId, status: "Created", model: "MiniMax-H3" });
    }
    if (url.pathname === "/v2/query/video_generation/mm-1") {
      minimaxQueries.minimax++;
      if (minimaxQueries.minimax >= 2) {
        return Response.json({
          status: "Success",
          progress: 1,
          content: { url: "/v2/files/mm-1.mp4" },
        });
      }
      return Response.json({ status: "Processing", progress: 0.3 });
    }
    if (url.pathname === "/v2/files/mm-1.mp4") return new Response(FAKE_MP4);
    if (url.pathname === "/v2/query/video_generation/mm-fail") {
      return Response.json({ status: "Fail", fail_reason: "内容审核未通过" });
    }
    return new Response("not found", { status: 404 });
  },
});
const minimaxQueries = { minimax: 0, posts: 0 };

const seedance = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/api/v3/contents/generations/tasks") {
      seen.seedanceSubmit = await req.json();
      return Response.json({ id: "cgt-1", status: "queued" });
    }
    if (url.pathname === "/api/v3/contents/generations/tasks/cgt-1") {
      return Response.json({
        id: "cgt-1",
        status: "succeeded",
        content: { video_url: `http://localhost:${seedance.port}/seedance-out.mp4` },
      });
    }
    if (url.pathname === "/seedance-out.mp4") return new Response(FAKE_MP4);
    return new Response("not found", { status: 404 });
  },
});

const comfy = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/prompt") {
      seen.comfySubmit = await req.json();
      return Response.json({ prompt_id: "p-1" });
    }
    if (url.pathname === "/history/p-1") {
      comfyQueries.comfy++;
      if (comfyQueries.comfy >= 2) {
        return Response.json({
          "p-1": {
            outputs: { "9": { gifs: [{ filename: "omnistudio_00001.webm", subfolder: "", type: "output" }] } },
            status: { completed: true, status_str: "success" },
          },
        });
      }
      return Response.json({});
    }
    if (url.pathname === "/view") {
      return new Response(FAKE_MP4);
    }
    if (url.pathname === "/object_info/CheckpointLoaderSimple") {
      return Response.json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["other.safetensors", "wan2.1_t2v_1.3b_fp16.safetensors"]] } } } });
    }
    if (url.pathname === "/object_info/CLIPLoader") {
      return Response.json({ CLIPLoader: { input: { required: { clip_name: [["clip_vision_h.safetensors", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"]] } } } });
    }
    if (url.pathname === "/object_info/VAELoader") {
      return Response.json({ VAELoader: { input: { required: { vae_name: [["wan_2.1_vae.safetensors"]] } } } });
    }
    return new Response("not found", { status: 404 });
  },
});
const comfyQueries = { comfy: 0 };

// ---------------------------------------------------------------------------
// 跑链路（env 就绪后再加载项目模块）
// ---------------------------------------------------------------------------

async function pollUntilDone(
  VideoGen: typeof VideoGenT,
  id: number,
): Promise<VideoRecordRow> {
  for (let i = 0; i < 40; i++) {
    const [row] = await VideoGen.pollVideoRecords([id]);
    if (row && row.status !== "processing") return row;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`record ${id} still processing after timeout`);
}

// env 就绪后由 main() 动态注入（项目模块必须在 OMNI_DATA_DIR 设置之后再加载）。
let getImagesBaseDir: () => string = () => {
  throw new Error("getImagesBaseDir not ready");
};

function assertFileOk(row: VideoRecordRow, label: string) {
  check(`${label}: status=done`, row.status === "done", `got ${row.status} ${row.error ?? ""}`);
  check(`${label}: videoUrl 指向本地媒体服务`, !!row.videoUrl?.startsWith("http://localhost:19782/videos/"), row.videoUrl ?? "");
  const ref = row.videoUrl!.replace("http://localhost:19782/", "");
  const abs = path.join(getImagesBaseDir(), ref);
  check(`${label}: 成片已落盘`, existsSync(abs));
  check(`${label}: 落盘内容正确`, existsSync(abs) && Buffer.compare(readFileSync(abs), Buffer.from(FAKE_MP4)) === 0);
}

async function main() {
  const VideoGen = (await import("../src/bun/video-gen")) as typeof VideoGenT;
  const { updateSettings } = await import("../src/bun/db/settings");
  const imageServer = await import("../src/bun/image-server");
  getImagesBaseDir = imageServer.getImagesBaseDir;

  updateSettings({
    VIDEO_BACKEND: "minimax",
    VIDEO_MINIMAX_BASE: `http://localhost:${minimax.port}`,
    VIDEO_MINIMAX_API_KEY: "test-key",
    VIDEO_MINIMAX_MODEL: "MiniMax-H3",
  });

  // ---------- MiniMax ----------
  console.log("MiniMax 链路：");
  {
    const r = await VideoGen.submitVideoGeneration({
      prompt: "一只海豚跃出海面，慢镜头",
      duration: 2, // 低于下限 4，应被钳到 4
      ratio: "16:9",
      resolution: "768P",
    });
    check("提交成功并返回 processing 记录", !!r.record && r.record.status === "processing", r.error);
    const submit = seen.minimaxSubmit as { model: string; content: { type: string; text?: string }[]; duration: number; ratio: string; resolution: string; aigc_watermark: boolean };
    check("请求体 model=MiniMax-H3", submit.model === "MiniMax-H3");
    check("请求体 content 文本", submit.content[0]?.text === "一只海豚跃出海面，慢镜头");
    check("duration 钳到 4", submit.duration === 4, String(submit.duration));
    check("ratio/resolution 透传", submit.ratio === "16:9" && submit.resolution === "768P");
    const row = await pollUntilDone(VideoGen, r.record!.id);
    assertFileOk(row, "MiniMax");
  }

  // ---------- MiniMax 失败路径 ----------
  console.log("MiniMax 失败路径：");
  {
    const r = await VideoGen.submitVideoGeneration({ prompt: "会失败的任务", duration: 5 });
    check("提交成功", !!r.record && r.record.status === "processing", r.error);
    const row = await pollUntilDone(VideoGen, r.record!.id);
    check("上游 Fail → 记录 failed", row.status === "failed", row.status);
    check("失败原因透传", (row.error ?? "").includes("内容审核未通过"), row.error ?? "");
  }

  // ---------- Seedance ----------
  console.log("Seedance 链路：");
  updateSettings({
    VIDEO_BACKEND: "seedance",
    VIDEO_SEEDANCE_BASE: `http://localhost:${seedance.port}/api/v3`,
    VIDEO_SEEDANCE_API_KEY: "ark-test",
    VIDEO_SEEDANCE_MODEL: "doubao-seedance-1-0-pro-t2v-250528",
  });
  {
    const r = await VideoGen.submitVideoGeneration({
      prompt: "赛博朋克城市夜景航拍",
      duration: 6,
      ratio: "9:16",
      resolution: "720p",
      watermark: true,
      seed: 42,
    });
    check("提交成功", !!r.record && r.record.status === "processing", r.error);
    const submit = seen.seedanceSubmit as { model: string; content: { type: string; text?: string }[] };
    check("model 透传", submit.model === "doubao-seedance-1-0-pro-t2v-250528");
    const text = submit.content[0]?.text ?? "";
    check("提示词带 --flag 尾缀", text.includes("赛博朋克城市夜景航拍") && text.includes("--resolution 720p") && text.includes("--ratio 9:16") && text.includes("--duration 6") && text.includes("--watermark true") && text.includes("--seed 42"), text);
    const row = await pollUntilDone(VideoGen, r.record!.id);
    assertFileOk(row, "Seedance");
  }

  // ---------- ComfyUI（含模型自动挑选） ----------
  console.log("ComfyUI 链路：");
  updateSettings({
    VIDEO_BACKEND: "comfyui",
    VIDEO_COMFY_BASE: `http://localhost:${comfy.port}`,
    // 三个模型名全部留空 → 提交时自动从 /object_info 挑 Wan 系
  });
  {
    const r = await VideoGen.submitVideoGeneration({
      prompt: "水墨风格金鱼游动",
      negativePrompt: "模糊",
      duration: 5,
      ratio: "16:9",
      steps: 20,
    });
    check("提交成功", !!r.record && r.record.status === "processing", r.error);
    const workflow = (seen.comfySubmit as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    check("自动挑中 Wan checkpoint", workflow["1"]?.inputs.ckpt_name === "wan2.1_t2v_1.3b_fp16.safetensors");
    check("自动挑中 umt5 clip", workflow["2"]?.inputs.clip_name === "umt5_xxl_fp8_e4m3fn_scaled.safetensors");
    check("VAELoader 选中 wan vae", workflow["3"]?.inputs.vae_name === "wan_2.1_vae.safetensors");
    check("SaveAnimatedWEBM 输出节点", workflow["9"]?.class_type === "SaveAnimatedWEBM");
    const latent = workflow["6"]?.inputs as { width: number; height: number; length: number };
    check("16:9 → 832×480", latent.width === 832 && latent.height === 480);
    check("5s → 81 帧", latent.length === 81, String(latent.length));
    const row = await pollUntilDone(VideoGen, r.record!.id);
    assertFileOk(row, "ComfyUI");
  }

  // ---------- 记录列表与删除 ----------
  console.log("记录管理：");
  {
    const list = VideoGen.listVideoRecords();
    check("列表包含 4 条（3 成功 + 1 失败）", list.length === 4, String(list.length));
    const done = list.filter((r) => r.status === "done");
    check("3 条均 done", done.length === 3);
    const target = done[0]!;
    const ref = target.videoUrl!.replace("http://localhost:19782/", "");
    const abs = path.join(getImagesBaseDir(), ref);
    VideoGen.deleteVideoRecord(target.id);
    check("删除后文件清理", !existsSync(abs));
    check("删除后列表减少", VideoGen.listVideoRecords().length === 3);
  }

  minimax.stop(true);
  seedance.stop(true);
  comfy.stop(true);

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
