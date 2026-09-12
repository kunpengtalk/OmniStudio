import { expect, test } from "bun:test";

// 与 cli-tab.test.tsx 同一套静态渲染做法：不需要 DOM，也不需要 RPC。
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const { MediaSourceBadge, MediaSourceFilter } = await import("./media-source-badge");
const { translate } = await import("../../shared/i18n");

test("来源徽标只标出 Agent 生成的素材", () => {
  const agent = renderToStaticMarkup(createElement(MediaSourceBadge, { source: "agent" }));
  expect(agent).toContain(translate("zh", "media.source.agent"));

  // 手工生成是常态：不挂标签，避免每张图都多一个徽标。
  const manual = renderToStaticMarkup(createElement(MediaSourceBadge, { source: "manual" }));
  expect(manual).toBe("");
});

test("来源筛选渲染三个选项，且不出现原始 key", () => {
  const html = renderToStaticMarkup(
    createElement(MediaSourceFilter, { value: "all", onChange: () => {} }),
  );
  for (const key of ["media.source.all", "media.source.manual", "media.source.agent"]) {
    expect(html).toContain(translate("zh", key));
  }
  expect(html).not.toContain("media.source.");

  // 当前选中项要带上 aria-pressed，便于无障碍与测试定位。
  expect(html).toContain('aria-pressed="true"');
});
