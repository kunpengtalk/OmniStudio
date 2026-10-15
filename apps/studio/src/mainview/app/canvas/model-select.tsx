/**
 * 画布节点的模型选择器：一张下拉里同时列出**本地**与**云端**可选模型。
 *
 * "网关里有什么就能选什么"分四种用途各自取数：
 * - 文本：`listChatModels`（本地 = 已启动实例；云端 = 厂商模型清单里加过的对话模型）；
 * - 图片：云端取厂商行的 image 模型，本地取 MLX 生图引擎扫到的权重；
 * - 视频：云端取 video 模型，本地取 ComfyUI 的 checkpoint（配了地址才出现）；
 * - 音频：云端 TTS 厂商；「跟随默认模型」= 设置 → 默认模型 里配的 TTS。
 *
 * 执行端（node-panel / canvas-gen）按 `CanvasModelChoice.source` 分派，
 * 不在这里提前展开凭据 —— 地址与密钥永远由主进程从厂商行解析。
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@ui/select";
import { rpcClient } from "@lib/rpc";
import { cn } from "@/mainview/lib/utils";
import { providerModelsOfType } from "@/shared/cloud-providers";
import type { CanvasModelChoice } from "@/shared/canvas";
import { useT } from "@stores/ui-lang";

export type CanvasModelKind = "text" | "image" | "video" | "music" | "tts";

export type CanvasModelOption = {
  /** 选项键必须由 `choiceKey(choice)` 派生 —— 手写一份必然和回显键漂移，
   *  漂移的样子正是"点了选不上"（value 匹配不到任何 item，trigger 永远是占位符）。 */
  value: string;
  label: string;
  group: string;
  choice: CanvasModelChoice | null; // null = 跟随默认
};

function option(label: string, group: string, choice: CanvasModelChoice | null): CanvasModelOption {
  return { value: choiceKey(choice), label, group, choice };
}

export function choiceKey(choice: CanvasModelChoice | null | undefined): string {
  if (!choice) return "default";
  return `${choice.source}:${choice.providerId ?? ""}:${choice.model}`;
}

