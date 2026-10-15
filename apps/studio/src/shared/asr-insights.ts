/**
 * 转写工作台右侧「智能整理」的纯逻辑：场景预设、一键动作、以及把转写稿拼成提示词。
 *
 * 为什么放 `shared/`：**一份动作清单同时被两边读** —— 主进程按它发指令
 * （`bun/asr-insights.ts`），webview 按它渲染按钮（`mainview/app/voice/asr-insight-panel.tsx`）。
 * 各写一份的坏处不是重复几行字，而是「界面上写着【行动项】、实际发出去的指令是【摘要】」
 * 这种看不出来的错位。所以**标签与指令放在同一条目录里**，提示词也只写在这里，
 * 主进程不再重复一遍。
 *
 * 本文件不 import 任何进程专属模块（无 db、无 electrobun、无 React），单测直接覆盖。
 */

/**
 * 转写片段。与 `bun/asr-parse.ts` 的 `AsrSegment` 同形（结构化类型，可直接传入），
 * 这里只声明提示词用得到的三项，避免 shared → bun 的反向依赖。
 */
export type InsightSegment = { start: number; end: number; text: string; speaker?: number };

/** 提示词上限：转写稿太长就掐头去尾，别把上下文整个撑爆（约 24k 字 ≈ 16k token 中文）。 */
export const ASR_INSIGHT_LIMITS = {
  transcriptChars: 24000,
  questionChars: 500,
  maxOutputTokens: 2000,
  timeoutMs: 180_000,
} as const;

// ---------------------------------------------------------------------------
// 场景（预设）
// ---------------------------------------------------------------------------

export type AsrSceneId = "general" | "meeting" | "interview" | "lecture" | "subtitle";

export type AsrScene = {
  id: AsrSceneId;
  /** 界面上的名字（i18n key）。 */
  labelKey: string;
  /** 这个场景会怎么影响结果，一句话（i18n key）。 */
  hintKey: string;
  /** 注入 system 的角色设定：同类稿件里哪些信息才是重点。 */
  context: string;
  /** 选这个场景时「人声分离」的默认值 —— 字幕不需要说话人，会议 / 访谈必须要。 */
  preferDiarize: boolean;
  /** 这个场景最常用的一键动作（排在动作条前面）。 */
  followUps: AsrInsightActionId[];
};

export const ASR_SCENES: readonly AsrScene[] = [
  {
    id: "general",
    labelKey: "voice.asr.scene.general",
    hintKey: "voice.asr.scene.generalHint",
    context: "用户没有说明用途，按通用文稿处理：结构清楚、要点齐全即可。",
    preferDiarize: false,
    followUps: ["summary", "actions", "questions"],
  },
  {
    id: "meeting",
    labelKey: "voice.asr.scene.meeting",
    hintKey: "voice.asr.scene.meetingHint",
    context:
      "这是一份会议记录。关注：达成的结论、待办事项（谁 / 做什么 / 什么时候）、悬而未决的分歧、下一次对齐的时间。",
    preferDiarize: true,
    followUps: ["actions", "summary", "questions"],
  },
  {
    id: "interview",
    labelKey: "voice.asr.scene.interview",
    hintKey: "voice.asr.scene.interviewHint",
    context:
      "这是一份访谈 / 对谈记录。关注：受访者说的具体事实与数字、观点与理由、值得单独成段的原话；提问方的引导不要混进受访者的观点里。",
    preferDiarize: true,
    followUps: ["summary", "questions", "proofread"],
  },
  {
    id: "lecture",
    labelKey: "voice.asr.scene.lecture",
    hintKey: "voice.asr.scene.lectureHint",
    context:
      "这是一份课程 / 讲演记录。关注：知识点的层次（概念 → 例子 → 结论）、专有名词与公式、可以复述的完整推理链。",
    preferDiarize: false,
    followUps: ["summary", "questions", "title"],
  },
  {
    id: "subtitle",
    labelKey: "voice.asr.scene.subtitle",
    hintKey: "voice.asr.scene.subtitleHint",
    context:
      "这份转写要用作字幕 / 口播稿。关注：删掉口癖与无意义的重复、把断句修顺，但保持口语原样，不要改写成书面语。",
    preferDiarize: false,
    followUps: ["proofread", "translate", "title"],
  },
];

export const DEFAULT_ASR_SCENE: AsrSceneId = "general";

