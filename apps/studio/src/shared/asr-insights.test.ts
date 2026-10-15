import { describe, expect, test } from "bun:test";

import {
  ASR_INSIGHT_ACTIONS,
  ASR_SCENES,
  asrInsightAction,
  asrScene,
  buildInsightMessages,
  buildTranscriptText,
  clipTranscript,
  insightInputError,
  normalizeAction,
  normalizeScene,
  type InsightSegment,
} from "./asr-insights";
import { LANGS, translate } from "./i18n";

const seg = (start: number, end: number, text: string, speaker?: number): InsightSegment => ({
  start,
  end,
  text,
  ...(speaker != null ? { speaker } : {}),
});

describe("转写稿 → 提示词文本", () => {
  test("每句一行，带时间点与说话人", () => {
    const text = buildTranscriptText(
      [seg(0, 2, "开始吧", 0), seg(65, 68, "收到", 1)],
      { hasSpeakers: true },
    );
    expect(text).toBe("[0:00] 说话人 1：开始吧\n[1:05] 说话人 2：收到");
  });

  test("超过一小时的时间戳带小时位", () => {
    expect(buildTranscriptText([seg(3725, 3730, "很久以后")], { hasSpeakers: false })).toBe(
      "[1:02:05] 很久以后",
    );
  });

  test("全部片段都归说话人 0 时不写说话人列（避免诱导模型编造发言人）", () => {
    const text = buildTranscriptText([seg(0, 1, "甲", 0), seg(1, 2, "乙", 0)]);
    expect(text).toBe("[0:00] 甲\n[0:01] 乙");
  });

  test("空片段被跳过，不产生空行", () => {
    const text = buildTranscriptText([seg(0, 1, "  "), seg(1, 2, "有效"), seg(2, 3, "")]);
    expect(text).toBe("[0:01] 有效");
  });

  test("可以关掉时间戳", () => {
    expect(buildTranscriptText([seg(0, 1, "只有正文")], { timestamps: false })).toBe("只有正文");
  });
});

describe("超长稿件裁剪", () => {
  test("不超限时原样返回", () => {
    expect(clipTranscript("短稿", 100)).toBe("短稿");
  });

  test("超限时保留开头与结尾，并写明省略了多少字", () => {
    const text = `${"甲".repeat(60)}${"乙".repeat(60)}`;
    const out = clipTranscript(text, 40);
    expect(out.startsWith("甲".repeat(24))).toBe(true);
    expect(out.endsWith("乙".repeat(16))).toBe(true);
    expect(out).toContain("此处省略 80 字");
    expect(out.length).toBeLessThan(text.length);
  });
});

describe("校验来自 webview 的取值", () => {
  test("认识的场景 / 动作原样通过，不认识的回落或拒绝", () => {
    expect(normalizeScene("meeting")).toBe("meeting");
    expect(normalizeScene("nonsense")).toBe("general");
    expect(normalizeScene(42)).toBe("general");
    expect(normalizeAction("proofread")).toBe("proofread");
    expect(normalizeAction("rm -rf")).toBeNull();
    expect(normalizeAction(undefined)).toBeNull();
  });

  test("目录本身就是合法值的全集", () => {
    for (const s of ASR_SCENES) expect(normalizeScene(s.id)).toBe(s.id);
    for (const a of ASR_INSIGHT_ACTIONS) expect(normalizeAction(a.id)).toBe(a.id);
  });
});

