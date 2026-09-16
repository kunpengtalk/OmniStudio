import { describe, expect, test } from "bun:test";
import { translate } from "@/shared/i18n";
import { RELEASE_REPO_URL } from "@/shared/release";
import { buildBenchmarkReportHtml, reportFileName } from "./export-html";
import type { DisplayResult } from "./parts";

/**
 * 导出报告：单文件、可分享。
 *
 * 这里守两件事：
 *  1. 报告里必须有全部数据（分享出去的那份要能独立看懂：配置、汇总、明细、异常提示）；
 *  2. 报告不能引用任何外部资源 —— 别人打开时可能离线。唯一样式来源是内联 <style>，
 *     图表用 CSS 画，不出现 http(s) / views:// / <img> / <script>。
 */
const t = (key: string, params?: Record<string, string>) => translate("zh", key, params);

function speedResult(over: Partial<DisplayResult> = {}): DisplayResult {
  return {
    source: "record",
    kind: "speed",
    model: "Qwen3.6-35B-A3B",
    engine: "llama.cpp",
    serverMode: "local",
    status: "done",
    rows: [
      {
        contextLength: 1024,
        promptTokens: 1044,
        batchSize: 2,
        ttftMs: 1208,
        tpotMs: 0,
        tps: 106,
        aggTps: 210.6,
        prefillTps: 1728.4,
        tokens: 256,
        totalMs: 1208,
        ok: 2,
        fails: 0,
        cache: "cold",
      },
      {
        contextLength: 8192,
        promptTokens: 8192,
        batchSize: 1,
        ttftMs: 800,
        tpotMs: 12,
        tps: 20,
        aggTps: 20,
        prefillTps: 10240,
        tokens: 128,
        totalMs: 6000,
        ok: 1,
        fails: 0,
        cache: "cold",
      },
      {
        contextLength: 8192,
        promptTokens: 8192,
        batchSize: 1,
        ttftMs: 80,
        tpotMs: 10,
        tps: 60,
        aggTps: 60,
        prefillTps: 102400,
        tokens: 128,
        totalMs: 2000,
        ok: 1,
        fails: 0,
        cache: "warm",
        cacheReusedTokens: 8000,
      },
    ],
    summary: {
      avgTps: 20,
      peakTps: 106,
      avgTtftMs: 800,
      bestTtftMs: 80,
      peakAggTps: 210.6,
      peakPrefillTps: 102400,
      totalTokens: 512,
      basis: "cold",
    },
    params: { genLength: 128, batchSize: 2, contexts: [1024, 8192], cacheModes: ["cold", "warm"] },
    createdAt: Date.UTC(2026, 8, 15, 1, 0),
    ...over,
  };
}

function evalResult(): DisplayResult {
  return {
    source: "record",
    kind: "eval",
    model: "Qwen3.6-35B-A3B",
    engine: "llama.cpp",
    serverMode: "local",
    status: "done",
    rows: [],
    evalRows: [{ category: "STEM", correct: 12, total: 20, accuracy: 60 }],
    summary: {
      avgTps: 0,
      peakTps: 0,
      avgTtftMs: 0,
      bestTtftMs: 0,
      peakAggTps: 0,
      peakPrefillTps: 0,
      totalTokens: 0,
      eval: {
        suite: "mmlu",
        accuracy: 55.5,
        correctCount: 111,
        totalQuestions: 200,
        datasetTotal: 14042,
        failures: 3,
      },
    },
    params: { suite: "mmlu", sampleSize: 200 },
    createdAt: 1_700_000_000_000,
    durationMs: 61_000,
  };
}

describe("reportFileName", () => {
  test("带上模型名与时间戳，路径分隔符被替换掉", () => {
    expect(reportFileName(speedResult(), new Date(2026, 8, 15, 9, 5))).toBe(
      "omni-benchmark-Qwen3.6-35B-A3B-20260915-0905.html",
    );
    const withPath = reportFileName(speedResult({ model: "/Users/me/models/qwen3" }), new Date(2026, 8, 15, 9, 5));
    expect(withPath).not.toContain("/");
    expect(withPath.endsWith(".html")).toBe(true);
  });
});

