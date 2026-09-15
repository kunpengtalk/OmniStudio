import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  dedupeInstructionSections,
  discoverInstructionFiles,
  findProjectRoot,
  formatInstructions,
  instructionDirs,
  instructionFileIn,
  loadProjectInstructions,
  splitInstructionBlocks,
  truncateInstructions,
  userInstructionsPath,
} from "./agent-instructions";

let root: string;

const mkfile = (target: string, contents: string) => {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "omni-instructions-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("项目指令发现（对齐 Codex 的 AGENTS.md 语义）", () => {
  test("向上找到 .git 作为项目根，不再往上翻", () => {
    const repo = path.join(root, "repo");
    const nested = path.join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    // root 本身也在向外的一层，但没有标记：不该被当成项目根。
    expect(findProjectRoot(nested)).toBe(repo);
    expect(findProjectRoot(repo)).toBe(repo);
    // 标记列表为空 = 关闭向上查找（Codex 的同名开关语义）。
    expect(findProjectRoot(nested, [])).toBeNull();
  });

  test("目录链是「项目根 → 工作区」，没有标记时只看工作区", () => {
    const repo = path.join(root, "repo");
    const nested = path.join(repo, "pkg", "inner");
    mkdirSync(nested, { recursive: true });
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(instructionDirs(nested)).toEqual([repo, path.join(repo, "pkg"), nested]);

    const orphan = path.join(root, "orphan", "deep");
    mkdirSync(orphan, { recursive: true });
    expect(instructionDirs(orphan)).toEqual([orphan]);
  });

  test("同目录下 AGENTS.override.md 优先于 AGENTS.md", () => {
    const dir = path.join(root, "d");
    mkfile(path.join(dir, "AGENTS.md"), "普通");
    expect(instructionFileIn(dir)).toBe(path.join(dir, "AGENTS.md"));
    mkfile(path.join(dir, "AGENTS.override.md"), "覆盖");
    expect(instructionFileIn(dir)).toBe(path.join(dir, "AGENTS.override.md"));
  });

  test("用户级指令在最前，项目指令按根 → 工作区顺序拼接", () => {
    const repo = path.join(root, "repo");
    const nested = path.join(repo, "pkg");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkfile(path.join(repo, "AGENTS.md"), "仓库约定：bun test");
    mkfile(path.join(nested, "AGENTS.md"), "包约定：先跑 typecheck");
    const userFile = path.join(root, "user-agents.md");
    mkfile(userFile, "全局偏好：中文回答");

    const files = discoverInstructionFiles(nested, { userFile });
    expect(files.map((file) => file.source)).toEqual(["user", "project", "project"]);
    expect(files.map((file) => file.contents)).toEqual([
      "全局偏好：中文回答",
      "仓库约定：bun test",
      "包约定：先跑 typecheck",
    ]);
  });

  test("空文件与不存在的文件被忽略，读不出来不抛错", () => {
    const dir = path.join(root, "empty");
    mkfile(path.join(dir, "AGENTS.md"), "   \n\n");
    expect(discoverInstructionFiles(dir, { userFile: path.join(root, "nope.md") })).toEqual([]);
  });
});

describe("体积上限与拼装", () => {
  test("超限时截断并标记；上限为 0 表示不限", () => {
    const files = [
      { path: "/a", contents: "x".repeat(10), source: "project" as const },
      { path: "/b", contents: "y".repeat(10), source: "project" as const },
    ];
    expect(truncateInstructions(files, 0).truncated).toBe(false);
    expect(truncateInstructions(files, 100).files).toHaveLength(2);

    const capped = truncateInstructions(files, 15);
    expect(capped.truncated).toBe(true);
    expect(capped.files).toHaveLength(2);
    expect(capped.files[0]!.contents).toBe("x".repeat(10));
    expect(capped.files[1]!.contents).toBe("y".repeat(5));

    const onlyFirst = truncateInstructions(files, 10);
    expect(onlyFirst.files).toHaveLength(1);
    expect(onlyFirst.truncated).toBe(true);
  });

  test("拼出的段落写明文件来源；截断时说明后面还有内容", () => {
    const section = formatInstructions(
      [{ path: "/repo/AGENTS.md", contents: "用 bun，别用 npm\n", source: "project" }],
      false,
    );
    expect(section).toContain("# 项目指令（AGENTS.md）");
    expect(section).toContain("## /repo/AGENTS.md");
    expect(section).toContain("用 bun，别用 npm");
    expect(section).not.toContain("被截断");

    const truncated = formatInstructions(
      [{ path: "/repo/AGENTS.md", contents: "开头部分", source: "project" }],
      true,
    );
    expect(truncated).toContain("被截断");
  });

  test("没有文件时是空段（不会往系统提示里塞一个空标题）", () => {
    expect(formatInstructions([], false)).toBe("");
  });

  test("截断不切出半个多字节字符", () => {
    const files = [{ path: "/a", contents: "中文".repeat(5), source: "project" as const }];
    // 中文一个字 3 字节：砍在第 4 个字节上，不能留下 U+FFFD 垃圾字符。
    const capped = truncateInstructions(files, 4);
    expect(capped.files[0]!.contents).toBe("中");
    expect(capped.files[0]!.contents).not.toContain("\uFFFD");
  });
});