export function asrScene(id: AsrSceneId): AsrScene {
  return ASR_SCENES.find((s) => s.id === id) ?? ASR_SCENES[0]!;
}

/** 校验来自 webview 的场景值（不认识的回落默认，而不是抛错）。 */
export function normalizeScene(raw: unknown): AsrSceneId {
  return typeof raw === "string" && ASR_SCENES.some((s) => s.id === raw)
    ? (raw as AsrSceneId)
    : DEFAULT_ASR_SCENE;
}

// ---------------------------------------------------------------------------
// 一键动作（FOLLOW-UPS）
// ---------------------------------------------------------------------------

export type AsrInsightActionId =
  | "summary"
  | "actions"
  | "questions"
  | "proofread"
  | "translate"
  | "title"
  | "custom";

export type AsrInsightAction = {
  id: AsrInsightActionId;
  labelKey: string;
  /** 发给模型的指令本身。 */
  instruction: string;
  /** 需要用户先写问题（只有「提问」需要）。 */
  needsQuestion?: boolean;
};

export const ASR_INSIGHT_ACTIONS: readonly AsrInsightAction[] = [
  {
    id: "summary",
    labelKey: "voice.asr.act.summary",
    instruction:
      "写一份结构化摘要：先用 2–4 句话讲清整段在说什么，再按主题分成 3–6 个小节（每节一个 ### 小标题），每节 1–3 句。",
  },
  {
    id: "actions",
    labelKey: "voice.asr.act.actions",
    instruction:
      "列出这段内容里的待办与承诺，做成 Markdown 任务清单（`- [ ] 事项 —— 负责人 —— 时间点`）。稿中没提到负责人或时间的写「未指定」，不要补。如果一条都没有，直接说明「没有待办」。",
  },
  {
    id: "questions",
    labelKey: "voice.asr.act.questions",
    instruction:
      "整理出 5–8 个关键问题，每个问题下面附一小段（1–2 句）基于转写稿的回答；稿中没答案的，在问题后面标注「稿中未提及」。",
  },
  {
    id: "proofread",
    labelKey: "voice.asr.act.proofread",
    instruction:
      "校对这份转写稿：只列出**确实有问题**的地方，用表格给出「时间点 / 原文 / 建议 / 理由」。常见问题是同音字、专有名词、英文术语拼写、断句。没有发现问题就说「未发现明显错误」。",
  },
  {
    id: "translate",
    labelKey: "voice.asr.act.translate",
    instruction:
      "把整份转写稿译成英文，保留原有的时间点与说话人标记，保持口语语气，不要意译成书面语。",
  },
  {
    id: "title",
    labelKey: "voice.asr.act.title",
    instruction:
      "起 5 个标题备选（每个不超过 20 字），并给出一份 60 字以内的简介。标题要具体到这段内容本身，不要用「关于…的讨论」这种空话。",
  },
  {
    id: "custom",
    labelKey: "voice.asr.act.custom",
    instruction: "回答用户针对这份转写稿提出的问题。",
    needsQuestion: true,
  },
];

export const DEFAULT_ASR_INSIGHT_ACTION: AsrInsightActionId = "summary";

export function asrInsightAction(id: AsrInsightActionId): AsrInsightAction {
  return ASR_INSIGHT_ACTIONS.find((a) => a.id === id) ?? ASR_INSIGHT_ACTIONS[0]!;
}

/** 校验来自 webview 的动作值；不认识的返回 null（调用方据此拒绝请求）。 */
export function normalizeAction(raw: unknown): AsrInsightActionId | null {
  return typeof raw === "string" && ASR_INSIGHT_ACTIONS.some((a) => a.id === raw)
    ? (raw as AsrInsightActionId)
    : null;
}

// ---------------------------------------------------------------------------
// 转写稿 → 提示词
// ---------------------------------------------------------------------------

/** 媒体时间轴时钟：m:ss 或 h:mm:ss（与界面上的时间戳同一规则）。 */
function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 转写稿 → 纯文本。每句一行，`[时间] 说话人 N：正文` —— 带时间点是为了让模型能引用
 * （「08:32 提到的上线时间」），用户也据此回到原音频核对。
 *
 * 说话人只在**确实有区分**时才写：所有片段都归说话人 0 时加这一列只是噪音，
 * 而且会诱导模型按说话人编造谁说了什么。
 */
