import { expect, mock, test } from "bun:test";

// 与 media-source-badge.test.tsx 同一套静态渲染做法：不需要 DOM，也不需要 RPC。
// 这里把 ImageComponent 打桩，是因为它连着 rpcClient → electrobun（浏览器运行时，测试里没有）。
mock.module("./image", () => ({ ImageComponent: () => null }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const { Markdown } = await import("./markdown");

test("正文块跟着正文列贴左，不自己居中", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, { content: "你好！有什么我可以帮你的吗？" }),
  );
  const rootClass = /^<div class="([^"]*)"/.exec(html)?.[1] ?? "";
  expect(rootClass).toContain("w-full");

  // Streamdown 的根节点挂在 `flex-col` 的正文列里：一旦带上自动外边距，
  // `align-items: stretch` 失效，整块会收缩到内容宽度再居中 —— 头像 / 模型名 / 操作条
  // 都贴左，只有正文飘在列中间，短回复看起来就像"被居中"了。
  expect(rootClass).not.toContain("mx-auto");
});
