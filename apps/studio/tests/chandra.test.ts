import { describe, expect, test } from "bun:test";

import { parseHtml, parseMarkdown } from "../src/bun/vllm/profiles/chandra";
import { SAMPLE_HTML } from "./test-fixtures";

// ---------------------------------------------------------------------------
// shieldMathTags (tested through parseHtml)
// ---------------------------------------------------------------------------

describe("parseHtml", () => {
  test("preserves math placeholder spans through cheerio", () => {
    const html = `<p><math>\\text{UFP} = 62</math></p>`;
    const out = parseHtml(html);
    expect(out).toContain("data-math-latex");
    expect(out).not.toContain("<math");
  });

  test("handles block math with display attribute", () => {
    const html = `<p><math display="block">x^2</math></p>`;
    const out = parseHtml(html);
    expect(out).toContain('data-math-display="true"');
  });

  test("inline math has display=false", () => {
    const html = `<p><math>x^2</math></p>`;
    const out = parseHtml(html);
    expect(out).toContain('data-math-display="false"');
  });

  test("decodes &amp; inside math to &", () => {
    const html = `<p><math display="block">a &amp;= b</math></p>`;
    const out = parseHtml(html);
    const match = out.match(/data-math-latex="([^"]+)"/);
    expect(match).not.toBeNull();
    const latex = Buffer.from(match?.[1]!, "base64").toString("utf8");
    expect(latex).toContain("&=");
    expect(latex).not.toContain("&amp;");
  });

  test("full sample preserves all math tags", () => {
    const out = parseHtml(SAMPLE_HTML);
    expect(out).not.toContain("<math");
    expect(out).not.toContain("</math>");
    const count = (out.match(/data-math-latex/g) ?? []).length;
    expect(count).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// parseMarkdown
// ---------------------------------------------------------------------------

describe("parseMarkdown", () => {
  test("converts inline math placeholder to $...$", () => {
    const latex = "x^2 + y^2";
    const encoded = Buffer.from(latex).toString("base64");
    const html = `<p>Formula: <span data-math-latex="${encoded}" data-math-display="false">\u200B</span> is cool</p>`;
    const md = parseMarkdown(html);
    expect(md).toContain(`$${latex}$`);
  });

  test("converts block math placeholder to $$...$$", () => {
    const latex = "\\begin{aligned}a &= b\\end{aligned}";
    const encoded = Buffer.from(latex).toString("base64");
    const html = `<p><span data-math-latex="${encoded}" data-math-display="true">\u200B</span></p>`;
    const md = parseMarkdown(html);
    expect(md).toContain(`$$${latex}$$`);
  });

  test("preserves backslashes in LaTeX", () => {
    const latex = "\\text{UFP} = \\frac{a}{b}";
    const encoded = Buffer.from(latex).toString("base64");
    const html = `<p><span data-math-latex="${encoded}" data-math-display="false">\u200B</span></p>`;
    const md = parseMarkdown(html);
    expect(md).toContain("\\text{UFP}");
    expect(md).toContain("\\frac{a}{b}");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: parseHtml → parseMarkdown
// ---------------------------------------------------------------------------

describe("end-to-end", () => {
  test("inline math round-trips", () => {
    const html = `<p>Result: <math>\\text{UFP} = 62</math></p>`;
    const md = parseMarkdown(parseHtml(html));
    expect(md).toContain("$\\text{UFP} = 62$");
  });

  test("block math round-trips", () => {
    const html = `<p><math display="block">\\begin{aligned}a &amp;= b\\end{aligned}</math></p>`;
    const md = parseMarkdown(parseHtml(html));
    expect(md).toContain("$$\\begin{aligned}a &= b\\end{aligned}$$");
  });

  test("multiple math blocks in one paragraph", () => {
    const html = `<p><math>a = 1</math><br><math>b = 2</math></p>`;
    const md = parseMarkdown(parseHtml(html));
    expect(md).toContain("$a = 1$");
    expect(md).toContain("$b = 2$");
  });

  test("math mixed with plain text", () => {
    const html = `<p>TCF = <math>0.65 + (0.01 \\times DI)</math> = 1.07</p>`;
    const md = parseMarkdown(parseHtml(html));
    expect(md).toContain("$0.65 + (0.01 \\times DI)$");
    expect(md).toContain("TCF =");
    expect(md).toContain("= 1.07");
  });

  test("dollar signs in plain text pass through (no <math> tags)", () => {
    const html = `<p>Average labor rate = $6500$ per month</p>`;
    const md = parseMarkdown(parseHtml(html));
    expect(md).toContain("6500");
    expect(md).toContain("per month");
  });

  test("full sample produces markdown with all math blocks", () => {
    const md = parseMarkdown(parseHtml(SAMPLE_HTML));

    expect(md).toContain("# Software metrics assignment");
    expect(md).toContain("## Question 1");

    expect(md).toContain(
      "$\\text{UFP} = (2 \\times 4) + (3 \\times 5) + (2 \\times 4) + (1 \\times 10) + (3 \\times 7) = 62$",
    );
    expect(md).toContain("$\\text{DI} = 14 \\times 4 = 42$");

    expect(md).toContain(
      "$$\\begin{aligned}\\text{FP} &= \\text{UFP} \\times \\text{TCF} \\\\ \\text{FP} &= 62 \\times 1.07 = 66.34\\end{aligned}$$",
    );

    expect(md).toContain("$0.65 + (0.01 \\times DI)$");
    expect(md).toContain("$220 \\times 1.07$");
    expect(md).toContain("$235.4 \\times 50$");

    expect(md).toContain("```");
    expect(md).toContain("SumVector");
  });
});