describe("提示词组装", () => {
  test("指令来自动作目录本身（界面上的按钮与发给模型的指令同源）", () => {
    for (const action of ASR_INSIGHT_ACTIONS) {
      const { prompt, system } = buildInsightMessages({
        action: action.id,
        scene: "general",
        transcript: "[0:00] 内容",
        question: action.needsQuestion ? "这稿讲了什么？" : undefined,
      });
      expect(prompt).toContain(action.instruction);
      expect(prompt).toContain("--- 转写稿开始 ---");
      expect(prompt).toContain("[0:00] 内容");
      expect(system).toContain("不要补");
    }
  });

  test("场景只贡献角色设定，不改动动作指令", () => {
    const meeting = buildInsightMessages({ action: "summary", scene: "meeting", transcript: "x" });
    const subtitle = buildInsightMessages({ action: "summary", scene: "subtitle", transcript: "x" });
    expect(meeting.prompt).toContain(asrScene("meeting").context);
    expect(subtitle.prompt).toContain(asrScene("subtitle").context);
    expect(meeting.system).toBe(subtitle.system);
    expect(meeting.prompt).toContain(asrInsightAction("summary").instruction);
  });

  test("自定义问题被带上，且截断到上限", () => {
    const long = "问".repeat(2000);
    const { prompt } = buildInsightMessages({
      action: "custom",
      scene: "general",
      transcript: "x",
      question: long,
    });
    expect(prompt).toContain(`用户的问题：${long.slice(0, 500)}`);
    expect(prompt).not.toContain("问".repeat(501));
  });

  test("非自定义动作不把问题塞进提示词", () => {
    const { prompt } = buildInsightMessages({
      action: "summary",
      scene: "general",
      transcript: "x",
      question: "顺便说说别的",
    });
    expect(prompt).not.toContain("顺便说说别的");
  });
});

describe("输入检查", () => {
  test("没有转写内容直接拦掉", () => {
    expect(insightInputError({ action: "summary", transcript: "   " })).toBe("还没有转写内容可以整理");
    expect(insightInputError({ action: "summary", transcript: "有内容" })).toBeNull();
  });

  test("提问类动作缺问题时报错，其它动作不受影响", () => {
    expect(insightInputError({ action: "custom", transcript: "有内容" })).toBe(
      "这个动作需要先写一个问题",
    );
    expect(insightInputError({ action: "custom", transcript: "有内容", question: "然后呢" })).toBeNull();
    expect(insightInputError({ action: "actions", transcript: "有内容" })).toBeNull();
  });
});

describe("场景与动作目录", () => {
  test("每个场景的推荐动作都是存在的动作，且列在前面时能取到", () => {
    for (const scene of ASR_SCENES) {
      for (const id of scene.followUps) expect(normalizeAction(id)).toBe(id);
    }
  });

  test("场景与动作的 labelKey / hintKey 都是 i18n 键名，没有漏写", () => {
    for (const scene of ASR_SCENES) {
      expect(scene.labelKey).toMatch(/^voice\.asr\./);
      expect(scene.hintKey).toMatch(/^voice\.asr\./);
      expect(scene.context.trim().length).toBeGreaterThan(4);
    }
    for (const action of ASR_INSIGHT_ACTIONS) {
      expect(action.labelKey).toMatch(/^voice\.asr\./);
      expect(action.instruction.trim().length).toBeGreaterThan(4);
    }
    // 只有一个动作需要额外提问，界面据此决定是否弹输入框。
    expect(ASR_INSIGHT_ACTIONS.filter((a) => a.needsQuestion).map((a) => a.id)).toEqual(["custom"]);
  });

  /**
   * 目录里的键是**动态拼**给 t() 的（`t(action.labelKey)`），i18n.test.ts 只检查字面量，
   * 所以漏一条词条不会让那个测试失败 —— 界面上会直接显示 `voice.asr.act.summary`。
   * 这里补上：两种语言都必须能取到文案。
   */
  test("目录里的键在 zh / en 都有文案（动态键不会被 i18n.test.ts 兜住）", () => {
    const keys = [
      ...ASR_SCENES.flatMap((s) => [s.labelKey, s.hintKey]),
      ...ASR_INSIGHT_ACTIONS.map((a) => a.labelKey),
    ];
    const missing: string[] = [];
    for (const { value } of LANGS) {
      for (const key of keys) if (translate(value, key) === key) missing.push(`${value}:${key}`);
    }
    expect(missing).toEqual([]);
  });
});
