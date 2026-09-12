import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { isInsideDir, safeBaseName, safeJoin, safeName } from "./path-safety";
import { isLocalOrigin, isLoopbackHost } from "../shared/server-info";

const root = mkdtempSync(join(tmpdir(), "path-safety-"));
mkdirSync(join(root, "sub"), { recursive: true });
mkdirSync(join(root, "imagesX"), { recursive: true });
writeFileSync(join(root, "a.txt"), "a");
writeFileSync(join(root, "sub", "b.txt"), "b");
writeFileSync(join(root, "imagesX", "secret.txt"), "s");

describe("safeJoin 阻断越界路径", () => {
  test("普通相对路径正常拼接", () => {
    expect(safeJoin(root, "a.txt")).toBe(join(root, "a.txt"));
    expect(safeJoin(root, "sub/b.txt")).toBe(join(root, "sub", "b.txt"));
  });

  test("拒绝 .. 逃逸（含多层）与绝对路径", () => {
    expect(safeJoin(root, "../outside.txt")).toBeNull();
    expect(safeJoin(root, "sub/../../outside.txt")).toBeNull();
    expect(safeJoin(root, "/etc/passwd")).toBeNull();
    expect(safeJoin(root, "")).toBeNull();
    expect(safeJoin(root, ".")).toBeNull();
    expect(safeJoin(root, "a\0.txt")).toBeNull();
  });

  test("拒绝指向基准目录外部的软链接", () => {
    const link = join(root, "escape");
    try {
      symlinkSync(join(tmpdir()), link, "dir");
    } catch {
      return; // 环境不支持软链接时跳过
    }
    expect(safeJoin(root, "escape")).toBeNull();
  });

  test("isInsideDir 不把基准目录自身算作内部，也不把同前缀兄弟目录算作内部", () => {
    expect(isInsideDir(root, root)).toBe(false);
    expect(isInsideDir(join(root, "images"), join(root, "imagesX", "secret.txt"))).toBe(false);
    expect(isInsideDir(root, join(root, "sub", "b.txt"))).toBe(true);
  });
});

describe("safeName / safeBaseName", () => {
  test("只接受不带分隔符的名称", () => {
    expect(safeName("my-skill")).toBe("my-skill");
    expect(safeName("..")).toBeNull();
    expect(safeName("a/b")).toBeNull();
    expect(safeName("")).toBeNull();
  });

  test("safeBaseName 去掉路径只留文件名", () => {
    expect(safeBaseName("a/b/c.png")).toBe("c.png");
    expect(safeBaseName("../../.zshrc")).toBe(".zshrc");
    expect(safeBaseName("..")).toBeNull();
  });
});

describe("回环 Host / 本地 Origin 判定", () => {
  test("回环 Host", () => {
    expect(isLoopbackHost("127.0.0.1:19782")).toBe(true);
    expect(isLoopbackHost("localhost:10000")).toBe(true);
    expect(isLoopbackHost("[::1]:10000")).toBe(true);
    expect(isLoopbackHost("evil.example.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.5:10000")).toBe(false);
  });

  test("Origin：无 Origin / 本地 / 应用协议放行，外部网页拒绝", () => {
    expect(isLocalOrigin(null)).toBe(true);
    expect(isLocalOrigin("")).toBe(true);
    expect(isLocalOrigin("file://")).toBe(true);
    expect(isLocalOrigin("views://mainview")).toBe(true);
    expect(isLocalOrigin("http://localhost:5173")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:10000")).toBe(true);
    expect(isLocalOrigin("https://evil.example.com")).toBe(false);
    expect(isLocalOrigin("http://169.254.169.254")).toBe(false);
  });
});
