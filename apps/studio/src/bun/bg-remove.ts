/**
 * 本地抠图引擎（去背景 / 换背景）。
 *
 * 与 BgSub 那条路线一致：**分割模型在本机跑，图片不出进程**。差别只在运行时——
 * 它在浏览器 Worker 里跑一份 Emscripten 编译的 ONNX Runtime，我们跑
 * `onnxruntime-web` 的 WASM 后端（主进程内）。选 WASM 而不是
 * `onnxruntime-node` 是打包决定的：后者一个包 291MB（含全平台 .so/.dll/.dylib），
 * 且 `bin/napi-v6/<平台>/libonnxruntime.so.1` 的载荷路径会越过
 * electrobun.config.ts 的 100 字符 tar 上限，Linux/Windows 直接构建失败。
 * WASM 一份 14MB 全平台通用，代价是单线程约 0.9s/次（u2netp @320），够用。
 *
 * 两段式设计（这是抠图工具好不好用的关键）：
 *   1. `removeBackground()` 跑模型，落盘**剪切图**（带 alpha 的 PNG）与**灰度掩膜**；
 *   2. 之后换背景、擦除/复原笔刷全在前端画布上做，不再跑模型。
 * 模型一次、编辑无限次 —— 否则每换一次底色等 1 秒，笔刷就没法用了。
 *
 * 掩膜分辨率说明：u2net 系模型的输入是**固定** 320×320（isnet 系固定 1024），
 * 与图片本身多大无关。所以掩膜升采样回原图尺寸后边缘必然偏软，靠
 * `refineMask()` 的引导滤波（以原图亮度为导向）把边缘贴回真实轮廓 ——
 * 这就是各家"边缘优化"按钮的实质。
 */

import { existsSync, mkdirSync } from "fs";
import path from "path";
import sharp from "sharp";
import { getDataDir } from "./paths";
import { safeJoin } from "./path-safety";
import { logEvent } from "./app-log";
import { downloadHttpFile } from "./modelscope";
import { partialBytesFor, removePartialFiles } from "./downloader";

// ---------------------------------------------------------------------------
// 模型清单
// ---------------------------------------------------------------------------

/**
 * 权重来源：rembg 的 GitHub release（u2net 家族，Apache-2.0）。
 * 每个模型给两个源：GitHub 直连 + hf-mirror 镜像。国内网络下 GitHub 经常连不上，
 * 换源时 `downloadHttpFile` 会保留已下载分片从断点续传，不会从头再来。
 */
const RELEASE_BASE = "https://github.com/danielgatis/rembg/releases/download/v0.0.0";
const HF_MIRROR = "https://hf-mirror.com/tomjackson2023/rembg/resolve/main";
const HF_OFFICIAL = "https://huggingface.co/tomjackson2023/rembg/resolve/main";

export type BgModelTier = "fast" | "balanced" | "quality" | "detail";

export interface BgModelSpec {
  id: string;
  /** 权重文件名，同时也是落盘名。 */
  file: string;
  /** 线上字节数：用来显示"要下多少"、判断本地那份是否完整。 */
  bytes: number;
  /**
   * 模型**固定**输入边长。这不是可调参数：u2net 系导出时 batch/height/width 都是
   * 写死的，喂 512 会直接报 "Got invalid dimensions for input"。
   */
  inputSize: number;
  tier: BgModelTier;
  license: string;
}

export const BG_MODELS: BgModelSpec[] = [
  {
    id: "u2netp",
    file: "u2netp.onnx",
    bytes: 4_574_861,
    inputSize: 320,
    tier: "fast",
    license: "Apache-2.0",
  },
  {
    id: "silueta",
    file: "silueta.onnx",
    bytes: 44_173_029,
    inputSize: 320,
    tier: "balanced",
    license: "Apache-2.0",
  },
  {
    id: "u2net",
    file: "u2net.onnx",
    bytes: 175_997_641,
    inputSize: 320,
    tier: "quality",
    license: "Apache-2.0",
  },
  {
    id: "isnet-general-use",
    file: "isnet-general-use.onnx",
    bytes: 178_648_008,
    inputSize: 1024,
    tier: "detail",
    license: "Apache-2.0",
  },
];

