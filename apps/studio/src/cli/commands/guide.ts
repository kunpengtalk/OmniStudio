import { optBool, optString, type ParsedArgs } from "../args";
import { cliDocJson, cliDocMarkdown, cliDocText, type CliLang } from "../../shared/cli-docs";

/**
 * `omi guide` — 完整使用手册（安装 / 启动 / 模型加载 / 记忆调用 / 编码工具加载）。
 *
 * 与设置页「工具 → 命令行」页、docs/omi-cli.md 共用同一份数据源
 * （src/shared/cli-docs.ts），所以三处永远一致：
 *   omi guide            纯文本（默认中文）
 *   omi guide --md       Markdown（docs/omi-cli.md 的正文）
 *   omi guide --json     结构化数据（脚本 / 二次渲染）
 *   omi guide --lang en  英文
 */
export async function cmdGuide(parsed: ParsedArgs): Promise<void> {
  const lang: CliLang = optString(parsed.options, "lang") === "en" ? "en" : "zh";

  if (optBool(parsed.options, "json")) {
    console.log(cliDocJson());
    return;
  }
  if (optBool(parsed.options, "md")) {
    console.log(cliDocMarkdown(lang));
    return;
  }
  console.log(cliDocText(lang));
}
