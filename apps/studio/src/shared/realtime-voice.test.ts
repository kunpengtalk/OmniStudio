import { describe, expect, test } from "bun:test";

import {
  DEFAULT_REALTIME_BASE_URL,
  STEPFUN_REALTIME_BASE_URL,
  isPresetRealtimeEndpoint,
  isRealtimeModelId,
  realtimeBaseUrlForProvider,
  realtimeDefaultModel,
  realtimeDefaultVoice,
  realtimeDialectFor,
  realtimeInputRate,
} from "./realtime-voice";

/**
 * 实时通话的「地址从厂商推、模型只列实时族、方言决定字段取值」三条规则。
 *
 * 以前这两件事都压在用户身上：地址要手填一个 wss（换厂商不会跟着换，填错只表现为
 * "连不上"），模型下拉把厂商清单里的对话 / 生图模型一起列出来（选中后连接时才报错）。
 * 加入阶跃后还多一层：两家的事件名相同但**字段取值不同**（pcm / pcm16、smart_turn /
 * server_vad、上行 16k / 24k），按同一套发过去会以"连上了但没声音"告终。
 */
describe("realtimeBaseUrlForProvider", () => {
  test("百炼（DashScope）的兼容地址能推出实时端点", () => {
    expect(realtimeBaseUrlForProvider("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(
      DEFAULT_REALTIME_BASE_URL,
    );
    expect(realtimeBaseUrlForProvider("https://bailian.aliyuncs.com/v1")).toBe(
      "wss://bailian.aliyuncs.com/api-ws/v1/realtime",
    );
  });

  test("阶跃的兼容地址推出它自己的实时端点", () => {
    expect(realtimeBaseUrlForProvider("https://api.stepfun.com/v1")).toBe(STEPFUN_REALTIME_BASE_URL);
    expect(STEPFUN_REALTIME_BASE_URL).toBe("wss://api.stepfun.com/v1/realtime");
  });

  test("认不出的主机不猜：自建中转 / 第三方聚合保持用户填的值", () => {
    expect(realtimeBaseUrlForProvider("https://api.siliconflow.cn/v1")).toBeNull();
    expect(realtimeBaseUrlForProvider("http://127.0.0.1:11434/v1")).toBeNull();
    expect(realtimeBaseUrlForProvider("")).toBeNull();
    expect(realtimeBaseUrlForProvider(null)).toBeNull();
    expect(realtimeBaseUrlForProvider("不是一个地址")).toBeNull();
  });
});

describe("realtimeDialectFor", () => {
  test("按地址认厂商（自建中转透传原地址时也认得出）", () => {
    expect(realtimeDialectFor({ baseUrl: STEPFUN_REALTIME_BASE_URL })).toBe("stepfun");
    expect(realtimeDialectFor({ baseUrl: "https://api.stepfun.com/v1" })).toBe("stepfun");
    expect(realtimeDialectFor({ baseUrl: DEFAULT_REALTIME_BASE_URL })).toBe("dashscope");
  });

  test("地址认不出时按模型名判", () => {
    expect(realtimeDialectFor({ baseUrl: "wss://relay.example/ws", model: "stepaudio-3-realtime-preview" })).toBe(
      "stepfun",
    );
    expect(realtimeDialectFor({ baseUrl: "wss://relay.example/ws", model: "qwen-audio-3.0-realtime-plus" })).toBe(
      "dashscope",
    );
    // 两边都认不出：保持本次功能最初的实现（百炼），不能把老配置的默认行为改掉。
    expect(realtimeDialectFor({ baseUrl: "wss://relay.example/ws", model: "whatever" })).toBe("dashscope");
    expect(realtimeDialectFor({})).toBe("dashscope");
  });

  test("上行采样率跟着方言（喂错会被当成另一种语速）", () => {
    expect(realtimeInputRate("stepfun")).toBe(24000);
    expect(realtimeInputRate("dashscope")).toBe(16000);
  });

  test("默认模型 / 音色互不通用", () => {
    expect(realtimeDefaultModel("stepfun")).toBe("stepaudio-3-realtime-preview");
    expect(realtimeDefaultModel("dashscope")).toBe("qwen-audio-3.0-realtime-plus");
    expect(realtimeDefaultVoice("stepfun")).not.toBe(realtimeDefaultVoice("dashscope"));
  });
});

describe("isPresetRealtimeEndpoint", () => {
  test("两家的预设端点都算预设（切换厂商时要能跟着换）", () => {
    expect(isPresetRealtimeEndpoint(DEFAULT_REALTIME_BASE_URL)).toBe(true);
    expect(isPresetRealtimeEndpoint(STEPFUN_REALTIME_BASE_URL)).toBe(true);
  });

  test("自建中转的地址不算：那是用户改过的值，不能被厂商推导覆盖", () => {
    expect(isPresetRealtimeEndpoint("wss://relay.example/ws")).toBe(false);
    expect(isPresetRealtimeEndpoint("")).toBe(false);
    expect(isPresetRealtimeEndpoint(null)).toBe(false);
  });
});

describe("isRealtimeModelId", () => {
  test("实时族放行（realtime / omni / 独立一段 audio 的老型号）", () => {
    expect(isRealtimeModelId("qwen-audio-3.0-realtime-plus")).toBe(true);
    expect(isRealtimeModelId("qwen3.5-omni-flash-realtime")).toBe(true);
    expect(isRealtimeModelId("stepaudio-3-realtime-preview")).toBe(true);
    expect(isRealtimeModelId("stepaudio-2.5-realtime")).toBe(true);
    expect(isRealtimeModelId("step-1o-audio")).toBe(true);
    expect(isRealtimeModelId("step-audio-2")).toBe(true);
  });

  test("对话 / 生图 / 嵌入 / 语音合成与识别模型挡掉", () => {
    expect(isRealtimeModelId("qwen-max")).toBe(false);
    expect(isRealtimeModelId("wanx-v1")).toBe(false);
    expect(isRealtimeModelId("text-embedding-v3")).toBe(false);
    // `stepaudio-3-tts` 里的 audio 是拼在词里的，不是独立一段：它是 TTS，不是实时语音。
    expect(isRealtimeModelId("stepaudio-3-tts")).toBe(false);
    expect(isRealtimeModelId("stepaudio-3-asr-max")).toBe(false);
  });
});
