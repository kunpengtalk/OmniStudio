import type { ElectrobunConfig } from "electrobun";
import { existsSync } from "node:fs";
import pkg from "../../package.json";

// CI builds without a signing certificate (secrets unset) must still package.
// ElectroBun skips codesign/notarization when codesign is false; local
// behavior is unchanged unless ELECTROBUN_NO_SIGN=1 is explicitly set.
const signForDistribution = process.env.ELECTROBUN_NO_SIGN !== "1";

// Electrobun builds for the host platform only, so the native runtime
// packages (sharp / @napi-rs/canvas) must match the machine doing the build
// — e.g. the CI runner — not the developer's Mac.
const nativePackages =
  process.platform === "darwin"
    ? process.arch === "arm64"
      ? ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64", "@napi-rs/canvas-darwin-arm64"]
      : ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64", "@napi-rs/canvas-darwin-x64"]
    : process.platform === "win32"
      ? ["@img/sharp-win32-x64", "@img/sharp-libvips-win32-x64", "@napi-rs/canvas-win32-x64-msvc"]
      : process.arch === "x64"
        ? ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64", "@napi-rs/canvas-linux-x64-gnu"]
        : ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64", "@napi-rs/canvas-linux-arm64-gnu"];

const nativeCopy: Record<string, string> = {};
for (const name of nativePackages) {
  if (existsSync(`node_modules/${name}`)) {
    nativeCopy[`node_modules/${name}`] = `bun/node_modules/${name}`;
  } else {
    console.warn(`[electrobun.config] missing native package: ${name}`);
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
