import { describe, expect, mock, test } from "bun:test";

// RPC 层依赖 Electrobun webview，测试里替换成固定设置（网关端口 / 密钥）后静态渲染。
mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({
      configured: true,
      platform: "darwin",
      settings: { GATEWAY_HOST: "127.0.0.1", GATEWAY_PORT: "12345", GATEWAY_API_KEY: "k-1" },
    }),
    updateSettings: async () => ({ ok: true }),
  },
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createElement } = await import("react");
const { CliTab } = await import("../mainview/app/main-layout/cli-tab");
const { CLI_MEMORY_SNIPPETS, CLI_SECTIONS } = await import("./cli-docs");

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 预置 settings 查询缓存：静态渲染不等异步请求，seed 后组件即读到「当前网关设置」。
  client.setQueryData(["settings"], {
    configured: true,
    platform: "darwin",
    settings: { GATEWAY_HOST: "127.0.0.1", GATEWAY_PORT: "12345", GATEWAY_API_KEY: "k-1" },
  });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(CliTab)),
  );
}

/** 静态渲染会转义 HTML 实体，比较文本时先做同样的转义。 */
function esc(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#x27;");
}

describe("设置页命令行标签页", () => {
  const html = render();

  test("渲染全部分组与主命令", () => {
    for (const section of CLI_SECTIONS) {
      expect(html).toContain(esc(section.titleZh));
      for (const entry of section.entries) expect(html).toContain(esc(entry.cmd));
    }
  });

  test("渲染记忆接入片段并用当前网关设置替换占位符", () => {
    for (const snippet of CLI_MEMORY_SNIPPETS) expect(html).toContain(esc(snippet.titleZh));
    expect(html).toContain("http://127.0.0.1:12345/mcp");
    expect(html).not.toContain("{{GATEWAY_URL}}");
    expect(html).not.toContain("{{GATEWAY_KEY}}");
  });

  test("i18n 词条存在（不出现原始 key）", () => {
    expect(html).toContain("命令行");
    expect(html).not.toContain("settings.cli.");
  });
});
