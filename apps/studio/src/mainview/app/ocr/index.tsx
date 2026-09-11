import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BotIcon, CpuIcon, FileTextIcon, ScanTextIcon, SparklesIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { OcrEngineType } from "../../../shared/ocr";
import { DropZone } from "../main-layout/drop-zone";
import { SegmentedControl, type StagedImage } from "./parts";
import { PaddleOcrTab } from "./paddleocr-tab";
import { TesseractTab } from "./tesseract-tab";
import { VlmTab } from "./vlm-tab";

type OcrTab = "extract" | "docs";

export function OcrScreen() {
  const t = useT();
  const [tab, setTab] = useState<OcrTab>("extract");
  const [engine, setEngine] = useState<OcrEngineType>("tesseract");
  // 图片在两个引擎间共享，切换引擎不必重新选图。
  const [image, setImage] = useState<StagedImage | null>(null);

  const hydrated = useRef(false);
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  useEffect(() => {
    if (hydrated.current || !settingsData?.settings) return;
    hydrated.current = true;
    const saved = settingsData.settings.OCR_ENGINE;
    if (saved === "vlm") {
      setEngine("vlm");
    } else if (saved === "tesseract") {
      setEngine("tesseract");
    } else if (saved === "paddleocr") {
      setEngine("paddleocr");
    } else {
      // 后端默认为空，识别时会因引擎未启用而失败，这里显式落到 Tesseract。
      setEngine("tesseract");
      void rpcClient.updateSettings({ settings: { OCR_ENGINE: "tesseract" } });
    }
  }, [settingsData]);

  const switchEngine = (v: OcrEngineType) => {
    if (engine === "paddleocr" && v !== "paddleocr") {
      // 切走时停掉常驻 worker，释放内存。
      void rpcClient.stopPpOcr();
    }
    setEngine(v);
    void rpcClient.updateSettings({ settings: { OCR_ENGINE: v } });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {(
            [
              { key: "extract", label: t("ocr.tab.extract"), icon: <ScanTextIcon className="size-3.5" /> },
              { key: "docs", label: t("ocr.tab.docs"), icon: <FileTextIcon className="size-3.5" /> },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                tab === item.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>

        {tab === "extract" ? (
          <div className="ml-auto w-72 shrink-0">
            <SegmentedControl<OcrEngineType>
              value={engine}
              onChange={switchEngine}
              options={[
                {
                  value: "tesseract",
                  label: t("ocr.engine.tesseract.short"),
                  icon: <CpuIcon className="size-3.5" />,
                },
                {
                  value: "paddleocr",
                  label: t("ocr.engine.paddleocr.short"),
                  icon: <BotIcon className="size-3.5" />,
                },
                {
                  value: "vlm",
                  label: t("ocr.engine.vlm.short"),
                  icon: <SparklesIcon className="size-3.5" />,
                },
              ]}
            />
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "docs" ? (
          <DropZone />
        ) : engine === "vlm" ? (
          <VlmTab image={image} onImageChange={setImage} />
        ) : engine === "paddleocr" ? (
          <PaddleOcrTab image={image} onImageChange={setImage} />
        ) : (
          <TesseractTab image={image} onImageChange={setImage} />
        )}
      </div>
    </div>
  );
}
