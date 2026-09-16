# Deep Dive Trace: access-embedding-model

## Observed Result

用户通过 OmniStudio 下载并启动了嵌入模型 WeMM-Embedding-9B-GGUF(`~/Library/Application Support/omni-studio.kunpengtalk.com/canary/models/TuTuCSF__WeMM-Embedding-9B-GGUF/WeMM-Embedding-9B-BF16.gguf`,17.9GB),询问如何访问该嵌入模型。

实时状态:llama-server(PID 9553)运行于 127.0.0.1:18080,`--alias wemm-embedding-9b-bf16`,**无 `--embeddings` 标志**;`/v1/models` 返回 `capabilities:["completion"]`。

## Ranked Hypotheses

| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | 当前 llama-server 无法输出嵌入:OmniStudio 的 llama.cpp 运行时对模型类别无感知,从不传 `--embeddings`(llama.cpp 默认禁用嵌入端点)→ `/v1/embeddings` 必然 501 | **High(已证实)** | Strong(实测 501 + 代码零命中 + 二进制帮助文档) | 唯一被端到端实测证实的机制 |
| 2 | 网关(OpenAI 兼容层,实跑 :10001)不代理嵌入:路由表无 `/v1/embeddings`,外部客户端无法经网关取嵌入 | **High(已证实)** | Strong(静态路由表 + L1 实测枚举) | 与 H1 独立的第二重阻断 |
| 3 | 「以为启动了嵌入模型」的前提部分错误:HF 仓库 `conversational` 标签使下载归类为 chat(tags-first 分类器优先于名字),但该归类只影响 UI 元数据,**即使归类为 embedding 也不会改变启动参数** | High | Strong(HF API 实测 tags + modelscope.ts:884-913 分类顺序) | 修正问题定性:功能性缺口是缺失标志,类别误标是并行的第二缺陷 |

## Evidence Summary by Hypothesis

- **H1**:POST `/v1/embeddings` → HTTP 501 `{"message":"This server does not support embeddings. Start it with --embeddings"}`(新旧端点同样失败);`llama.ts buildArgs`(205-251)固定参数 + SERVER_EXTRA_ARGS,`embedding`/`category` 零命中;llama-server build 9410 支持 `--embedding/--pooling` 但默认禁用、无自动启用。
- **H2**:gateway.ts:2173-2196 路由仅 models/chat/responses/messages/audio/images/memories/media/mcp,无 embeddings;L1 实测网关(10001)路由枚举一致;应用自身 KB 客户端(embeddings.ts)也直连推理服务器、不经网关。
- **H3**:HF API(经代理实测)tags 含 `conversational`;classifyModel(modelscope.ts:884-913)tags-first → chat;按名分类本会得出 embedding(modelscope.ts:367-390);`.vllm-meta.json` 在下载时写入(download-manager.ts:398 → model-store.ts:104-115)。

## Evidence Against / Missing Evidence

- **H1**:无反证。二进制能力已确认,缺失纯在启动参数。
- **H2**:无反证。
- **H3**:「归类为 chat 是 501 的原因」这一强表述不成立——归类仅是 UI 元数据,功能根因仍是 H1;归类路径的作用是让模型不出现在正确的市场分类里。

## Per-Lane Critical Unknowns

- **Lane 1(服务暴露)**:SIGTERM 是否触发 before-quit 清理链(launcher JS 层吞掉 SIGINT/SIGTERM 为 no-op,强杀/崩溃必留孤儿 llama-server 占显存)。
- **Lane 2(启动语义)**:HF tags 归因——**已由主会话经代理实测关闭**(`conversational` 标签坐实)。
- **Lane 3(访问方案)**:用户的实际客户端与意图(临时 curl 验证 / 自有 Python/JS 代码 / 应用内 KB / Continue 类第三方工具)——决定方案排名。

## Lane 3 Misplacement / SoT Ownership Scope

不适用(本轮无 MOVE/SoT 类发现)。

## Rebuttal Round

