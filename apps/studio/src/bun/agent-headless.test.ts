import { describe, expect, test } from "bun:test";

import { HEADLESS_MODES, isHeadlessMode, runHeadlessAgent } from "./agent-headless";

/**
 * 无头执行（对齐 Codex 的 `codex exec`）。
 *
 * 真实跑一轮需要推理服务，那部分在 `scripts/agent-live-check.ts` 里用桩服务端到端跑；
 * 这里只钉住"还没碰模型就该拒绝"的几条与模式校验 —— 它们决定了脚本拿到的是
 * 清晰的报错还是莫名其妙的空结果。
 *
 * 注意：这里**不碰数据库**。`chat.test.ts` 会 `mock.module("./db")`，而 bun test 的
 * mock 注册表在同一批次里跨文件可见 —— 任何读真实 DB 的断言都会在整包跑时拿到假库
 * （报 "disk I/O error"）。“会话不存在”那条因此放在 live-check 里（独立进程）。
 */
describe("无头执行的入参校验", () => {
  test("空提示词直接拒绝，不会建出一条空会话", async () => {
    await expect(runHeadlessAgent({ prompt: "   " })).rejects.toThrow("prompt 不能为空");
  });

  test("模式只认 agent / plan / goal", () => {
    expect(HEADLESS_MODES).toEqual(["agent", "plan", "goal"]);
    expect(isHeadlessMode("plan")).toBe(true);
    expect(isHeadlessMode("goal")).toBe(true);
    expect(isHeadlessMode("nope")).toBe(false);
    expect(isHeadlessMode(undefined)).toBe(false);
  });
});
