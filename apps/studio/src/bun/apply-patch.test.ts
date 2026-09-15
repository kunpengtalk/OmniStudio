import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  applyPatch,
  parsePatch,
  patchTouchedPaths,
  seekSequence,
  stripPatchWrapper,
  type PatchFileSystem,
} from "./apply-patch";

/** 内存文件系统：补丁语义的测试不该依赖真实磁盘。 */
function memoryFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const fs: PatchFileSystem = {
    read: (target) => (files.has(target) ? files.get(target)! : null),
    write: (target, contents) => {
      files.set(target, contents);
    },
    remove: (target) => {
      files.delete(target);
    },
  };
  return {
    fs,
    files,
    /** 工作区根 = "/" 的简化解析：补丁里的路径原样当绝对路径。 */
    resolve: (raw: string) => path.resolve("/", raw),
    apply: (patch: string) => applyPatch(patch, { resolve: (raw) => path.resolve("/", raw), fs }),
  };
}

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

// ---------------------------------------------------------------------------
// 解析：格式、宽松包装、错误信息
// ---------------------------------------------------------------------------
describe("补丁解析", () => {
  test("Add / Update / Delete / Move 都能解析出来", () => {
    const ops = parsePatch(
      patch(
        [
          "*** Add File: src/new.ts",
          "+export const a = 1;",
          "+",
          "*** Update File: src/old.ts",
          "*** Move to: src/renamed.ts",
          "@@ function hello()",
          " const x = 1;",
          "-const y = 2;",
          "+const y = 3;",
          "*** Delete File: gone.txt",
        ].join("\n"),
      ),
    );

    expect(ops).toHaveLength(3);
    expect(ops[0]).toEqual({
      kind: "add",
      path: "src/new.ts",
      contents: "export const a = 1;\n\n",
    });
    const update = ops[1]!;
    if (update.kind !== "update") throw new Error("expected update op");
    expect(update.path).toBe("src/old.ts");
    expect(update.moveTo).toBe("src/renamed.ts");
    expect(update.hunks).toHaveLength(1);
    expect(update.hunks[0]!.context).toBe("function hello()");
    expect(update.hunks[0]!.lines).toEqual([
      { type: "context", text: "const x = 1;" },
      { type: "remove", text: "const y = 2;" },
      { type: "add", text: "const y = 3;" },
    ]);
    expect(ops[2]).toEqual({ kind: "delete", path: "gone.txt" });
  });

  test("没有 @@ 的隐式片段也算改动", () => {
    const ops = parsePatch(patch("*** Update File: a.py\n import foo\n+bar"));
    const update = ops[0]!;
    if (update.kind !== "update") throw new Error("expected update op");
    expect(update.hunks).toHaveLength(1);
    expect(update.hunks[0]!.lines).toEqual([
      { type: "context", text: "import foo" },
      { type: "add", text: "bar" },
    ]);
  });

  test("接受模型常加的代码围栏与 heredoc 包装", () => {
    const inner = patch("*** Add File: a.txt\n+hi");
    expect(parsePatch("```diff\n" + inner + "\n```")).toHaveLength(1);
    expect(parsePatch("<<'EOF'\n" + inner + "\nEOF\n")).toHaveLength(1);
    expect(stripPatchWrapper("\n\n```\n" + inner + "\n```\n\n")).toBe(inner);
  });

  test("格式错误给出可照着改的报错", () => {
    expect(() => parsePatch("*** Add File: a.txt\n+hi")).toThrow(/Begin Patch/);
    expect(() => parsePatch("*** Begin Patch\n*** Add File: a.txt\n+hi")).toThrow(/End Patch/);
    expect(() => parsePatch(patch("*** Add File: a.txt\nhi"))).toThrow(/must start with '\+'/);
    expect(() => parsePatch(patch("*** Update File: a.txt"))).toThrow(/no changes/);
    expect(() => parsePatch(patch("*** Frobnicate: a.txt"))).toThrow(/unexpected line/);
    expect(() => parsePatch(patch(""))).toThrow(/no file changes/);
  });

  test("touched paths 含重命名目标（权限判定用）", () => {
    const ops = parsePatch(
      patch("*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Delete File: c.ts"),
    );
    expect(patchTouchedPaths(ops).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

// ---------------------------------------------------------------------------
// 匹配：逐级放宽
// ---------------------------------------------------------------------------
describe("片段定位", () => {
  test("精确匹配优先，其次忽略行尾空白，再忽略首尾空白", () => {
    expect(seekSequence(["a  ", "b"], ["a", "b"], 0)).toBe(0);
    expect(seekSequence(["  a", "  b"], ["a", "b"], 0)).toBe(0);
    expect(seekSequence(["x", "a", "b"], ["a", "b"], 0)).toBe(1);
    expect(seekSequence(["x", "a", "b"], ["a", "b"], 2)).toBeNull();
  });

  test("Unicode 标点差异也能匹配（最后一级放宽）", () => {
    expect(seekSequence(["const s = “hi”;"], ['const s = "hi";'], 0)).toBe(0);
    expect(seekSequence(["a — b"], ["a - b"], 0)).toBe(0);
  });

  test("End of File 语义：贴着文件末尾匹配", () => {
    const lines = ["tail", "x", "tail"];
    expect(seekSequence(lines, ["tail"], 0, true)).toBe(2);
    expect(seekSequence(lines, ["tail"], 0, false)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 应用：原子性、模糊匹配保留原文、多文件摘要
// ---------------------------------------------------------------------------
describe("补丁应用", () => {
  test("多文件改动一次落盘，摘要与 Codex 同款 A/M/D", () => {
    const { apply, files } = memoryFs({
      "/src/old.ts": "const x = 1;\nconst y = 2;\n",
      "/gone.txt": "bye\n",
    });
    const result = apply(
      patch(
        [
          "*** Add File: src/new.ts",
          "+export const a = 1;",
          "*** Update File: src/old.ts",
          "@@",
          " const x = 1;",
          "-const y = 2;",
          "+const y = 3;",
          "*** Delete File: gone.txt",
        ].join("\n"),
      ),
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.summary).toBe(
      [
        "Success. Updated the following files:",
        "A src/new.ts",
        "M src/old.ts",
        "D gone.txt",
      ].join("\n"),
    );
    expect(files.get("/src/new.ts")).toBe("export const a = 1;\n");
    expect(files.get("/src/old.ts")).toBe("const x = 1;\nconst y = 3;\n");
    expect(files.has("/gone.txt")).toBe(false);
  });

  test("任何一处匹配不上 → 一个字节都不写", () => {
    const { apply, files } = memoryFs({
      "/a.txt": "hello\n",
      "/b.txt": "world\n",
    });
    const result = apply(
      patch(
        [
          "*** Update File: a.txt",
          "@@",
          "-hello",
          "+HELLO",
          "*** Update File: b.txt",
          "@@",
          "-nope",
          "+NOPE",
        ].join("\n"),
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("Invalid Context");
    expect(result.error).toContain("nope");
    // 第一个文件的改动也不能留下。
    expect(files.get("/a.txt")).toBe("hello\n");
    expect(files.get("/b.txt")).toBe("world\n");
  });

  test("落盘中途失败（磁盘满 / 权限）→ 回滚已写的，工作区还是原样", () => {
    // 匹配阶段过了，写阶段才炸：这才是"改了一半"最容易发生的时刻。
    // 工具说明对模型承诺的是"任何一段失败就什么都不写"，模型据此继续干活；
    // 留下半个改动比直接报错更糟 —— 它会基于错误的前提往下推理。
    const files = new Map<string, string>([
      ["/a.txt", "hello\n"],
      ["/b.txt", "world\n"],
    ]);
    let writes = 0;
    const fs: PatchFileSystem = {
      read: (target) => (files.has(target) ? files.get(target)! : null),
      write: (target, contents) => {
        writes += 1;
        if (target === "/b.txt") throw new Error("ENOSPC: no space left on device");
        files.set(target, contents);
      },
      remove: (target) => {
        files.delete(target);
      },
    };
    const result = applyPatch(
      patch(["*** Update File: a.txt", "@@", "-hello", "+HELLO", "*** Update File: b.txt", "@@", "-world", "+WORLD"].join("\n")),
      { resolve: (raw) => path.resolve("/", raw), fs },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("ENOSPC");
    expect(result.error).toContain("rolled back");
    // a.txt 先被写成功，必须被撤回去。
    expect(files.get("/a.txt")).toBe("hello\n");
    expect(files.get("/b.txt")).toBe("world\n");
    expect(writes).toBeGreaterThan(1);
  });

  test("回滚自己也失败时如实说明，不谎称工作区没动", () => {
    const files = new Map<string, string>([
      ["/a.txt", "hello\n"],
      ["/b.txt", "world\n"],
    ]);
    const fs: PatchFileSystem = {
      read: (target) => (files.has(target) ? files.get(target)! : null),
      write: (target, contents) => {
        // 第一个文件写成功；之后（包括回滚）一律失败。
        if (target === "/a.txt" && contents === "HELLO\n") {
          files.set(target, contents);
          return;
        }
        throw new Error("EACCES: permission denied");
      },
      remove: (target) => {
        files.delete(target);
      },
    };
    const result = applyPatch(
      patch(["*** Update File: a.txt", "@@", "-hello", "+HELLO", "*** Update File: b.txt", "@@", "-world", "+WORLD"].join("\n")),
      { resolve: (raw) => path.resolve("/", raw), fs },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("Rollback was incomplete");
    expect(result.error).not.toContain("workspace is unchanged");
    // a.txt 停在改过的状态上 —— 报错必须说清这一点。
    expect(files.get("/a.txt")).toBe("HELLO\n");
  });

  test("模糊匹配命中时保留文件原有写法（不会把整行空格重写）", () => {
    const { apply, files } = memoryFs({ "/a.md": "  indented line  \nnext\n" });
    const result = apply(patch("*** Update File: a.md\n@@\n indented line\n-next\n+next!\n"));

    if (!result.ok) throw new Error(result.error);
    expect(files.get("/a.md")).toBe("  indented line  \nnext!\n");
  });

  test("重命名 + 改写；目标已存在时报错且不动原文", () => {
    const { apply, files } = memoryFs({ "/a.txt": "old\n", "/b.txt": "occupied\n" });
    const blocked = apply(
      patch("*** Update File: a.txt\n*** Move to: b.txt\n@@\n-old\n+new\n"),
    );
    expect(blocked.ok).toBe(false);
    expect(files.get("/a.txt")).toBe("old\n");
    expect(files.get("/b.txt")).toBe("occupied\n");

    const moved = apply(patch("*** Update File: a.txt\n*** Move to: c.txt\n@@\n-old\n+new\n"));
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.summary).toContain("M c.txt");
    expect(files.has("/a.txt")).toBe(false);
    expect(files.get("/c.txt")).toBe("new\n");
  });

  test("新增已存在的文件、删除不存在的文件都明确报错", () => {
    const { apply } = memoryFs({ "/a.txt": "x\n" });
    const add = apply(patch("*** Add File: a.txt\n+x"));
    expect(add.ok).toBe(false);
    if (!add.ok) expect(add.error).toContain("already exists");

    const del = apply(patch("*** Delete File: nope.txt"));
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error).toContain("does not exist");
  });

  test("追加到文件末尾（*** End of File）不会插到开头", () => {
    const { apply, files } = memoryFs({ "/log.txt": "first\nsecond\n" });
    const result = apply(
      patch("*** Update File: log.txt\n@@\n second\n+third\n*** End of File"),
    );
    if (!result.ok) throw new Error(result.error);
    expect(files.get("/log.txt")).toBe("first\nsecond\nthird\n");
  });

  test("路径解析交给调用方：越界时抛错，整体不落盘", () => {
    const files = new Map<string, string>([["/safe.txt", "ok\n"]]);
    const result = applyPatch(
      patch("*** Update File: /etc/passwd\n@@\n-ok\n+hacked\n"),
      {
        resolve: () => {
          throw new Error("Path outside workspace is not writable: /etc/passwd");
        },
        fs: {
          read: (target) => files.get(target) ?? null,
          write: (target, contents) => void files.set(target, contents),
          remove: (target) => void files.delete(target),
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("outside workspace");
    expect(files.get("/safe.txt")).toBe("ok\n");
  });
});

// ---------------------------------------------------------------------------
// 真实文件系统跑一遍（工作区里的相对路径、目录创建、删除）
// ---------------------------------------------------------------------------
describe("补丁落盘（真实 fs）", () => {
  test("在临时工作区里完成新增 / 修改 / 删除 / 重命名", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "omni-patch-"));
    try {
      mkdirSync(path.join(workspace, "src"), { recursive: true });
      writeFileSync(path.join(workspace, "src", "app.ts"), "export const version = 1;\n");
      writeFileSync(path.join(workspace, "notes.md"), "# 旧标题\n\n正文\n");

      const result = applyPatch(
        patch(
          [
            "*** Add File: src/util.ts",
            "+export const helper = () => 42;",
            "*** Update File: src/app.ts",
            "@@",
            "-export const version = 1;",
            "+export const version = 2;",
            "*** Update File: notes.md",
            "*** Move to: docs/notes.md",
            "@@",
            "-# 旧标题",
            "+# 新标题",
            "*** Delete File: notes.md",
            "*** End Patch",
          ].join("\n"),
        ),
        {
          resolve: (raw) => path.resolve(workspace, raw),
          fs: {
            read: (target) => (existsSync(target) ? readFileSync(target, "utf8") : null),
            write: (target, contents) => {
              mkdirSync(path.dirname(target), { recursive: true });
              writeFileSync(target, contents, "utf8");
            },
            remove: (target) => rmSync(target, { force: true }),
          },
        },
      );

      // 上面故意让 notes.md 先移动再删除：删除作用在移动后的路径上会失败，
      // 因此整张补丁必须整体回滚 —— 这是"原子"最容易被忽略的一面。
      expect(result.ok).toBe(false);
      expect(readFileSync(path.join(workspace, "src", "app.ts"), "utf8")).toBe(
        "export const version = 1;\n",
      );
      expect(existsSync(path.join(workspace, "docs"))).toBe(false);
      expect(readFileSync(path.join(workspace, "notes.md"), "utf8")).toBe("# 旧标题\n\n正文\n");
      expect(readdirSync(path.join(workspace, "src"))).toEqual(["app.ts"]);

      const ok = applyPatch(
        patch(
          [
            "*** Add File: src/util.ts",
            "+export const helper = () => 42;",
            "*** Update File: src/app.ts",
            "@@",
            "-export const version = 1;",
            "+export const version = 2;",
            "*** Update File: notes.md",
            "*** Move to: docs/notes.md",
            "@@",
            "-# 旧标题",
            "+# 新标题",
          ].join("\n"),
        ),
        {
          resolve: (raw) => path.resolve(workspace, raw),
          fs: {
            read: (target) => (existsSync(target) ? readFileSync(target, "utf8") : null),
            write: (target, contents) => {
              mkdirSync(path.dirname(target), { recursive: true });
              writeFileSync(target, contents, "utf8");
            },
            remove: (target) => rmSync(target, { force: true }),
          },
        },
      );
      if (!ok.ok) throw new Error(ok.error);
      expect(readFileSync(path.join(workspace, "src", "util.ts"), "utf8")).toBe(
        "export const helper = () => 42;\n",
      );
      expect(readFileSync(path.join(workspace, "src", "app.ts"), "utf8")).toBe(
        "export const version = 2;\n",
      );
      expect(readFileSync(path.join(workspace, "docs", "notes.md"), "utf8")).toBe(
        "# 新标题\n\n正文\n",
      );
      expect(existsSync(path.join(workspace, "notes.md"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
