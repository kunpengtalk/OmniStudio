import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_PACKAGES_BY_PLATFORM, nativePackagesFor } from "./native-packages";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

describe("打包原生依赖声明", () => {
  it("清单里每个平台原生包都声明在 optionalDependencies —— 否则构建机上装不到，载荷会缺 binding（issue #4）", () => {
    const declared = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    const missing = Object.entries(NATIVE_PACKAGES_BY_PLATFORM).flatMap(([platform, names]) =>
      names.filter((name) => !declared.has(name)).map((name) => `${platform} → ${name}`),
    );

    expect(missing).toEqual([]);
  });

  it("平台原生包不能声明成 dependencies：os 不匹配的普通依赖会在别的平台上装不上", () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    const platformOnly = Object.values(NATIVE_PACKAGES_BY_PLATFORM)
      .flat()
      .filter((name) => deps.includes(name));

    expect(platformOnly).toEqual([]);
  });

  it("Windows 不声明不存在的 @img/sharp-libvips-win32-x64（sharp 把 libvips DLL 打在 @img/sharp-win32-x64 里）", () => {
    expect(nativePackagesFor("win32", "x64")).toEqual([
      "@img/sharp-win32-x64",
      "@napi-rs/canvas-win32-x64-msvc",
    ]);
    expect(Object.values(NATIVE_PACKAGES_BY_PLATFORM).flat()).not.toContain("@img/sharp-libvips-win32-x64");
  });

  it("每个平台都有非空清单（空清单 = 载荷里没有原生 binding）", () => {
    for (const [platform, names] of Object.entries(NATIVE_PACKAGES_BY_PLATFORM)) {
      expect(`${platform}: ${names.length > 0}`).toBe(`${platform}: true`);
    }
  });
});
