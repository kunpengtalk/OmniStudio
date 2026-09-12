/**
 * omi 手册冒烟：命令实现 / 帮助文本 / 共享数据源 / docs/omi-cli.md 四者一致性校验。
 *
 * 跑法：
 *   bun run scripts/omi-docs-smoke.ts            校验（doc 不一致时报错）
 *   bun run scripts/omi-docs-smoke.ts --write    用当前数据源重新生成 docs/omi-cli.md
 *
 * 校验内容：
 *   1. 命令表（COMMANDS）与 CMD_HELP 一一对应，HELP_TEXT 里列到每条命令；
 *   2. TOPIC_HELP / launch 工具帮助的父命令都存在；
 *   3. shared/cli-docs.ts 的分组条目中英双语齐全、命令非空；
 *   4. omi guide --json 可解析；
 *   5. docs/omi-cli.md 与 cliDocMarkdown() 输出一致（防止手册漂移）。
 */
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const docPath = path.join(repoRoot, "docs", "omi-cli.md");

// 先隔离数据目录再 import CLI 模块：命令模块会（间接）加载 db 层，
// 直接跑迁移 —— 不能让冒烟脚本碰用户真实数据。
// 目录用 mkdtemp 保证每次运行互不干扰（与 kb-* 冒烟脚本一致）。
const providedDataDir = process.env.OMNI_DATA_DIR;
const dataDir = providedDataDir ?? mkdtempSync(path.join(tmpdir(), "omni-docs-smoke-"));
mkdirSync(dataDir, { recursive: true });
process.env.OMNI_DATA_DIR = dataDir;

const { HELP_TEXT, CMD_HELP, TOPIC_HELP, launchToolHelp } = await import("../src/cli/help");
const { COMMANDS } = await import("../src/cli/index");
const { CLI_SECTIONS, CLI_MEMORY_SNIPPETS, cliDocJson, cliDocMarkdown } = await import(
  "../src/shared/cli-docs"
);

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

console.log("命令表 ↔ 帮助文本");
const commandNames = Object.keys(COMMANDS);
const helpNames = Object.keys(CMD_HELP);
check("每个已实现命令都有帮助", commandNames.every((c) => helpNames.includes(c)), `缺失：${commandNames.filter((c) => !helpNames.includes(c)).join(", ") || "无"}`);
check("帮助里没有未实现的命令", helpNames.every((c) => commandNames.includes(c)), `多余：${helpNames.filter((c) => !commandNames.includes(c)).join(", ") || "无"}`);
const undocumented = commandNames.filter((c) => !HELP_TEXT.includes(c));
check("HELP_TEXT 列出全部命令", undocumented.length === 0, undocumented.join(", ") || "无");

console.log("\n子命令帮助");
const topicParents = Object.keys(TOPIC_HELP).map((k) => k.split(" ")[0]!);
const badTopics = topicParents.filter((p) => !commandNames.includes(p));
check("子命令帮助的父命令存在", badTopics.length === 0, badTopics.join(", ") || "无");
const launchTools = ["claude", "codex", "opencode", "openclaw", "hermes", "pi", "copilot", "chatgpt"];
const missingToolHelp = launchTools.filter((t) => !launchToolHelp(t));
check("每个编码工具都有 omi help launch <tool>", missingToolHelp.length === 0, missingToolHelp.join(", ") || "无");
check("未知工具不给假帮助", launchToolHelp("nope") === undefined);

console.log("\n共享数据源完整性");
check("分组数量 > 0", CLI_SECTIONS.length > 0);
check(
  "每条命令都有中英说明与主命令",
  CLI_SECTIONS.every((s) =>
    s.entries.every((e) => e.cmd.trim() && e.zh.trim() && e.en.trim()),
  ),
);
check(
  "分组标题 / 说明中英齐全",
  CLI_SECTIONS.every((s) => s.titleZh && s.titleEn && s.descZh && s.descEn),
);
check(
  "记忆片段中英齐全且含网关占位符或可独立复制",
  CLI_MEMORY_SNIPPETS.length >= 4 &&
    CLI_MEMORY_SNIPPETS.every((s) => s.titleZh && s.titleEn && s.descZh && s.descEn && s.code.trim()),
);
const entryIds = CLI_SECTIONS.flatMap((s) => s.entries.map((e) => e.cmd));
check("命令条目无重复", new Set(entryIds).size === entryIds.length);

console.log("\nguide 输出");
let guideJson = "";
try {
  guideJson = cliDocJson();
  JSON.parse(guideJson);
  check("--json 是合法 JSON", true);
} catch (err) {
  check("--json 是合法 JSON", false, String(err));
}
check("--md 含全部分组标题", CLI_SECTIONS.every((s) => cliDocMarkdown("zh").includes(s.titleZh)));
check("--lang en 输出英文标题", cliDocMarkdown("en").includes(CLI_SECTIONS[1]!.titleEn));

console.log("\ndocs/omi-cli.md 同步");
const generated = cliDocMarkdown("zh");
if (process.argv.includes("--write")) {
  writeFileSync(docPath, generated);
  check(`已写入 ${path.relative(repoRoot, docPath)}`, true);
} else {
  let onDisk = "";
  try {
    onDisk = readFileSync(docPath, "utf8");
  } catch {
    check("docs/omi-cli.md 存在", false, "运行 --write 生成");
  }
  if (onDisk) {
    check(
      "docs/omi-cli.md 与数据源一致",
      onDisk === generated,
      onDisk === generated ? undefined : "运行 bun run scripts/omi-docs-smoke.ts --write 重新生成",
    );
  }
}

// 只清理自己建的临时目录；调用方显式指定 OMNI_DATA_DIR 时保留现场。
if (!providedDataDir) {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}

console.log(failed === 0 ? "\n全部通过。" : `\n${failed} 项未通过。`);
process.exit(failed === 0 ? 0 : 1);
