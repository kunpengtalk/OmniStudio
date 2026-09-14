import { listInstalledModels, setModelMeta, type InstalledModel } from "./model-store";
import type { ModelCategory } from "../shared/modelscope";

/**
 * 更新已下载模型的类别（模型详情页的类别下拉）。
 *
 * 只对应用下载目录（managed）里的模型生效：类别写在仓库目录的 `.vllm-meta.json`，
 * 外部目录 / HF 缓存 / 直连单文件模型没有这个仓库目录 —— 写了也落不了盘。
 * 写完用安装列表回读确认，落不了盘就如实报错，不给「改了但没生效」的假象；
 * 类别持久化后，重启模型即按新类别启动（③-C2）。
 */
export function updateModelCategory(
  target: string,
  category: ModelCategory,
): { ok: boolean; error?: string; model?: InstalledModel } {
  const model = listInstalledModels().find((m) => m.path === target);
  if (!model) return { ok: false, error: "未找到该模型，请刷新模型列表后重试" };
  if (model.origin !== "managed") return { ok: false, error: "仅市场下载的模型支持修改类别" };
  setModelMeta(model.repo, { category });
  // setModelMeta 落盘失败会静默吞掉（目录不存在 / 嵌套仓库路径编不回去等），
  // 这里用列表回读兜住，避免界面显示已改、下次启动仍按旧类别跑。
  const updated = listInstalledModels().find((m) => m.path === target);
  if (!updated || updated.category !== category) {
    return { ok: false, error: "类别修改未生效，请重试" };
  }
  return { ok: true, model: updated };
}
