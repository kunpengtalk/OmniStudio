import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { completeText, getMiniAppCapabilities, logFromMiniApp, saveMiniAppFile } from "./miniapps";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "omni-miniapp-"));
}

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from("hello-png").toString("base64")}`;

test("产物落盘：按 mime 决定扩展名，重名自动加序号", () => {
  const dir = tempDir();
  try {
    const first = saveMiniAppFile({ name: "证件照.png", dataUrl: PNG_DATA_URL, directory: dir });
    expect(first.ok).toBe(true);
    expect(existsSync(first.path!)).toBe(true);
    expect(readFileSync(first.path!, "utf8")).toBe("hello-png");

    const second = saveMiniAppFile({ name: "证件照.png", dataUrl: PNG_DATA_URL, directory: dir });
    expect(second.path).not.toBe(first.path);
    expect(second.path!.endsWith("证件照 (1).png")).toBe(true);
    expect(readdirSync(dir).length).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("产物落盘：扩展名听 mime，不听小应用给的文件名", () => {
  const dir = tempDir();
  try {
    // 一个叫 x.sh 的 PNG 不能带着可执行后缀落进下载目录
    const result = saveMiniAppFile({ name: "x.sh", dataUrl: PNG_DATA_URL, directory: dir });
    expect(result.ok).toBe(true);
    expect(result.path!.endsWith(".png")).toBe(true);
    expect(readdirSync(dir)).toEqual(["x.png"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("产物落盘：目录穿越的文件名被净化成纯文件名", () => {
  const dir = tempDir();
  try {
    const result = saveMiniAppFile({
      name: "../../evil.png",
      dataUrl: PNG_DATA_URL,
      directory: dir,
    });
    expect(result.ok).toBe(true);
    expect(result.path!.startsWith(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual(["evil.png"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("产物落盘：只收 base64 的 data: 地址，类型不在白名单直接拒", () => {
  const dir = tempDir();
  try {
    expect(saveMiniAppFile({ name: "a.png", dataUrl: "https://example.com/a.png", directory: dir }).ok).toBe(false);
    expect(saveMiniAppFile({ name: "a.png", dataUrl: "data:image/png,plain", directory: dir }).ok).toBe(false);
    const sh = saveMiniAppFile({ name: "a", dataUrl: "data:application/x-sh;base64,AAAA", directory: dir });
    expect(sh.ok).toBe(false);
    expect(sh.error).toContain("不支持");
    expect(readdirSync(dir).length).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("产物落盘：超过体积上限直接拒", () => {
  const dir = tempDir();
  try {
    const big = `data:image/png;base64,${Buffer.alloc(25 * 1024 * 1024).toString("base64")}`;
    const result = saveMiniAppFile({ name: "big.png", dataUrl: big, directory: dir });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("过大");
    expect(readdirSync(dir).length).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("小应用日志：每分钟有配额，超出后丢弃而不是无限写盘", () => {
  const results = [];
  for (let i = 0; i < 40; i++) {
    results.push(logFromMiniApp({ appId: "test-app", event: "spam", message: `#${i}` }));
  }
  expect(results.some((r) => r.dropped === true)).toBe(true);
  expect(results[0]).toEqual({ ok: true });
});

test("能力探测：四类能力都有 ready 与说明字段", () => {
  const caps = getMiniAppCapabilities();
  for (const key of ["image", "imageEdit", "chat", "asr"] as const) {
    expect(typeof caps[key].ready).toBe("boolean");
    expect(typeof caps[key].label).toBe("string");
    // 未就绪时 label 留给界面拼"缺什么"，不该带具体后端名
    if (!caps[key].ready) expect(caps[key].label).toBe("");
  }
});

test("一次性补全：空输入与超长输入在本地就被拒", async () => {
  const empty = await completeText({ messages: [] });
  expect(empty.text).toBe("");
  expect(empty.error).toContain("没有可用的输入内容");

  const huge = await completeText({ messages: [{ role: "user", content: "字".repeat(60_001) }] });
  expect(huge.text).toBe("");
  expect(huge.error).toContain("输入过长");
});
