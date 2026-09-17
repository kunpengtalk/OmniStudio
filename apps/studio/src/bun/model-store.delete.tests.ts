import { describe, expect, test, mock } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * 删除本地模型的留痕（issue #18）：
 *
 * 报告者把 LM Studio 的目录加进「本地模型目录」后，权重文件整批消失、只剩视觉投影文件，
 * 而**日志里查不到应用到底动没动过它们** —— 删除以前一条记录都不写，事故只能靠猜。
 * 两个断言：删成功要留下 location=extra-dir（说明删的是用户自己的文件），
 * 白名单之外的路径被拒也要留记录（证明"不可能悄悄删"）。
 *
 * 用子进程跑（见 model-store.delete.test.ts）：批内其它文件会 stub 掉 model-store。
 */
const SETTINGS: Record<string, string> = {};
mock.module("./db/settings", () => ({
  getSetting: (key: string) => SETTINGS[key] ?? "",
  updateSettings: (values: Record<string, string>) => Object.assign(SETTINGS, values),
}));

const { deleteLocalModel } = await import("./model-store");
const { readAppLogs } = await import("./app-log");

describe("deleteLocalModel 留痕", () => {
  test("删用户添加目录里的模型：文件真的没了，日志留下 location=extra-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-model-del-"));
    const file = join(dir, "some-model-Q4_K_M.gguf");
    writeFileSync(file, "fake weights");
    SETTINGS.MODEL_DIRS = dir;

    const res = deleteLocalModel(file);
    expect(res.ok).toBe(true);
    expect(existsSync(file)).toBe(false);

    const entry = readAppLogs({ limit: 200 }).find((e) => e.event === "model.delete" && e.detail);
    expect(entry).toBeTruthy();
    const detail = entry!.detail as { location?: string; path?: string; freed?: number };
    expect(detail.location).toBe("extra-dir");
    expect(detail.path).toBe(file);
    expect(detail.freed).toBeGreaterThan(0);
  });

  test("白名单之外的路径：拒绝、文件还在、并留下 refused 记录", () => {
    const outside = join(tmpdir(), `omni-not-allowed-${process.pid}.gguf`);
    writeFileSync(outside, "x");

    const res = deleteLocalModel(outside);
    expect(res.ok).toBe(false);
    expect(existsSync(outside)).toBe(true);

    const entry = readAppLogs({ limit: 200 }).find((e) => e.event === "model.delete.refused");
    expect(entry).toBeTruthy();
  });
});
