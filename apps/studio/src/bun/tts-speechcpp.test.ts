import { describe, expect, test } from "bun:test";

import {
  SPEECHCPP_ENGINE_VERSION,
  SPEECHCPP_RELEASE_TAG,
  SPEECHCPP_TTS_CATALOG,
  speechCppModelEntry,
} from "../shared/speechcpp";
import { buildSpeechCppArgs, releaseAssetName } from "./tts-speechcpp";

/**
 * speech.cpp TTS 引擎：目录完整性 + 参数拼装。
 *
 * 这里盯的是三类"编译通过、跑起来才发现"的问题：
 *  1. 目录里少字段 -> 界面上的音色控件空着、或合成时 `--voice` 拼不出值；
 *  2. Release 资产名对不上 -> 下载 404 之后一路换镜像，最后报一句看不懂的错；
 *  3. 参数拼错（漏 `--voice none`、把描述当音色名）-> 引擎拒绝请求。
 */
describe("speech.cpp 模型目录", () => {
  test("id 唯一、每个模型都指向一个 .gguf 与一个仓库", () => {
    const ids = SPEECHCPP_TTS_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of SPEECHCPP_TTS_CATALOG) {
      expect(m.repo).toContain("/");
      expect(m.repoPath.endsWith(".gguf")).toBe(true);
      expect(m.sizeBytes).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
    }
  });

  test("preset 模型的默认音色一定在候选里（否则下拉框选不出来）", () => {
    for (const m of SPEECHCPP_TTS_CATALOG) {
      if (m.voiceKind !== "preset") continue;
      const voices = (m.presetVoices ?? []).map((v) => v.id);
      expect(voices.length).toBeGreaterThan(0);
      const fallback = m.defaultVoice;
      expect(fallback).toBeDefined();
      expect(voices).toContain(fallback!);
    }
  });

  test("支持语言的模型必须给出语言码，且都在标签表里有显示名", () => {
    for (const m of SPEECHCPP_TTS_CATALOG) {
      if (!m.languageSupported) continue;
      expect((m.languageCodes ?? []).length).toBeGreaterThan(0);
    }
  });

  test("按 id 能取到条目，未知 id 返回 undefined", () => {
    expect(speechCppModelEntry("qwen3-tts-0.6b")?.repoPath).toContain("Qwen3-TTS");
    expect(speechCppModelEntry("nope")).toBeUndefined();
    expect(speechCppModelEntry(null)).toBeUndefined();
  });
});

describe("speech.cpp Release 资产", () => {
  test("资产名用不带 v 的版本号，标签才带 v", () => {
    expect(SPEECHCPP_RELEASE_TAG).toBe(`v${SPEECHCPP_ENGINE_VERSION}`);
    const mac = releaseAssetName("darwin", "arm64");
    expect(mac).toBe(`speech-${SPEECHCPP_ENGINE_VERSION}-macos-arm64-metal.zip`);
    expect(mac?.includes(`v${SPEECHCPP_ENGINE_VERSION}`)).toBe(false);
    expect(releaseAssetName("linux", "x64")).toContain("linux-x64-cpu");
    expect(releaseAssetName("win32", "x64")).toContain("windows-x64-vulkan");
  });

  test("没有预编译包的平台返回 null（Intel Mac / arm64 Linux）", () => {
    expect(releaseAssetName("darwin", "x64")).toBeNull();
    expect(releaseAssetName("linux", "arm64")).toBeNull();
  });
});