export function CanvasModelSelect({
  kind,
  value,
  onChange,
  className,
}: {
  kind: CanvasModelKind;
  value: CanvasModelChoice | null | undefined;
  onChange: (choice: CanvasModelChoice | null) => void;
  className?: string;
}) {
  const t = useT();
  const groups = useModelGroups(kind);
  const options = useMemo(
    () => (groups.data ?? []).filter((o) => o.group !== "__hidden"),
    [groups.data],
  );
  const currentKey = choiceKey(value);

  return (
    <Select
      value={currentKey}
      onValueChange={(key) => {
        const opt = options.find((o) => o.value === key);
        onChange(opt ? opt.choice : null);
      }}
    >
      <SelectTrigger size="sm" className={cn("min-w-0 w-full", className)}>
        <SelectValue placeholder={groups.isLoading ? t("canvas.model.loading") : t("canvas.model")} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.length === 0 && !groups.isLoading ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">{t("canvas.model.none")}</div>
        ) : null}
        {groups.groups?.map(({ group, items }) => (
          <SelectGroup key={group}>
            <SelectLabel>{group}</SelectLabel>
            {items.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">
                <span className="truncate">{opt.label}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 按用途拉取模型清单并编组（group 名同时是下拉里的分组标题）。 */
function useModelGroups(kind: CanvasModelKind): {
  data: CanvasModelOption[];
  groups: { group: string; items: CanvasModelOption[] }[];
  isLoading: boolean;
} {
  const t = useT();
  const cloud = useQuery({
    queryKey: ["cloud-providers"],
    queryFn: () => rpcClient.cloudProviderList(undefined),
  });

  const chat = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(undefined),
    enabled: kind === "text",
  });

  const mlx = useQuery({
    queryKey: ["canvas-image-models-mlx"],
    queryFn: () => rpcClient.listImageGenModels({ backend: "mlx" }),
    enabled: kind === "image",
    retry: false,
  });

  const comfyImage = useQuery({
    queryKey: ["canvas-image-models-comfy"],
    queryFn: async () => {
      const cfg = await rpcClient.getImageGenConfig(undefined);
      if (!cfg.config.comfyBase?.trim()) return { models: [] as string[] };
      const models = await rpcClient.listImageGenModels({ backend: "comfyui" });
      return { models: models.models ?? [] };
    },
    enabled: kind === "image",
    retry: false,
  });

  const comfy = useQuery({
    queryKey: ["canvas-video-models-comfy"],
    queryFn: async () => {
      const cfg = await rpcClient.getVideoGenConfig(undefined);
      if (!cfg.config.comfyBase?.trim()) return { checkpoints: [] as string[] };
      const models = await rpcClient.listVideoGenModels({ backend: "comfyui" });
      return { checkpoints: models.checkpoints ?? [] };
    },
    enabled: kind === "video",
    retry: false,
  });

  return useMemo(() => {
    const options: CanvasModelOption[] = [];
    const push = (group: string, opt: CanvasModelOption) => options.push(opt);
    const localLabel = t("canvas.model.local");
    const cloudLabel = t("canvas.model.cloud");

    if (kind === "text") {
      for (const m of chat.data?.models ?? []) {
        if (m.type === "local") {
          if (m.state !== "running") continue;
          push(localLabel, option(m.label, localLabel, { source: "local", providerId: m.value, model: m.value }));
        } else if (m.type === "api") {
          push(cloudLabel, option(m.value, `${cloudLabel} · ${m.providerName ?? ""}`, { source: "cloud", providerId: m.providerId, model: m.value }));
        }
      }
    }

    if (kind === "image") {
      for (const p of cloud.data?.providers ?? []) {
        if (!p.enabled) continue;
        for (const m of providerModelsOfType(p, "image")) {
          push(cloudLabel, option(m.name || m.id, `${cloudLabel} · ${p.name}`, { source: "cloud", backend: "api", providerId: p.id, model: m.id }));
        }
      }
      for (const id of mlx.data?.models ?? []) {
        push(localLabel, option(id.split("/").pop() || id, `${localLabel} · MLX`, { source: "local", backend: "mlx", model: id }));
      }
      // ComfyUI：只有配了地址才出现（与生图页后端切换同一判据）。
      for (const id of comfyImage.data?.models ?? []) {
        push(localLabel, option(id.split("/").pop() || id, `${localLabel} · ComfyUI`, { source: "local", backend: "comfyui", model: id }));
      }
    }

    if (kind === "video") {
      for (const p of cloud.data?.providers ?? []) {
        if (!p.enabled) continue;
        for (const m of providerModelsOfType(p, "video")) {
          push(cloudLabel, option(m.name || m.id, `${cloudLabel} · ${p.name}`, { source: "cloud", backend: "cloud", providerId: p.id, model: m.id }));
        }
      }
      for (const id of comfy.data?.checkpoints ?? []) {
        push(localLabel, option(id.split("/").pop() || id, `${localLabel} · ComfyUI`, { source: "local", backend: "comfyui", model: id }));
      }
    }

    if (kind === "music") {
      // 生音乐的"本地引擎"在上游还是预留位（见 bun/music-gen.ts 的 localUnavailable），
      // 所以这里只有云端候选 + 「跟随默认模型」（音乐页保存的那套配置）。
      options.push(option(t("canvas.model.followDefault"), localLabel, null));
      for (const p of cloud.data?.providers ?? []) {
        if (!p.enabled) continue;
        for (const m of providerModelsOfType(p, "music")) {
          push(cloudLabel, option(m.name || m.id, `${cloudLabel} · ${p.name}`, { source: "cloud", backend: "cloud", providerId: p.id, model: m.id }));
        }
      }
    }

    if (kind === "tts") {
      options.push(option(t("canvas.model.followDefault"), localLabel, null));
      for (const p of cloud.data?.providers ?? []) {
        if (!p.enabled) continue;
        for (const m of providerModelsOfType(p, "tts")) {
          push(cloudLabel, option(m.name || m.id, `${cloudLabel} · ${p.name}`, { source: "cloud", providerId: p.id, model: m.id }));
        }
      }
    }

    // group 出现顺序即下拉分组顺序；"__hidden" 桶用于 disabled 的占位（当前没有）。
    const seen = new Map<string, CanvasModelOption[]>();
    for (const opt of options) {
      const list = seen.get(opt.group) ?? [];
      list.push(opt);
      seen.set(opt.group, list);
    }
    const groups = Array.from(seen.entries()).map(([group, items]) => ({ group, items }));
    return { data: options, groups, isLoading: chat.isLoading || cloud.isLoading };
  }, [kind, chat.data, cloud.data, chat.isLoading, cloud.isLoading, mlx.data, comfyImage.data, comfy.data, t]);
}
