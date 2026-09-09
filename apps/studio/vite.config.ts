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
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