describe("多层 AGENTS.md 的段落去重", () => {
  const rootFile = {
    path: "/repo/AGENTS.md",
    source: "project" as const,
    contents: [
      "# 仓库约定",
      "",
      "提交前必须跑 `bun run lint && bun run test`，CI 会执行同样的命令。",
      "",
      "## 测试",
      "",
      "单元测试用 bun test，端到端脚本放在 scripts/ 下，跑之前先构建。",
    ].join("\n"),
  };

  test("子层原样抄来的段落被省略，并留下说明", () => {
    const child = {
      path: "/repo/pkg/AGENTS.md",
      source: "project" as const,
      contents: [
        "# 包内约定",
        "",
        "提交前必须跑 `bun run lint && bun run test`，CI 会执行同样的命令。",
        "",
        "## 测试",
        "",
        "单元测试用 bun test，端到端脚本放在 scripts/ 下，跑之前先构建。",
        "",
        "本包额外约定：改 schema 后要重新生成迁移。",
      ].join("\n"),
    };
    const [first, second] = dedupeInstructionSections([rootFile, child]);
    // 上位文件永远不动（它是"最上位"的约定，删了没有下家可比）。
    expect(first!.contents).toBe(rootFile.contents);
    expect(second!.contents).toContain("本包额外约定");
    expect(second!.contents).not.toContain("CI 会执行同样的命令");
    expect(second!.contents).toContain("与上层 AGENTS.md 重复");
    // 标题跟着正文一起走，不会留下一个空标题。
    expect(second!.contents).not.toContain("## 测试");
  });

  test("只重复了一条：那条删掉，本层特有的内容一字不少", () => {
    const child = {
      path: "/repo/pkg/AGENTS.md",
      source: "project" as const,
      contents: [
        "提交前必须跑 `bun run lint && bun run test`，CI 会执行同样的命令。",
        "",
        "本包用 SQLite，改动迁移要跑 drizzle-kit generate。",
      ].join("\n"),
    };
    const [, second] = dedupeInstructionSections([rootFile, child]);
    expect(second!.contents).toContain("本包用 SQLite");
    expect(second!.contents).not.toContain("CI 会执行同样的命令");
  });

  test("标题重复但正文是本层特有的：标题保留（删了会砍掉下面那段内容的归属）", () => {
    const child = {
      path: "/repo/pkg/AGENTS.md",
      source: "project" as const,
      contents: ["## 测试", "", "本包的测试要连真实数据库，先跑 scripts/db-up.sh。"].join("\n"),
    };
    const [, second] = dedupeInstructionSections([rootFile, child]);
    expect(second!.contents).toContain("## 测试");
    expect(second!.contents).toContain("db-up.sh");
  });

  test("短行不参与去重（省不下什么，还容易误伤）", () => {
    const parent = { path: "/r", source: "project" as const, contents: "用 bun。" };
    const child = { path: "/r/c", source: "project" as const, contents: "用 bun。" };
    const [, second] = dedupeInstructionSections([parent, child]);
    expect(second!.contents).toBe("用 bun。");
  });

  test("代码围栏里的空行不切段（半截代码不会被当成独立段落比对）", () => {
    const blocks = splitInstructionBlocks(
      ["```bash", "bun test", "", "bun run lint", "```", "", "普通段落。"].join("\n"),
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("bun run lint");
    expect(blocks[1]).toBe("普通段落。");
  });

  test("整份文件都是抄来的：留下说明而不是一个空段落", () => {
    const child = {
      path: "/repo/pkg/AGENTS.md",
      source: "project" as const,
      contents: rootFile.contents,
    };
    const [, second] = dedupeInstructionSections([rootFile, child]);
    expect(second!.contents).toContain("重复");
    expect(second!.contents).toContain("/repo/pkg/AGENTS.md");
  });
});

describe("按工作区装载", () => {
  test("工作区里的 AGENTS.md 会进入系统提示段落", () => {
    const workspace = path.join(root, "ws");
    mkdirSync(path.join(workspace, ".git"), { recursive: true });
    mkfile(path.join(workspace, "AGENTS.md"), "本项目用 pnpm；改动前先跑 lint。");

    const loaded = loadProjectInstructions(workspace);
    expect(loaded.section).toContain("本项目用 pnpm");
    expect(loaded.files).toHaveLength(1);
    expect(loaded.truncated).toBe(false);
    // 用户级指令指向数据目录（测试环境是隔离的临时目录，不该读到开发者的真实文件）。
    expect(userInstructionsPath().endsWith("AGENTS.md")).toBe(true);
  });

  test("默认上限是 8KB（本地模型窗口小，不能照搬 Codex 的 32KB）", () => {
    expect(DEFAULT_PROJECT_DOC_MAX_BYTES).toBe(8 * 1024);
  });
});
