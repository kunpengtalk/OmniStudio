/**
 * 一次性抽取脚本：把 vibedesign（默认 ~/ai/vibedesign 或当前用户家目录下的 ai/vibedesign）
 * 的三类提示词数据归一化成 JSON 种子文件，供 OmniStudio 首次启动时灌入本地 SQLite：
 *
 *   - image：图片提示词（image2hub 97 条 + awesome-gpt-image-2 541 条）
 *   - video：MiniMax H3 视频提示词/案例（2000+ 条）
 *   - llm  ：大模型提示词（vibedesign 的 Agent/设计 taste 提示词 + 常见角色提示词）
 *
 * 用法：
 *   bun scripts/extract-vibedesign-prompts.ts
 * 输出到 apps/studio/src/bun/prompt-library/seed/
 *
 * 种子数据只含提示词文本与公开链接，不含任何密钥/凭据。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIBE_DIR = `${process.env.HOME || "/Users/jwangkun"}/ai/vibedesign`;
const OUT_DIR = join(HERE, "../apps/studio/src/bun/prompt-library/seed");

// ---------------------------------------------------------------------------
// TS `export const X = <json>` 解析（数据文件均为生成器产物，值是严格 JSON）
// ---------------------------------------------------------------------------

function extractExportBlocks(src: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = src.split("\n");
  const offsets: number[] = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    offsets.push(offsets[i]! + lines[i]!.length + 1);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/);
    if (!m) continue;
    const name = m[1]!;
    const start = offsets[i]! + line.indexOf("=") + 1;
    const end = valueEnd(src, start);
    if (end <= start) continue;
    const raw = src.slice(start, end).trim();
    if (raw) blocks.set(name, raw);
  }
  return blocks;
}

/**
 * 从 src[start] 起找到 JSON 值的结束偏移：支持数组/对象（括号配平，跳过字符串）、
 * 字符串字面量（含转义）、JSON.parse(...) 调用（到行尾）。
 */
function valueEnd(src: string, start: number): number {
  let i = start;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (i >= src.length) return start;
  const ch = src[i]!;
  if (ch === "[" || ch === "{") {
    const close = ch === "[" ? "]" : "}";
    let depth = 1;
    let inStr = false;
    for (i = i + 1; i < src.length; i++) {
      const c = src[i]!;
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === ch) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return src.length;
  }
  if (ch === '"') {
    for (i = i + 1; i < src.length; i++) {
      if (src[i] === "\\") i++;
      else if (src[i] === '"') return i + 1;
    }
    return src.length;
  }
  // JSON.parse(...) 或其它单行表达式：取到行尾
  const nl = src.indexOf("\n", i);
  return nl === -1 ? src.length : nl;
}

function parseBlockValue(block: string, blocks: Map<string, string>): unknown {
  if (!block.startsWith("JSON.parse(")) return JSON.parse(block);
  // JSON.parse(SOME_NAME)：该常量本身是一个字符串字面量，先取出来解一次
  const inner = block.slice("JSON.parse(".length, block.lastIndexOf(")")).trim();
  if (blocks.has(inner)) {
    const lit = blocks.get(inner)!;
    const a = lit.indexOf('"');
    const b = lit.lastIndexOf('"');
    if (a !== -1 && b > a) return JSON.parse(JSON.parse(lit.slice(a, b + 1)) as string);
  }
  // JSON.parse("...")：字面量直接双重解析
  const a = block.indexOf('"');
  const b = block.lastIndexOf('"');
  if (a === -1 || b <= a) return [];
  return JSON.parse(JSON.parse(block.slice(a, b + 1)) as string);
}

