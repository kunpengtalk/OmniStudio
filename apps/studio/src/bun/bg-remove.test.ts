/**
 * 抠图引擎纯函数测试。
 *
 * 这里守的都是"跑得通但结果是错的"那类问题：掩膜归一化把背景顶成前景、
 * 盒式滤波串行、引导滤波把边缘糊回去、通道交错读错位。它们不会抛异常，
 * 只会让抠出来的图边缘发毛或整张被抠出来 —— 所以必须有数值断言。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  BG_MODELS,
  DEFAULT_BG_MODEL,
  bgModelPath,
  bgModelSpec,
  boxFilter,
  isBgModelReady,
  isDownloadInFlight,
  listBgModels,
  luminanceOf,
  mergeAlpha,
  normalizeMask,
  refineMask,
  softThreshold,
} from "./bg-remove";

/** 把 1 通道数组当掩膜看：算均值与"高置信前景"占比。 */
function stats(a: Float32Array) {
  let sum = 0;
  let high = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] ?? 0;
    if ((a[i] ?? 0) > 0.5) high += 1;
  }
  return { mean: sum / a.length, highRatio: high / a.length };
}

describe("normalizeMask", () => {
  test("已是 0..1 的概率时原样返回，不做 min/max 拉伸", () => {
    // 全图最大只有 0.6（没有显著主体）：拉伸会把 0.6 顶成 1，等于把背景判成前景
    const raw = new Float32Array([0, 0.1, 0.3, 0.6, 0.6, 0.2]);
    const out = normalizeMask(raw);
    const want = [0, 0.1, 0.3, 0.6, 0.6, 0.2];
    for (let i = 0; i < want.length; i += 1) expect(out[i]!).toBeCloseTo(want[i]!, 6);
  });

  test("超出 [0,1] 的 logits 按自身 min/max 拉伸", () => {
    const out = normalizeMask(new Float32Array([-3, 0, 5]));
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(3 / 8, 6);
    expect(out[2]).toBeCloseTo(1, 6);
  });

  test("常数输入不会除零，返回全 0", () => {
    const out = normalizeMask(new Float32Array([5, 5, 5]));
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  test("概率输入里的轻微越界被 clamp（不触发拉伸）", () => {
    // 0.02 的越界在容差内：应当 clamp 而不是当成 logits 拉伸
    const out = normalizeMask(new Float32Array([-0.02, 0.5, 1.02, 1.0]));
    expect(Array.from(out)).toEqual([0, 0.5, 1, 1]);
  });

  test("明显越过容差才走拉伸分支", () => {
    const out = normalizeMask(new Float32Array([-1, 0, 1]));
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(1, 6);
  });
});

describe("softThreshold", () => {
  test("过渡带外压成 0/1，带内单调", () => {
    const out = softThreshold(new Float32Array([0, 0.25, 0.5, 0.75, 1]), 0.25, 0.75);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(0.5, 6);
    expect(out[3]).toBe(1);
    expect(out[4]).toBe(1);
  });

  test("整体单调不减（smoothstep 不应出现回落）", () => {
    const input = new Float32Array(64);
    for (let i = 0; i < 64; i += 1) input[i] = i / 63;
    const out = softThreshold(input, 0.3, 0.7);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
    }
  });

  test("lo=hi 时退化成硬阈值", () => {
    const out = softThreshold(new Float32Array([0.4, 0.6]), 0.5, 0.5);
    expect(Array.from(out)).toEqual([0, 1]);
  });
});

describe("boxFilter", () => {
  test("常数图滤波后仍是常数（边界不衰减）", () => {
    const src = new Float32Array(8 * 6).fill(0.5);
    const out = boxFilter(src, 8, 6, 2);
    for (const v of out) expect(v).toBeCloseTo(0.5, 6);
  });

  test("脉冲在半径 1 内摊成均匀 1/9，范围外为 0", () => {
    const W = 8;
    const H = 6;
    const src = new Float32Array(W * H);
    src[3 * W + 3] = 1;
    const out = boxFilter(src, W, H, 1);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const want = Math.abs(x - 3) <= 1 && Math.abs(y - 3) <= 1 ? 1 / 9 : 0;
        expect(out[y * W + x]!).toBeCloseTo(want, 5);
      }
    }
  });

  test("半径 0 是恒等变换", () => {
    const src = new Float32Array([1, 2, 3, 4]);
    expect(Array.from(boxFilter(src, 2, 2, 0))).toEqual([1, 2, 3, 4]);
  });

  test("纵向渐变：每一行内必须均匀（纵向那一趟没有串行）", () => {
    const W = 6;
    const H = 6;
    const src = new Float32Array(W * H);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) src[y * W + x] = y;
    const out = boxFilter(src, W, H, 1);
    for (let y = 0; y < H; y += 1) {
      const first = out[y * W]!;
      for (let x = 0; x < W; x += 1) expect(out[y * W + x]!).toBeCloseTo(first, 5);
    }
    // 中间行应是上下邻域均值
    expect(out[2 * W]!).toBeCloseTo(2, 5);
  });

  test("横向渐变：每一列内必须均匀（横向那一趟没有串行）", () => {
    const W = 6;
    const H = 6;
    const src = new Float32Array(W * H);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) src[y * W + x] = x;
    const out = boxFilter(src, W, H, 1);
    for (let x = 0; x < W; x += 1) {
      const first = out[x]!;
      for (let y = 0; y < H; y += 1) expect(out[y * W + x]!).toBeCloseTo(first, 5);
    }
  });
});

