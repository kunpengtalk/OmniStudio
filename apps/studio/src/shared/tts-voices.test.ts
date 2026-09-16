import { describe, expect, test } from "bun:test";

import {
  DEFAULT_STEPFUN_TTS_VOICE,
  STEPFUN_VOICES,
  audioVendorFor,
  defaultVoiceForVendor,
  isOpenAiCompatVoice,
  resolveTtsVoice,
  vendorVoices,
} from "./tts-voices";

/**
 * 「换了厂商但没改音色」这一脚踩下去的表现，是合成时报一句上游的 `invalid voice`：
 * 音色名各家完全不通用（OpenAI 的 alloy / 百炼的 longanqian / 阶跃的 cixingnansheng），
 * 而 TTS_VOICE 是**全局一个槽位**。这里钉住：只有"别家留下的占位默认值"才被替换，
 * 用户自己填的（包括复刻音色 id）一律原样尊重。
 */
describe("audioVendorFor", () => {
  test("预设 id 与地址主机两条路都认得出阶跃", () => {
    expect(audioVendorFor({ providerId: "stepfun" })).toBe("stepfun");
    expect(audioVendorFor({ baseUrl: "https://api.stepfun.com/v1" })).toBe("stepfun");
    // 自建一行 custom-* 指向阶跃的地址：只看 id 的话音色目录与默认值都会落空。
    expect(audioVendorFor({ providerId: "custom-1730000000000", baseUrl: "https://api.stepfun.com/v1" })).toBe(
      "stepfun",
    );
  });

  test("其它厂商 / 空值不认（页面保持自由输入）", () => {
    expect(audioVendorFor({ providerId: "omnilabs", baseUrl: "https://omnilabs.vibeadmin.cn/v1" })).toBeNull();
    expect(audioVendorFor({ providerId: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1" })).toBeNull();
    expect(audioVendorFor({})).toBeNull();
    expect(audioVendorFor({ baseUrl: "不是一个地址" })).toBeNull();
  });
});

describe("resolveTtsVoice", () => {
  test("显式传入的音色优先（复刻音色 id 也照样用）", () => {
    expect(resolveTtsVoice({ requested: "my-cloned-voice", configured: "alloy", vendor: "stepfun" })).toBe(
      "my-cloned-voice",
    );
  });

  test("没配过音色：按厂商给默认值", () => {
    expect(resolveTtsVoice({ configured: "", vendor: "stepfun" })).toBe(DEFAULT_STEPFUN_TTS_VOICE);
    expect(resolveTtsVoice({ configured: null, vendor: null })).toBe("alloy");
  });

  test("存的是别家的占位默认值（alloy）：换成该厂商的默认音色", () => {
    // 工厂默认就是 alloy，直接发出去阶跃只会回 invalid voice —— 而用户什么都没动过。
    expect(resolveTtsVoice({ configured: "alloy", vendor: "stepfun" })).toBe(DEFAULT_STEPFUN_TTS_VOICE);
    expect(resolveTtsVoice({ configured: "Nova", vendor: "stepfun" })).toBe(DEFAULT_STEPFUN_TTS_VOICE);
  });

  test("存的是用户自己填的音色：不替换（哪怕它不在官方清单里）", () => {
    expect(resolveTtsVoice({ configured: "longanqian", vendor: "stepfun" })).toBe("longanqian");
    expect(resolveTtsVoice({ configured: "custom-clone-42", vendor: "stepfun" })).toBe("custom-clone-42");
  });

  test("厂商没有内置目录时不动用户的值", () => {
    expect(resolveTtsVoice({ configured: "alloy", vendor: null })).toBe("alloy");
    expect(resolveTtsVoice({ configured: "zh-CN-XiaoxiaoNeural", vendor: null })).toBe("zh-CN-XiaoxiaoNeural");
  });

  test("isOpenAiCompatVoice 只认 OpenAI 那套占位名", () => {
    expect(isOpenAiCompatVoice("alloy")).toBe(true);
    expect(isOpenAiCompatVoice(" Alloy ")).toBe(true);
    expect(isOpenAiCompatVoice("cixingnansheng")).toBe(false);
    expect(isOpenAiCompatVoice("")).toBe(false);
  });
});

describe("vendorVoices", () => {
  test("阶跃给官方音色清单（含文档示例里用到的那个）", () => {
    const voices = vendorVoices("stepfun");
    expect(voices.length).toBeGreaterThan(10);
    expect(voices.map((v) => v.id)).toContain(DEFAULT_STEPFUN_TTS_VOICE);
    expect(voices.map((v) => v.id)).toContain("linjiajiejie");
    // 官方清单里带连字符的 id 也要在（截图里最常出现的几个）。
    expect(voices.map((v) => v.id)).toContain("elegantgentle-female");
  });

  test("id 不重复（下拉里出现两条一样的会让用户以为没生效）", () => {
    const ids = STEPFUN_VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("认不出的厂商返回空目录", () => {
    expect(vendorVoices(null)).toEqual([]);
  });

  test("默认音色在清单里（不然会把用户置空）", () => {
    expect(defaultVoiceForVendor("stepfun")).toBe(DEFAULT_STEPFUN_TTS_VOICE);
    expect(STEPFUN_VOICES.map((v) => v.id)).toContain(defaultVoiceForVendor("stepfun"));
  });
});
