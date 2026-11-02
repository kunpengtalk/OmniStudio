import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildOmlxServeArgs, omlxRequestModelId } from "../../shared/omlx";
import { OmlxRuntime } from "./omlx";

/**
 * oMLX 运行时的纯函数部分（命令拼装 / 模型 id）。
 *
 * 这里盯的是两个真实会出问题的地方：
 *  1. **模型 id 必须原样**：oMLX 把 `--model-dir` 指向的目录注册成模型，id 就是目录名
 *     （`Qwen__Qwen3.5-4B`）。别的引擎用 slug，照抄过来请求就会 404 —— MLX 已经因为
 *     「id 不是 slug」踩过一次。
 *  2. **参数拼装**：端口 / 主机 / 模型目录 / 数据目录是启动的硬前提；内存守护档位与
 *     最大并发只有设置了才传，附加参数永远在最后。
 */
describe("omlxRequestModelId", () => {
  test("目录名原样返回，不做 slug（大小写与 __ 都保留）", () => {
    expect(omlxRequestModelId("/models/Qwen__Qwen3.5-4B")).toBe("Qwen__Qwen3.5-4B");
    // 与 model-store 的 slug 化服务名对比：两者不能混用。
    expect(omlxRequestModelId("/models/Qwen__Qwen3.5-4B")).not.toBe("qwen3.5-4b");
  });

  test("末尾斜杠 / 空串 / 相对路径都取得到末段", () => {
    expect(omlxRequestModelId("/models/Qwen3-8B/")).toBe("Qwen3-8B");
    expect(omlxRequestModelId("")).toBe("");
    expect(omlxRequestModelId("mlx-community/Qwen3-8B-4bit")).toBe("Qwen3-8B-4bit");
  });

  test("真实存在的目录取解析后的 basename", () => {
    const root = mkdtempSync(join(tmpdir(), "omlx-id-"));
    try {
      const dir = join(root, "Qwen__Qwen3.5-9B");
      mkdirSync(dir, { recursive: true });
      expect(omlxRequestModelId(dir)).toBe("Qwen__Qwen3.5-9B");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildOmlxServeArgs", () => {
  test("硬参数齐全：serve + 模型目录 + 主机 + 端口 + 数据目录", () => {
    const args = buildOmlxServeArgs({
      modelDir: "/models/Qwen3-8B",
      host: "127.0.0.1",
      port: "8000",
      basePath: "/data/omlx",
    });
    expect(args).toEqual([
      "serve",
      "--model-dir",
      "/models/Qwen3-8B",
      "--host",
      "127.0.0.1",
      "--port",
      "8000",
      "--base-path",
      "/data/omlx",
    ]);
    // 不传 --headless：保留 oMLX 自带 /admin，设置页的「管理页」才有东西可开。
    expect(args).not.toContain("--headless");
  });

  test("内存守护档位与最大并发只在有值时传", () => {
    const withOptions = buildOmlxServeArgs({
      modelDir: "/m",
      host: "127.0.0.1",
      port: "8000",
      basePath: "/d",
      memoryGuard: "aggressive",
      maxConcurrentRequests: "16",
    });
    expect(withOptions).toContain("--memory-guard");
    expect(withOptions[withOptions.indexOf("--memory-guard") + 1]).toBe("aggressive");
    expect(withOptions[withOptions.indexOf("--max-concurrent-requests") + 1]).toBe("16");

    const defaults = buildOmlxServeArgs({
      modelDir: "/m",
      host: "127.0.0.1",
      port: "8000",
      basePath: "/d",
      memoryGuard: "",
      maxConcurrentRequests: "",
    });
    expect(defaults).not.toContain("--memory-guard");
    expect(defaults).not.toContain("--max-concurrent-requests");
  });

  test("非法并发值不传（避免把 oMLX 启动参数喂坏）", () => {
    for (const bad of ["0", "-1", "eight", "8.5"]) {
      const args = buildOmlxServeArgs({
        modelDir: "/m",
        host: "127.0.0.1",
        port: "8000",
        basePath: "/d",
        maxConcurrentRequests: bad,
      });
      expect(args).not.toContain("--max-concurrent-requests");
    }
  });

  test("用户附加参数拼在最后，按空白切分", () => {
    const args = buildOmlxServeArgs({
      modelDir: "/m",
      host: "127.0.0.1",
      port: "8000",
      basePath: "/d",
      memoryGuard: "safe",
      extraArgs: "  --log-level debug  --no-cache ",
    });
    expect(args.slice(-3)).toEqual(["--log-level", "debug", "--no-cache"]);
  });
});

/**
 * 假 oMLX CLI：解析 `serve --port/--model-dir`，起一个只回答 `/v1/models` 的 HTTP
 * 服务，模型 id 用模型目录名（与真 oMLX 的 fallback 一致）。
 *
 * 这就够覆盖运行时真正会出问题的那段：Bun.spawn 的 argv、就绪轮询「要求目标模型在列」、
 * 以及 stop 时按进程组杀干净。真 oMLX 的推理本身不在应用这一侧，不在这里测。
 */
const FAKE_OMLX_SERVER = `
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const port = Number(value("--port"));
const modelDir = value("--model-dir");
const id = modelDir.split("/").filter(Boolean).pop();
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id, object: "model" }] });
    }
    return new Response("ok");
  },
});
`;

describe("OmlxRuntime 生命周期（假 omlx CLI）", () => {
  test("start 等到目标模型就绪，stop 停掉进程组", async () => {
    const root = mkdtempSync(join(tmpdir(), "omlx-runtime-"));
    const oldPath = process.env.PATH;
    try {
      const modelDir = join(root, "Qwen__Qwen3.5-4B");
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(join(modelDir, "config.json"), "{}");

      const serverFile = join(root, "fake-omlx-server.js");
      writeFileSync(serverFile, FAKE_OMLX_SERVER);
      const binary = join(root, "omlx");
      writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${serverFile}" "$@"\n`, {
        mode: 0o755,
      });
      process.env.PATH = `${root}:${oldPath ?? ""}`;

      // 先让内核分配一个空闲端口，再关掉交给假服务，避免 8000 被占。
      const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
      const port = probe.port;
      probe.stop(true);

      const runtime = new OmlxRuntime({ model: modelDir, port: String(port) });
      const result = await runtime.start();
      expect(result.ok).toBe(true);
      expect(runtime.getStatus()).toBe("running");
      expect(runtime.getPid()).toBeGreaterThan(0);
      // 命令预览里能直接看到模型目录与隔离的数据目录。
      expect(runtime.buildCommandLine(modelDir)).toContain("--model-dir");

      await runtime.stop();
      expect(runtime.getStatus()).toBe("stopped");
    } finally {
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("目标目录不是模型（没有 config.json）时不拉起进程，错误点名目录", async () => {
    const root = mkdtempSync(join(tmpdir(), "omlx-runtime-bad-"));
    try {
      const runtime = new OmlxRuntime({ model: root, port: "0" });
      const result = await runtime.start();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("模型目录");
      expect(runtime.getStatus()).toBe("stopped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
