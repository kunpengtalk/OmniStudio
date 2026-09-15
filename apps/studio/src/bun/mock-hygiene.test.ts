import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";

// ---------------------------------------------------------------------------
// `mock.module` 卫生检查：替身必须**覆盖被替换模块的全部运行时导出**。
//
// 背景（真踩过两次）：
//   bun 的 `mock.module(spec, factory)` 是**整体替换** —— 工厂返回什么，之后 import
//   该模块的文件就只能拿到什么。它又是**进程级生效且撤不掉**的。于是只要有人写
//   `mock.module("./db/settings", () => ({ getSetting, updateSettings }))`，
//   后来 `db/settings` 新增 `ensureSettingsEncrypted`（云端密钥加密那次）时，
//   chat.test.ts 的整条模块图就在 import 阶段报 `Export named ... not found` ——
//   报错现场离原因隔着好几个文件，而且只在"跑全量、且顺序凑巧"时出现。
//   media-setup.test.ts 的 fake 漏了 `fetchRemoteModels` 同款（表现为
//   "xxx is not a function"，比导出缺失更晚、更难认）。
//
// 规矩：替身要写 `...realModule` 再覆盖（见 test-mocks.ts 的 mockModulePartial），
// 或者把全部导出显式列出来。本文件把这条规矩机械化。
// ---------------------------------------------------------------------------

const APP = resolve(import.meta.dir, "../..");
const SRC = join(APP, "src");
const ALIASES: [string, string][] = [
  ["@/", "src/"],
  ["@components/", "src/mainview/components/"],
  ["@ui/", "src/mainview/components/ui/"],
  ["@stores/", "src/mainview/stores/"],
  ["@lib/", "src/mainview/lib/"],
  ["@hooks/", "src/mainview/hooks/"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

/** 把 mock.module 的 specifier 解析到真实文件（相对路径 + tsconfig 别名）。 */
function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else {
    for (const [alias, target] of ALIASES) {
      if (spec.startsWith(alias)) {
        base = join(SRC, target + spec.slice(alias.length));
        break;
      }
    }
  }
  if (!base) return null; // 裸模块名（依赖包）：不归本检查管
  for (const candidate of [base + ".ts", base + ".tsx", join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续试下一个后缀
    }
  }
  return null;
}

/**
 * 取模块的运行时导出名（类型导出不算：运行时根本不存在）。
 * 出现 `export * from` 时返回 null —— 静态枚举不到，跳过而不是误报。
 */
export function runtimeExports(source: string): Set<string> | null {
  if (/^\s*export\s+\*\s+from/m.test(source)) return null;
  const names = new Set<string>();
  const decl = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(decl)) names.add(m[2]!);
  if (/^\s*export\s+default\s/m.test(source)) names.add("default");
  // export { a, b as c } / export type { T }
  const list = /^\s*export\s+(type\s+)?\{([^}]*)\}/gm;
  for (const m of source.matchAll(list)) {
    if (m[1]) continue; // 纯类型导出
    for (const part of m[2]!.split(",")) {
      const piece = part.trim().replace(/^type\s+/, "");
      if (!piece) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(piece);
      names.add(alias ? alias[1]! : piece);
    }
  }
  return names;
}

/** 收集对象字面量「一层深」的键名（含简写属性）。顶层有 `...` 展开时返回 null。 */
export function literalKeys(body: string): Set<string> | null {
  const open = body.indexOf("{");
  if (open === -1) return null;
  const keys = new Set<string>();
  let segment = "";
  let i = open + 1;
  let closed = false;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "{" || ch === "[" || ch === "(") {
      // 嵌套的值表达式整段跳过（括号配对），不参与取键
      let inner = 1;
      i++;
      for (; i < body.length && inner > 0; i++) {
        const c = body[i]!;
        if (c === "{" || c === "[" || c === "(") inner++;
        else if (c === "}" || c === "]" || c === ")") inner--;
      }
      segment += " "; // 占位：别把值的前后粘成一个标识符
      continue;
    }
    if (ch === "}") {
      closed = true;
      break;
    }
    if (ch === ",") {
      if (segment.trim().startsWith("...")) return null; // 展开了真实模块
      addKey(keys, segment);
      segment = "";
      i++;
      continue;
    }
    segment += ch;
    i++;
  }
  if (!closed) return null; // 括号不配对：形态不认识，不硬猜
  if (segment.trim().startsWith("...")) return null;
  addKey(keys, segment);
  return keys.size > 0 ? keys : null;
}

