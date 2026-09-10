/**
 * 把 vibedesign 的提示词库素材（frontend/public/prompt-library）拷进本仓库，
 * 随应用一起打包，作为远程封面加载失败时的离线兜底：
 *
 *   - 源：默认 ~/ai/vibedesign（可用 VIBE_DIR 覆盖）
 *   - 目标：apps/studio/public/prompt-library（vite 复制进 dist，再由
 *     electrobun 打进 webview；提交 git 后其他机器无需 vibedesign 仓库）
 *
 * 素材不在本机时直接跳过——远程源（PROMPT_LIBRARY_MEDIA_ORIGIN）仍是默认加载方式。
 *
 * 用法：
 *   bun scripts/bundle-prompt-library-assets.ts
 */
import { cpSync, existsSync, statSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIBE_DIR = process.env.VIBE_DIR || `${process.env.HOME || "/Users/jwangkun"}/ai/vibedesign`;
const SRC = join(VIBE_DIR, "frontend", "public", "prompt-library");
const DEST = join(HERE, "..", "apps", "studio", "public", "prompt-library");

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

if (!existsSync(SRC)) {
  console.log(`[bundle-prompt-library-assets] 未找到 ${SRC}，跳过（远程源仍可正常加载）。`);
  process.exit(0);
}

cpSync(SRC, DEST, { recursive: true });
const mb = (dirSize(DEST) / 1024 / 1024).toFixed(1);
const files = countFiles(DEST);
console.log(`[bundle-prompt-library-assets] 已拷入 ${DEST}`);
console.log(`  文件数：${files}，大小：${mb} MB`);
console.log("  提交 git 后，这些素材会随应用打包，作为远程封面加载失败时的离线兜底。");
