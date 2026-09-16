/**
 * 「这个模型 id 属于哪个生图后端」—— 纯逻辑，放这里而不是页面里，
 * 是因为它守着一次实测事故，值得有测试盯着（见 isForeignModel 的说明）。
 *
 * 单独成模块的另一个原因：`app/image/parts.tsx` 会拉起 `@lib/rpc`（进而拉起
 * electrobun 的浏览器端），在 `bun test` 里 import 它需要先铺一整套 happy-dom 全局。
 * 这条判定不需要 DOM，就别把测试也拖进去。
 */
import type { ImageGenBackend } from "../../bun/image-gen";

/** MLX 内置模型的默认步数（恢复配置时同步 steps 用；完整目录来自 listMlxGenModels）。 */
export const MLX_FALLBACKS: { id: string; defaultSteps: number }[] = [
  { id: "z-image-turbo", defaultSteps: 9 },
  { id: "flux-schnell", defaultSteps: 4 },
  { id: "flux2-klein-9b", defaultSteps: 4 },
  { id: "flux-dev", defaultSteps: 50 },
];

/**
 * 这个模型 id 是不是属于**别的后端**（切后端时该清掉）。
 *
 * 三个后端（云端 / MLX / ComfyUI）共用一个模型槽位 `IMG_MODEL`，切换后端只改
 * `IMG_BACKEND` 不会动它。实测踩到的组合是「云端 + z-image-turbo」：那是本地 MLX 的
 * preset id，界面显示"已配置"、参数看着都对，生成时却被原样发给了厂商，换回一句
 * `Model does not exist` —— 从这句话看不出问题在自己的设置里。
 *
 * MLX 的 id 目录是固定的（`bun/mlx-gen.ts` 的 MLX_MODELS，MLX_FALLBACKS 是它在 UI 侧的
 * 镜像；引擎起来后 listMlxGenModels 会给完整的那份），所以两个方向都判得准。
 */
export function isForeignModel(
  backend: ImageGenBackend,
  model: string,
  mlxModels: { id: string }[] = [],
): boolean {
  const id = model.trim();
  if (!id) return false;
  const mlxIds = new Set([...MLX_FALLBACKS.map((m) => m.id), ...mlxModels.map((m) => m.id)]);
  return backend === "mlx" ? !mlxIds.has(id) : mlxIds.has(id);
}
