import { describe, expect, test } from "bun:test";

import { AUDIOCPP_TTS_CATALOG } from "./tts-local";
import { SPEECHCPP_TTS_CATALOG } from "../shared/speechcpp";
import { localTtsEngineOfModel, resolveLocalTtsEngine } from "./tts-engine-route";
import { updateSettings } from "./db/settings";

/**
 * 本地 TTS 的引擎路由。
 *
 * 两个目录的 id 一旦重名，"按 id 认引擎"就会把请求送到错的引擎上（表现是"未知模型"），
 * 所以第一条测试盯的是 id 不重名这个前提 —— 它是下面所有判断的地基。
 */
describe("本地 TTS 引擎路由", () => {
  test("两个引擎的模型 id 不重名（按 id 认引擎的前提）", () => {
    const acp = new Set(AUDIOCPP_TTS_CATALOG.map((m) => m.id));
    const collisions = SPEECHCPP_TTS_CATALOG.filter((m) => acp.has(m.id)).map((m) => m.id);
    expect(collisions).toEqual([]);
  });

  test("按模型 id 认出所属引擎；两边都不认识返回 null", () => {
    expect(localTtsEngineOfModel("qwen3-tts-0.6b")).toBe("speech.cpp");
    expect(localTtsEngineOfModel("drama-3")).toBe("speech.cpp");
    expect(localTtsEngineOfModel("irodori-tts-mf")).toBe("speech.cpp");
    // audio.cpp 里同样是 qwen3-tts，但 id 带后缀 —— 别把两者混成一个。
    expect(localTtsEngineOfModel("qwen3-tts-1.7b-customvoice")).toBe("audio.cpp");
    expect(localTtsEngineOfModel("supertonic-3")).toBe("audio.cpp");
    expect(localTtsEngineOfModel("nope")).toBeNull();
    expect(localTtsEngineOfModel("")).toBeNull();
    expect(localTtsEngineOfModel(undefined)).toBeNull();
  });

  test("点名了模型就以模型为准，不管当前启用的是哪个引擎", () => {
    updateSettings({ TTS_LOCAL_ENGINE: "audio.cpp" });
    expect(resolveLocalTtsEngine("drama-3")).toBe("speech.cpp");
    updateSettings({ TTS_LOCAL_ENGINE: "speech.cpp" });
    expect(resolveLocalTtsEngine("supertonic-3")).toBe("audio.cpp");
  });

  test("没点名（或名字不认识）时跟随设置，缺省 audio.cpp", () => {
    updateSettings({ TTS_LOCAL_ENGINE: "speech.cpp" });
    expect(resolveLocalTtsEngine(undefined)).toBe("speech.cpp");
    expect(resolveLocalTtsEngine(null)).toBe("speech.cpp");
    expect(resolveLocalTtsEngine("不认识的名字")).toBe("speech.cpp");

    updateSettings({ TTS_LOCAL_ENGINE: "audio.cpp" });
    expect(resolveLocalTtsEngine(undefined)).toBe("audio.cpp");

    // 清空 = 老用户的既有状态（两个都没启用）→ 保持 audio.cpp 的旧行为。
    updateSettings({ TTS_LOCAL_ENGINE: "" });
    expect(resolveLocalTtsEngine(undefined)).toBe("audio.cpp");
  });
});
