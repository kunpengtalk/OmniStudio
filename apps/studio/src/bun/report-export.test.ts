import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { exportHtmlReport, reportFileName } from "./report-export";

/**
 * 报告导出：文件名来自 webview，必须防住路径穿越与非法字符；重名不能互相覆盖
 * （同一份报告导两次是很正常的事）。
 */
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "omni-report-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("reportFileName", () => {
  test("去目录、补 .html、清掉非法字符", () => {
    expect(reportFileName("omni-benchmark-qwen3-20260915-0900.html")).toBe(
      "omni-benchmark-qwen3-20260915-0900.html",
    );
    // 目录部分被剥掉：`..` / 绝对路径都只能落到目标目录里
    expect(reportFileName("../../etc/passwd")).toBe("passwd.html");
    expect(reportFileName("/tmp/report")).toBe("report.html");
    // 非法字符替换成下划线；中文名保留
    expect(reportFileName('基准"报告".html')).toBe("基准_报告_.html");
    expect(reportFileName("a:b|c?d*.html")).toBe("a_b_c_d_.html");
    expect(reportFileName("")).toBeNull();
    expect(reportFileName("   ")).toBeNull();
  });
});

describe("exportHtmlReport", () => {
  test("写盘并返回完整路径", () => {
    const res = exportHtmlReport({ dir, filename: "r.html", html: "<html>ok</html>" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toBe(path.join(dir, "r.html"));
    expect(readFileSync(res.path, "utf8")).toBe("<html>ok</html>");
  });

  test("重名加序号，不覆盖已有文件", () => {
    writeFileSync(path.join(dir, "r.html"), "first", "utf8");
    const res = exportHtmlReport({ dir, filename: "r.html", html: "second" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(path.basename(res.path)).toBe("r (1).html");
    expect(readFileSync(path.join(dir, "r.html"), "utf8")).toBe("first");
  });

  test("目录不存在时自己建（下载目录被删过也要能导出）", () => {
    const nested = path.join(dir, "a", "b");
    const res = exportHtmlReport({ dir: nested, filename: "r.html", html: "x" });
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(nested, "r.html"))).toBe(true);
  });

  test("空内容 / 非法文件名不写盘", () => {
    expect(exportHtmlReport({ dir, filename: "r.html", html: "   " }).ok).toBe(false);
    expect(exportHtmlReport({ dir, filename: "..", html: "<p>x</p>" }).ok).toBe(false);
    expect(existsSync(path.join(dir, "r.html"))).toBe(false);
  });
});