- Best rebuttal to leader:「llama.cpp 可能对嵌入架构模型自动启用嵌入端点」→ 被实测 501 与 `--help`(默认禁用)双重否决。
- Why leader held:501 响应体直接点名 `Start it with --embeddings`,与运行命令行缺失该标志完全互证。

## Convergence / Separation Notes

- L2(501 根因)与 L3(访问缺口)收敛于同一机制:运行时类别无感知 + 网关无嵌入路由。
- L1 独立贡献:端口稳定性(推理口首选 18080 冲突顺延 +1..+100;网关 10000 冲突顺延 +0..+19,真实端口仅内存)与生命周期(随应用退出而停;SIGTERM 路径存疑;强杀留孤儿)。
- 附带澄清:50000=Electrobun webview broker(与模型无关);18929=第三方 deepseek-relay(非本项目);28000 已消失。

## Most Likely Explanation

**当前服务器无法输出嵌入向量,这是 OmniStudio 的产品缺口而非配置失误**:llama.cpp 运行时从不为嵌入模型传 `--embeddings`(类别信息不进入启动参数),网关也不代理 `/v1/embeddings`。叠加陷阱:KB 嵌入选择器按名字过滤(knowledge.ts:681-715,filterModelIds 按名分类),`wemm-embedding-9b` 会被列出,选中后知识库导入必然 501。可用的访问路径(按是否即刻可用):① 独立 llama-server 手工带 `--embeddings` 起(即刻可用,应用外);② `SERVER_EXTRA_ARGS` 修复受管服务器(仅 `omni config set`/SQLite/RPC 可设,无 GUI、无 omi 命令)+ 重启,之后 127.0.0.1:18080 + OpenAI SDK 可用;③ KB 逐库 embeddingBase 指向①的地址(即刻可用);网关恒不可用。

## Critical Unknown

用户的真实访问意图与客户端形态(临时验证 / 自有代码长期集成 / 应用内 KB / 第三方工具),以及是否需要多模态(图文)嵌入与常驻服务——决定推荐方案与是否需要把修复固化为产品规格。

## Recommended Discriminating Probe

访谈提问(见上 Critical Unknown)。运行时问题已被 501 实测完全判定,无需进一步本机探测;归因问题已被 HF API 实测关闭。

## 附:实测数据快照(2026-09-13/14)

- llama-server PID 9553 @127.0.0.1:18080,`--ctx-size 8192 --cache-type-k/v q8_0 --temp 0.2 --no-mmproj-offload`,别名 `wemm-embedding-9b-bf16`,n_embd 4096,n_params 8.95B,vocab 248078,架构 qwen35(底模 tencent/WeMM-Embedding-9B,多模态嵌入,原生 ctx 262144)。
- 网关实跑 10001(10000 被占顺延),匿名开放,chat/completions 实测可用;无嵌入路由。
- 模型目录仅单个 BF16 GGUF + `.vllm-meta.json{"category":"chat"}`,无独立 mmproj 文件 → 当前加载不含视觉投影器,即使启用 --embeddings 也是纯文本嵌入。

## 附:SIGTERM 判别探针增量修正(2026-09-14,Lane 1 补充)

推翻上文「SIGTERM 路径存疑」:

- `src/bun/index.ts:242-252` 的 `process.on("SIGTERM")` → `ServerManager.forceKill()` → 进程组强杀全部推理实例;同一 forceKill 也挂在 uncaughtException(:253-266)与 unhandledRejection(:268-281)。
- 运行中的 canary 构建(Resources/app/bun/index.js 含 "app.sigterm")已带该处理器;launcher 的 no-op 监听器与 app 处理器并存不冲突(多监听器都会执行)。
- 结论:SIGTERM / Ctrl-C / 未捕获异常 → llama-server 均被进程组清理,无孤儿;残余风险仅 kill -9、bun 原生层崩溃、断电(detached 方案固有)。
- 生命周期半边自「存疑」升级为「除 SIGKILL/原生崩溃外稳定」;端口漂移半边结论不变。遗留观察(未验证):SIGTERM 处理器清完子进程后不调 process.exit(),应用本体是否真正退出属应用生命周期范畴,不影响模型暴露结论。
