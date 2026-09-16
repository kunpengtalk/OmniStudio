import { expect, test } from "bun:test";

import { isForeignModel } from "./image-model";

/**
 * 这条判定守的是实测踩到的一次事故：三个后端共用一个 IMG_MODEL 槽位，从本地 MLX
 * 切到云端时它不被清掉，于是 z-image-turbo（MLX 的 preset id）被当成云端模型发给
 * 了硅基流动 —— 界面写着"已配置"，生成时才换回一句 `Model does not exist`。
 */
test("云端 / ComfyUI 下，本地 MLX 的模型 id 算外来值", () => {
  expect(isForeignModel("api", "z-image-turbo")).toBe(true);
  expect(isForeignModel("api", "flux-dev")).toBe(true);
  expect(isForeignModel("comfyui", "flux-schnell")).toBe(true);
  // 引擎起来后 listMlxGenModels 给的 id 也认（不只是静态兜底那四个）
  expect(isForeignModel("api", "some-new-mlx-model", [{ id: "some-new-mlx-model" }])).toBe(true);
});

test("云端模型名 / ComfyUI checkpoint 在云端后端下是正常值", () => {
  expect(isForeignModel("api", "Kwai-Kolors/Kolors")).toBe(false);
  expect(isForeignModel("api", "Tongyi-MAI/Z-Image-Turbo")).toBe(false);
  expect(isForeignModel("comfyui", "sd_xl_base_1.0.safetensors")).toBe(false);
});

test("切回 MLX 时反向判：云端模型名算外来值", () => {
  expect(isForeignModel("mlx", "Kwai-Kolors/Kolors")).toBe(true);
  expect(isForeignModel("mlx", "z-image-turbo")).toBe(false);
  expect(isForeignModel("mlx", "flux-schnell")).toBe(false);
});

test("空值是「没选」，不是外来值（别把空串也清一遍）", () => {
  expect(isForeignModel("api", "")).toBe(false);
  expect(isForeignModel("mlx", "   ")).toBe(false);
});
