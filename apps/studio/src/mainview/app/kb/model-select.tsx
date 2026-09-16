import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";
import { Input } from "@ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@ui/select";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 「不使用」在状态里是空字符串，但 Radix 的 SelectItem 不接受空字符串 value
 * （Select 关闭时 children 也会渲染进游离 DocumentFragment 收集候选项文本，
 * 空串会直接抛错把整棵树卸载），这里用哨兵值代替再映射回空串。
 */
export const NO_MODEL = "__none__";

export type KbModelSource = "embedding" | "rerank";
export type KbServiceKind = "local" | "remote" | "custom";

/** 服务来源对应的界面文案（选择器分组标题、设置页的服务说明共用）。 */
export function serviceLabelKey(kind: KbServiceKind): string {
  return {
    local: "kb.settings.serviceLocal",
    remote: "kb.settings.serviceRemote",
    custom: "kb.settings.serviceCustom",
  }[kind];
}

/**
 * 嵌入 / 重排的模型候选：本地推理服务提供的模型 + 云端配置的模型，
 * 以及服务端解析出的实际地址（界面据此说明「本地服务无需 Key」）。
 */
export function useKbModelCandidates(
  source: KbModelSource,
  base: string,
  apiKey: string,
  enabled = true,
  /** 云服务商 id：非空时地址/密钥/模型候选都取该厂商。 */
  providerId = "",
) {
  const trimmedBase = base.trim();
  const trimmedKey = apiKey.trim();
  const trimmedProvider = providerId.trim();
  return useQuery({
    queryKey: ["kb-model-candidates", source, trimmedBase, trimmedProvider],
    queryFn: () => {
      const params = {
        base: trimmedBase || undefined,
        apiKey: trimmedKey || undefined,
        providerId: trimmedProvider || undefined,
      };
      return source === "embedding"
        ? rpcClient.kbEmbeddingModels(params)
        : rpcClient.kbRerankModels(params);
    },
    enabled,
    staleTime: 60_000,
  });
}

/** 候选列表里是否存在某个模型（当前值不在列表里时要单独列出来）。 */
function hasCandidate(
  candidates: { local: string[]; remote: string[] } | undefined,
  model: string,
): boolean {
  if (!candidates || !model) return false;
  return candidates.local.includes(model) || candidates.remote.includes(model);
}

type KbModelCandidatesView = {
  local: string[];
  remote: string[];
  service: { base: string; kind: KbServiceKind };
  /** 一个都没认出该类模型、已回退成全量时为 true。 */
  relaxed?: boolean;
  /** 服务端引导（i18n key）：本地模式没有运行中的嵌入服务时给出。 */
  hint?: string;
};

/**
 * 知识库嵌入 / 重排模型选择器：从「本地推理服务」和「云端 API」两组里挑，
 * 候选按场景过滤（嵌入选择器只列嵌入模型，重排只列重排名模型），
 * 不需要配密钥（密钥只在自定义地址时用得上）。
 *
 * 默认纯下拉；传 `allowCustom` 后支持手填模型名 —— 搜索框回车，或点候选区顶部的
 * 「使用「xxx」」项，输入的名字原样提交（默认模型面板这类自定义服务场景需要）。
 */
