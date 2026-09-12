import type { ElectrobunConfig } from "electrobun";
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pkg from "../../package.json";
import { nativePackagesFor } from "./src/shared/native-packages";

// CI builds without a signing certificate (secrets unset) must still package.
// ElectroBun skips codesign/notarization when codesign is false; local
// behavior is unchanged unless ELECTROBUN_NO_SIGN=1 is explicitly set.
const signForDistribution = process.env.ELECTROBUN_NO_SIGN !== "1";

// Electrobun builds for the host platform only, so the native runtime
// packages (sharp / @napi-rs/canvas) must match the machine doing the build
// — e.g. the CI runner — not the developer's Mac. 清单与它依赖的
// package.json optionalDependencies 声明见 src/shared/native-packages.ts。
const nativePackages = nativePackagesFor(process.platform, process.arch);

// libvips 的平台包会带上一个只在编译期有用的 glib 头文件目录
// （lib/glib-2.0/include/glibconfig.h）。它在 Linux 载荷里是 107 字符 —— 正好越过下面
// 的 100 字符上限，而运行时只加载 lib/libvips-cpp.so*（sharp 按包名解析后读该目录），
// 头文件没人读。打包前直接清掉，别让一个死文件把安装包顶爆。
for (const name of nativePackages) {
  if (!name.startsWith("@img/sharp-libvips")) continue;
  const devHeaders = `node_modules/${name}/lib/glib-2.0`;
  if (existsSync(devHeaders)) rmSync(devHeaders, { recursive: true, force: true });
}

const nativeCopy: Record<string, string> = {};
for (const name of nativePackages) {
  if (existsSync(`node_modules/${name}`)) {
    // 目标放 app 根（Resources/app/node_modules/…）而不是 bun/ 下：两个位置都在
    // node 解析链上（从 bun/ 或 bun/node_modules/@napi-rs/canvas/ 往上找都会命中），
    // 但少一层目录能省 4 个字符 —— canvas 的 skia.<平台>.node 放在 bun/ 下会到 104
    // 字符，正好越过下面 assertPathsFitTar 的 100 字符上限。
    nativeCopy[`node_modules/${name}`] = `node_modules/${name}`;
  } else {
    // 这里只 warn 的话，会安安静静产出一个缺 binding 的载荷：包装得上、装完一启动就崩
    // （issue #4 —— Windows/Linux 载荷里没有 sharp 的 win32-x64 binding）。宁可让构建
    // 直接失败，也不要再发一个跑不起来的包。
    throw new Error(
      `[electrobun.config] 缺少平台原生包 ${name}（构建机 ${process.platform}-${process.arch}）。` +
        `它需要在 apps/studio/package.json 的 optionalDependencies 里声明并在构建机上 bun install 过，` +
        `否则载荷不会带上 sharp / @napi-rs/canvas 的原生 binding。`,
    );
  }
}

// tar 的 ustar 名字段只有 100 字节：条目名一旦超过 100 字符，写入器就改用 GNU
// long-name（typeflag 'L'）记录，而 Electrobun 的安装包解包器（Zig std.tar）读不了
// 这种条目，直接 `error: TarUnsupportedFileType` 中断整个安装。
// 这个坑已经踩过两次：issue #2 的三条 @fontsource 字体（104/108/109 字符），以及把
// 原生包打进载荷之后 @napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node 的
// 104 字符（v0.0.8-canary.0 的 Windows 包就是这么发出去的）。
// 所以在构建期把载荷里每个文件的最终路径算一遍：超限直接让构建失败，而不是发一个
// 「下得下来、装不上去」的包。
const MAX_TAR_PATH = 100;
// bundle 目录名是 <app.name>-<channel>，取最长的渠道后缀（canary）保守计算。
const BUNDLE_ROOT = `${"OmniStudio"}-canary`;
const bundlePrefix =
  process.platform === "darwin"
    ? `${BUNDLE_ROOT}.app/Contents/Resources/app/`
    : `${BUNDLE_ROOT}/Resources/app/`;

function walkFiles(entry: string, seen = new Set<string>()): string[] {
  if (!existsSync(entry)) return [];
  const real = realpathSync(entry);
  if (seen.has(real)) return [];
  seen.add(real);
  if (!statSync(entry).isDirectory()) return [entry];
  return readdirSync(entry, { withFileTypes: true }).flatMap((d) => walkFiles(join(entry, d.name), seen));
}

function payloadPaths(copy: Record<string, string>): string[] {
  return Object.entries(copy).flatMap(([src, dest]) => {
    const files = walkFiles(src);
    if (files.length === 0) return [];
    if (!statSync(src).isDirectory()) return [`${bundlePrefix}${dest}`];
    return files.map((file) => `${bundlePrefix}${dest}/${relative(src, file)}`);
  });
}