/**
 * 默认模型取 silueta 而不是最快的 u2netp：u2netp 只有 4.5MB，发丝和半透明边缘
 * 会成块状，抠图工具第一次用就出这种结果等于劝退。44MB 的 silueta 是同一架构
 * 训得更充分的版本，质量对得起多出来的下载时间。
 */
export const DEFAULT_BG_MODEL = "silueta";

export function bgModelSpec(id: string): BgModelSpec | undefined {
  return BG_MODELS.find((m) => m.id === id);
}

function sourcesFor(spec: BgModelSpec): string[] {
  return [`${RELEASE_BASE}/${spec.file}`, `${HF_MIRROR}/${spec.file}`, `${HF_OFFICIAL}/${spec.file}`];
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function bgEngineDir(): string {
  return getDataDir("engines", "bgremove");
}

export function bgModelDir(): string {
  return path.join(bgEngineDir(), "models");
}

/** 权重落盘路径；id 来自 RPC，越界一律返回 null 交给调用方当参数错误处理。 */
export function bgModelPath(id: string): string | null {
  const spec = bgModelSpec(id);
  if (!spec) return null;
  return safeJoin(bgModelDir(), spec.file);
}

export interface BgModelStatus {
  id: string;
  bytes: number;
  inputSize: number;
  tier: BgModelTier;
  license: string;
  ready: boolean;
  /** 真实已下载字节数（未下载为 0）；进度条与"就绪"都看它，**不看文件长度**。 */
  localBytes: number;
}

/**
 * 真实已下载字节数。
 *
 * **不能用 `statSync(dest).size`**：下载器一开始就把最终文件 `ftruncate` 到完整长度，
 * 于是"长度够了"和"内容下完了"完全是两回事。这么写过的后果是实测踩到的——
 * 44MB 的 silueta 刚建好文件（内容全是 0）就被判成已就绪，小应用把下载卡片收起来、
 * 放行了「抠图」，用户点下去拿到的是 ort 的
 * `Failed to load model because protobuf parsing failed`（没人能从这句话看出是没下完）。
 *
 * `partialBytesFor` 才是权威口径：有侧车（`.download.json`）时用侧车记录的
 * 已搬移前缀 + 分片字节数（下载完成时下载器会删掉侧车，那时两者一致）。
 */
export function downloadedBytesOf(dest: string, total: number): number {
  try {
    return Math.min(total, partialBytesFor(dest, total));
  } catch {
    return 0;
  }
}

/** 下载还在进行中吗（侧车在 = 没下完）。用于区分"下了一半"与"文件真的是坏的"。 */
export function isDownloadInFlight(id: string): boolean {
  const dest = bgModelPath(id);
  return Boolean(dest && existsSync(`${dest}.download.json`));
}

export function listBgModels(): BgModelStatus[] {
  return BG_MODELS.map((spec) => {
    const dest = bgModelPath(spec.id);
    const localBytes = dest ? downloadedBytesOf(dest, spec.bytes) : 0;
    // 只比"够不够"不比"相等"：远端换过版本时大小会变，下不完的文件不能被当成可用。
    return {
      id: spec.id,
      bytes: spec.bytes,
      inputSize: spec.inputSize,
      tier: spec.tier,
      license: spec.license,
      ready: localBytes >= spec.bytes,
      localBytes,
    };
  });
}

export function isBgModelReady(id: string): boolean {
  const spec = bgModelSpec(id);
  const dest = bgModelPath(id);
  if (!spec || !dest) return false;
  return downloadedBytesOf(dest, spec.bytes) >= spec.bytes;
}

/** 任意一个可用的模型 id（优先默认模型）。没下过任何模型时返回 null。 */
export function anyReadyModel(): string | null {
  if (isBgModelReady(DEFAULT_BG_MODEL)) return DEFAULT_BG_MODEL;
  const ready = BG_MODELS.find((m) => isBgModelReady(m.id));
  return ready ? ready.id : null;
}

export interface BgDownloadProgress {
  model: string;
  loaded: number;
  total: number;
  /** 0..100；总长度未知时为 0，UI 应退化成不确定进度条。 */
  percent: number;
}

/**
 * 下载权重。多源 + 断点续传 + 进度都在 downloader 内核里，这里只做源轮换。
 */
export async function downloadBgModel(
  id: string,
  options: {
    onProgress?: (p: BgDownloadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: true; path: string; size: number } | { ok: false; error: string }> {
  const spec = bgModelSpec(id);
  const dest = bgModelPath(id);
  if (!spec || !dest) {
    return { ok: false, error: `unknown model: ${id}` };
  }
  if (isBgModelReady(id)) {
    return { ok: true, path: dest, size: spec.bytes };
  }
  mkdirSync(path.dirname(dest), { recursive: true });

  const sources = sourcesFor(spec);
  let lastError = "download failed";
  for (const url of sources) {
    try {
      const res = await downloadHttpFile(
        url,
        dest,
        (progress) => {
          // downloader 的 total/percent 在服务端没给 Content-Length 时是 null，
          // 这时退回清单里声明的字节数，至少让进度条有确定的分母。
          const total = progress.total ?? spec.bytes;
          const percent =
            progress.percent ??
            (total > 0 ? Math.min(100, Math.round((progress.received / total) * 100)) : 0);
          options.onProgress?.({
            model: id,
            loaded: progress.received,
            total,
            percent,
          });
        },
        options.signal,
      );
      logEvent({
        level: "info",
        source: "image",
        event: "bgremove.model.downloaded",
        message: `抠图模型下载完成：${id}`,
        detail: { model: id, bytes: res.size, from: url },
      });
      return { ok: true, path: res.path, size: res.size };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // 用户主动取消就不要再换源重试 —— 他刚点了取消。
      if (options.signal?.aborted) break;
      logEvent({
        level: "warn",
        source: "image",
        event: "bgremove.model.source_failed",
        message: `抠图模型源失败，尝试下一个：${url}`,
        detail: { model: id, error: lastError },
      });
    }
  }

  logEvent({
    level: "error",
    source: "image",
    event: "bgremove.model.download_failed",
    message: `抠图模型下载失败：${id}`,
    detail: { model: id, error: lastError },
  });
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------
// ONNX Runtime（WASM）
// ---------------------------------------------------------------------------

type OrtModule = typeof import("onnxruntime-web");

let ortPromise: Promise<OrtModule> | null = null;

/**
 * WASM 运行时资源（glue .mjs + .wasm）的位置。
 *
 * 打包后主进程被合成单个 `bun/index.js`，`node_modules` 不复存在，所以这两个文件是
 * 由 electrobun.config.ts 复制到 bundle 里 `bun/` 下的 —— 与 `mlx-worker.py` 那套
 * 「以 import.meta.dir 为准」的规则相同。开发时回落到 node_modules。
 *
 * 注意**不能**靠 ort 自己推导 glue 路径：它在 Node 分支下
 * （`Bt()` 里 `j` 为真时直接返回 undefined）压根不走 `import.meta.url` 那条路，
 * 必须由我们显式给 `env.wasm.wasmPaths.mjs`，它才会 `await import(那个 URL)`。
 */
function runtimeAssetDirs(): string[] {
  return [
    import.meta.dir,
    path.join(import.meta.dir, "..", "..", "node_modules", "onnxruntime-web", "dist"),
    path.join(process.cwd(), "node_modules", "onnxruntime-web", "dist"),
  ];
}

const GLUE_FILE = "ort-wasm-simd-threaded.mjs";
const WASM_FILE = "ort-wasm-simd-threaded.wasm";

function findRuntimeAsset(file: string): string | null {
  for (const dir of runtimeAssetDirs()) {
    const candidate = path.join(dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = (await import("onnxruntime-web")) as OrtModule;
      // 单线程：ort 的多线程要 SharedArrayBuffer + Worker 池，Bun 主进程里没有
      // 浏览器那套 worker，开了只会退化成警告或直接抛错。
      ort.env.wasm.numThreads = 1;

      const glue = findRuntimeAsset(GLUE_FILE);
      const wasm = findRuntimeAsset(WASM_FILE);
      if (!glue || !wasm) {
        throw new Error(
          `缺少 ONNX 运行时文件（${GLUE_FILE} / ${WASM_FILE}）——打包时需随主进程一起复制到 bun/ 下`,
        );
      }
      const { pathToFileURL } = await import("node:url");
      ort.env.wasm.wasmPaths = { mjs: pathToFileURL(glue).href };
      // 直接把字节喂进去，省掉一次 14MB 的 fetch：打包环境下 ort 的取文件逻辑
      // 要么走 fetch（views:// 不认）要么走 fs，不如自己读来得确定。
      ort.env.wasm.wasmBinary = await Bun.file(wasm).arrayBuffer();
      return ort;
    })().catch((e) => {
      // 失败后别把坏 Promise 缓存住：用户可能重新装/补文件后想再试。
      ortPromise = null;
      throw e;
    });
  }
  return ortPromise;
}

/**
 * 会话缓存：一次只留一个。
 * u2net 权重 176MB，加上运行时激活缓冲，同时驻留两三个模型在 8GB 机器上会很难看。
 */
let sessionCache: { model: string; session: Promise<import("onnxruntime-web").InferenceSession> } | null =
  null;

async function getSession(modelId: string) {
  if (sessionCache?.model === modelId) return sessionCache.session;
  const dest = bgModelPath(modelId);
  if (!dest || !isBgModelReady(modelId)) throw new Error(`模型未就绪：${modelId}`);
  const ort = await loadOrt();
  const previous = sessionCache?.session;
  const session = ort.InferenceSession.create(await Bun.file(dest).arrayBuffer(), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  sessionCache = { model: modelId, session };
  // 换模型时把旧的释放掉（await 不阻塞当前调用，释放失败也不影响结果）。
  if (previous) void previous.then((s) => s.release?.()).catch(() => {});
  // 建会话失败**不能把坏 Promise 缓存住**：文件坏了 → 清除 → 重新下载之后，
  // 用户点第一次就应该成功，而不是被上一次的失败钉死到重启（loadOrt 同理）。
  void session.catch(() => {
    if (sessionCache?.session === session) sessionCache = null;
  });
  return session;
}

// ---------------------------------------------------------------------------
// 掩膜后处理（纯函数，单独测）
// ---------------------------------------------------------------------------

/**
 * u2net 输出的归一化。
 *
 * 导出图里是否已经带 sigmoid 并不统一：`silueta`/`u2netp` 的输出直接落在 0..1，
 * 而另一些导出是未过激活的 logits。判断方式看值域 —— 已经在 [0,1] 附近就原样用
 * （只 clamp），明显超出才按自身 min/max 拉伸。
 *
 * 不能无条件拉伸：整张图没有显著主体时，输出的最大值可能只有 0.6，min/max 拉伸
 * 会把一片本该书背景的灰噪声顶成不透明，结果是"整张图都被抠出来了"。
 *
 * 留 0.05 的容差而不是严格的 [0,1]：概率输出常带一点数值越界（-0.001 / 1.0002），
 * 拿严格边界判会把一整张概率图误判成 logits 去拉伸。
 */
const PROB_TOLERANCE = 0.05;

export function normalizeMask(raw: Float32Array | number[]): Float32Array {
  const out = new Float32Array(raw.length);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i += 1) {
    const v = raw[i] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // 已经是概率：只做 clamp。
  if (min >= -PROB_TOLERANCE && max <= 1 + PROB_TOLERANCE) {
    for (let i = 0; i < raw.length; i += 1) {
      const v = raw[i] ?? 0;
      out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return out;
  }

  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) {
    out.fill(0);
    return out;
  }
  for (let i = 0; i < raw.length; i += 1) out[i] = ((raw[i] ?? 0) - min) / span;
  return out;
}

/**
 * 软化阈值：把 [lo,hi] 之间的过渡带做 smoothstep，两侧压成 0/1。
 * 模型给的边缘是一段厚过渡带（因为掩膜只有 320×320），不压一下整圈都是灰雾。
 */
export function softThreshold(alpha: Float32Array, lo = 0.25, hi = 0.75): Float32Array {
  const out = new Float32Array(alpha.length);
  const span = hi - lo;
  if (span <= 0) {
    for (let i = 0; i < alpha.length; i += 1) out[i] = (alpha[i] ?? 0) >= hi ? 1 : 0;
    return out;
  }
  for (let i = 0; i < alpha.length; i += 1) {
    const t = Math.min(1, Math.max(0, ((alpha[i] ?? 0) - lo) / span));
    out[i] = t * t * (3 - 2 * t);
  }
  return out;
}

/**
 * 可分离盒式滤波（滑动窗口，每像素 O(1)）。
 * 先横后竖两次一维均值 = 二维均值，半径再大也不掉速 —— 引导滤波要在全分辨率上
 * 跑四五次滤波，用积分图/卷积核都会慢一个量级。
 */
export function boxFilter(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(0, Math.floor(radius));
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  if (r === 0) {
    tmp.set(src);
    out.set(src);
    return out;
  }

  // 横向
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -r; x <= r; x += 1) sum += src[row + Math.min(width - 1, Math.max(0, x))] ?? 0;
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum * inv;
      const outIdx = row + Math.max(0, x - r);
      const inIdx = row + Math.min(width - 1, x + r + 1);
      sum += (src[inIdx] ?? 0) - (src[outIdx] ?? 0);
    }
  }
  // 纵向
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -r; y <= r; y += 1) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x] ?? 0;
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum * inv;
      const outIdx = Math.max(0, y - r) * width + x;
      const inIdx = Math.min(height - 1, y + r + 1) * width + x;
      sum += (tmp[inIdx] ?? 0) - (tmp[outIdx] ?? 0);
    }
  }
  return out;
}