function addKey(keys: Set<string>, segment: string): void {
  const text = segment.trim();
  if (!text) return;
  if (text.startsWith("...")) return;
  const colon = text.indexOf(":");
  const head = (colon === -1 ? text : text.slice(0, colon)).trim().replace(/^["']|["']$/g, "");
  if (/^[A-Za-z_$][\w$]*$/.test(head)) keys.add(head);
}

type Violation = { file: string; line: number; spec: string; missing: string[] };

/** 扫描一个测试文件里所有 `mock.module(...)` 调用，返回覆盖不全的违规项。 */
function scanFile(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
  const out: Violation[] = [];
  const call = /mock\.module\s*\(/g;
  for (const match of source.matchAll(call)) {
    const start = match.index!;
    const before = source.slice(source.lastIndexOf("\n", start) + 1, start);
    if (before.includes("//") || before.trimStart().startsWith("*")) continue; // 注释里的提及
    const line = source.slice(0, start).split("\n").length;

    let i = start + match[0].length;
    if (source[i] !== '"' && source[i] !== "'") continue;
    const quote = source[i]!;
    const end = source.indexOf(quote, i + 1);
    if (end === -1) continue;
    const spec = source.slice(i + 1, end);
    i = end + 1;
    while (source[i] === " " || source[i] === "\n") i++;
    if (source[i] !== ",") continue; // 没有工厂函数（注释式引用），不管
    i++;
    while (source[i] === " " || source[i] === "\n") i++;
    if (source.startsWith("mockModulePartial", i)) continue; // helper 内部已铺开真实导出

    // 取第二个实参：`() => ({...})` / `function(){ return {...} }` / 标识符
    const rest = source.slice(i);
    const arrowIdx = rest.indexOf("=>");
    const factory = arrowIdx !== -1 && arrowIdx < 200 ? rest.slice(arrowIdx + 2) : rest;
    const head = factory.trimStart();
    if (!head.startsWith("({") && !head.startsWith("{") && !head.startsWith("return")) continue;
    const keys = literalKeys(factory);
    if (!keys) continue; // 展开真实模块 / 形态不认识：不误报
    const target = resolveSpec(file, spec);
    if (!target) continue;
    const real = runtimeExports(readFileSync(target, "utf8"));
    if (!real) continue;
    const missing = [...real].filter((name) => !keys.has(name));
    if (missing.length > 0) out.push({ file, line, spec, missing: missing.sort() });
  }
  return out;
}

test("mock.module 的替身覆盖被替换模块的全部运行时导出", () => {
  const files = [...walk(SRC), ...walk(join(APP, "scripts"))];
  const violations = files.filter((f) => /\.test\.(ts|tsx)$/.test(f)).flatMap(scanFile);

  const report = violations
    .map(
      (v) =>
        `${relative(APP, v.file)}:${v.line}  mock.module("${v.spec}") 缺少导出: ${v.missing.join(", ")}`,
    )
    .join("\n");

  expect(report).toBe("");
});

test("检查器自己认得出手写替身漏掉的导出（拿真实例子钉）", () => {
  // 直接喂一段历史现场：chat.test.ts 当年那份缺 ensureSettingsEncrypted 的替身。
  const missing = ["ensureSettingsEncrypted", "invalidateSettingsCache"].filter(
    (name) => !literalKeys(`() => ({ getSetting: () => "", updateSettings: () => {} })`)!.has(name),
  );
  expect(missing).toEqual(["ensureSettingsEncrypted", "invalidateSettingsCache"]);

  // 展开真实导出后不再报缺
  expect(literalKeys("() => ({ ...real, getSetting: () => \"\" })")).toBeNull();
});