function assertPathsFitTar(copy: Record<string, string>) {
  const paths = payloadPaths(copy);
  const overlong = paths.filter((path) => path.length > MAX_TAR_PATH);
  const longest = paths.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (overlong.length === 0) {
    // 余量提醒：Windows 侧现在最长的就是 canvas 的 skia.<平台>.node，正好贴着上限，
    // 依赖升级把文件名改长一点就会越界 —— 提前把余量打出来，别等到安装包发出去。
    if (longest.length > MAX_TAR_PATH - 5) {
      console.warn(
        `[electrobun.config] 载荷最长路径 ${longest.length}/${MAX_TAR_PATH} 字符，余量不足 5：\n  ${longest}`,
      );
    }
    return;
  }
  const detail = overlong
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)
    .map((path) => `  ${path.length}  ${path}`)
    .join("\n");
  if (process.platform === "darwin") {
    // macOS 走 dmg 安装、不经过 tar 解包，历史上就一直带着超限路径（sharp 的 libvips
    // dylib 与头文件最长 ~127），这里先只告警，不把 macOS 构建一并拦死。
    console.warn(
      `[electrobun.config] 载荷里有 ${overlong.length} 条路径超过 ${MAX_TAR_PATH} 字符（macOS 走 dmg，暂不阻断）：\n${detail}`,
    );
    return;
  }
  throw new Error(
    `[electrobun.config] 载荷里有 ${overlong.length} 条路径超过 ${MAX_TAR_PATH} 字符，` +
      `自解包器（Zig std.tar）会拒绝解包并中断安装：\n${detail}\n` +
      `缩短办法：把资源换到更浅的目标目录，或收敛文件名（参考 src/shared/native-packages.ts 与字体输出命名）。`,
  );
}

const copy: Record<string, string> = {
  // Vite builds to dist/, we copy from there
  "dist/index.html": "views/mainview/index.html",
  "dist/assets": "views/mainview/assets",
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs": "bun/pdf.worker.mjs",
  "node_modules/@napi-rs/canvas": "bun/node_modules/@napi-rs/canvas",
  ...nativeCopy,
  "src/bun/db/migrations": "bun/db/migrations",
  "src/bun/prompt-library/seed": "bun/prompt-library/seed",
  // MLX 生图模型下载/校验脚本：mlx-gen.ts 以 import.meta.dir 同目录相对路径
  // 调用它；不打进 bundle 时主进程 spawpython 跑不到文件，python 以「文件
  // 不存在」退出（退出码 2），模型的 check/download 会全部误报失败。
  "src/bun/mlx-model.py": "bun/mlx-model.py",
  // 常驻生图 worker（模型加载一次、反复生成），同样以同目录相对路径调用。
  "src/bun/mlx-worker.py": "bun/mlx-worker.py",
  // 常驻 PaddleOCR worker（PP-OCRv6，本地模型目录加载）；主进程以
  // import.meta.dir 同目录相对路径 spawn，必须打进 bundle。
  "src/bun/ppocr-worker.py": "bun/ppocr-worker.py",
  // 提示词库内置素材（scripts/bundle-prompt-library-assets.ts 生成）：
  // 有则打进 webview，作为远程封面加载失败时的离线兜底。
  ...(existsSync("dist/prompt-library")
    ? { "dist/prompt-library": "views/mainview/prompt-library" }
    : {}),
};

assertPathsFitTar(copy);

export default {
  app: {
    name: "OmniStudio",
    identifier: "omni-studio.kunpengtalk.com",
    version: pkg.version,
  },
  build: {
    copy,
    // Ignore Vite output in watch mode — HMR handles view rebuilds separately
    // @ts-ignore
    watchIgnore: ["dist/**"],
    mac: {
      icons: "icon.iconset",
      bundleCEF: false,
      codesign: signForDistribution,
      notarize: signForDistribution,
      entitlements: {
        // Microphone access (voice recording for ASR). Electrobun maps this
        // entitlement to NSMicrophoneUsageDescription in the generated Info.plist.
        "com.apple.security.device.audio-input":
          "OmniStudio needs microphone access for voice input and real-time speech-to-text.",
      },
    },
    linux: {
      bundleCEF: false,
      icon: "icon-linux.png",
    },
    win: {
      bundleCEF: false,
      icon: "icon.ico",
    },
  },
  release: {
    baseUrl: "https://github.com/kunpengtalk/OmniStudio/releases/latest/download",
  },
} satisfies ElectrobunConfig;
