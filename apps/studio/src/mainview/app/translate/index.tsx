// 翻译工作台：文本翻译 / 同传翻译两个工具。引擎选择器与文本标签页各自成文件，
// 同传页（live-translate）复用同一个引擎选择器。
import { useTranslateStore } from "@stores/translate";
import { LiveTranslateTab } from "../live-translate";
import { TextTranslateTab } from "./text-tab";

export function TranslateScreen() {
  const tool = useTranslateStore((s) => s.tool);
  return tool === "live" ? <LiveTranslateTab /> : <TextTranslateTab />;
}
