/**
 * 数据目录的归属判断（`isOmniDataPath`）。
 *
 * 这个函数决定 Agent 的凭据拦截范围，两个方向都会出事：
 * - 判宽了：`OMNI_DATA_DIR` 被指向临时目录时（测试隔离 / `omi` CLI 都会这么干），
 *   把父目录一起算进去会把整片 `/tmp` 变成禁区，工作区里正常的文件读写被误报成
 *   "访问凭据路径"（实测就是这么挂的：media-tools 的参考图被当成凭据拒了）；
 * - 判窄了：靠写死的路径名字去匹配真实布局 `<appData>/<标识>/<频道>`，
 *   名字对不上就永远匹配不到 —— 设置表里的云端 API Key 一个字节都没拦住。
 */
import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { tmpdir } from "os";

import { getDataDir, isOmniDataPath } from "./paths";

const saved = process.env.OMNI_DATA_DIR;

afterEach(() => {
  if (saved === undefined) delete process.env.OMNI_DATA_DIR;
  else process.env.OMNI_DATA_DIR = saved;
});

describe("isOmniDataPath", () => {
  test("数据目录自己与它的内容算（测试环境下它就是临时目录，照样算）", () => {
    process.env.OMNI_DATA_DIR = path.join(tmpdir(), "omni-isomni-data");
    expect(isOmniDataPath(getDataDir())).toBe(true);
    expect(isOmniDataPath(path.join(getDataDir(), "settings.db"))).toBe(true);
    expect(isOmniDataPath(path.join(getDataDir(), "logs", "app.log"))).toBe(true);
  });

  test("数据目录的**父目录**不算：否则临时目录整片变成禁区", () => {
    // OMNI_DATA_DIR=<tmp>/omni-isomni-data 时，父目录是 <tmp> 本身。
    // 把它当成凭据目录，工作区里任何临时文件都会被拒（参考图 / 截图 / 导出的产物）。
    process.env.OMNI_DATA_DIR = path.join(tmpdir(), "omni-isomni-data");
    expect(isOmniDataPath(tmpdir())).toBe(false);
    expect(isOmniDataPath(path.join(tmpdir(), "某个工作区", "photo.png"))).toBe(false);
  });

  test("前缀相同的兄弟目录不算（不是 startsWith 的字面比较）", () => {
    process.env.OMNI_DATA_DIR = path.join(tmpdir(), "omni-isomni-data");
    expect(isOmniDataPath(path.join(tmpdir(), "omni-isomni-data-别的"))).toBe(false);
    expect(isOmniDataPath(path.join(tmpdir(), "omni-isomni-data-别的", "x"))).toBe(false);
  });

  test("真实布局下标识目录也算：dev / canary / 正式频道各有密钥", () => {
    // 不设 OMNI_DATA_DIR 时走真实规则 `<appData>/omni-studio.kunpengtalk.com/<频道>`。
    delete process.env.OMNI_DATA_DIR;
    const dataDir = getDataDir();
    expect(isOmniDataPath(dataDir)).toBe(true);
    expect(isOmniDataPath(path.join(dataDir, "omni-studio.db"))).toBe(true);
    // 标识目录（`<appData>/omni-studio.kunpengtalk.com`）本身与其它频道都在内。
    const identifierDir = path.dirname(dataDir);
    if (path.basename(identifierDir).startsWith("omni-studio")) {
      expect(isOmniDataPath(identifierDir)).toBe(true);
      expect(isOmniDataPath(path.join(identifierDir, "canary"))).toBe(true);
    }
  });
});
