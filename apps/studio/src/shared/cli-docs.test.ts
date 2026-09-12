import { describe, expect, test } from "bun:test";

import {
  CLI_DOC_INTRO,
  CLI_MEMORY_SNIPPETS,
  CLI_SECTIONS,
  cliDocJson,
  cliDocMarkdown,
  cliDocText,
  renderSnippet,
} from "./cli-docs";

describe("cli-docs 数据完整性", () => {
  test("分组与条目中英双语齐全", () => {
    expect(CLI_SECTIONS.length).toBeGreaterThan(0);
    for (const section of CLI_SECTIONS) {
      expect(section.id).toBeTruthy();
      expect(section.titleZh).toBeTruthy();
      expect(section.titleEn).toBeTruthy();
      expect(section.descZh).toBeTruthy();
      expect(section.descEn).toBeTruthy();
      expect(section.entries.length).toBeGreaterThan(0);
      for (const entry of section.entries) {
        expect(entry.cmd.trim()).toBeTruthy();
        expect(entry.zh.trim()).toBeTruthy();
        expect(entry.en.trim()).toBeTruthy();
        for (const note of entry.notes ?? []) expect(note.zh && note.en).toBeTruthy();
        for (const example of entry.examples ?? []) {
          expect(example.cmd.trim()).toBeTruthy();
          expect(example.zh && example.en).toBeTruthy();
        }
      }
    }
  });

  test("命令条目不重复", () => {
    const cmds = CLI_SECTIONS.flatMap((s) => s.entries.map((e) => e.cmd));
    expect(new Set(cmds).size).toBe(cmds.length);
  });

  test("覆盖记忆与 code 加载专题", () => {
    const ids = CLI_SECTIONS.map((s) => s.id);
    expect(ids).toContain("memory");
    expect(ids).toContain("code");
    // 记忆片段至少覆盖 stdio MCP（Claude / Codex / opencode）与 HTTP / REST。
    const snippetIds = CLI_MEMORY_SNIPPETS.map((s) => s.id);
    for (const id of ["claude", "codex", "opencode", "http", "rest"]) {
      expect(snippetIds).toContain(id);
    }
  });
});

describe("renderSnippet", () => {
  test("替换网关地址与密钥占位符", () => {
    const out = renderSnippet('{"url":"{{GATEWAY_URL}}/mcp","k":"{{GATEWAY_KEY}}"}', {
      gatewayUrl: "http://127.0.0.1:12345",
      gatewayKey: "secret",
    });
    expect(out).toBe('{"url":"http://127.0.0.1:12345/mcp","k":"secret"}');
    expect(out).not.toContain("{{");
  });

  test("同一占位符出现多次全部替换", () => {
    const out = renderSnippet("{{GATEWAY_URL}} {{GATEWAY_URL}}", {
      gatewayUrl: "http://x",
      gatewayKey: "k",
    });
    expect(out).toBe("http://x http://x");
  });
});

describe("渲染输出", () => {
  test("纯文本含全部分组标题、主命令与示例", () => {
    const text = cliDocText("zh");
    expect(text).toContain(CLI_DOC_INTRO.zh);
    for (const section of CLI_SECTIONS) {
      expect(text).toContain(section.titleZh);
      for (const entry of section.entries) {
        expect(text).toContain(entry.cmd);
        for (const example of entry.examples ?? []) expect(text).toContain(example.cmd);
      }
    }
  });

  test("英文输出用英文词条", () => {
    const text = cliDocText("en");
    expect(text).toContain(CLI_DOC_INTRO.en);
    expect(text).toContain(CLI_SECTIONS[0]!.titleEn);
    expect(text).not.toContain(CLI_SECTIONS[0]!.titleZh);
  });

  test("Markdown 是合法结构：分组标题 + 代码块 + 片段语言", () => {
    const md = cliDocMarkdown("zh");
    for (const section of CLI_SECTIONS) expect(md).toContain(`## ${section.titleZh}`);
    expect(md).toContain("```bash");
    for (const snippet of CLI_MEMORY_SNIPPETS) {
      expect(md).toContain(`### ${snippet.titleZh}`);
      expect(md).toContain(`\`\`\`${snippet.language}`);
    }
    // 代码块成对闭合
    expect(md.split("```").length % 2).toBe(1);
  });

  test("JSON 可解析且与数据源一致", () => {
    const parsed = JSON.parse(cliDocJson()) as {
      sections: unknown[];
      snippets: unknown[];
    };
    expect(parsed.sections.length).toBe(CLI_SECTIONS.length);
    expect(parsed.snippets.length).toBe(CLI_MEMORY_SNIPPETS.length);
  });
});