describe("buildBenchmarkReportHtml", () => {
  test("速度报告含配置、表头、全部档位、汇总与缓存对比", () => {
    const html = buildBenchmarkReportHtml({ result: speedResult(), t, lang: "zh" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('lang="zh-CN"');
    // 测试配置：生成长度 × 并发、档位、缓存场景
    expect(html).toContain(t("benchmark.export.config"));
    expect(html).toContain("128 tok × 2");
    expect(html).toContain("1k / 8k");
    // 表头与档位（与界面同一份词条）
    for (const key of ["benchmark.col.ttft", "benchmark.col.tpot", "benchmark.col.total"]) {
      expect(html).toContain(t(key));
    }
    expect(html).toContain("冷启（不命中）");
    expect(html).toContain("完全命中");
    // 汇总卡 + 取值说明
    expect(html).toContain(t("benchmark.export.summary"));
    expect(html).toContain("平均 / 最佳取自");
    // 缓存对比与复用比例（8000 / 8192 = 98%）
    expect(html).toContain(t("benchmark.cacheCompare"));
    expect(html).toContain("×10");
    expect(html).toContain("98%");
  });

  test("评测报告换成总分 + 分科目，不出速度表", () => {
    const html = buildBenchmarkReportHtml({ result: evalResult(), t, lang: "zh" });
    expect(html).toContain("55.5%");
    expect(html).toContain("111 / 200");
    expect(html).toContain("STEM");
    expect(html).toContain("60% (12/20)");
    expect(html).not.toContain(t("benchmark.results"));
  });

  test("自包含：不引用外部资源，也不带脚本（只允许报告里那一个仓库链接）", () => {
    const html = buildBenchmarkReportHtml({ result: speedResult(), t, lang: "zh" });
    // 唯一样式来源是内联 <style>：没有外链、没有脚本、没有外部图片
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("views://");
    // 正文里出现的 URL 只能是页脚那个 GitHub 仓库地址（文字链接，不是外部资源）
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([RELEASE_REPO_URL]);
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<]+/g)].map((m) => m[0]);
    expect(new Set(urls)).toEqual(new Set([RELEASE_REPO_URL]));
  });

  test("抬头写清出自哪个软件，页脚给仓库地址", () => {
    const html = buildBenchmarkReportHtml({ result: speedResult(), t, lang: "zh" });
    // 字标 + 一句话说明 + 内联图标（不是外链图片）
    expect(html).toContain('<span class="name">OmniStudio</span>');
    expect(html).toContain(t("benchmark.export.tagline"));
    expect(html).toContain('<svg class="mark"');
    expect(html).toContain(`<title>OmniStudio · ${t("benchmark.export.title")} · Qwen3.6-35B-A3B</title>`);
    // 页脚：生成方 + GitHub 地址（链接文本就是去掉协议头的地址，方便直接抄下来）
    expect(html).toContain(t("benchmark.export.footer"));
    expect(html).toContain(
      `<a class="repo" href="${RELEASE_REPO_URL}">${RELEASE_REPO_URL.replace(/^https?:\/\//, "")}</a>`,
    );
  });

  test("模型名与失败原因照 HTML 转义（这些文本来自服务端）", () => {
    const result = speedResult({
      model: '<img src=x onerror="alert(1)">',
      rows: [
        {
          contextLength: 1024,
          promptTokens: 0,
          batchSize: 1,
          ttftMs: 0,
          tpotMs: 0,
          tps: 0,
          aggTps: 0,
          prefillTps: 0,
          tokens: 0,
          totalMs: 0,
          ok: 0,
          fails: 1,
          cache: "cold",
          error: 'HTTP 400: <b>bad</b> "prompt"',
        },
      ],
    });
    const html = buildBenchmarkReportHtml({ result, t, lang: "zh" });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<b>bad</b>");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    // 整档失败仍然进"需要注意"
    expect(html).toContain(t("benchmark.notes"));
  });

  test("英文界面导出英文报告", () => {
    const en = (key: string, params?: Record<string, string>) => translate("en", key, params);
    const html = buildBenchmarkReportHtml({ result: speedResult(), t: en, lang: "en" });
    expect(html).toContain('lang="en"');
    expect(html).toContain("TTFT (ms)");
    expect(html).toContain("Cold (miss)");
    expect(html).toContain("Benchmark report");
    expect(html).toContain("Generated by OmniStudio");
  });
});