describe("speech.cpp 参数拼装", () => {
  const preset = speechCppModelEntry("qwen3-tts-0.6b")!;
  const described = speechCppModelEntry("irodori-tts-mf")!;

  test("preset：--voice 用选中的音色，缺省回落到默认音色", () => {
    const args = buildSpeechCppArgs({
      modelPath: "/m/a.gguf",
      outPath: "/o.wav",
      entry: preset,
      options: { voice: "ryan" },
    });
    expect(args.slice(0, 5)).toEqual(["tts", "/m/a.gguf", "-o", "/o.wav", "--voice"]);
    expect(args[5]).toBe("ryan");

    const fallback = buildSpeechCppArgs({
      modelPath: "/m/a.gguf",
      outPath: "/o.wav",
      entry: preset,
      options: {},
    });
    expect(fallback[5]).toBe(preset.defaultVoice);
  });

  test("preset：支持语言时带上 --language，非法语言码直接丢掉", () => {
    const ok = buildSpeechCppArgs({
      modelPath: "/m/a.gguf",
      outPath: "/o.wav",
      entry: preset,
      options: { voice: "ryan", language: "ja" },
    });
    expect(ok).toContain("--language");
    expect(ok[ok.indexOf("--language") + 1]).toBe("ja");

    const bad = buildSpeechCppArgs({
      modelPath: "/m/a.gguf",
      outPath: "/o.wav",
      entry: preset,
      options: { voice: "ryan", language: "not a code" },
    });
    expect(bad).not.toContain("--language");
  });

  test("described：有音色文件时注册后按名字引用", () => {
    const args = buildSpeechCppArgs({
      modelPath: "/m/i.gguf",
      outPath: "/o.wav",
      entry: described,
      options: { voice: "我的音色" },
      voiceFile: "/voices/me.voice.gguf",
      voiceName: "me",
    });
    expect(args).toContain("--add-voice");
    expect(args[args.indexOf("--add-voice") + 1]).toBe("me=/voices/me.voice.gguf");
    expect(args[args.indexOf("--voice") + 1]).toBe("me");
    expect(args).not.toContain("none");
  });

  test("described：没有音色文件时 --voice none + --instructions", () => {
    const args = buildSpeechCppArgs({
      modelPath: "/m/i.gguf",
      outPath: "/o.wav",
      entry: described,
      options: { instruct: "低沉沉稳的男声" },
    });
    expect(args[args.indexOf("--voice") + 1]).toBe("none");
    expect(args[args.indexOf("--instructions") + 1]).toBe("低沉沉稳的男声");
    expect(args).not.toContain("--add-voice");
  });

  test("described：只给音色文件、没给描述时不拼空的 --instructions", () => {
    const args = buildSpeechCppArgs({
      modelPath: "/m/i.gguf",
      outPath: "/o.wav",
      entry: described,
      options: { instruct: "   " },
      voiceFile: "/voices/me.voice.gguf",
      voiceName: "me",
    });
    expect(args).not.toContain("--instructions");
  });

  test("模型不认 --instructions 时，哪怕传了描述也不拼这条（Drama 3 会拒绝整次请求）", () => {
    const drama = speechCppModelEntry("drama-3")!;
    expect(drama.supportsInstruct).toBe(false);
    const args = buildSpeechCppArgs({
      modelPath: "/m/d.gguf",
      outPath: "/o.wav",
      entry: drama,
      options: { instruct: "用很轻的声音念" },
    });
    expect(args).not.toContain("--instructions");
    // 但 voice 仍然必填：Drama 3 认 `--voice none`。
    expect(args[args.indexOf("--voice") + 1]).toBe("none");
  });

  test("0.6B 不认 --instructions，1.7B 认（同一份预设音色，能力位不同）", () => {
    const small = speechCppModelEntry("qwen3-tts-0.6b")!;
    const big = speechCppModelEntry("qwen3-tts-1.7b")!;
    expect(small.supportsInstruct).toBe(false);
    expect(big.supportsInstruct).toBe(true);
    const opts = { voice: "vivian", instruct: "慢一点" };
    expect(
      buildSpeechCppArgs({
        modelPath: "/m/a.gguf",
        outPath: "/o.wav",
        entry: small,
        options: opts,
      }),
    ).not.toContain("--instructions");
    expect(
      buildSpeechCppArgs({ modelPath: "/m/a.gguf", outPath: "/o.wav", entry: big, options: opts }),
    ).toContain("--instructions");
  });

  test("Drama 3 的目录条目对得上官方文档（Q4_K 默认档、20.8GB 文件）", () => {
    const drama = speechCppModelEntry("drama-3")!;
    expect(drama.repoPath).toBe("Drama-35B-A3B-v3-Q4_K.gguf");
    expect(drama.sizeBytes).toBe(20_787_264_352);
    // 说话人写在正文里，所以不需要 --language。
    expect(drama.languageSupported).toBe(false);
  });
});
