/**
 * 托管引擎的落盘位置 —— 「应用自己装的引擎住在哪」的唯一真源。
 *
 * 三条约束都在这里收口，别处不要再拼路径：
 *  - 与既有的媒体引擎同规矩：全部落在 `<dataDir>/engines/<名字>/`（cloudflared 用
 *    `current/` 存二进制、mflux 直接把 venv 放根目录），备份 / 排障时只看一个地方；
 *  - 解析顺序统一是**托管目录 → 系统 PATH**：应用自己装的版本自洽可复现，
 *    用户自己装过的仍然能用（只是不接管、不删除）；
 *  - 谁装的谁删得掉：卸载只动托管目录，PATH 上的东西一律不碰。
 */
import { join } from "path";

import { getDataDir } from "./paths";

const isWindows = process.platform === "win32";

/** Python 引擎（mlx-lm / vLLM / SGLang）的 venv 目录：`<dataDir>/engines/<id>`。 */
export type PythonEngineId = "mlx-lm" | "vllm" | "sglang";

export function pythonEngineDir(id: PythonEngineId): string {
  return getDataDir("engines", id);
}

/** venv 里的可执行文件路径（Windows 是 `Scripts/`，其余是 `bin/`）。 */
export function pythonEngineBin(id: PythonEngineId, name: string): string {
  const dir = pythonEngineDir(id);
  return isWindows ? join(dir, "Scripts", `${name}.exe`) : join(dir, "bin", name);
}

/** venv 的解释器：跑 `-m <module>` / `-c "import …"` 都用它。 */
export function pythonEnginePython(id: PythonEngineId): string {
  return isWindows
    ? join(pythonEngineDir(id), "Scripts", "python.exe")
    : join(pythonEngineDir(id), "bin", "python3");
}

/** llama.cpp 托管安装的根（与 cloudflared 同构：暂存 → 原子 rename 到 current）。 */
export function llamaCppRootDir(): string {
  return getDataDir("engines", "llama.cpp");
}

export function llamaCppCurrentDir(): string {
  return join(llamaCppRootDir(), "current");
}

/** llama-server 可执行文件（托管安装的目标路径，也是 runtimes 优先解析的那个）。 */
export function llamaCppBinaryPath(): string {
  return join(llamaCppCurrentDir(), isWindows ? "llama-server.exe" : "llama-server");
}

/** 安装标记（记下装的是哪个官方构建，排障与「要不要升级」都读它）。 */
export function engineVersionFilePath(id: "llama.cpp" | PythonEngineId): string {
  return id === "llama.cpp"
    ? join(llamaCppCurrentDir(), "VERSION")
    : join(pythonEngineDir(id), "VERSION");
}

/**
 * oMLX 的应用托管数据目录（传给 `omlx serve --base-path`）。
 *
 * oMLX 默认把所有状态写在 `~/.omlx`（settings.json / 日志 / SSD KV 缓存）。应用自己
 * 拉起的那份实例必须与用户手动安装的实例隔离：否则改一次端口就重写了用户自己的
 * oMLX 配置，两边的日志与 SSD 缓存还会互相覆盖。所以固定指到 `<dataDir>/omlx`。
 * 这里不是「托管安装」目录——oMLX 本体由 Homebrew / .dmg 安装，应用不接管卸载。
 */
export function omlxBaseDir(): string {
  return getDataDir("omlx");
}
