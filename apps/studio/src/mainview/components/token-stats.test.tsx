import { expect, test } from "bun:test";

// 与其它界面组件测试同一套静态渲染做法：不需要 DOM，也不需要 RPC。
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const { TokenStatsCard, MessageTokenStats, formatDuration, formatRate, formatTokenCount } =
  await import("./token-stats");
const { translate } = await import("../../shared/i18n");
const { useChatStore } = await import("@stores/chat");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

test("数字格式：千分位、速度一位小数、时长分档", () => {
  expect(formatTokenCount(1012)).toBe("1,012");
  expect(formatTokenCount(0)).toBe("0");
  expect(formatRate(177.66)).toBe("177.7");
  expect(formatRate(1024)).toBe("1024.0");
  expect(formatDuration(zh, 899)).toBe("899 ms");
  expect(formatDuration(zh, 5300)).toBe("5.3 秒");
  expect(formatDuration(zh, 95_000)).toBe("1.6 分");
});

test("详情卡片列出输入 / 输出 / 生成速度与关键耗时", () => {
  const html = renderToStaticMarkup(
    createElement(TokenStatsCard, {
      view: {
        inputTokens: 233,
        outputTokens: 779,
        totalTokens: 1012,
        tokensPerSec: 177,
        endToEndTokensPerSec: 147,
        ttftMs: 899,
        elapsedMs: 5300,
        generationMs: 4401,
        reasoningTokens: 535,
        cachedTokens: 100,
        source: "usage" as const,
        model: "deepseek-v4-flash",
        provider: "llama.cpp",
        live: false,
      },
      createdAt: Date.UTC(2026, 8, 13, 9, 50),
      context: { percent: 12, usedTokens: 1012, windowTokens: 8192 },
    }),
  );

  expect(html).toContain("deepseek-v4-flash");
  expect(html).toContain("llama.cpp");
  expect(html).toContain(zh("tokenStats.input"));
  expect(html).toContain(zh("tokenStats.output"));
  expect(html).toContain(zh("tokenStats.speed"));
  expect(html).toContain(zh("tokenStats.ttft"));
  expect(html).toContain(zh("tokenStats.e2eTps"));
  expect(html).toContain(zh("tokenStats.elapsed"));
  expect(html).toContain(zh("tokenStats.reasoning"));
  expect(html).toContain(zh("tokenStats.cached"));
  // 未缓存输入 = 233 - 100
  expect(html).toContain("133");
  expect(html).toContain("779");
  expect(html).toContain("177.0"); // 速度保留一位小数
  // 原始 key 一个都不该漏到界面上
  expect(html).not.toContain("tokenStats.");
});

test("底部胶囊：总量 + 速度，点开是同一份统计", () => {
  useChatStore.setState({ messageStats: {} });
  const html = renderToStaticMarkup(
    createElement(MessageTokenStats, {
      message: {
        id: 1,
        tokens: 779,
        createdAt: Date.UTC(2026, 8, 13, 9, 50),
        stats: {
          tokens: 779,
          tokensPerSec: 177.7,
          elapsedMs: 5300,
          inputTokens: 233,
          outputTokens: 779,
          source: "usage" as const,
        },
      },
      conversationId: 1,
      streaming: false,
    }),
  );
  // 总量 = 输入 + 输出
  expect(html).toContain(zh("tokenStats.tokens", { count: "1,012" }));
  expect(html).toContain(zh("tokenStats.tps", { value: "177.7" }));
  expect(html).not.toContain("tokenStats.");
});

test("没有统计也没有 tokens 时不渲染胶囊", () => {
  useChatStore.setState({ messageStats: {} });
  const html = renderToStaticMarkup(
    createElement(MessageTokenStats, {
      message: { id: 2, tokens: null, createdAt: Date.now(), stats: null },
      conversationId: 1,
      streaming: false,
    }),
  );
  expect(html).toBe("");
});

test("生成中：输入还没实测值时留空位，并标注是实时估算", () => {
  const html = renderToStaticMarkup(
    createElement(TokenStatsCard, {
      view: {
        outputTokens: 120,
        totalTokens: 120,
        tokensPerSec: 42.5,
        elapsedMs: 3000,
        live: true,
      },
    }),
  );
  expect(html).toContain(zh("tokenStats.generating"));
  expect(html).toContain("42.5");
  expect(html).not.toContain(zh("tokenStats.source.usage"));
});

test("只有输出 tokens 的老消息卡片不炸", () => {
  const html = renderToStaticMarkup(
    createElement(TokenStatsCard, {
      view: { outputTokens: 12, totalTokens: 12, tokensPerSec: 0, elapsedMs: 0, live: false },
    }),
  );
  expect(html).toContain(zh("tokenStats.output"));
  expect(html).toContain("12");
});
