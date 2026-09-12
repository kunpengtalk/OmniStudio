import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BotIcon, CpuIcon, SparklesIcon } from "lucide-react";

import { Label } from "@ui/label";
import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { useOcrStore } from "@stores/ocr";
import type { OcrEngineType } from "../../../shared/ocr";
import { DropZone } from "../main-layout/drop-zone";
import { SegmentedControl, type StagedImage } from "./parts";
import { PaddleOcrTab } from "./paddleocr-tab";
import { TesseractTab } from "./tesseract-tab";
import { VlmTab } from "./vlm-tab";

export function OcrScreen() {
  const t = useT();
  const tab = useOcrStore((s) => s.tab);
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

  // 引擎切换放在左栏参数面板顶部（与生图页的后端切换同款位置）。
  const engineSwitcher: ReactNode = (
    <div>
      <Label className="mb-1.5 block text-xs">{t("ocr.engine.title")}</Label>
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
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tab === "docs" ? (
        <DropZone />
      ) : engine === "vlm" ? (
        <VlmTab image={image} onImageChange={setImage} engineSwitcher={engineSwitcher} />
      ) : engine === "paddleocr" ? (
        <PaddleOcrTab image={image} onImageChange={setImage} engineSwitcher={engineSwitcher} />
      ) : (
        <TesseractTab image={image} onImageChange={setImage} engineSwitcher={engineSwitcher} />
      )}
    </div>
  );
}
