import { useState } from "react";
import {
  StoreIcon,
  MessageCircleIcon,
  AudioLinesIcon,
  MicIcon,
  ImageIcon,
  BoxIcon,
  ChevronRightIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";

import { ScrollArea } from "@ui/scroll-area";
import { useModelDetailStore } from "@stores/model-detail";
import { useRouter } from "@stores/router";
import { useEngine } from "@lib/use-engine";
import { useT } from "@stores/ui-lang";
import {
  MODEL_PRESETS,
  MODEL_CATEGORIES,
  matchCategory,
  type ModelCategory,
  type ChatPreset,
  type InferenceEngine,
} from "@/shared/modelscope";
import { cn } from "@/mainview/lib/utils";

const CARD_GRADIENTS = [
  "from-slate-900 via-slate-800 to-indigo-950",
  "from-violet-950 via-purple-900 to-fuchsia-950",
  "from-rose-950 via-rose-900 to-pink-950",
  "from-blue-950 via-blue-900 to-cyan-950",
];

const CARD_ICONS: Record<ModelCategory, LucideIcon> = {
  chat: MessageCircleIcon,
  tts: AudioLinesIcon,
  asr: MicIcon,
  image: ImageIcon,
  other: BoxIcon,
};

/**
 * 推荐模型展示卡片（模型库只做展示）：
 * 点击进入详情页，下载在详情页/在线模型市场完成。
 */
function PresetCard({
  preset,
  index,
}: {
  preset: ChatPreset;
  index: number;
}) {
  const t = useT();
  const setSource = useModelDetailStore((s) => s.setSource);
  const setRoute = useRouter((s) => s.setRoute);

  const openDetail = () => {
    setSource({ kind: "preset", preset });
    setRoute({ path: "model-detail" });
  };

  const CardIcon = CARD_ICONS[preset.app];

  return (
    <button
      type="button"
      onClick={openDetail}
      className={cn(
        "group relative flex flex-col gap-3 rounded-xl border border-white/10 bg-gradient-to-br p-4 text-left text-white shadow-sm transition-transform hover:-translate-y-0.5",
        CARD_GRADIENTS[index % CARD_GRADIENTS.length],
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10">
          <CardIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{preset.label}</p>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-white/60">
            {preset.description}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex h-5 items-center rounded-full bg-white/15 px-2 text-[10px] font-medium">
          {t(`models.cat.${preset.app}`)}
        </span>
        {preset.engine && preset.engine !== "all" && (
          <span className="inline-flex h-5 items-center rounded-full bg-white/15 px-2 text-[10px] font-medium">
            {t(`settings.engine.${preset.engine}`)}
          </span>
        )}
      </div>
      <div className="mt-auto flex items-center gap-1 pt-1 text-[11px] text-white/70">
        <SparklesIcon className="size-3" />
        {t("models.viewDetail")}
        <ChevronRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

/** 模型库：只做展示，浏览推荐模型。搜索/下载在「在线模型市场」，推理/启动在「本地模型」。 */
export function ModelsScreen() {
  const t = useT();
  const [activeCategory, setActiveCategory] = useState<ModelCategory | "all">("all");
  const { engine } = useEngine();

  const filteredPresets = MODEL_PRESETS.filter(
    (p) =>
      (!p.engine || p.engine === "all" || p.engine === engine) &&
      matchCategory(
        {
          ...p,
          id: p.repo,
          tags: [
            `task:${p.app === "chat" ? "text-generation" : p.app === "tts" ? "text-to-speech" : p.app === "asr" ? "auto-speech-recognition" : "text-to-image-synthesis"}`,
            `custom_tag:${p.app}`,
          ],
          tasks: [],
        } as unknown as Parameters<typeof matchCategory>[0],
        activeCategory,
      ),
  );

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-30 pt-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <StoreIcon className="size-5" />
            {t("models.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("models.subtitle")}</p>
        </div>

        {/* Category filter */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setActiveCategory("all")}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              activeCategory === "all"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
            )}
          >
            {t("models.cat.all")}
          </button>
          {MODEL_CATEGORIES.filter((c) => c.value !== "all").map((cat) => {
            const isActive = activeCategory === cat.value;
            return (
              <button
                key={cat.value}
                type="button"
                onClick={() => setActiveCategory(cat.value)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                )}
              >
                {t(cat.labelKey)}
              </button>
            );
          })}
        </div>

        {/* Recommended presets */}
        <div>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {t("models.recommended")}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredPresets.map((preset, i) => (
              <PresetCard key={preset.repo} preset={preset} index={i} />
            ))}
          </div>
        </div>

        <p className="text-center text-[11px] text-muted-foreground/60">
          {t("models.downloadHint")}
        </p>
      </div>
    </ScrollArea>
  );
}