describe("refineMask", () => {
  const W = 40;
  const H = 40;

  test("strength=0 原样返回（不复制也不改动）", () => {
    const guide = new Float32Array(W * H).fill(0.5);
    const mask = new Float32Array(W * H).fill(0.4);
    expect(refineMask(guide, mask, W, H, 0)).toBe(mask);
  });

  test("输出始终落在 [0,1]（引导滤波会外推出界，必须夹住）", () => {
    const guide = new Float32Array(W * H);
    const mask = new Float32Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        guide[y * W + x] = x < W / 2 ? 0 : 1;
        mask[y * W + x] = x < W / 2 ? 0.35 : 0.65;
      }
    }
    const out = refineMask(guide, mask, W, H, 0.8);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("以硬边为导向时收窄软过渡带（这才是'边缘优化'）", () => {
    const S = 200;
    const stepAt = 100;
    // 12px 宽的软过渡 —— 模拟模型掩膜从 320 升采样回大图后的样子
    const band = 12;
    const guide = new Float32Array(S * S);
    const mask = new Float32Array(S * S);
    for (let y = 0; y < S; y += 1) {
      for (let x = 0; x < S; x += 1) {
        guide[y * S + x] = x < stepAt ? 0.2 : 0.8;
        const t = Math.min(1, Math.max(0, (x - (stepAt - band / 2)) / band));
        mask[y * S + x] = 0.2 + 0.6 * t;
      }
    }
    const out = refineMask(guide, mask, S, S, 1);
    const mid = Math.floor(S / 2) * S;

    // 远离边缘的平坦区应当基本不变（没有边缘可依，不该被无端改动）
    expect(out[mid + 5]!).toBeCloseTo(mask[mid + 5]!, 2);
    expect(out[mid + S - 6]!).toBeCloseTo(mask[mid + S - 6]!, 2);

    // 过渡带内：含糊像素（0.35..0.65）应当变少 = 边缘更锐
    const ambiguous = (a: Float32Array) => {
      let n = 0;
      for (let x = stepAt - band; x <= stepAt + band; x += 1) {
        const v = a[mid + x]!;
        if (v > 0.35 && v < 0.65) n += 1;
      }
      return n;
    };
    expect(ambiguous(out)).toBeLessThan(ambiguous(mask));
  });

  test("输出长度与输入一致（升采样后掩膜与像素数对齐，不能出现 3 倍长）", () => {
    const guide = new Float32Array(W * H).fill(0.5);
    const mask = new Float32Array(W * H).fill(0.4);
    expect(refineMask(guide, mask, W, H, 0.5).length).toBe(W * H);
  });

  test("平坦区（无边缘）几乎不改变掩膜", () => {
    const guide = new Float32Array(W * H).fill(0.5);
    const mask = new Float32Array(W * H).fill(0.5);
    const out = refineMask(guide, mask, W, H, 0.5);
    for (const v of out) expect(v).toBeCloseTo(0.5, 2);
  });
});

describe("luminanceOf / mergeAlpha", () => {
  test("亮度按 Rec.709 加权", () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const lum = luminanceOf(rgb, 4);
    expect(lum[0]!).toBeCloseTo(0.2126, 3);
    expect(lum[1]!).toBeCloseTo(0.7152, 3);
    expect(lum[2]!).toBeCloseTo(0.0722, 3);
    expect(lum[3]!).toBeCloseTo(1, 3);
  });

  test("mergeAlpha 按 RGBA 交错写入", () => {
    const rgb = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const alpha = new Uint8Array([255, 128]);
    expect(Array.from(mergeAlpha(rgb, alpha, 2))).toEqual([10, 20, 30, 255, 40, 50, 60, 128]);
  });
});

