/**
 * 本地抠图冒烟：模型下载 → 合成图跑一遍 → 校验掩膜与剪切图。
 *
 * 跑法：bun scripts/bg-remove-smoke.ts
 *
 * 需要网络（首次拉 4.5MB 的 u2netp）。想跳过下载可先设
 * `OMNI_BG_SMOKE_MODEL=/path/to/u2netp.onnx` 复用本地那份。
 *
 * 这里同时守着 ONNX 运行时资源的可加载性：打包时 glue .mjs 与 .wasm 必须随主进程
 * 一起进 bundle，少了任何一个，本脚本会以「缺少 ONNX 运行时文件」失败 —— 这正是
 * 用户点开抠图时看到的那句话。
 */
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import sharp from "sharp";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "bg-remove-smoke-"));
process.env.NODE_ENV = "production";

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * 读灰度 PNG 的像素。**必须按 sharp 实际给的通道数取字节**：1 通道 raw 进去、
 * 出来的可能是 3 通道（灰度被复制到 R/G/B），当单通道读会整体错位 —— 冒烟测试
 * 自己踩过一次，判据就全歪了。
 */
async function readGray(file: string) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const ch = Math.max(1, info.channels);
  return {
    width: info.width,
    height: info.height,
    at: (x: number, y: number) => data[y * info.width * ch + x * ch] ?? 0,
  };
}

/** 读 RGBA 的 alpha 通道。 */
async function readAlpha(file: string) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = Math.max(1, info.channels);
  return { width: info.width, height: info.height, at: (x: number, y: number) => data[(y * info.width + x) * ch + 3] ?? 0 };
}

const dataDir = process.env.OMNI_DATA_DIR;

try {
  const BG = await import("../src/bun/bg-remove");

  console.log("1) 模型清单");
  const before = BG.listBgModels();
  check("列出了 4 个模型", before.length === 4, `got ${before.length}`);
  check("默认模型已声明", before.some((m) => m.id === BG.DEFAULT_BG_MODEL));
  check("初始都没就绪（隔离数据目录）", before.every((m) => !m.ready));

  console.log("2) 权重就位");
  const preset = process.env.OMNI_BG_SMOKE_MODEL;
  const dest = BG.bgModelPath("u2netp");
  check("解析出落盘路径", !!dest);
  if (preset && existsSync(preset)) {
    mkdirSync(BG.bgModelDir(), { recursive: true });
    copyFileSync(preset, dest!);
    console.log(`  · 复用本地模型 ${preset}`);
  } else {
    const progressSeen: number[] = [];
    const dl = await BG.downloadBgModel("u2netp", {
      onProgress: (p) => progressSeen.push(p.percent),
    });
    check("下载成功", dl.ok, dl.ok ? undefined : dl.error);
    check("过程中有进度回调", progressSeen.length > 0, `${progressSeen.length} 次`);
  }
  check("下载后标记为就绪", BG.isBgModelReady("u2netp"));

  console.log("3) 端到端抠图");
  // 合成图：浅灰底 + 居中的深红圆（模型能稳定识别出的显著主体）
  const W = 640;
  const H = 480;
  const srcPath = path.join(dataDir, "src.png");
  await sharp(
    Buffer.from(
      `<svg width="${W}" height="${H}"><rect width="100%" height="100%" fill="#e8e6e1"/>` +
        `<circle cx="${W / 2}" cy="${H / 2}" r="150" fill="#a01f2e"/></svg>`,
    ),
  )
    .png()
    .toFile(srcPath);

  const res = await BG.removeBackground({ imagePath: srcPath, model: "u2netp" });
  check("抠图返回成功", res.ok, res.ok ? undefined : res.error);
  if (!res.ok) throw new Error(res.error);
  const r = res.result;

  check("尺寸与原图一致", r.width === W && r.height === H, `${r.width}x${r.height}`);
  check("报告了推理耗时", r.inferenceMs > 0, `${r.inferenceMs}ms`);
  check("耗时在合理范围（<60s）", r.totalMs < 60_000, `${r.totalMs}ms`);

  const cutoutPath = path.join(dataDir, "images", r.cutoutRef);
  const maskPath = path.join(dataDir, "images", r.maskRef);
  check("剪切图已落盘", existsSync(cutoutPath));
  check("掩膜已落盘", existsSync(maskPath));

  console.log("4) 掩膜内容");
  const mask = await readGray(maskPath);
  check("掩膜尺寸一致", mask.width === W && mask.height === H, `${mask.width}x${mask.height}`);

  const corner = mask.at(6, 6);
  const center = mask.at(Math.floor(W / 2), Math.floor(H / 2));
  check("主体中心是不透明", center > 200, `center=${center}`);
  check("角落背景是透明", corner < 40, `corner=${corner}`);

  // 非退化：不能整张全黑或全白（那是"掩膜读出错位"或"归一化把背景顶成前景"）
  let fg = 0;
  let bg = 0;
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      const v = mask.at(x, y);
      if (v > 200) fg++;
      else if (v < 40) bg++;
    }
  }
  check("掩膜非退化（前景/背景都存在）", fg > 50 && bg > 50, `fg=${fg} bg=${bg}`);

  console.log("5) 剪切图 alpha 与掩膜一致");
  const alpha = await readAlpha(cutoutPath);
  check("剪切图带 alpha 且尺寸一致", alpha.width === W && alpha.height === H, `${alpha.width}x${alpha.height}`);
  const ac = alpha.at(Math.floor(W / 2), Math.floor(H / 2));
  check("中心 alpha 不透明", ac > 200, `alpha=${ac}`);
  check("角落 alpha 透明", alpha.at(6, 6) < 40, `alpha=${alpha.at(6, 6)}`);

  console.log("6) 错误路径");
  const missing = await BG.removeBackground({ imagePath: path.join(dataDir, "nope.png") });
  check("源图不存在时明确失败", !missing.ok && missing.error.includes("not found"), JSON.stringify(missing));
  const badModel = await BG.removeBackground({ imagePath: srcPath, model: "does-not-exist" });
  check("未知模型明确失败", !badModel.ok && badModel.error.includes("unknown model"), JSON.stringify(badModel));
  const notReady = await BG.removeBackground({ imagePath: srcPath, model: "u2net" });
  check(
    "未下载的模型明确失败而不是崩溃",
    !notReady.ok && notReady.error.startsWith("model-not-ready:"),
    JSON.stringify(notReady),
  );
} catch (e) {
  failed++;
  console.error(`  ✗ 冒烟中断：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  rmSync(dataDir!, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n抠图冒烟失败：${failed} 项`);
  process.exit(1);
}
console.log("\n抠图冒烟通过");
