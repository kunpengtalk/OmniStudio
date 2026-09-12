import { describe, expect, test } from "bun:test";

import { installedFileNames } from "../src/mainview/lib/installed-models";

/**
 * 市场页的"这个文件下过没有"：
 * vLLM / SGLang / MLX 的仓库在已安装列表里只有一条目录记录，成员文件必须能命中，
 * 否则仓库里的每个分片都会显示成"还没下载"（点一下又下一遍）。
 */
describe("installedFileNames", () => {
  test("把整仓库条目的成员文件摊平进去", () => {
    const names = installedFileNames([
      {
        fileName: "LFM2.5-2.6B-MLX",
        files: ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"],
      },
      { fileName: "Qwen3-4B-Q4_K_M.gguf" },
    ]);
    expect(names.has("model-00001-of-00002.safetensors")).toBe(true);
    expect(names.has("Qwen3-4B-Q4_K_M.gguf")).toBe(true);
    // 仓库里的 config.json / tokenizer 不是权重文件，不参与判断
    expect(names.has("config.json")).toBe(false);
  });

  test("分批 GGUF 用真实分片名命中（展示名不是磁盘上的文件）", () => {
    const names = installedFileNames([
      {
        fileName: "GLM-5.2-UD-Q3_K_M.gguf",
        files: ["GLM-5.2-UD-Q3_K_M-00001-of-00003.gguf", "GLM-5.2-UD-Q3_K_M-00002-of-00003.gguf"],
      },
    ]);
    expect(names.has("GLM-5.2-UD-Q3_K_M-00001-of-00003.gguf")).toBe(true);
    expect(names.has("GLM-5.2-UD-Q3_K_M-00002-of-00003.gguf")).toBe(true);
    expect(names.has("GLM-5.2-UD-Q3_K_M.gguf")).toBe(false);
  });

  test("没有 files 的老条目退回到 fileName（向后兼容）", () => {
    const names = installedFileNames([{ fileName: "old-model.gguf" }]);
    expect([...names]).toEqual(["old-model.gguf"]);
  });
});