describe("模型清单", () => {
  test("默认模型在清单里且已声明字节数", () => {
    const spec = bgModelSpec(DEFAULT_BG_MODEL);
    expect(spec).toBeDefined();
    expect(spec!.bytes).toBeGreaterThan(0);
    expect(spec!.inputSize).toBeGreaterThan(0);
  });

  test("inputSize 是 320 / 1024 之一（导出图里写死，喂别的尺寸会直接报错）", () => {
    for (const spec of BG_MODELS) expect([320, 1024]).toContain(spec.inputSize);
  });

  test("id 不重复、都是 Apache-2.0 可商用", () => {
    const ids = BG_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of BG_MODELS) expect(spec.license).toBe("Apache-2.0");
  });

  test("未知模型返回 undefined / null，不抛异常", () => {
    expect(bgModelSpec("nope")).toBeUndefined();
    expect(bgModelPath("nope")).toBeNull();
  });

  test("路径穿越的 id 不会落到模型目录外", () => {
    expect(bgModelPath("../../omni-studio.db")).toBeNull();
    expect(bgModelPath("../silueta.onnx")).toBeNull();
  });

  test("没下载时 ready=false，localBytes=0", () => {
    const statuses = listBgModels();
    expect(statuses.length).toBe(BG_MODELS.length);
    for (const s of statuses) {
      // 测试数据目录是隔离的临时目录，任何模型都不该就绪
      expect(s.ready).toBe(false);
      expect(s.localBytes).toBe(0);
    }
    expect(isBgModelReady(DEFAULT_BG_MODEL)).toBe(false);
  });
});

/**
 * 回归：下载器一上来就把最终文件 `ftruncate` 到完整长度，所以**文件长度不是进度**。
 * 只按长度判就绪，会让"44MB 全零、一片都没下进来"的文件被当成可用：小应用收起
 * 下载卡片、放行「抠图」，用户拿到的是一句
 * `Failed to load model because protobuf parsing failed`（实测踩过）。
 */
describe("就绪判定与进度（预分配文件不算已下载）", () => {
  const spec = bgModelSpec(DEFAULT_BG_MODEL)!;
  const dest = bgModelPath(DEFAULT_BG_MODEL)!;
  const sidecar = `${dest}.download.json`;

  function writeSidecar(flushed: number, have: number) {
    writeFileSync(
      sidecar,
      JSON.stringify({
        url: "https://example.com/silueta.onnx",
        total: spec.bytes,
        etag: '"x"',
        flushed,
        parts: [{ index: 0, start: 0, end: spec.bytes, have }],
      }),
    );
  }

  test("预分配到完整长度但没搬进内容：不就绪，进度按侧车算", () => {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.alloc(spec.bytes)); // 全 0，长度却是"完整"的
    writeSidecar(0, 0);

    expect(isDownloadInFlight(DEFAULT_BG_MODEL)).toBe(true);
    expect(isBgModelReady(DEFAULT_BG_MODEL)).toBe(false);
    expect(listBgModels().find((m) => m.id === DEFAULT_BG_MODEL)!.localBytes).toBe(0);
  });

  test("下到一半：进度是已搬移 + 分片字节数，不是文件长度", () => {
    writeSidecar(1_000_000, 500_000);
    const status = listBgModels().find((m) => m.id === DEFAULT_BG_MODEL)!;
    expect(status.localBytes).toBe(1_500_000);
    expect(status.ready).toBe(false);
    expect(isBgModelReady(DEFAULT_BG_MODEL)).toBe(false);
  });

  test("下载完成（下载器删掉侧车）后，长度才是可信的就绪判据", () => {
    rmSync(sidecar, { force: true });
    expect(isDownloadInFlight(DEFAULT_BG_MODEL)).toBe(false);
    expect(isBgModelReady(DEFAULT_BG_MODEL)).toBe(true);
    expect(listBgModels().find((m) => m.id === DEFAULT_BG_MODEL)!.localBytes).toBe(spec.bytes);
    // 收尾：临时目录里的这份假文件别留给后面的用例
    rmSync(dest, { force: true });
  });

  test("侧车记录的总长与清单不符（远端换了版本）→ 进度归零，等于没下过", () => {
    writeFileSync(dest, Buffer.alloc(spec.bytes));
    writeSidecar(0, 100);
    writeFileSync(
      sidecar,
      JSON.stringify({
        url: "https://example.com/silueta.onnx",
        total: spec.bytes + 100_000,
        etag: '"y"',
        flushed: 4_000_000,
        parts: [{ index: 0, start: 0, end: spec.bytes + 100_000, have: 4_000_000 }],
      }),
    );
    expect(listBgModels().find((m) => m.id === DEFAULT_BG_MODEL)!.localBytes).toBe(0);
    rmSync(dest, { force: true });
    rmSync(sidecar, { force: true });
  });
});

describe("stats helper sanity", () => {
  test("自检：stats 对已知数组算得对（防止测试自身的判据写错）", () => {
    const s = stats(new Float32Array([0, 0, 1, 1]));
    expect(s.mean).toBeCloseTo(0.5, 6);
    expect(s.highRatio).toBeCloseTo(0.5, 6);
  });
});
