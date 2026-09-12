import type { ElectrobunConfig } from "electrobun";
import { existsSync } from "node:fs";
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

const nativeCopy: Record<string, string> = {};
for (const name of nativePackages) {
  if (existsSync(`node_modules/${name}`)) {
    nativeCopy[`node_modules/${name}`] = `bun/node_modules/${name}`;
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

export default {
  app: {
    name: "OmniStudio",
    identifier: "omni-studio.kunpengtalk.com",
    version: pkg.version,
  },
  build: {
    // Vite builds to dist/, we copy from there
    copy: {
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
    },
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
