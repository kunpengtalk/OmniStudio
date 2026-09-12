import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

import tsconfig from "./tsconfig.json";

const paths = Object.entries(tsconfig.compilerOptions.paths).reduce(
  (acc, [key, value]) => {
    acc[key.replace("/*", "")] = path.resolve(
      __dirname,
      value[0]!.replace("./", "").replace("/*", ""),
    );
    return acc;
  },
  {} as Record<string, string>,
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/mainview",
  resolve: {
    alias: paths,
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rolldownOptions: {
      external: ["sharp", "@napi-rs/canvas"],
      output: {
        // 打包路径必须守住 100 字符：Electrobun 的自解包器是 Zig std.tar，条目名一超过
        // 100 字符 tar 写入器就改用 GNU long-name（typeflag 'L'）记录，而它读不了这种条目，
        // 直接 error.TarUnsupportedFileType 中断安装（issue #2 的 win11 装不上）。
        // 打包后前缀 OmniStudio-canary/Resources/app/views/mainview/assets/ 已占 54 字符，
        // 而 @fontsource 的字体名本身长 50–55（plus-jakarta-sans-latin-ext-wght-normal-XXXXXXXX.woff2），
        // 叠起来 104–109 必然越界 —— 实测 v0.0.7-canary.0 里超限的正好只有这 3 个字体。
        // 收敛成 assets/fonts/<hash>.<ext> 后完整路径约 73 字符，留足余量。
        assetFileNames: (asset) => {
          const name = asset.names?.[0] ?? "";
          return /\.(woff2?|ttf|otf|eot)$/i.test(name)
            ? "assets/fonts/[hash][extname]"
            : "assets/[name]-[hash][extname]";
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
