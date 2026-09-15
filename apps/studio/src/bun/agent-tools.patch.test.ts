import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { buildAgentTools, buildReadOnlyTools, type BuiltTool, type ToolContext } from "./agent-tools";
import { permissionRequestForTool } from "./permissions";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "omni-agent-tools-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const ctx: ToolContext = {
  get workspace() {
    return workspace;
  },
  allowShell: false,
} as ToolContext;

function tool(tools: BuiltTool[], name: string): BuiltTool {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .map((part) => part.text ?? "")
    .join("\n");
}

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

describe("apply_patch 工具", () => {
  test("多文件补丁一次落盘，返回 A/M/D 摘要并登记产出物", async () => {
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(path.join(workspace, "src", "app.ts"), "const version = 1;\n");
    const artifacts: string[] = [];
    const tools = buildAgentTools({ ...ctx, recordArtifact: (file) => artifacts.push(file) });

    const result = await tool(tools, "apply_patch").execute("t1", {
      patch: wrap(
        [
          "*** Add File: src/util.ts",
          "+export const five = 5;",
          "*** Update File: src/app.ts",
          "@@",
          "-const version = 1;",
          "+const version = 2;",
        ].join("\n"),
      ),
    });

    expect(textOf(result)).toContain("Success. Updated the following files:");
    expect(textOf(result)).toContain("A src/util.ts");
    expect(textOf(result)).toContain("M src/app.ts");
    expect(readFileSync(path.join(workspace, "src", "util.ts"), "utf8")).toBe(
      "export const five = 5;\n",
    );
    expect(readFileSync(path.join(workspace, "src", "app.ts"), "utf8")).toBe("const version = 2;\n");
    expect(artifacts).toHaveLength(2);
  });

  test("定位失败时不动文件，报错能照着改", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "hello\n");
    const tools = buildAgentTools(ctx);

    const result = await tool(tools, "apply_patch").execute("t2", {
      patch: wrap("*** Update File: a.txt\n@@\n-goodbye\n+hello\n"),
    });

    expect(textOf(result)).toContain("Invalid Context");
    expect(textOf(result)).toContain("goodbye");
    expect(readFileSync(path.join(workspace, "a.txt"), "utf8")).toBe("hello\n");
  });

  test("工作区之外的写入被路径层拦住（补丁也一样）", async () => {
    const outside = path.join(tmpdir(), `omni-outside-${Date.now()}.txt`);
    const tools = buildAgentTools(ctx);
    const result = await tool(tools, "apply_patch").execute("t3", {
      patch: wrap(`*** Add File: ${outside}\n+hacked`),
    });
    expect(textOf(result)).toMatch(/outside workspace|outside the workspace|not writable/i);
  });
});

describe("view_image 工具", () => {
  /** 1x1 透明 PNG。 */
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("视觉模型才有这个工具；纯文本模型拿不到", () => {
    expect(buildReadOnlyTools({ ...ctx, vision: false }).some((t) => t.name === "view_image")).toBe(false);
    expect(buildReadOnlyTools({ ...ctx, vision: true }).some((t) => t.name === "view_image")).toBe(true);
  });

  test("图片以内容块返回（base64 + mimeType），同时给一行文字说明", async () => {
    const file = path.join(workspace, "shot.png");
    writeFileSync(file, Buffer.from(PNG_BASE64, "base64"));
    const tools = buildReadOnlyTools({ ...ctx, vision: true });

    const result = (await tool(tools, "view_image").execute("v1", { path: "shot.png" })) as {
      content: { type: string; text?: string; data?: string; mimeType?: string }[];
    };
    const image = result.content.find((part) => part.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data).toBe(PNG_BASE64);
    expect(textOf(result)).toContain("shot.png");
  });

  test("不支持的扩展名与超大文件都给出可操作的报错", async () => {
    writeFileSync(path.join(workspace, "notes.txt"), "not an image");
    const tools = buildReadOnlyTools({ ...ctx, vision: true });
    const unsupported = await tool(tools, "view_image").execute("v2", { path: "notes.txt" });
    expect(textOf(unsupported)).toContain("Unsupported image type");

    const big = path.join(workspace, "huge.png");
    writeFileSync(big, Buffer.alloc(11 * 1024 * 1024, 1));
    const oversized = await tool(tools, "view_image").execute("v3", { path: "huge.png" });
    expect(textOf(oversized)).toContain("too large");
  });
});

