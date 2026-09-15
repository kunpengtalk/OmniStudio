import { expect, test } from "bun:test";

// 与 media-source-badge.test.tsx 同一套静态渲染做法：不需要 DOM，也不需要 RPC。
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const { ModelCategoryChips } = await import("./model-category-chips");
const { translate } = await import("../../shared/i18n");

const zh = (key: string) => translate("zh", key);

const VALUES = ["all", "chat", "tts", "stale"] as const;
const COUNTS: Record<string, number> = { all: 27, chat: 12, tts: 2, stale: 0 };

function render(countOf?: (value: (typeof VALUES)[number]) => number) {
  return renderToStaticMarkup(
    createElement(ModelCategoryChips<(typeof VALUES)[number]>, {
      values: VALUES,
      value: "all",
      countOf,
      onChange: () => {},
    }),
  );
}

test("筛选颗用两字短名 + 计数，完整分类名只进悬浮提示", () => {
  const html = render((v) => COUNTS[v]!);

  for (const key of ["models.catShort.all", "models.catShort.chat", "models.catShort.tts"]) {
    expect(html).toContain(`>${zh(key)}<`);
  }
  expect(html).toContain(">27<");
  expect(html).toContain(">12<");
  // 长名不占版面（"语音合成 TTS" 曾把一行撑到出横向滚动条），但也没丢
  expect(html).not.toContain(`>${zh("models.cat.tts")}<`);
  expect(html).toContain(`title="${zh("models.cat.tts")} · 2"`);
  expect(html).toContain(`title="${zh("cloud.tabStale")} · 0"`);
  // 界面里不该漏出原始 key
  expect(html).not.toContain("models.cat");
});

test("分类颗带图标，全部 / 失效 是筛选口径不带图标", () => {
  const html = render((v) => COUNTS[v]!);
  // 图标数量 = 真正的分类数（chat / tts），"全部" 与 "失效" 没有图标
  expect([...html.matchAll(/<svg/g)].length).toBe(2);
  // 分类图标是行内标签那套的马甲，筛选颗不能挂 data-model-category：
  // 否则测试里"一行有几个分类标签"的统计会把筛选条也数进去
  expect(html).not.toContain("data-model-category");
});

test("不知道条数时不显示计数，选中项带 aria-pressed", () => {
  const html = render();
  expect(html).not.toContain(">0<");
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-pressed="false"');
  expect(html).toContain(`title="${zh("models.cat.chat")}"`);
});

test("筛选条换行排版，不做横向滚动", () => {
  const html = render((v) => COUNTS[v]!);
  expect(html).toContain("flex-wrap");
  expect(html).not.toContain("overflow-x");
});