/**
 * 引导滤波（He et al.）——边缘优化。
 *
 * 以原图灰度为导向图、模型掩膜为输入，在局部窗口内做线性拟合后取均值：
 * 结果是"掩膜的取值跟着原图边缘走"。因为窗口内方差大的地方（真实轮廓）几乎
 * 不糊，方差小的地方（平坦区）才会被平均掉，所以能一边抹掉 320×320 升采样留下
 * 的锯齿，一边把发丝/商品边缘找回来。
 *
 * `strength` 0..1 映射到窗口半径与正则项：强度越大边缘越硬，但过大会把
 * 模型本来判断对的半透明区域（纱、烟、玻璃）也切成硬边。
 */
export function refineMask(
  guide: Float32Array,
  mask: Float32Array,
  width: number,
  height: number,
  strength = 0.5,
): Float32Array {
  const s = Math.min(1, Math.max(0, strength));
  if (s === 0) return mask;
  // 半径随图片短边走：固定像素半径在 400px 和 4000px 的图上完全是两种效果。
  const radius = Math.max(1, Math.round((Math.min(width, height) / 100) * s));
  const eps = 1e-4 + s * 1e-2;

  const meanGuide = boxFilter(guide, width, height, radius);
  const meanMask = boxFilter(mask, width, height, radius);

  const guideSq = new Float32Array(guide.length);
  const guideMask = new Float32Array(guide.length);
  for (let i = 0; i < guide.length; i += 1) {
    guideSq[i] = (guide[i] ?? 0) * (guide[i] ?? 0);
    guideMask[i] = (guide[i] ?? 0) * (mask[i] ?? 0);
  }
  const meanGuideSq = boxFilter(guideSq, width, height, radius);
  const meanGuideMask = boxFilter(guideMask, width, height, radius);

  const a = new Float32Array(guide.length);
  const b = new Float32Array(guide.length);
  for (let i = 0; i < guide.length; i += 1) {
    const mg = meanGuide[i] ?? 0;
    const varGuide = (meanGuideSq[i] ?? 0) - mg * mg;
    const cov = (meanGuideMask[i] ?? 0) - mg * (meanMask[i] ?? 0);
    const ai = cov / (varGuide + eps);
    a[i] = ai;
    b[i] = (meanMask[i] ?? 0) - ai * mg;
  }

  const meanA = boxFilter(a, width, height, radius);
  const meanB = boxFilter(b, width, height, radius);
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    const v = (meanA[i] ?? 0) * (guide[i] ?? 0) + (meanB[i] ?? 0);
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

/** 灰度导向图（Rec.709 亮度），输入是 sharp 的 RGB raw。 */
export function luminanceOf(rgb: Uint8Array | Buffer, pixels: number): Float32Array {
  const out = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const r = rgb[i * 3] ?? 0;
    const g = rgb[i * 3 + 1] ?? 0;
    const b = rgb[i * 3 + 2] ?? 0;
    out[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  return out;
}

/** RGB + 单通道 alpha → RGBA buffer（sharp 要 4 通道 raw 才认）。 */
export function mergeAlpha(rgb: Uint8Array | Buffer, alpha: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    out[i * 4] = rgb[i * 3] ?? 0;
    out[i * 4 + 1] = rgb[i * 3 + 1] ?? 0;
    out[i * 4 + 2] = rgb[i * 3 + 2] ?? 0;
    out[i * 4 + 3] = alpha[i] ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 推理
// ---------------------------------------------------------------------------

export interface BgRemoveOptions {
  /** 源图绝对路径（调用方负责用 imageRef 解析并校验过）。 */
  imagePath: string;
  /** 模型 id；不传用默认模型，未下载则报错。 */
  model?: string;
  /**
   * 工作分辨率上限（长边）。模型输入是固定的，这里限制的是**解码/合成/编码**的尺寸：
   * 4000×3000 的图做交互预览没必要按原尺寸编 PNG。不传 = 原尺寸。
   */
  maxSize?: number;
  /** 边缘优化强度 0..1，默认 0.5；0 = 关闭。 */
  refine?: number;
}

export interface BgRemoveResult {
  /** images/ 下的相对 ref（喂给 image server / 记录用）。 */
  cutoutRef: string;
  cutoutUrl: string;
  /** 灰度掩膜（白=前景）。前端靠它做笔刷与实时换底，不必再跑模型。 */
  maskRef: string;
  maskUrl: string;
  width: number;
  height: number;
  model: string;
  /** 纯模型耗时，不含落盘。 */
  inferenceMs: number;
  totalMs: number;
}

/** 模型输入张量：按模型固定尺寸**拉伸**成正方形（与训练/导出时的预处理一致）。 */
function buildInputTensor(
  rgb: Uint8Array | Buffer,
  inputSize: number,
): Float32Array {
  // sharp 已经把图缩到 inputSize×inputSize；这里只做归一化。
  // u2net 的预处理是 ImageNet 均值方差后除最大值，不是简单 /255。
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const max = 1;
  const pixels = inputSize * inputSize;
  const out = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const v = ((rgb[i * 3 + c] ?? 0) / 255 - mean[c]!) / std[c]! / max;
      out[c * pixels + i] = v;
    }
  }
  return out;
}

/**
 * 掩膜（0..1 浮点）落成 8 位灰度 PNG 再让 sharp 升采样回原尺寸。
 *
 * 读回来时**必须按 sharp 实际给的通道数走**：喂 1 通道 raw 进去，sharp 的
 * resize 输出仍可能是 3 通道（灰度被复制到 R/G/B），此时 buffer 长度是
 * `像素数 × 3`。当成单通道读会拿到 3 倍长的数组 —— 掩膜只覆盖图上一条、且按
 * 通道交错，表现是"抠出来的边缘全是横向毛刺"。这个坑踩过一次，别再假设通道数。
 */
async function resizeMask(
  mask: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Promise<Float32Array> {
  const u8 = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    const v = mask[i] ?? 0;
    u8[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  const { data, info } = await sharp(Buffer.from(u8), { raw: { width: srcW, height: srcH, channels: 1 } })
    .resize(dstW, dstH, { fit: "fill", kernel: "cubic" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = Math.max(1, info.channels);
  const pixels = dstW * dstH;
  const out = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) out[i] = (data[i * channels] ?? 0) / 255;
  return out;
}

/**
 * 跑一次抠图：解码 → 模型 → 掩膜后处理 → 落盘剪切图 + 掩膜。
 * 不做背景合成 —— 那是前端画布的事（见文件头"两段式设计"）。
 */
export async function removeBackground(
  options: BgRemoveOptions,
): Promise<{ ok: true; result: BgRemoveResult } | { ok: false; error: string }> {
  const started = Date.now();
  const modelId = options.model ?? anyReadyModel() ?? DEFAULT_BG_MODEL;
  const spec = bgModelSpec(modelId);
  if (!spec) return { ok: false, error: `unknown model: ${modelId}` };
  if (!isBgModelReady(modelId)) return { ok: false, error: `model-not-ready:${modelId}` };
  if (!existsSync(options.imagePath)) return { ok: false, error: `image not found: ${options.imagePath}` };

  try {
    // 1) 解码 + 降到工作分辨率（保持长宽比）
    const maxSize = options.maxSize && options.maxSize > 0 ? Math.floor(options.maxSize) : null;
    let pipeline = sharp(options.imagePath).rotate(); // rotate() 无参 = 按 EXIF 摆正
    const meta = await pipeline.metadata();
    if (maxSize && meta.width && meta.height && Math.max(meta.width, meta.height) > maxSize) {
      pipeline = pipeline.resize({ width: maxSize, height: maxSize, fit: "inside" });
    }
    const { data: rgb, info } = await pipeline.removeAlpha().toColourspace("srgb").raw().toBuffer({
      resolveWithObject: true,
    });
    const width = info.width;
    const height = info.height;
    const pixels = width * height;
    // 下游全部按 RGB 三通道取字节。sharp 这里正常就是 3（removeAlpha + srgb），
    // 但一旦不是，之后的取值会整体错位却仍然"跑得通"—— 与其产出错图，不如当场停下。
    if (info.channels !== 3) {
      throw new Error(`源图解码得到 ${info.channels} 通道，期望 3（RGB）`);
    }

    // 2) 模型输入：拉伸到固定尺寸（与 rembg 的预处理一致）
    const modelInput = await sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } })
      .resize(spec.inputSize, spec.inputSize, { fit: "fill", kernel: "linear" })
      .raw()
      .toBuffer();

    const ort = await loadOrt();
    const session = await getSession(modelId);
    const tensor = new ort.Tensor("float32", buildInputTensor(modelInput, spec.inputSize), [
      1,
      3,
      spec.inputSize,
      spec.inputSize,
    ]);

    const inferenceStart = Date.now();
    // 第一路输出是 u2net 的融合头 d0；后面 6 路是各层侧输出，不用。
    const outputs = await session.run({ [session.inputNames[0]!]: tensor });
    const inferenceMs = Date.now() - inferenceStart;
    const primary = outputs[session.outputNames[0]!];
    if (!primary) return { ok: false, error: "model returned no output" };

    // 3) 掩膜：归一化 → 升采样回工作分辨率 → 软化阈值 → 边缘优化
    let mask = normalizeMask(primary.data as Float32Array);
    mask = await resizeMask(mask, spec.inputSize, spec.inputSize, width, height);
    mask = softThreshold(mask);
    const strength = options.refine ?? 0.5;
    if (strength > 0) {
      mask = refineMask(luminanceOf(rgb, pixels), mask, width, height, strength);
    }

    // 4) 落盘：剪切图（RGBA PNG）+ 灰度掩膜
    const outDir = path.join(getDataDir("images"), "bgremove");
    mkdirSync(outDir, { recursive: true });
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const cutoutName = `${stamp}-cutout.png`;
    const maskName = `${stamp}-mask.png`;
    const cutoutPath = path.join(outDir, cutoutName);
    const maskPath = path.join(outDir, maskName);

    const alpha = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i += 1) {
      const v = mask[i] ?? 0;
      alpha[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
    await sharp(mergeAlpha(rgb, alpha, pixels), { raw: { width, height, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toFile(cutoutPath);
    await sharp(Buffer.from(alpha), { raw: { width, height, channels: 1 } })
      .png({ compressionLevel: 9 })
      .toFile(maskPath);

    const result: BgRemoveResult = {
      cutoutRef: `bgremove/${cutoutName}`,
      cutoutUrl: "",
      maskRef: `bgremove/${maskName}`,
      maskUrl: "",
      width,
      height,
      model: modelId,
      inferenceMs,
      totalMs: Date.now() - started,
    };
    logEvent({
      level: "info",
      source: "image",
      event: "bgremove.done",
      message: `抠图完成：${width}×${height}（${modelId}）`,
      detail: { model: modelId, width, height, inferenceMs, totalMs: result.totalMs },
    });
    return { ok: true, result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const cleared = clearCorruptModel(modelId, message);
    logEvent({
      level: "error",
      source: "image",
      event: "bgremove.failed",
      message: `抠图失败：${message}`,
      detail: { model: modelId, imagePath: options.imagePath, error: message, cleared },
    });
    return {
      ok: false,
      error: cleared
        ? `模型文件已损坏（${modelId}），已清除，请在模型列表里重新下载`
        : message,
    };
  }
}

/**
 * 建会话失败且报的是 protobuf 解析错误 = 盘上那份权重不是有效 ONNX。
 *
 * 只要它**不在下载中**（没有侧车），就是写坏/被换过的死文件：留着它，用户点多少次
 * 都是同一句英文报错，所以直接清掉，让界面回到"可以下载"的状态。
 * 下载中的绝不能删 —— 那正是断点续传的成果（删了要重下几十上百 MB）。
 */
const CORRUPT_MODEL_ERROR =
  /protobuf parsing failed|invalid protobuf|Failed to load model|INVALID_PROTOBUF/i;

function clearCorruptModel(id: string, message: string): boolean {
  if (!CORRUPT_MODEL_ERROR.test(message)) return false;
  if (isDownloadInFlight(id)) return false;
  const dest = bgModelPath(id);
  if (!dest) return false;
  try {
    removePartialFiles(dest);
    logEvent({
      level: "warn",
      source: "image",
      event: "bgremove.model.corrupt",
      message: `抠图模型文件损坏，已清除：${id}`,
      detail: { model: id, error: message },
    });
    return true;
  } catch {
    return false;
  }
}

/** 测试用：丢掉会话缓存与运行时单例。 */
export function resetBgRuntime(): void {
  sessionCache = null;
  ortPromise = null;
}
