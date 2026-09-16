// 语音工作台：左侧栏（语音页的）切换三个工具，主屏按 tab 渲染对应标签页。
// 三个标签页各自拆成独立文件（tts / asr / clone），共用的结果展示与模型行在 parts.tsx。
import { useVoiceStore } from "@stores/voice";
import { TtsTab } from "./tts-tab";
import { AsrTab } from "./asr-tab";
import { CloneTab } from "./clone-tab";

export function VoiceScreen() {
  const { tab } = useVoiceStore();

  // 工具入口（语音合成 / 语音识别 / 声音克隆）在左侧栏顶部，与生图页一致。
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tab === "tts" && <TtsTab />}
      {tab === "asr" && <AsrTab />}
      {tab === "clone" && <CloneTab />}
    </div>
  );
}