describe("request_permissions（模型主动申请权限）", () => {
  test("工具能跑起来就意味着闸门已放行；工作区内不必多问一次", async () => {
    const tools = buildReadOnlyTools({ workspace, allowShell: false });
    const tool = tools.find((item) => item.name === "request_permissions");
    expect(tool).toBeDefined();

    const granted = await tool!.execute("p1", { path: "/Users/someone/notes", reason: "读参考文档" });
    expect(textOf(granted)).toContain("Access granted");

    const inside = await tool!.execute("p2", { path: "notes/a.md", reason: "读一下" });
    expect(textOf(inside)).toContain("already inside the workspace");
  });

  test("它必须过授权闸门：被翻译成 external_directory 的询问（不是免授权工具）", () => {
    const request = permissionRequestForTool({
      toolName: "request_permissions",
      workspace,
      args: { path: "/Users/someone/notes", reason: "读参考文档" },
    });
    // 返回 null 就说明它躲过了闸门 —— 那样模型能拿到一句假的"已授权"。
    expect(request).not.toBeNull();
    expect(request?.permission).toBe("external_directory");
    expect(request?.pattern).toBe("/Users/someone/notes");
    expect(request?.detail["原因"]).toBe("读参考文档");
    expect(request?.title).toContain("模型申请");
  });

  test("旧的权限翻译用例（保留分组）", () => {
    const request = permissionRequestForTool({
      toolName: "request_permissions",
      workspace,
      args: { path: "/Users/someone/notes", reason: "读参考文档" },
    });
    expect(request?.permission).toBe("external_directory");
    expect(request?.pattern).toBe("/Users/someone/notes");
    expect(request?.detail["原因"]).toBe("读参考文档");
  });
});

describe("权限翻译", () => {
  test("apply_patch 落到 edit，模式取公共目录；多文件时展示文件清单", () => {
    const request = permissionRequestForTool({
      toolName: "apply_patch",
      workspace,
      args: {
        patch: wrap(
          [
            "*** Update File: src/a.ts",
            "@@",
            "-a",
            "+b",
            "*** Update File: src/b.ts",
            "@@",
            "-a",
            "+b",
          ].join("\n"),
        ),
      },
    });
    expect(request?.permission).toBe("edit");
    expect(request?.pattern).toBe("src/*");
    expect(request?.detail["文件"]).toContain("src/a.ts");
    expect(request?.detail["文件"]).toContain("src/b.ts");
  });

  test("补丁里只要有一个文件在工作区外，就按 external_directory 询问", () => {
    const request = permissionRequestForTool({
      toolName: "apply_patch",
      workspace,
      args: {
        patch: wrap(
          ["*** Update File: inside.md", "@@", "-a", "+b", "*** Add File: /tmp/evil.sh", "+rm -rf /"].join(
            "\n",
          ),
        ),
      },
    });
    expect(request?.permission).toBe("external_directory");
    expect(request?.detail["文件"]).toContain("/tmp/evil.sh");
  });

  test("补丁本身解析不出文件时不弹窗（工具会带着报错回来）", () => {
    expect(
      permissionRequestForTool({ toolName: "apply_patch", workspace, args: { patch: "not a patch" } }),
    ).toBeNull();
  });

  test("view_image 读工作区外的图片要授权，读区内不打扰", () => {
    expect(
      permissionRequestForTool({ toolName: "view_image", workspace, args: { path: "shot.png" } }),
    ).toBeNull();
    const outside = permissionRequestForTool({
      toolName: "view_image",
      workspace,
      args: { path: "/tmp/other/shot.png" },
    });
    expect(outside?.permission).toBe("external_directory");
  });
});
