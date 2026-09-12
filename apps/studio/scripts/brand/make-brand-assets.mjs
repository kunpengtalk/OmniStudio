// 生成 OmniStudio 品牌资源（app 图标各尺寸、icns、应用内 logo、landing/README logo、favicon）。
//
//   node scripts/brand/make-brand-assets.mjs preview            # 三个方向的对比图（/tmp/brand）
//   node scripts/brand/make-brand-assets.mjs emit <variant>     # 落地某个方向到仓库各资源位
//
// 标记（mark）= 圆角方形环（squircle ring），与 tile 同为超椭圆，形成同形呼应。
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "../../../.."); // repo root
const STUDIO = path.join(ROOT, "apps/studio");
const OUT_TMP = "/tmp/brand";

// ---------- 几何 ----------
// 1024 画布上，macOS 图标网格：图标体 824×824 居中（Apple HIG），连续圆角用超椭圆近似。
const CANVAS = 1024;
const TILE_HALF = 412;
const RING_HALF = 240;
const HOLE_HALF = 139;
const SE = 5; // 超椭圆指数

/** 超椭圆（squircle）路径，n=5 接近 Apple 连续圆角。 */
function squircle(cx, cy, a, n = SE, steps = 480) {
  const pts = [];
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = cx + a * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = cy + a * Math.sign(s) * Math.abs(s) ** (2 / n);
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

// ---------- 方向 ----------
const VARIANTS = {
  // 墨：近黑底 + 纯白环，安静、贴单色 UI，dock 里辨识度最高
  ink: {
    label: "Ink · 墨底白环",
    tile: "#101015",
    sheen: 0.12,
    ring: ["#FFFFFF", "#FFFFFF"],
    border: "rgba(255,255,255,0.12)",
  },
  // 光谱：墨底 + 靛蓝→青 渐变环
  spectrum: {
    label: "Spectrum · 渐变环",
    tile: "#0E0E12",
    sheen: 0.10,
    ring: ["#8B9BFF", "#2FD4F2"],
    border: "rgba(255,255,255,0.10)",
  },
  // 靛蓝：饱和底色 + 白环，彩色方案
  indigo: {
    label: "Indigo · 靛蓝底白环",
    tile: "#4F46E5",
    tileGrad: ["#6366F1", "#4338CA"],
    sheen: 0.20,
    ring: ["#FFFFFF", "#EEF0FF"],
    border: null,
  },
};

const cx = CANVAS / 2;
const cy = CANVAS / 2;

function svgFor(variant, size = CANVAS) {
  const v = VARIANTS[variant];
  const s = size / CANVAS; // 统一缩放
  const ringGrad = v.ring
    .map((c, i) => `<stop offset="${((i / (v.ring.length - 1)) * 100).toFixed(0)}%" stop-color="${c}"/>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    ${
      v.tileGrad
        ? `<linearGradient id="tile" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0%" stop-color="${v.tileGrad[0]}"/><stop offset="100%" stop-color="${v.tileGrad[1]}"/></linearGradient>`
        : `<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${v.tile}"/><stop offset="100%" stop-color="${v.tile}"/></linearGradient>`
    }
    <linearGradient id="ring" x1="0" y1="0" x2="0.1" y2="1">${ringGrad}</linearGradient>
    <radialGradient id="sheen" cx="0.5" cy="0.06" r="0.85">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="${v.sheen}"/>
      <stop offset="55%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="9" stdDeviation="15" flood-color="#000000" flood-opacity="0.26"/>
    </filter>
    <filter id="ringShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${5 * s}" stdDeviation="${9 * s}" flood-color="#000000" flood-opacity="0.20"/>
    </filter>
  </defs>
  <g filter="url(#shadow)">
    <path d="${squircle(cx, cy, TILE_HALF)}" fill="url(#tile)"/>
    <path d="${squircle(cx, cy, TILE_HALF)}" fill="url(#sheen)"/>
    ${v.border ? `<path d="${squircle(cx, cy, TILE_HALF)}" fill="none" stroke="${v.border}" stroke-width="${2.5 * s}"/>` : ""}
  </g>
  <g filter="url(#ringShadow)">
    <path d="${squircle(cx, cy, RING_HALF)} ${squircle(cx, cy, HOLE_HALF)}" fill="url(#ring)" fill-rule="evenodd"/>
  </g>
</svg>`;
}

/** 单色版标记（透明底，仅环），用 currentColor 场景：favicon/README/深色标题栏。 */
function svgMono(size, color = "#111111") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <path d="${squircle(cx, cy, RING_HALF)} ${squircle(cx, cy, HOLE_HALF)}" fill="${color}" fill-rule="evenodd"/>
</svg>`;
}

async function render(variant, size, opts = {}) {
  const svg = svgFor(variant, size);
  return sharp(Buffer.from(svg), { density: 72 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
    .then((buf) => (opts.bg ? sharp(buf).flatten({ background: opts.bg }).png().toBuffer() : buf));
}

/** 对比图：现有 logo + 三个新方向上排大图 + 小尺寸实际观感。 */
async function previewSheet(bg) {
  const cols = ["current", "ink", "spectrum", "indigo"];
  const W = 1800;
  const H = 660;
  const composites = [];
  const big = 250;
  for (let i = 0; i < cols.length; i += 1) {
    const x = 80 + i * 430;
    const buf =
      cols[i] === "current"
        ? await sharp("/tmp/brand/before/app-512.png").resize(big, big).png().toBuffer()
        : await render(cols[i], big);
    composites.push({ input: buf, left: x, top: 60 });
    let sx = x + 4;
    for (const size of [64, 32, 16]) {
      const small =
        cols[i] === "current"
          ? await sharp("/tmp/brand/before/app-512.png").resize(size, size).png().toBuffer()
          : await render(cols[i], size);
      composites.push({ input: small, left: sx, top: 350 });
      sx += size + 30;
    }
    const onDark =
      cols[i] === "current"
        ? await sharp("/tmp/brand/before/app-512.png").resize(128, 128).png().toBuffer()
        : await render(cols[i], 128);
    composites.push({ input: onDark, left: x + 55, top: 440 });
  }
  const base = await sharp({
    create: { width: W, height: H, channels: 4, background: bg },
  })
    .png()
    .toBuffer();
  return sharp(base).composite(composites).png().toBuffer();
}

// ---------- 落地 ----------
const ICONSET = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

async function emit(variant) {
  const written = [];
  const put = async (file, buf) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buf);
    written.push(path.relative(ROOT, file));
  };

  // 1) macOS 图标集
  for (const [name, size] of ICONSET) {
    await put(path.join(STUDIO, "icon.iconset", name), await render(variant, size));
  }
  // 2) Linux / Windows 源图
  await put(path.join(STUDIO, "icon-linux.png"), await render(variant, 512));
  await put(path.join(STUDIO, "icon-512.png"), await render(variant, 512));
  // 3) 应用内 logo（透明底标记，适配单色 UI）
  await put(path.join(STUDIO, "src/mainview/assets/omni-logo.png"), await render(variant, 256));
  // 4) 仓库 / landing / README 品牌位
  await put(path.join(ROOT, "logo.png"), await render(variant, 512));
  await put(path.join(ROOT, ".github/assets/logo.png"), await render(variant, 512));
  await put(path.join(ROOT, "apps/landing/public/logo.png"), await render(variant, 512));
  await put(
    path.join(ROOT, "apps/landing/public/logo.webp"),
    await sharp(await render(variant, 512)).webp({ quality: 92, lossless: false }).toBuffer(),
  );
  // 5) landing favicon 组
  for (const [name, size] of [
    ["favicon-16x16.png", 16],
    ["favicon-32x32.png", 32],
    ["apple-touch-icon.png", 180],
  ]) {
    await put(path.join(ROOT, "apps/landing/public/icons", name), await render(variant, size));
  }
  // 6) 单色标记备用（README 深色底 / 未来标题栏）
  await put(
    path.join(ROOT, "apps/studio/scripts/brand/mark-mono-dark.svg"),
    Buffer.from(svgMono(512, "#FFFFFF")),
  );
  await put(
    path.join(ROOT, "apps/studio/scripts/brand/mark-mono-light.svg"),
    Buffer.from(svgMono(512, "#111111")),
  );

  return written;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "emit") {
    const variant = arg ?? "ink";
    if (!VARIANTS[variant]) throw new Error(`unknown variant: ${variant}`);
    const written = await emit(variant);
    console.log(`emitted ${variant}:`);
    for (const f of written) console.log("  " + f);
    return;
  }
  // preview
  await mkdir(OUT_TMP, { recursive: true });
  for (const [name, bg] of [
    ["sheet-light.png", { r: 255, g: 255, b: 255, alpha: 1 }],
    ["sheet-dark.png", { r: 17, g: 17, b: 20, alpha: 1 }],
  ]) {
    const buf = await previewSheet(bg);
    await writeFile(path.join(OUT_TMP, name), buf);
    console.log("wrote", path.join(OUT_TMP, name));
  }
  // 单张 1024 预览
  for (const v of Object.keys(VARIANTS)) {
    await writeFile(path.join(OUT_TMP, `${v}-1024.png`), await render(v, 1024));
    await writeFile(path.join(OUT_TMP, `${v}-48.png`), await render(v, 48));
  }
  console.log("wrote per-variant PNGs in", OUT_TMP);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