function loadExports(file: string): Map<string, unknown> {
  const src = readFileSync(file, "utf8");
  const blocks = extractExportBlocks(src);
  const out = new Map<string, unknown>();
  for (const [name, block] of blocks) {
    try {
      out.set(name, parseBlockValue(block, blocks));
    } catch (e) {
      console.warn(`  [warn] 无法解析 ${name}（${file}）：${e}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// image：归一化到统一中文分类（与 vibedesign PromptsView 一致）
// ---------------------------------------------------------------------------

const AWESOME_CAT_TO_ZH: Record<string, string> = {
  "Posters & Typography": "海报",
  "Illustration & Art": "插画",
  "Photography & Realism": "其他",
  "Characters & People": "插画",
  "UI & Interfaces": "其他",
  "Charts & Infographics": "运营",
  "Products & E-commerce": "运营",
  "Brand & Logos": "IP",
  "Architecture & Spaces": "其他",
  "Scenes & Storytelling": "海报",
  "Documents & Publishing": "其他",
  "History & Classical Themes": "艺术",
};

const IMG2HUB_CAT_TO_NAME: Record<string, string> = {
  ops: "运营",
  app: "APP",
  poster: "海报",
  illustration: "插画",
  ip: "IP",
};

function unifyImageCat(source: string, cat: string): string {
  const zh = source === "awesome" ? AWESOME_CAT_TO_ZH[cat] : IMG2HUB_CAT_TO_NAME[cat];
  return zh || "其他";
}

function buildImageSeed() {
  const lib = loadExports(join(VIBE_DIR, "frontend/src/content/promptLibrary.ts"));
  const awesome = loadExports(join(VIBE_DIR, "frontend/src/content/awesomePrompts.ts"));

  const img2hubItems: any[] = (lib.get("IMAGE_PROMPTS") as any[]) || [];
  const awesomeItems: any[] = (awesome.get("AWESOME_PROMPTS") as any[]) || [];

  const items: Record<string, unknown>[] = [];
  for (const it of img2hubItems) {
    items.push({
      id: it.id,
      name: it.name,
      category: unifyImageCat("img2hub", it.cat),
      subcategory: it.sub || "",
      prompt: it.prompt,
      ratio: it.ratio || "",
      image: it.image || "",
      source: "img2hub",
      sourceUrl: "https://image2hub.netlify.app/",
      sourceLabel: "Image2Hub",
      featured: 0,
    });
  }
  for (const it of awesomeItems) {
    items.push({
      id: it.id,
      name: it.name,
      category: unifyImageCat("awesome", it.cat),
      subcategory: AWESOME_CAT_TO_ZH[it.cat] || "其他",
      prompt: it.prompt,
      ratio: it.ratio || "",
      image: it.image || "",
      source: "awesome",
      sourceUrl: it.source || "",
      sourceLabel: it.sourceLabel || "",
      featured: it.featured ? 1 : 0,
    });
  }

  const categoryIntro: Record<string, string> = {
    "运营": "运营活动、图表信息图、电商产品等落地场景。",
    "APP": "App 界面 / 功能演示 / 上架素材等移动端场景。",
    "海报": "海报、横幅、排版与叙事场景。",
    "插画": "插画、角色、二次元与艺术创作。",
    "IP": "品牌 Logo、IP 形象与吉祥物。",
    "其他": "摄影写实、UI 界面、空间建筑等其它场景。",
    "艺术": "插画、艺术海报等艺术类场景。",
  };
  const cats = [...new Set(items.map((i) => i.category as string))].map((name) => ({
    name,
    intro: categoryIntro[name] || "",
  }));

  return { categories: cats, items };
}

// ---------------------------------------------------------------------------
// video：MiniMax H3 视频提示词/案例
// ---------------------------------------------------------------------------

function buildVideoSeed() {
  const exps = loadExports(join(VIBE_DIR, "frontend/src/content/videoPrompts.ts"));
  const categories: any[] = (exps.get("VIDEO_PROMPT_CATEGORIES") as any[]) || [];
  const sources: any[] = (exps.get("VIDEO_PROMPT_SOURCES") as any[]) || [];
  const all: any[] = (exps.get("VIDEO_PROMPTS") as any[]) || [];

  // 视频条目里 category 是分类 id（cinema/ads…），统一映射成中文名作为 category
  const catName = new Map<string, string>(categories.map((c) => [c.id, c.name]));

  const items = all
    .filter((it) => it.name && (it.prompt || it.summary))
    .map((it) => ({
      id: it.id,
      name: it.name,
      titleEn: it.titleEn || "",
      category: catName.get(it.cat) || it.cat || "",
      subcategory: it.sub || "",
      prompt: it.prompt || "",
      hasPrompt: !!it.hasPrompt,
      mode: it.mode || "",
      duration: it.duration || 0,
      ratio: it.ratio || "",
      summary: it.summary || "",
      image: it.image || "",
      video: it.video || "",
      playUrl: it.playUrl || "",
      playLabel: it.playLabel || "",
      source: it.source || "",
    }));

  return {
    categories: categories.map((c) => ({ name: c.name, intro: c.intro, id: c.id })),
    sources: sources.map((s) => ({ id: s.id, label: s.label, url: s.repoUrl, count: s.count })),
    items,
  };
}

// ---------------------------------------------------------------------------
// llm：大模型提示词（vibedesign Agent 提示词 + 设计 taste SKILL + 常用角色）
// ---------------------------------------------------------------------------

function buildLlmSeed() {
  const skillDir = join(VIBE_DIR, "agent/skills");

  function skill(file: string) {
    const p = join(skillDir, file, "SKILL.md");
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf8");
    const metaEnd = raw.indexOf("---", 3);
    const meta = metaEnd === -1 ? "" : raw.slice(0, metaEnd);
    const descMatch = meta.match(/description\s*:\s*"([^"]*)"/);
    const desc = descMatch ? descMatch[1] : file;
    const body = (metaEnd === -1 ? raw : raw.slice(metaEnd + 3)).trim();
    return { desc, body };
  }

  const items: Record<string, unknown>[] = [];

  const push = (category: string, it: {
    id: string; name: string; prompt: string; summary?: string; source?: string;
  }) => items.push({
    category, id: it.id, name: it.name, prompt: it.prompt,
    summary: it.summary || "", source: it.source || "", featured: 0,
  });

  push("设计助手", {
    id: "design-suggest-compact",
    name: "设计方案建议（英文精简）",
    summary: "grok/gpt 设计助手的原始 system prompt：给出布局、配色、字体与视觉元素建议。",
    source: "vibedesign generate-design API",
    prompt:
      "You are a professional design assistant. Based on user's description, provide detailed design suggestions including layout, colors, typography, and visual elements. Be specific and creative.",
  });
  push("设计助手", {
    id: "design-suggest-zh",
    name: "结构化中文设计方案",
    summary: "vibedesign agent 的结构化建议：布局、色彩（含 hex）、字体 + 3 个具体视觉元素，160 字内。",
    source: "vibedesign app/agent.py",
    prompt:
      "你是一名专业的设计 Agent。根据用户的需求描述，用中文返回精炼、结构化的设计方案建议，涵盖：布局、配色（附 hex 色值）、字体，以及 3 个具体的视觉元素。控制在 160 字以内。",
  });

  const uiSkills: { file: string; id: string; name: string; src: string }[] = [
    { file: "high-end-visual-design", id: "skill-high-end", name: "高级视觉设计（Awwwards 级）", src: "taste-skill/high-end-visual-design" },
    { file: "minimalist-ui", id: "skill-minimalist", name: "极简主义文档风 UI", src: "taste-skill/minimalist-ui" },
    { file: "industrial-brutalist-ui", id: "skill-brutalist", name: "工业粗野主义 UI", src: "taste-skill/industrial-brutalist-ui" },
    { file: "imagegen-frontend-web", id: "skill-img-web", name: "前端 Web 页面生成协议", src: "taste-skill/imagegen-frontend-web" },
    { file: "imagegen-frontend-mobile", id: "skill-img-mobile", name: "前端移动端页面生成协议", src: "taste-skill/imagegen-frontend-mobile" },
  ];
  for (const s of uiSkills) {
    const got = skill(s.file);
    if (got) push("UI 设计风格", { id: s.id, name: s.name, prompt: got.body, summary: got.desc, source: s.src });
  }

  push("品牌", {
    id: "brand-full-case",
    name: "品牌全案工作流",
    summary: "vibedesign 规划器的品牌全案阶段模板：Logo → 手册 → 色彩 → 产品 → 包装 → 海报 → App → 电商 → TVC → 带货视频。",
    source: "vibedesign app/agents/planner.py",
    prompt:
      "请为一个「{brief}」执行完整品牌全案，依次产出：\n" +
      "1. 极简几何 Logo（一个主标 + 一个图标版）\n" +
      "2. 品牌视觉规范手册（Logo 使用规范、字体、辅助图形）\n" +
      "3. 品牌色彩体系（主色/辅色/强调色，附 hex 与占比）\n" +
      "4. 品牌角色 IP 吉祥物形象\n" +
      "5. 产品 3D 渲染效果图与结构示意\n" +
      "6. 三款产品外观渲染图\n" +
      "7. 产品包装设计\n" +
      "8. 主视觉海报与门店陈列图\n" +
      "9. 可交互 App 首页 HTML demo\n" +
      "10. 电商详情页 HTML（预留实景图占位）\n" +
      "11. 30 秒 TVC 脚本并出片\n" +
      "12. 真人带货短视频",
  });
  push("品牌", {
    id: "brand-product-launch",
    name: "新品上市工作流",
    summary: "vibedesign 规划器：主视觉 → 海报 → 电商详情页 → TVC。",
    source: "vibedesign app/agents/planner.py",
    prompt:
      "请为「{brief}」执行新品上市流程：\n" +
      "1. 生成产品主视觉图\n" +
      "2. 生成宣传海报\n" +
      "3. 生成电商详情页 HTML\n" +
      "4. 生成 TVC 短片",
  });

  push("图像生成", {
    id: "image-prompt-basic",
    name: "中文生图提示词骨架",
    summary: "通用图像生成提示词骨架，可直接替换内容用于本地生图。",
    source: "curated",
    prompt: "一个{主体}在{场景}，{光线/氛围}，{风格关键词}，电影感构图，细节丰富，高分辨率",
  });
  push("图像生成", {
    id: "image-prompt-multi",
    name: "多主体一致性生图提示词",
    summary: "结构化、多语义块的长提示词写法（参考 MiniMax/海螺案例）。",
    source: "curated",
    prompt:
      "subject_definitions:\n" +
      "<Subject 1>: 主要角色/主体描述（含外貌、服装、气质）\n" +
      "<Subject 2>: 核心道具/元素描述\n" +
      "<Scene>: 场景与背景描述\n\n" +
      "summary:\n" +
      "[镜头/画面描述] 用一段话描述完整画面：主体动作、构图、镜头运动、光线与色调。\n\n" +
      "detailing:\n" +
      "补充细节：材质、阴影、纹理、前景/背景层次，确保风格与参考一致。",
  });

  const roles: { id: string; name: string; prompt: string; summary: string }[] = [
    {
      id: "role-assistant",
      name: "通用助手（本地部署）",
      summary: "适合本地模型的基础角色设定：简洁、不编造、不确定时说明。",
      prompt:
        "你是一名可靠的 AI 助手。请用简洁、准确的中文回答用户的问题。\n" +
        "规则：\n" +
        "1. 不确定的内容明确说明，不要编造事实；\n" +
        "2. 涉及代码、配置时给出可直接运行的完整示例；\n" +
        "3. 回答过长时先给结论，再展开细节。",
    },
    {
      id: "role-translator",
      name: "翻译助手（中英互译）",
      summary: "忠实通顺地翻译，保留专有名词与代码块。",
      prompt:
        "你是一名专业译者。将用户提供的内容翻译成目标语言：\n" +
        "1. 保持原文语气与信息完整，专有名词首次出现可附原文；\n" +
        "2. 代码、命令、路径、URL、变量名保持原样；\n" +
        "3. 只输出译文，不添加解释。",
    },
    {
      id: "role-polish",
      name: "中文写作润色",
      summary: "润色中文文案：更流畅、简洁、有力，保持原意。",
      prompt:
        "你是一名中文编辑。请润色用户提供的文字：\n" +
        "1. 修正语病、冗余与不自然的表达；\n" +
        "2. 让句子更有节奏与感染力，但不改变原意；\n" +
        "3. 输出润色后的全文，并在最后用列表说明主要修改点。",
    },
    {
      id: "role-code-review",
      name: "代码审查专家",
      summary: "按严重程度列出问题：正确性、安全、性能、可读性，并给出修复建议。",
      prompt:
        "你是一名资深代码审查专家。请审查用户提交的代码：\n" +
        "1. 按「严重 > 一般 > 建议」列出问题；\n" +
        "2. 每个问题指出位置、原因与修复示例；\n" +
        "3. 关注正确性、安全性（注入/越权/泄露）、性能与可读性；\n" +
        "4. 最后给出总体结论（通过 / 修改后通过 / 不通过）。",
    },
    {
      id: "role-summarizer",
      name: "长文总结",
      summary: "把长文本压缩成要点清单与一句话结论。",
      prompt:
        "请总结用户提供的长文：\n" +
        "1. 先用一句话概括核心结论；\n" +
        "2. 再按主题列出要点（每条不超过一行）；\n" +
        "3. 仅基于原文，不添加外部信息。",
    },
    {
      id: "role-prompt-engineer",
      name: "提示词工程师",
      summary: "帮你把模糊想法改写成高质量的提示词。",
      prompt:
        "你是一名提示词工程师。请把用户的想法改写成高质量提示词：\n" +
        "1. 明确角色、任务、输入、输出格式与约束；\n" +
        "2. 补充示例与负面约束；\n" +
        "3. 同时给出一个精简版（直接可用）与一个进阶版。",
    },
  ];
  for (const r of roles) push("常用角色", r);

  // 办公场景提示词（策展数据）：整理自公开提示词合集
  // （awesome-chatgpt-prompts / awesome-prompts-and-scripts / prompt-handbook /
  //   Awesome-Office-AI-Workflow），内容为通用中文办公提示词，可直接复制使用。
  const office: { id: string; name: string; prompt: string; summary: string; source: string }[] = [
    {
      id: "weekly-report",
      name: "周报生成助手",
      summary: "用 STAR 法则生成结构化的周报，含详细版与精简版两版。",
      source: "awesome-prompts-and-scripts 职场办公-写周报",
      prompt: `请帮我写一份周报。时间：本周。
主要工作内容：
- {任务1}: {完成情况}
- {任务2}: {完成情况}
- {任务3}: {进行中}
本周成果/关键数据：
- {数据/成果1}
- {数据/成果2}
遇到的问题和解决方案：
- {问题1}: {解决方案}
下周计划：
- {计划1}
- {计划2}

要求：使用 STAR 法则写工作内容；突出成果和价值，用数据说话；问题要写解决方案而非单纯抱怨；语言简洁，避免流水账；提供详细版（给直属上级）和精简版（给大老板）两个版本。`,
    },
    {
      id: "daily-work-log",
      name: "日报/工作日志助手",
      summary: "把当天的工作、数据、问题和明日计划整理成可直接发送的日报。",
      source: "awesome-prompts-and-scripts 职场办公-写日报",
      prompt: `请帮我写一份今日工作日报。
时间段：{例如：9:00-18:00}
今日主要工作：
- {任务1}: {进展/完成情况}
- {任务2}: {进展/完成情况}
今日数据与成果：{关键数据和数字}
遇到的问题及处理：{问题与解决方法}
明日计划：
- {计划1}
- {计划2}

要求：按时间或优先级整理，重点突出成果与进展；每个任务说明状态（已完成/进行中/受阻）；语言简洁，避免流水账；如有未完成事项，说明原因和预计完成时间。`,
    },
    {
      id: "business-email-draft",
      name: "商务邮件撰写",
      summary: "按收件人、目的与语气生成结构完整、可直接发送的工作邮件。",
      source: "awesome-prompts-and-scripts 写作助手-工作邮件 / prompt-handbook-邮件撰写",
      prompt: `请帮我写一封工作邮件，场景如下：
- 收件人：{收件人身份}
- 目的：{邮件目的}
- 语气：{正式/半正式/友好}
- 需要包含的信息：{关键信息}

要求邮件结构完整：主题行 -> 称呼 -> 开场 -> 正文 -> 行动号召 -> 结束语 -> 署名。语气得体专业，信息清晰，方便收件人直接回复。`,
    },
    {
      id: "email-polish",
      name: "邮件润色改写",
      summary: "对草稿邮件进行语气、结构和措辞的润色，并给出前后对比。",
      source: "awesome-chatgpt-prompts Professional Email Writer / prompt-handbook-文本润色",
      prompt: `请以专业邮件写作者的身份帮我润色以下邮件。
原邮件：{粘贴原文}

要求：1. 调整语气为正式/半正式/友好；2. 优化主题行、称呼、开场、正文、行动号召和结束语；3. 保持清晰和专业，去除冗余词句；4. 保留所有核心信息，不改变原意；5. 针对不同场合调整篇幅（简短/中等/详细）；6. 最后给出润色前后的对比说明。`,
    },
    {
      id: "meeting-minutes",
      name: "会议纪要整理",
      summary: "把杂乱的会议记录整理成含行动项、可直接发送的正式纪要。",
      source: "awesome-prompts-and-scripts 职场办公-写会议纪要",
      prompt: `请根据以下会议记录整理正式会议纪要。
会议主题：{主题}
时间：{日期时间}
参会人：{名单}
主持人：{主持人}
会议记录：{粘贴会议录音文字/笔记要点}

纪要格式：
1. 会议概况（时间/地点/参会人/主题）
2. 会议目标
3. 讨论要点（按议题分类，每个议题含讨论过程和结论）
4. 决议事项（决定了什么）
5. 行动项（事项/负责人/截止日期）
6. 下次会议预告

要求：客观中立，只记录事实不夹带个人观点。`,
    },
    {
      id: "ppt-outline",
      name: "PPT 大纲与演讲稿生成",
      summary: "根据主题与听众生成结构完整的 PPT 大纲及配套演讲词。",
      source: "awesome-prompts-and-scripts 职场办公-写PPT大纲/演讲稿",
      prompt: `请为以下主题设计 PPT 大纲和演讲稿。
主题：{主题}
演讲时长：{分钟}
听众：{听众背景和期望}
核心目标：{听众听完后应该知道/做什么}
你的身份：{职位/角色}
已有内容：{材料/数据}

PPT 结构建议：
1. 封面标题和副标题（各 3 个备选）
2. 目录页（3-4 个章节）
3. 每页 PPT 内容：标题、核心要点（3-5 个 bullet points）、建议配图/表格/示意图类型、该页的演讲词（口语化，150 字以内）
4. 过渡页设计
5. 结尾页（核心信息回顾+行动号召）
6. Q&A 准备（预设 3-5 个问题及回答）`,
    },
    {
      id: "annual-summary",
      name: "工作总结/年终总结撰写",
      summary: "基于实际工作事实生成结构清晰、杜绝空话套话的汇报总结。",
      source: "Awesome-Office-AI-Workflow 公文与材料写作-工作总结汇报",
      prompt: `你现在是一位资深的办公室主笔材料专家。请帮我撰写一份{时间段，如：2026 年上半年}工作总结。
核心要求：
1. 结构清晰：采用「总-分-总」的结构，层级分明，多用一、二、三等序号进行层次划分，方便我直接复制到 Word 中进行微调。
2. 拒绝空洞：不要使用万能模板和浮夸的形容词，严禁杜撰数据，内容必须结合我提供的实际工作事实，做到言之有物。
3. 语言风格：庄重、凝练、雅致，注重使用有文采的短语来提炼各部分的小标题。

我提供的工作事实与核心数据如下（请基于此进行适当扩写与逻辑串联，切勿偏离事实）：
- {补充实际做过的工作和数据}
- {补充其他重点项目落地情况}

请根据以上要求，为我生成一份不少于 1500 字的总结初稿。`,
    },
    {
      id: "okr-setting",
      name: "OKR/KPI 目标制定",
      summary: "结合岗位与部门目标，产出可量化、可验证的 OKR/KPI。",
      source: "awesome-prompts-and-scripts 职场办公-写OKR/KPI目标",
      prompt: `请帮我制定{季度/年度}的 OKR/KPI。
我的岗位：{岗位}
部门目标：{部门级目标}
公司战略方向：{公司级方向}
可用资源：{预算/人力/工具}
挑战：{面临的主要困难}

OKR 格式：
Objective（目标）: {有激励性的目标描述}
Key Results（关键结果）:
  KR1: {可量化的结果 1}
  KR2: {可量化的结果 2}
  KR3: {可量化的结果 3}

要求：目标有挑战性但不至于不可能；关键结果必须可量化、可验证；各 KR 之间有逻辑关联；标注每个 KR 的置信度（5/10）；提供稳健版和挑战版两个版本；对齐上级目标。`,
    },
    {
      id: "task-breakdown",
      name: "任务拆解与项目管理",
      summary: "把大任务拆为带责任、耗时与完成标准的可执行子任务清单。",
      source: "prompt-handbook-任务拆解 / awesome-prompts-and-scripts-项目计划书",
      prompt: `请将以下任务拆解成若干个子任务：{任务描述}，并附带详细的实行方法或步骤。
要求：
1. 按优先级和依赖关系排列子任务；
2. 为每个子任务标注负责角色、预计耗时和完成标准；
3. 识别关键路径和主要风险点，并给出应对；
4. 给出里程碑节点和整体时间表（可含 WBS 工作分解）；
5. 最后输出一份可直接执行的整体清单。`,
    },
    {
      id: "excel-formula",
      name: "Excel 公式生成",
      summary: "根据数据结构与需求生成可直接复制的 Excel/表格公式。",
      source: "awesome-prompts-and-scripts 数据分析-Excel公式生成",
      prompt: `请帮我生成一个 Excel/Google Sheets 公式。
数据说明：
- {列A}: {说明}
- {列B}: {说明}
- {列C}: {说明}
我需要实现：{详细描述想要的计算或操作}
示例数据：{提供几行输入数据与期望结果}

请提供：
1. 完整的 Excel 公式
2. 公式的拆解说明（每部分的作用）
3. 替代方案（如使用新函数 XLOOKUP 等）
4. 注意事项（如数据类型、空值处理）`,
    },
    {
      id: "competitor-analysis",
      name: "竞品分析（角色扮演法）",
      summary: "通过模拟竞品高管对话，反推竞品策略并制定应对方案。",
      source: "awesome-prompts-and-scripts 角色扮演-模拟竞争对手",
      prompt: `请扮演{竞品公司}的{CEO/产品经理/销售总监}，与我进行对话。
竞品信息：
- 公司：{名称}
- 产品：{主要产品}
- 优势：{核心优势}
- 弱点：{薄弱环节}
- 近期动作：{新品/价格调整等}
我的角色：{我方公司/产品}

对话目的：了解竞品策略，找到应对方法。
规则：以竞品的视角思考和回答问题；不轻易透露核心信息，需要技巧性提问；对敏感问题会回避或误导。

对话后请帮我总结竞品的关键信息，并给出基于对话的竞争策略建议。`,
    },
    {
      id: "swot-analysis",
      name: "SWOT 分析助手",
      summary: "对目标对象做完整的 SWOT 分析并输出优先级排序的策略建议。",
      source: "awesome-chatgpt-prompts SWOT Analysis",
      prompt: `请对{公司/项目}进行全面的 SWOT 分析。识别内部的优势（Strengths）和劣势（Weaknesses），以及外部的机会（Opportunities）和威胁（Threats），并针对每一项给出事实依据。最后提出具体策略建议：如何利用优势、抓住机会、改进劣势、化解威胁，并按优先级排序。`,
    },
    {
      id: "impromptu-speech",
      name: "即兴发言/演讲稿撰写",
      summary: "生成口语化、结构清晰且适合朗读的发言稿或演讲词。",
      source: "awesome-prompts-and-scripts 写作助手-写演讲稿/发言稿",
      prompt: `请帮我写一篇{场合}的发言稿/演讲稿。
身份：{你的身份}
听众：{听众构成}
时长：{约几分钟}
核心想表达的内容：{主要内容}

要求：
1. 开头快速建立共鸣（问候+感谢+关联）
2. 正文有清晰的逻辑主线（最多 3 个要点）
3. 穿插 1-2 个小故事或亲身经历
4. 语言口语化，适合朗读
5. 结尾有号召力，可加金句
6. 标注语速/停顿/手势提示`,
    },
    {
      id: "leave-request-email",
      name: "请假/调休申请撰写",
      summary: "生成正式得体、包含交接安排的请假或调休申请。",
      source: "awesome-prompts-and-scripts 职场办公-写请假/调休申请",
      prompt: `请帮我写一封请假/调休申请。
请假类型：{年假/病假/事假/调休}
日期：{开始日期-结束日期}
时长：{天数}
原因：{简要说明}
工作交接：{已安排同事/已提前完成重要工作}
联系方式：{紧急情况下能否联系到}

要求：正式但不啰嗦；说明工作已妥善安排，让领导放心；语气礼貌；提供邮件版和 IM 沟通版两个版本。`,
    },
    {
      id: "im-message-polish",
      name: "IM 消息高情商回复",
      summary: "针对客户/同事/领导的消息给出得体的回复话术与潜台词分析。",
      source: "prompt-handbook-消息回复/社交技巧",
      prompt: `我的{客户/同事/领导}发消息说：{对方消息内容}，我的目的是{想达成的目标}，我应该如何回复？
请提供：
1. 2-3 个不同侧重点的高情商回复话术；
2. 如需婉拒或不便明说的场景，提供委婉表达；
3. 分析对方消息中的潜台词或言外之意；
4. 指出哪些说法容易引起误会，并给出改写建议。`,
    },
    {
      id: "interview-prep",
      name: "模拟面试官（面试准备）",
      summary: "以面试官身份进行多轮模拟面试并逐题点评打分。",
      source: "awesome-prompts-and-scripts 角色扮演-模拟面试官 / prompt-handbook-模拟面试",
      prompt: `请扮演{岗位}的资深面试官，对我进行模拟面试。
岗位：{如 Java 后端/前端/数据科学/产品经理}
面试轮次：{电话面/技术面/行为面/终面}
我的背景：{几年经验，主要技能栈/亮点}

规则：
1. 每次只问一个问题，等我回答后给出评价再问下一个
2. 从易到难，逐步深入
3. 考察基础知识、项目经验（用 STAR 法则提问）和解决问题的能力
4. 每个问题后给出：我的回答评分（1-10）、要点补充、可以改进的地方
5. 模拟 5 轮左右，最后做总结点评`,
    },
    {
      id: "resume-optimize",
      name: "简历优化改写",
      summary: "对简历进行量化、关键词与 ATS 友好的整体优化。",
      source: "awesome-prompts-and-scripts 翻译润色-简历润色 / prompt-handbook-简历优化",
      prompt: `请帮我优化以下简历内容。
目标岗位：{岗位名称}
目标公司：{公司名称}
原文：{粘贴简历内容}

润色要求：
1. 使用强有力的动词开头
2. 量化成果（用数字和百分比）
3. 去除冗余词汇
4. 针对岗位需求优化关键词
5. 用数据化和结果导向的语言改写工作经历
6. 保持真实准确
7. 符合 ATS（自动筛选系统）优化要求
8. 给出优化前后的对比`,
    },
    {
      id: "data-analysis-report",
      name: "数据分析报告撰写",
      summary: "把分析结果组织成结论先行、可汇报的专业数据分析报告。",
      source: "awesome-prompts-and-scripts 数据分析-数据分析报告撰写",
      prompt: `请根据以下数据分析结果，撰写一份数据分析报告。
分析主题：{主题}
数据来源：{数据源}
分析结果摘要：{粘贴分析结果/图表描述/关键发现}
目标读者：{管理层/客户/技术团队}

报告结构：
1. 执行摘要（一页纸概览）
2. 分析背景和目标
3. 数据概况和处理方法
4. 核心发现（3-5 个关键洞察）
5. 深入分析（图表+解读）
6. 结论和建议
7. 附录（方法论和原始数据）

要求：语言简洁、结论先行、建议可执行。`,
    },
  ];
  for (const o of office) push("办公", o);

  const cats = ["设计助手", "UI 设计风格", "品牌", "图像生成", "常用角色", "办公"].filter((c) =>
    items.some((i) => i.category === c),
  );
  const llmIntro: Record<string, string> = {
    "办公": "周报/日报、邮件、会议纪要、PPT、总结汇报、OKR、任务拆解、面试简历等日常办公场景的即用提示词（整理自公开提示词合集）。",
  };
  return { categories: cats.map((name) => ({ name, intro: llmIntro[name] || "" })), items };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const image = buildImageSeed();
const video = buildVideoSeed();
const llm = buildLlmSeed();

writeFileSync(join(OUT_DIR, "image-prompts.json"), JSON.stringify(image));
writeFileSync(join(OUT_DIR, "video-prompts.json"), JSON.stringify(video));
writeFileSync(join(OUT_DIR, "llm-prompts.json"), JSON.stringify(llm));

console.log(`已写入 ${OUT_DIR}`);
console.log(`  image: ${image.items.length} 条提示词 / ${image.categories.length} 个分类`);
console.log(`  video: ${video.items.length} 条提示词 / ${video.categories.length} 个分类`);
console.log(`  llm  : ${llm.items.length} 条提示词 / ${llm.categories.length} 个分类`);
