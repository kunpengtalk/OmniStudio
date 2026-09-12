import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * 帮助体系与命令表一致性。
 *
 * 注意：命令模块会（间接）加载 db 层并在 import 时跑迁移，所以先隔离数据目录
 * 再动态 import —— 不能让测试碰真实用户数据。
 */
process.env.OMNI_DATA_DIR ??= join(tmpdir(), "omni-help-test");
mkdirSync(process.env.OMNI_DATA_DIR, { recursive: true });

let HELP_TEXT: typeof import("./help")["HELP_TEXT"];
let CMD_HELP: typeof import("./help")["CMD_HELP"];
let TOPIC_HELP: typeof import("./help")["TOPIC_HELP"];
let helpFor: typeof import("./help")["helpFor"];
let launchToolHelp: typeof import("./help")["launchToolHelp"];
let COMMANDS: typeof import("./index")["COMMANDS"];

beforeAll(async () => {
  const help = await import("./help");
  HELP_TEXT = help.HELP_TEXT;
  CMD_HELP = help.CMD_HELP;
  TOPIC_HELP = help.TOPIC_HELP;
  helpFor = help.helpFor;
  launchToolHelp = help.launchToolHelp;
  COMMANDS = (await import("./index")).COMMANDS;
});

const LAUNCH_TOOLS = [
  "claude",
  "codex",
  "opencode",
  "openclaw",
  "hermes",
  "pi",
  "copilot",
  "chatgpt",
];

describe("命令表 ↔ 帮助文本", () => {
  test("每个已实现命令都有帮助，且没有多余帮助", () => {
    const commands = Object.keys(COMMANDS).sort();
    const documented = Object.keys(CMD_HELP).sort();
    expect(documented).toEqual(commands);
  });

  test("总览列出全部命令", () => {
    for (const cmd of Object.keys(COMMANDS)) expect(HELP_TEXT).toContain(cmd);
  });

  test("子命令帮助的父命令都存在", () => {
    for (const topic of Object.keys(TOPIC_HELP)) {
      expect(Object.keys(COMMANDS)).toContain(topic.split(" ")[0]!);
    }
  });
});

describe("helpFor 查表", () => {
  test("无参数 / 未知命令回落总览", () => {
    expect(helpFor([])).toBe(HELP_TEXT);
    expect(helpFor([undefined])).toBe(HELP_TEXT);
    expect(helpFor(["nope"])).toBe(HELP_TEXT);
    expect(helpFor(["memory", "nope"])).toBe(CMD_HELP.memory!);
  });

  test("命令帮助与子命令帮助分别命中", () => {
    expect(helpFor(["memory"])).toBe(CMD_HELP.memory!);
    expect(helpFor(["memory", "add"])).toBe(TOPIC_HELP["memory add"]!);
    expect(helpFor(["memory", "mcp"])).toBe(TOPIC_HELP["memory mcp"]!);
    expect(helpFor(["server", "logs"])).toBe(TOPIC_HELP["server logs"]!);
  });

  test("omi help launch <tool> 给工具级帮助", () => {
    for (const tool of LAUNCH_TOOLS) {
      const text = helpFor(["launch", tool]);
      expect(text).toContain(`omi launch ${tool}`);
      expect(text).toContain("--model");
    }
    expect(launchToolHelp("nope")).toBeUndefined();
    expect(helpFor(["launch", "nope"])).toBe(CMD_HELP.launch!);
  });
});

describe("帮助文本内容", () => {
  test("记忆相关命令有用法与接入说明", () => {
    expect(TOPIC_HELP["memory add"]!).toContain("--category");
    expect(TOPIC_HELP["memory add"]!).toContain("--tags");
    expect(TOPIC_HELP["memory search"]!).toContain("--limit");
    expect(TOPIC_HELP["memory mcp"]!).toContain("memory_save");
    expect(TOPIC_HELP["memory mcp"]!).toContain("omni-memory");
    // 记忆三条通道：CLI / stdio MCP / 网关 HTTP
    expect(CMD_HELP.memory!).toContain("/mcp");
    expect(CMD_HELP.memory!).toContain("/v1/memories");
  });

  test("guide / launch / serve 帮助提到关键入口", () => {
    expect(CMD_HELP.guide!).toContain("--md");
    expect(CMD_HELP.launch!).toContain("omi launch --list");
    expect(CMD_HELP.serve!).toContain("Ctrl+C");
    expect(CMD_HELP.start!).toContain("--server");
  });
});