export function buildTranscriptText(
  segments: readonly InsightSegment[],
  opts?: { hasSpeakers?: boolean; timestamps?: boolean },
): string {
  const timestamps = opts?.timestamps !== false;
  const speakers = opts?.hasSpeakers ?? segments.some((s) => s.speaker != null && s.speaker !== 0);
  return segments
    .map((s) => {
      const text = (s.text ?? "").trim();
      if (!text) return "";
      const head = timestamps ? `[${fmtClock(s.start)}] ` : "";
      const who = speakers ? `说话人 ${(s.speaker ?? 0) + 1}：` : "";
      return `${head}${who}${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 超长稿件掐头去尾（保留开头 60% 与结尾 40%）：开头有主题、结尾有结论，
 * 中间那段丢掉的信息量最小；中间的省略标记也明确告诉模型"这里缺了一段"，
 * 免得它把前后两段接成一句话。
 */
export function clipTranscript(text: string, maxChars: number = ASR_INSIGHT_LIMITS.transcriptChars): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const dropped = text.length - maxChars;
  return `${text.slice(0, head)}\n\n……（此处省略 ${dropped} 字，稿子过长）……\n\n${text.slice(text.length - tail)}`;
}

/** 场景无关的硬规则：不编造、纠正明显的识别错误、Markdown 输出、引用带时间点。 */
function systemRules(): string {
  return [
    "你是中文语音转写稿的整理助手。",
    "规则：",
    "1. 只依据转写稿作答；稿子里没有的人名、数字、结论一律不要补。拿不准就写「稿中未提及」。",
    "2. 转写稿来自语音识别，可能有同音字与断句错误：明显不合理处按上下文纠正，但不要改写原意、不要润色成书面语。",
    "3. 用 Markdown 输出，标题从 ### 起；不要寒暄、不要复述这些规则、不要用代码块把整篇包起来。",
    "4. 引用具体内容时带上时间点（如 `08:32`），方便回到原音频核对。",
  ].join("\n");
}

/**
 * 动作 + 场景 + 转写稿 → 发给模型的 system / prompt。
 *
 * 指令来自 `ASR_INSIGHT_ACTIONS`（与界面按钮同一份），场景只提供角色设定，
 * 所以「界面上点的是哪个按钮」和「模型收到的指令」不可能对不上。
 */
export function buildInsightMessages(input: {
  action: AsrInsightActionId;
  scene: AsrSceneId;
  transcript: string;
  question?: string;
}): { system: string; prompt: string } {
  const action = asrInsightAction(input.action);
  const scene = asrScene(input.scene);
  const question = (input.question ?? "").trim().slice(0, ASR_INSIGHT_LIMITS.questionChars);

  const prompt = [
    scene.context,
    `任务：${action.instruction}`,
    // 只有需要提问的动作才把问题带上：其余动作带上它只会让模型在「摘要」里回答别的问题。
    action.needsQuestion && question ? `用户的问题：${question}` : "",
    "",
    "--- 转写稿开始 ---",
    clipTranscript(input.transcript),
    "--- 转写稿结束 ---",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { system: systemRules(), prompt };
}

/** 这次请求缺少必要输入时的说明（调用方直接当错误返回）。 */
export function insightInputError(input: {
  action: AsrInsightActionId;
  transcript: string;
  question?: string;
}): string | null {
  if (!input.transcript.trim()) return "还没有转写内容可以整理";
  if (asrInsightAction(input.action).needsQuestion && !(input.question ?? "").trim()) {
    return "这个动作需要先写一个问题";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 一次「智能整理」的输入 / 输出（主进程与 webview 共用同一份形状）
// ---------------------------------------------------------------------------

export type AsrInsightRequest = {
  action?: string;
  scene?: string;
  /** 只有 `custom` 动作用得到。 */
  question?: string;
  /** 结构化片段：主进程自己拼提示词，界面不负责拼字。 */
  segments?: InsightSegment[];
  /** 没有分段时的整段文本。 */
  text?: string;
  hasSpeakers?: boolean;
};

export type AsrInsightResult = {
  ok: boolean;
  /** 模型返回的 Markdown 正文。 */
  text?: string;
  error?: string;
  action?: AsrInsightActionId;
  scene?: AsrSceneId;
  /** 展示用的模型名（本地为服务名，云端为模型 id）。 */
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};
