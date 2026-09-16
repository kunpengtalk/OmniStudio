import { describe, expect, test } from "bun:test";
import { hasInstallTerminalLine, isInstallTerminalLine } from "./install-log";

describe("引擎安装日志的终态判定", () => {
  test("三个引擎的收尾行都认得（成功与失败）", () => {
    expect(isInstallTerminalLine("安装成功：mflux 0.9.0")).toBe(true);
    expect(isInstallTerminalLine("mflux 安装失败")).toBe(true);
    expect(isInstallTerminalLine("安装成功：paddleocr 3.2.0")).toBe(true);
    expect(isInstallTerminalLine("paddleocr 安装失败")).toBe(true);
    expect(isInstallTerminalLine("tesseract 安装成功。")).toBe(true);
    expect(isInstallTerminalLine("安装失败（退出码 1）")).toBe(true);
  });

  test("安装过程中的中间行不算终态", () => {
    expect(isInstallTerminalLine("$ brew install tesseract")).toBe(false);
    expect(isInstallTerminalLine("默认 PyPI 源安装失败（退出码 1），改用清华镜像重试…")).toBe(false);
    expect(isInstallTerminalLine("[stderr] Downloading wheel")).toBe(false);
    expect(isInstallTerminalLine("PaddleOCR 启动失败：端口被占用")).toBe(false);
    expect(isInstallTerminalLine("模型下载失败：PP-OCRv6")).toBe(false);
    expect(isInstallTerminalLine("")).toBe(false);
  });

  test("整批判定：任意一行是终态就算（合批后一批里混着中间行）", () => {
    expect(
      hasInstallTerminalLine(["$ uv pip install mflux", "Collecting mflux", "安装成功：mflux 0.9.0"]),
    ).toBe(true);
    expect(hasInstallTerminalLine(["Collecting", "Building wheel", "Installing"])).toBe(false);
    expect(hasInstallTerminalLine([])).toBe(false);
  });
});