export function KbModelSelect({
  id,
  ariaLabel,
  value,
  onChange,
  candidates,
  loading,
  allowCustom,
  className,
}: {
  /** 供 <Label htmlFor> 关联，点标签也能聚焦选择器。 */
  id?: string;
  /** 无障碍名：同一页有多个「模型」选择器时区分开。 */
  ariaLabel?: string;
  value: string;
  onChange: (model: string) => void;
  candidates?: KbModelCandidatesView;
  loading?: boolean;
  /** 允许手填候选之外的模型名（回车或「使用」项提交）。 */
  allowCustom?: boolean;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const keyword = query.trim().toLowerCase();
  const matches = (m: string) => !keyword || m.toLowerCase().includes(keyword);
  const local = (candidates?.local ?? []).filter(matches);
  const remote = (candidates?.remote ?? []).filter(matches);
  const total = (candidates?.local.length ?? 0) + (candidates?.remote.length ?? 0);
  const kind = candidates?.service.kind;
  const base = candidates?.service.base ?? "";
  const known = hasCandidate(candidates, value);
  // 手填值（allowCustom）：正在输入且不在候选里的名字 —— 可回车或点「使用」项直接采用。
  const typed = query.trim();
  const typedKnown = Boolean(typed) && hasCandidate(candidates, typed);
  const commitTyped = () => {
    if (typed && typed !== value) onChange(typed);
    closeAndReset(false);
  };
  // 分组标题：[本地推理服务 | 云端 API | 自定义地址] · 实际地址
  // 本地服务这一组就是本机模型；另一组是云端：地址来自云服务商槽位时标「云端 API」，
  // 手填地址时标「自定义地址」。
  const localLabel = t("kb.settings.serviceLocal");
  const remoteLabel = kind && kind !== "local" ? t(serviceLabelKey(kind)) : t("kb.settings.serviceRemote");
  const closeAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  return (
    <Select
      value={value || NO_MODEL}
      open={open}
      onOpenChange={closeAndReset}
      onValueChange={(v) => {
        onChange(v === NO_MODEL ? "" : v);
        closeAndReset(false);
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        size="sm"
        className={cn("h-8 w-full min-w-0 gap-1.5 text-xs", className)}
      >
        {/* 直接渲染当前值：Radix 的 SelectValue 靠候选项文本回填，
            当前值不在候选列表里（换了服务地址、旧的手填值）时会显示空白。 */}
        <span
          data-slot="select-value"
          className={cn("min-w-0 flex-1 truncate text-left", !value && "text-muted-foreground")}
        >
          {value || t("kb.create.notUse")}
        </span>
      </SelectTrigger>
      <SelectContent
        className="w-[26rem] max-w-[min(26rem,90vw)]"
        position="popper"
        sideOffset={6}
      >
        {/* 搜索框：拦截键盘事件，避免被 Select 的 typeahead 抢走焦点 */}
        <div className="sticky top-0 z-10 bg-popover p-1.5 pb-1" onKeyDown={(e) => e.stopPropagation()}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeAndReset(false);
                return;
              }
              // 手填模式：回车把输入的名字原样提交（不在候选里也行）
              if (allowCustom && e.key === "Enter") {
                e.preventDefault();
                commitTyped();
              }
            }}
            placeholder={allowCustom ? t("kb.modelSelect.searchOrType") : t("chat.modelSearch")}
            autoFocus
            className="h-7 text-xs"
          />
        </div>

        {/* 手填项：名字不在候选里时给出可点的「使用」入口（与回车等价） */}
        {allowCustom && typed && !typedKnown && (
          <SelectGroup>
            <SelectItem value={typed}>
              <span className="min-w-0 flex-1 truncate">
                {t("kb.modelSelect.useTyped", { model: typed })}
              </span>
            </SelectItem>
          </SelectGroup>
        )}

        <SelectGroup>
          <SelectItem value={NO_MODEL} className="text-xs">
            {t("kb.create.notUse")}
          </SelectItem>
        </SelectGroup>

        {/* 当前值不在候选里（换过地址 / 手填过的旧值）也展示出来，避免选择器看起来是空的 */}
        {value && !known && (
          <SelectGroup>
            <SelectItem value={value}>
              <span className="min-w-0 flex-1 truncate">{value}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                {t("settings.integrations.currentValue")}
              </span>
            </SelectItem>
          </SelectGroup>
        )}

        {local.length > 0 && (
          <SelectGroup>
            <SelectLabel>
              {localLabel}
              {base && kind === "local" ? ` · ${base}` : ""}
            </SelectLabel>
            {local.map((m) => (
              <SelectItem key={`local-${m}`} value={m}>
                <span className="min-w-0 flex-1 truncate">{m}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}

        {remote.length > 0 && (
          <SelectGroup>
            <SelectLabel>
              {remoteLabel}
              {base && kind !== "local" ? ` · ${base}` : ""}
            </SelectLabel>
            {remote.map((m) => (
              <SelectItem key={`remote-${m}`} value={m}>
                <span className="min-w-0 flex-1 truncate">{m}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}

        {total === 0 && (
          <div className="px-2 py-2.5 text-center text-[11px] leading-4 text-muted-foreground">
            {loading
              ? t("kb.create.loadingModels")
              : kind && kind !== "local"
                ? t("kb.settings.noCandidatesRemote")
                : t("kb.settings.noCandidates")}
          </div>
        )}
        {total > 0 && local.length === 0 && remote.length === 0 && (
          <div className="px-2 py-2.5 text-center text-[11px] text-muted-foreground">
            {t("chat.modelNoMatch")}
          </div>
        )}
        {/* 服务端返回的模型没一个能判出这类用途：列出的是全量，明确说明一句，
            免得用户以为"这里的模型都能干这个"。 */}
        {candidates?.relaxed && total > 0 && (
          <div className="border-t px-2 py-2 text-[11px] leading-4 text-muted-foreground">
            {t("models.filter.relaxed")}
          </div>
        )}
        {/* 服务端引导：本地模式没有运行中的嵌入服务 —— 本地组为空，先去模型页把
            嵌入模型（类别为「嵌入」）启动起来，或改用云端 / 自定义地址。 */}
        {candidates?.hint && (
          <div className="border-t px-2 py-2 text-[11px] leading-4 text-muted-foreground">
            {t(candidates.hint)}
          </div>
        )}
      </SelectContent>
    </Select>
  );
}
