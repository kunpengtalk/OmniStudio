/**
 * oMLX 的**纯约定**（模型 id / `omlx serve` 参数拼装）。
 *
 * 放在 `shared/` 而不是 `bun/runtimes/omlx.ts` 是因为 `model-store` / `model-servers`
 * 都要用它，而那两个模块被很多测试用**部分 mock** 的 `db/settings` 替换；把 runtime
 * （它 import 了 settings / stats / proc）拖进 model-store 的 import 链，会让一个
 * 只 mock 了 getSetting/updateSettings 的测试在模块求值时就报「找不到导出」。
 * 这里不 import 任何 bun/db 模块，主进程与测试都能直接用。
 */

export type OmlxServeParams = {
  modelDir: string;
  host: string;
  port: string;
  basePath: string;
  /** off / safe / balanced / aggressive；空 = 不传（用 oMLX 默认）。 */
  memoryGuard?: string;
  /** 正整数字符串；空 / 非法 = 不传（用 oMLX 默认 8）。 */
  maxConcurrentRequests?: string;
  /** 用户附加参数（空白分隔）。 */
  extraArgs?: string;
};

/**
 * `omlx serve` 的参数列表（不含可执行文件本身）。
 *
 * 只拼「应用确实有设置项」的参数：端口 / 主机 / 模型目录 / 数据目录 / 内存守护档位 /
 * 最大并发，最后追加用户手填的附加参数。不传 `--headless` —— 保留 oMLX 自带的
 * `/admin` 页面，设置页的「打开 oMLX 管理页」才有东西可开。
 */
export function buildOmlxServeArgs(params: OmlxServeParams): string[] {
  const args: string[] = [
    "serve",
    "--model-dir",
    params.modelDir,
    "--host",
    params.host,
    "--port",
    params.port,
    "--base-path",
    params.basePath,
  ];

  const guard = (params.memoryGuard ?? "").trim();
  if (guard) args.push("--memory-guard", guard);

  const concurrency = (params.maxConcurrentRequests ?? "").trim();
  if (/^\d+$/.test(concurrency) && Number(concurrency) > 0) {
    args.push("--max-concurrent-requests", concurrency);
  }

  const extra = (params.extraArgs ?? "").trim();
  if (extra) args.push(...extra.split(/\s+/));

  return args;
}

/**
 * 模型目录在 oMLX 侧的 id：**目录名原样**。
 *
 * oMLX 对 `--model-dir` 指向的单个模型目录注册 `model_dir.name` 作为 id
 * （见 omlx/model_discovery.py 的 fallback 分支）—— 不是应用其他地方用的 slug。
 * `Qwen__Qwen3.5-4B` 就是 `Qwen__Qwen3.5-4B`，请求里写 `qwen3.5-4b` 会 404。
 */
export function omlxRequestModelId(target: string): string {
  const trimmed = (target ?? "").trim();
  if (!trimmed) return "";
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed;
}
