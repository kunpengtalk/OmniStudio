import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { DEFAULT_LANG, LANGS, translate } from "../shared/i18n";

/**
 * i18n 对齐测试：此前 shared/i18n.ts 里 zh/en 都是手写的扁平表，
 * 结果整块 `engine.*` 键（34 个）在界面里直接渲染成英文 key 原文，
 * 另有 7 个键只有中文。这里把三类问题都变成测试失败：
 *   1. 代码里 t("...") 用到、字典里没有的键；
 *   2. zh 有而 en 没有（英文界面回落到 key 原文）；
 *   3. 两个字典键集合不一致。
 */
const SRC = join(import.meta.dir);
const I18N_FILE = join(SRC, "i18n.ts");

/** 从某个字典对象里提取键（扁平表：`"key": "value",`）。 */
function dictKeys(source: string, name: string): Set<string> {
  const m = new RegExp(`\\nconst ${name}: Record<string, string> = \\{(.*?)\\n\\};`, "s").exec(source);
  if (!m) throw new Error(`找不到 ${name} 字典`);
  const keys = new Set<string>();
  for (const line of m[1]!.matchAll(/^\s*"([^"]+)":/gm)) keys.add(line[1]!);
  return keys;
}

/** 递归收集 src 下所有 ts/tsx 源码（排除测试自身与测试文件）。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** 去掉注释：文档里常有 `t("some.key")` 形式的示例，不能算真实引用。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 代码里所有 `t("literal.key")` 的键（模板字符串/变量无法静态检查，这里跳过）。 */
function usedKeys(): Set<string> {
  const used = new Set<string>();
  for (const file of walk(SRC)) {
    if (file.endsWith("i18n.ts")) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    for (const m of text.matchAll(/\bt\(\s*"([^"]+)"\s*\)/g)) used.add(m[1]!);
  }
  return used;
}

const source = readFileSync(I18N_FILE, "utf8");
const zh = dictKeys(source, "zh");
const en = dictKeys(source, "en");
const used = usedKeys();

describe("i18n 字典", () => {
  test("zh / en 键集合一致", () => {
    const onlyZh = [...zh].filter((k) => !en.has(k)).sort();
    const onlyEn = [...en].filter((k) => !zh.has(k)).sort();
    expect({ onlyZh, onlyEn }).toEqual({ onlyZh: [], onlyEn: [] });
  });

  test("代码里引用的字面量键都已定义（否则界面显示原始 key）", () => {
    const missing = [...used].filter((k) => !zh.has(k) || !en.has(k)).sort();
    expect(missing).toEqual([]);
  });

  test("每个受支持的界面语言都能取到非空文案", () => {
    const bad: string[] = [];
    for (const { value } of LANGS) {
      for (const key of used) {
        const text = translate(value, key);
        if (!text || text === key) bad.push(`${value}:${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("默认语言为中文，且未知 key 回落到 key 本身（约定不变）", () => {
    expect(DEFAULT_LANG).toBe("zh");
    expect(translate("zh", "no.such.key")).toBe("no.such.key");
  });
});
