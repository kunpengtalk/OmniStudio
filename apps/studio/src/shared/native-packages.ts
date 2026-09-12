/**
 * 打包进载荷时要一并复制的平台原生包（sharp 的 libvips、@napi-rs/canvas 的 binding）。
 *
 * 这些包各自带 os/cpu 约束，同一次安装只会装构建机对应的那一份，所以它们必须声明在
 * package.json 的 `optionalDependencies` 里 —— 否则在 Windows / Linux 构建机上
 * `node_modules/<pkg>` 压根不存在，electrobun.config.ts 的复制清单会整条落空：
 * 载荷里少了 sharp 的 win32-x64 binding，用户一启动就崩在
 * `Could not load the "sharp" module using the win32-x64 runtime`（issue #4）。
 * 声明与这份清单的一致性由 native-packages.test.ts 守着。
 *
 * 键是 `${process.platform}-${process.arch}`。注意 Windows 的 libvips DLL 是打在
 * `@img/sharp-win32-x64` 里的，sharp 并不存在 `@img/sharp-libvips-win32-x64` 这个包。
 */
export const NATIVE_PACKAGES_BY_PLATFORM: Record<string, string[]> = {
  "darwin-arm64": [
    "@img/sharp-darwin-arm64",
    "@img/sharp-libvips-darwin-arm64",
    "@napi-rs/canvas-darwin-arm64",
  ],
  "darwin-x64": ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64", "@napi-rs/canvas-darwin-x64"],
  // Windows 只有这两个：libvips 的 DLL 在 sharp-win32-x64 包里
  "win32-x64": ["@img/sharp-win32-x64", "@napi-rs/canvas-win32-x64-msvc"],
  "linux-x64": ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64", "@napi-rs/canvas-linux-x64-gnu"],
  "linux-arm64": ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64", "@napi-rs/canvas-linux-arm64-gnu"],
};

/** 构建机需要复制哪几个原生包；未知平台按架构回落到对应的 linux 包（与历史行为一致）。 */
export function nativePackagesFor(platform: string, arch: string): string[] {
  const exact = NATIVE_PACKAGES_BY_PLATFORM[`${platform}-${arch}`];
  if (exact) return exact;
  return NATIVE_PACKAGES_BY_PLATFORM[arch === "x64" ? "linux-x64" : "linux-arm64"] ?? [];
}
