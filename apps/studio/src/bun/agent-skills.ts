/**
 * 把 Skills 接进 Agent（对齐 oh-my-pi 的渐进披露）。
 *
 * 在此之前，Skills 管理页装了多少技能，Agent 都看不见 —— UI 文案写着"按需加载"，
 * 但代码里没有任何路径把技能交给模型（`agent.ts` / `agent-tools.ts` 里搜不到 skill）。
 *
 * 这里是两步式的渐进披露，和 oh-my-pi 的做法一致：
 * 1. **列表**：系统提示里只放 `名字: 描述`（`skillsPromptSection()`）——
 *    正文不进上下文，8k 窗口才装得下；
 * 2. **正文**：模型看到匹配的技能后自己调 `read_skill` 把 SKILL.md 读进来
 *    （`readSkillFile()`），技能目录里的其他文件（脚本 / 模板）用 `file` 参数按需读。
 *
 * 读的是中央技能库（`~/.agents/skills`），不涉及工作区，因此不需要授权弹窗；
 * 路径一路走 `centralSkillDir()` 与 `safeJoin()` 校验，`../..` 出不去。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { listSkills } from "./skills";
import { centralSkillDir } from "./skills/central-repo";
import { logEvent } from "./app-log";
import { isInsideDir, safeJoin } from "./path-safety";

/** 列表里最多列几个技能：8k 窗口下这段也是要花 token 的。 */
export const MAX_SKILLS_IN_PROMPT = 24;
/** 单条描述的字符上限。 */
export const MAX_SKILL_DESCRIPTION_CHARS = 160;
/** 单次读取技能文件的字符上限。 */
const MAX_SKILL_FILE_CHARS = 40_000;
/** 只允许读这些后缀：技能目录里可能有二进制素材，塞进上下文只会浪费窗口。 */
const TEXT_EXTENSIONS = new Set([
  "",
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".rb",
  ".go",
  ".rs",
  ".sql",
  ".html",
  ".css",
  ".csv",
]);

/**
 * 系统提示里的技能清单。
 *
 * 开关（`AGENT_SKILLS_PROMPT`）与"有没有装着技能"都影响结果：没有技能时不返回任何内容，
 * 不占窗口，也不给模型一个空清单去困惑。
 */
/** 技能清单读失败只报一次（这个是每轮都要拼的系统提示片段，反复报会把日志刷满）。 */
let loggedListFailure = false;

export function skillsPromptSection(): string | null {
  let skills: { id: string; name: string; description: string | null }[] = [];
  try {
    skills = listSkills().map((skill) => ({
      id: skill.id,
      name: skill.name || skill.id,
      description: skill.description,
    }));
  } catch (error) {
    // 技能子系统没起来（比如数据库迁移失败）不该拖垮 Agent 回合，但要留痕：
    // 不留的话现象是"Skills 页里装了技能，模型却像不知道有这回事"，
    // 而 app.log 里查不到任何相关记录。
    if (!loggedListFailure) {
      loggedListFailure = true;
      logEvent({
        level: "warn",
        source: "agent",
        event: "agent.skills.list_failed",
        message: `读取技能清单失败，本回合不注入技能列表：${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return null;
  }
  // 读成功就把标记清掉：下次再坏（真的发生变化）时还能报一条。
  loggedListFailure = false;
  if (skills.length === 0) return null;

  const shown = skills.slice(0, MAX_SKILLS_IN_PROMPT);
  const lines = shown.map((skill) => {
    const description = (skill.description ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_SKILL_DESCRIPTION_CHARS);
    return description ? `- ${skill.id}: ${description}` : `- ${skill.id}`;
  });
  return [
    "## 可用的 Skills（技能）",
    "",
    "下面是用户为本机安装的技能。**匹配到当前任务时，先调 read_skill 把它的 SKILL.md 读进来再动手**，",
    "不要凭技能名猜测它的做法。技能里如果引用了脚本 / 模板，用 read_skill 的 file 参数读取，",
    "路径相对于技能目录。",
    "",
    ...lines,
    skills.length > shown.length ? `（还有 ${skills.length - shown.length} 个技能未列出，需要时可用 read_skill 直接按名字读取。）` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export type SkillFileResult =
  | { ok: true; name: string; path: string; text: string; truncated: boolean }
  | { ok: false; reason: string };

/**
 * 读一个技能的文件。
 *
 * `file` 省略时读 SKILL.md（技能的本体）；给了就按技能目录内的相对路径解析，
 * 并且必须仍在技能目录里（挡 `../../etc/passwd` 与指向外部的软链）。
 */
export function readSkillFile(name: string, file?: string): SkillFileResult {
  // 技能目录的路径来自设置（可能指向用户自定义的中央库），设置层在数据库还没起来时
  // 会返回 null —— 那不该让一次工具调用炸掉，给一句能读懂的原因就够了。
  let dir: string | null = null;
  try {
    dir = centralSkillDir(name);
  } catch (error) {
    return { ok: false, reason: `读不到技能目录：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!dir) return { ok: false, reason: `技能名不合法：${name}` };
  if (!existsSync(dir)) return { ok: false, reason: `没有名为 ${name} 的技能（先用 read_skill 不带参数看看有哪些）` };

  let target: string;
  if (!file || !file.trim()) {
    target = ["SKILL.md", "skill.md"]
      .map((marker) => join(dir, marker))
      .find((candidate) => existsSync(candidate)) ??
      "";
    if (!target) return { ok: false, reason: `技能 ${name} 里没有 SKILL.md` };
  } else {
    const joined = safeJoin(dir, file.trim().replace(/^\.\//, ""));
    if (!joined) return { ok: false, reason: `技能内的路径不合法：${file}` };
    target = joined;
  }

  if (!existsSync(target)) return { ok: false, reason: `技能 ${name} 里没有这个文件：${file ?? "SKILL.md"}` };
  try {
    if (!statSync(target).isFile()) return { ok: false, reason: `${file ?? "SKILL.md"} 不是一个文件` };
    // 软链要额外挡一次：safeJoin 只看字面路径。
    if (!isInsideDir(dir, target)) return { ok: false, reason: "只能读取技能目录内的文件" };
    const extension = extname(target).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) {
      return { ok: false, reason: `不读二进制 / 未知类型的文件（${extension || "无后缀"}），技能里通常不需要它` };
    }
    const raw = readFileSync(target, "utf8");
    const truncated = raw.length > MAX_SKILL_FILE_CHARS;
    return {
      ok: true,
      name,
      path: target,
      text: truncated ? raw.slice(0, MAX_SKILL_FILE_CHARS) : raw,
      truncated,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
