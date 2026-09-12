import * as ImageGen from "./image-gen";
import { getImagesBaseDir } from "./image-server";
import { findMlxModel, MLX_MODELS } from "./mlx-gen";

/**
 * 网关 → 生图模块的适配层。
 *
 * 网关只依赖这一个文件，避免在单元测试里直接 mock `./image-gen`：
 * `mock.module` 会在同进程内泄漏给其它测试文件（image-gen.test.ts 需要真实的
 * `./image-gen`），单独 mock 本适配层就能互不干扰地控制网关的生图行为。
 */

export type ImageGenBackend = ImageGen.ImageGenBackend;

/** 全部内置 MLX 生图模型（/v1/models 声明用）。 */
export const IMAGE_MODELS = MLX_MODELS;

/** 按 id 查内置 MLX 模型；非内置返回 null。 */
export function lookupMlxModel(id: string): ReturnType<typeof findMlxModel> {
  return findMlxModel(id);
}

/** 当前保存的生图配置（IMG_BACKEND / IMG_MODEL / IMG_API_* / IMG_COMFY_BASE）。 */
export function getImageGenConfig(): ImageGen.ImageGenConfig {
  return ImageGen.getImageGenConfig();
}

/** 调用生图（MLX / API / ComfyUI 由配置决定），返回记录行。 */
export function generateImage(params: ImageGen.GenerateImageParams) {
  return ImageGen.generateImage(params);
}

/** images 根目录（b64_json 直读落盘文件用）。 */
export function imagesBaseDir(): string {
  return getImagesBaseDir();
}
