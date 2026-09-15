/**
 * `/model` 的候选清单（对齐 Codex 的 `/model`）—— 纯函数，界面与测试共用。
 *
 * 规则与输入框右下角的模型选择器**完全一致**（`model-picker.tsx`）：
 * - 本地只列**已启动**（running / starting / downloading）的实例 —— 没启动的模型
 *   在这里选中要么等一次冷启动、要么报错；
 * - 云端只列用户在「模型云服务」里添加过的对话模型；
 * - 当前模型排在最前，输入 `/model` 直接回车就是"不换"（不会误切到别的模型）。
 */

/** 只依赖结构的两条字段，避免 shared 层反向依赖主进程模块。 */
export type ModelLike = {
  type: "local" | "api";
  value: string;
  label: string;
  detail?: string;
  /** 本地实例状态：只有 running / starting / downloading 可切。 */
  state?: string;
  isActive?: boolean;
  providerId?: string;
  providerName?: string;
};

export const MODEL_COMMAND_LIMIT = 12;

/** 本地实例是否"能立刻用"（与对话选择器同一个判据）。 */
export function isRunnableLocalModel(model: Pick<ModelLike, "state">): boolean {
  return model.state === "running" || model.state === "starting" || model.state === "downloading";
}

/**
 * 过滤出 `/model` 的候选：能用的本地实例 + 已配置厂商的云端模型，
 * 按查询词匹配（名称 / id / 详情），当前模型排最前。
 */
export function modelCommandOptions<T extends ModelLike>(models: T[], query = ""): T[] {
  const keyword = query.trim().toLowerCase();
  const usable = models.filter(
    (model) => model.type === "api" || (model.type === "local" && isRunnableLocalModel(model)),
  );
  const matched = usable.filter((model) => {
    if (!keyword) return true;
    return (
      model.label.toLowerCase().includes(keyword) ||
      model.value.toLowerCase().includes(keyword) ||
      (model.detail ?? "").toLowerCase().includes(keyword) ||
      (model.providerName ?? "").toLowerCase().includes(keyword)
    );
  });
  // 当前模型排最前：输入 `/model` 直接回车 = 不换（不会误切到列表里的第一个）。
  const sorted = [...matched].sort((a, b) => Number(Boolean(b.isActive)) - Number(Boolean(a.isActive)));
  return sorted.slice(0, MODEL_COMMAND_LIMIT);
}

/** 候选的副标题：本地给引擎 / 地址，云端给厂商名。 */
export function modelCommandDetail(model: ModelLike): string {
  if (model.type === "api") return model.providerName ?? "";
  return model.detail ?? model.value;
}
