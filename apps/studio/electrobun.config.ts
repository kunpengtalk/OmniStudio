import type { ElectrobunConfig } from "electrobun";
import pkg from "../../package.json";

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
      "node_modules/@img/sharp-darwin-arm64": "bun/node_modules/@img/sharp-darwin-arm64",
      "node_modules/@img/sharp-libvips-darwin-arm64":
        "bun/node_modules/@img/sharp-libvips-darwin-arm64",
      "node_modules/@napi-rs/canvas": "bun/node_modules/@napi-rs/canvas",
      "node_modules/@napi-rs/canvas-darwin-arm64": "bun/node_modules/@napi-rs/canvas-darwin-arm64",
      "src/bun/db/migrations": "bun/db/migrations",
    },
    // Ignore Vite output in watch mode — HMR handles view rebuilds separately
    // @ts-ignore
    watchIgnore: ["dist/**"],
    mac: {
      icons: "icon.iconset",
      bundleCEF: false,
      codesign: true,
      notarize: true,
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
