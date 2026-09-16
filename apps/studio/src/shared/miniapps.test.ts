import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { translateOptional } from "./i18n";
import { LANGS } from "./i18n";
import {
  MINIAPP_ACTIONS,
  MINIAPP_CAPABILITY_LABEL_KEY,
  MINIAPPS,
  isMiniAppChannelMessage,
  miniAppById,
} from "./miniapps";

const MINIAPP_DIR = join(import.meta.dir, "..", "mainview", "miniapps");
const PAGES_FILE = join(import.meta.dir, "..", "mainview", "app", "apps", "pages.ts");

/** 运行时暴露给小应用的方法名（`omni.<路径>`）；与小应用里的调用逐一对账。 */
const RUNTIME_API = new Set([
  "omni.ready",
  "omni.lang",
  "omni.appId",
  "omni.capabilities",
  "omni.capabilitiesOf",
  "omni.refresh",
  "omni.openSettings",
  "omni.log",
  "omni.onCapabilities",
  "omni.image.generate",
  "omni.image.edit",
  "omni.audio.record",
  "omni.audio.transcribe",
  "omni.text.complete",
  "omni.files.pick",
  "omni.files.read",
  "omni.files.save",
  "omni.files.pickAndRead",
  "omni.bg.status",
  "omni.bg.download",
  "omni.bg.run",
  // 命名空间本身（页面注释里会写 `omni.notes.*`，逐级回溯要能命中）
  "omni.notes",
  "omni.notes.list",
  "omni.notes.save",
  "omni.notes.remove",
  "omni.notes.attach",
  "omni.notes.setAgentAccess",
]);

test("登记表：id 唯一，分类与必需能力都在枚举内", () => {
  const ids = MINIAPPS.map((app) => app.id);
  expect(new Set(ids).size).toBe(ids.length);
  const accents = new Set(["violet", "sky", "amber", "emerald", "indigo", "rose"]);
  for (const app of MINIAPPS) {
    expect(["image", "audio", "text"]).toContain(app.category);
    expect(app.requires.length).toBeGreaterThan(0);
    expect(app.keywords.length).toBeGreaterThan(0);
    // 只允许语义名：Tailwind 类串写在 shared 里不会进 CSS（封面会一片空白）
    expect(accents.has(app.accent)).toBe(true);
  }
  expect(miniAppById("bg-remove")?.id).toBe("bg-remove");
  expect(miniAppById("nope")).toBeUndefined();
});

test("每个小应用的名称与说明都有中英词条", () => {
  for (const app of MINIAPPS) {
    for (const lang of LANGS) {
      expect(translateOptional(lang.value, app.nameKey)).toBeTruthy();
      expect(translateOptional(lang.value, app.descKey)).toBeTruthy();
    }
  }
  for (const key of Object.values(MINIAPP_CAPABILITY_LABEL_KEY)) {
    for (const lang of LANGS) {
      expect(translateOptional(lang.value, key)).toBeTruthy();
    }
  }
});

test("每个小应用都有页面文件，且页面文件与登记表一一对应", () => {
  for (const app of MINIAPPS) {
    const file = join(MINIAPP_DIR, `${app.id}.html`);
    expect(existsSync(file)).toBe(true);
    const html = readFileSync(file, "utf8");
    // 运行时靠 `<head>` 注入 window.omni：没有 head 的话所有调用都会是 undefined。
    expect(html).toContain("<head>");
    expect(html).toContain("omni.ready");
  }
});

test("pages.ts 为每个小应用 import 了页面（漏一个就是运行时空白卡片）", () => {
  const source = readFileSync(PAGES_FILE, "utf8");
  for (const app of MINIAPPS) {
    expect(source).toContain(`miniapps/${app.id}.html?raw`);
    expect(source).toMatch(new RegExp(`["']?${app.id}["']?\\s*:`));
  }
});

test("小应用只调用运行时真实存在的方法", () => {
  for (const app of MINIAPPS) {
    const html = readFileSync(join(MINIAPP_DIR, `${app.id}.html`), "utf8");
    const refs = html.match(/\bomni\.[A-Za-z.]+/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      // 逐级回溯：`omni.capabilities.chat.ready` 命中 `omni.capabilities` 即可，
      // 而 `omni.files.write` 这种不存在的方法任何前缀都命中不了。
      const parts = ref.split(".");
      const hit = parts.some((_, index) => RUNTIME_API.has(parts.slice(0, index + 1).join(".")));
      expect({ ref, hit }).toEqual({ ref, hit: true });
    }
  }
});

test("动作清单里的每一项都有说明（生成给小应用的接口文档）", () => {
  for (const [action, description] of Object.entries(MINIAPP_ACTIONS)) {
    expect(action).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    expect(description.length).toBeGreaterThan(0);
  }
  // 运行时里写死的动作名必须在这份清单里 —— 少一条就是"小应用调不到"。
  for (const action of [
    "host.ready",
    "host.capabilities",
    "host.openSettings",
    "host.log",
    "files.pick",
    "files.read",
    "files.save",
    "image.generate",
    "image.edit",
    "bg.status",
    "bg.download",
    "bg.run",
    "audio.record",
    "audio.transcribe",
    "text.complete",
    "notes.list",
    "notes.save",
    "notes.remove",
    "notes.attach",
    "notes.setAgentAccess",
  ]) {
    expect(MINIAPP_ACTIONS[action as keyof typeof MINIAPP_ACTIONS]).toBeTruthy();
  }
});

test("小应用页面里的脚本能通过语法解析（语法错就是整页白屏）", () => {
  for (const app of MINIAPPS) {
    const html = readFileSync(join(MINIAPP_DIR, `${app.id}.html`), "utf8");
    const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const block of scripts) {
      const code = block.slice("<script>".length, -"</script>".length);
      // 只解析、不执行：语法错在这里就会抛，白屏变成一条测试失败。
      expect(() => new Function(code)).not.toThrow();
    }
  }
});

test("消息判定只认带 channel 的消息", () => {
  expect(isMiniAppChannelMessage({ channel: "omni-miniapp", kind: "request" })).toBe(true);
  expect(isMiniAppChannelMessage({ kind: "request" })).toBe(false);
  expect(isMiniAppChannelMessage({ channel: "other", kind: "request" })).toBe(false);
  expect(isMiniAppChannelMessage(null)).toBe(false);
  expect(isMiniAppChannelMessage("omni-miniapp")).toBe(false);
});
