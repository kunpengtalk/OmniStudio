import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { isMmprojFile, scanPlainDir } from "./model-scan";

/**
 * model-scan 的 mmproj 排除测试（真测试体）。
 *
 * 为什么套一层子进程：与 model-store.embedding.test.ts 同一先例 —— bun 的 mock
 * 注册表在同一批次里跨文件共享，别的测试文件会桩掉 fs（download-manager.test.ts
 * 把整个 fs 模块桩掉了，leftover 的 existing 集合会往每个 readdir 结果里塞假
 * 文件名），而本套测试需要真实 readdir/stat 真实临时目录。子进程里零 mock，
 * 结果确定。文件名不带 .test.，批次不会自动发现；入口是 model-scan.test.ts
 * （子进程包装）。
 */

const tmp = mkdtempSync(join(tmpdir(), "model-scan-mmproj-"));

function put(dir: string, name: string) {
  writeFileSync(join(dir, name), "gguf");
}

// 平面目录：模型 + 两个 mmproj 变体（排除后只应剩模型一条）
mkdirSync(join(tmp, "flat"));
put(join(tmp, "flat"), "gme-2b-f16.gguf");
put(join(tmp, "flat"), "mmproj-f16.gguf");
put(join(tmp, "flat"), "mmproj-bf16.gguf");

// 子目录里的平面布局（扫描任意深度都排除）
mkdirSync(join(tmp, "nested"));
put(join(tmp, "nested"), "wemm-9b.gguf");
put(join(tmp, "nested"), "mmproj-model-f16.gguf");

// 仓库布局目录（config.json + safetensors → walkWeights 聚合，不走排除点）
mkdirSync(join(tmp, "repo"));
writeFileSync(join(tmp, "repo", "config.json"), "{}");
writeFileSync(join(tmp, "repo", "model.safetensors"), "x");
put(join(tmp, "repo"), "mmproj-f16.gguf");

const models = scanPlainDir(tmp, "external");

describe("model-scan / mmproj 排除", () => {
  test("isMmprojFile：mmproj-*.gguf 命中，普通权重不命中", () => {
    expect(isMmprojFile("mmproj-f16.gguf")).toBe(true);
    expect(isMmprojFile("mmproj-bf16.gguf")).toBe(true);
    expect(isMmprojFile("mmproj-model-f16.gguf")).toBe(true);
    expect(isMmprojFile("model.gguf")).toBe(false);
    expect(isMmprojFile("mmproj-f16.safetensors")).toBe(false);
    expect(isMmprojFile("prefix-mmproj-f16.gguf")).toBe(false);
  });

  test("平面目录（含子目录）里的 mmproj-*.gguf 不出现在扫描结果", () => {
    const fileNames = models.filter((m) => !m.isDir).map((m) => `${m.repo}/${m.fileName}`);
    expect(fileNames).toContain("flat/gme-2b-f16.gguf");
    expect(fileNames).toContain("nested/wemm-9b.gguf");
    for (const name of fileNames) {
      expect(name.includes("mmproj")).toBe(false);
    }
  });

  test("仓库目录的 files[] 聚合不受损：mmproj 仍在（已知可接受残留，风险表在案）", () => {
    const repoEntry = models.find((m) => m.isDir && m.repo === "repo");
    expect(repoEntry).toBeDefined();
    expect([...(repoEntry?.files ?? [])].sort()).toEqual(["mmproj-f16.gguf", "model.safetensors"]);
  });
});
