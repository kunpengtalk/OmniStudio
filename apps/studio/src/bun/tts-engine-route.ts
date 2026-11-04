/**
 * 本地 TTS 的引擎路由：audio.cpp 与 speech.cpp 是两个并列引擎，这里决定某一次合成走谁。
 *
 * 为什么要有这个文件：三个入口都要做同一个判断 —— RPC `runTTSLocal`（语音页 / 画布 /
 * Agent）、`bun/media-tools.ts` 的 `generate_speech`、`bun/voice.ts` 的通话逐句合成。
 * 判断分散在三处，任何一处漏读 `TTS_LOCAL_ENGINE`，用户切了引擎之后就会有一个入口
 * 还在叫上一个引擎 —— 表现是"界面上已经切过去了，这里还报未启动/未知模型"。
 *
 * 两条规则：
 *  - **显式给出的模型 id 优先**：id 属于哪个引擎就归哪个。画布节点自带 `localModelId`，
 *    调用方点名要的模型不该被"当前启用的引擎"覆盖掉。两个目录的 id 不重名，可以安全判定。
 *  - 没点名（或名字两边都不认识）时听设置 `TTS_LOCAL_ENGINE`，缺省 audio.cpp
 *    （与老用户的既有行为一致）。
 *
 * 引擎本体的一次性调用（各自的 `runTTSLocal` / `runTTSSpeechCpp`）不看设置 ——
 * 它们假定调用方已经把该启用的那个启用了，这也是 `isTtsLocalActive` 那类判断留在各自模块里的原因。
 */
import type { MediaSource } from "./db/schema";
import { getSetting } from "./db/settings";
import { SPEECHCPP_ENGINE_ID, speechCppModelEntry } from "../shared/speechcpp";
import * as TTSLocal from "./tts-local";
import * as TtsSpeechCpp from "./tts-speechcpp";
import type { VoiceRecordRow } from "./voice";

export type LocalTtsEngine = "audio.cpp" | "speech.cpp";

/** 某个模型 id 属于哪个本地引擎；两边都不认识时返回 null。 */
export function localTtsEngineOfModel(modelId: string | null | undefined): LocalTtsEngine | null {
  const id = modelId?.trim();
  if (!id) return null;
  if (speechCppModelEntry(id)) return "speech.cpp";
  if (TTSLocal.AUDIOCPP_TTS_CATALOG.some((m) => m.id === id)) return "audio.cpp";
  return null;
}

/** 这次合成该走哪个引擎（显式模型优先，其次设置）。 */
export function resolveLocalTtsEngine(modelId?: string | null): LocalTtsEngine {
  return (
    localTtsEngineOfModel(modelId) ??
    (getSetting("TTS_LOCAL_ENGINE") === SPEECHCPP_ENGINE_ID ? "speech.cpp" : "audio.cpp")
  );
}

export function localTtsEngineActive(engine: LocalTtsEngine): boolean {
  return engine === "speech.cpp" ? TtsSpeechCpp.isSpeechCppActive() : TTSLocal.isTtsLocalActive();
}

/** 有没有任何一个本地 TTS 引擎在启用（Agent 的 `auto` 链用它决定要不要试本地这一档）。 */
export function anyLocalTtsActive(): boolean {
  return TTSLocal.isTtsLocalActive() || TtsSpeechCpp.isSpeechCppActive();
}

export type LocalTtsRunInput = {
  text: string;
  model?: string;
  voice?: string;
  emotion?: string;
  language?: string;
  instruct?: string;
  source?: MediaSource;
};

/** 按路由把一次合成交给对应的引擎，落库并返回记录。 */
export function runLocalTts(input: LocalTtsRunInput): Promise<VoiceRecordRow> {
  return resolveLocalTtsEngine(input.model) === "speech.cpp"
    ? TtsSpeechCpp.runTTSSpeechCpp(input)
    : TTSLocal.runTTSLocal(input);
}

/**
 * 通话逐句本地合成：先走当前启用的那个引擎，它没有可用模型（未下载 / 全部失败）时
 * 再试另一个 —— 用户装着 audio.cpp 的模型却切到了 speech.cpp 时，通话不该直接退到云端。
 */
export async function synthesizeLocalTtsCall(text: string): Promise<Buffer | null> {
  const ordered: LocalTtsEngine[] =
    getSetting("TTS_LOCAL_ENGINE") === SPEECHCPP_ENGINE_ID
      ? ["speech.cpp", "audio.cpp"]
      : ["audio.cpp", "speech.cpp"];
  for (const engine of ordered) {
    const buf =
      engine === "speech.cpp"
        ? await TtsSpeechCpp.synthesizeCallSpeechCpp(text)
        : await TTSLocal.synthesizeCallLocal(text);
    if (buf) return buf;
  }
  return null;
}
