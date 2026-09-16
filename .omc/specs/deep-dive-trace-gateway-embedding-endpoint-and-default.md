# Deep Dive Trace: gateway-embedding-endpoint-and-default

注:Lane 3(预期审计)未回传报告(两次催收未响应);其职责由 L1/L2 证据 + 主会话自行验证的关键前提覆盖,L3 相关推断已在下文标注来源。

## Observed Result

用户提出两个 UI 优化点(原话):「在网关页面的端点列表中，添加嵌入模型的地址，以及在默认模型中，添加嵌入模型的配置。」背景:上一轮修复后嵌入服务已可正常使用(llama-server `--embeddings`,18190 段,网关 10001)。

## Ranked Hypotheses

| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | 「网关页加嵌入地址」若指**网关代理路径**(`{gatewayUrl}/v1/embeddings`),修法是**静态数组加一行 + 中英各 1 条 i18n**,零新 RPC、零动态数据 | High | Strong | 现有 9 行全是 `{gatewayUrl} + 静态 path`(gateway-screen.tsx:163-173);网关根端点已列 `POST /v1/embeddings`(gateway.ts:2258);/docs 与 openAPI 已含该路由(gateway.ts:1882-1909)——**React 列表是唯一过时展示面** |
| 2 | 「地址」若指**直连嵌入实例地址**,数据**今天已存在且已展示**:`listServedModels` RPC 已返回 `port`/`endpoint`/`purpose`(served-models.ts:11,20-58;rpc/index.ts:2405),`ServedModelsPanel` 已渲染 `EndpointCopy`(served-models-panel.tsx:236,用于 dashboard:439 / console:36)。缺的不是数据而是**嵌入语义标注** | High | Strong | 主会话实测确认面板渲染 `http://127.0.0.1:<port>/v1` + 复制按钮;webview 全局 `useServedStore` 已持有该快照(lib/rpc.ts:66 推送) |
| 3 | 「默认模型加嵌入配置」是**真缺口,但暗含结构性前提**:今天嵌入配置散落 KB 逐库行 + `MEMORY_EMBEDDING_*`(后者 mainview 零 UI)+ 实例自动发现;而 **`resolveEmbeddingBase()` 只解析 base,没有共享的 `resolveEmbeddingModel()`**——model 闸门在三处各写一遍(knowledge.ts:937 / kb-ingest.ts:271 / memory.ts:99)。加全局默认而不抽共享解析函数,会被 **8+ 消费方静默忽略** | High | Strong | L2 逐点核实(L2 报告 task 5 表列 13 个站点,净结论:model 半边被 8+ 处忽略) |

## Evidence Summary by Hypothesis

- **H1**:端点行渲染器 `EndpointRow`(gateway-screen.tsx:33-62)带复制按钮,数据源仅 `getGatewayStatus` + `getSettings`(:99-107);页面无 served-models 查询、不 import served store。i18n key 模式 `settings.gateway.endpoints.<slug>`(i18n.ts:1784-1795 zh / 4045-4056 en),**无 embeddings slug**。无测试覆盖该数组(`app/` 下无 gateway-screen.test.tsx)。
- **H2**:`ServedModelInfo` 带 `purpose: "chat" | "embedding"` 与 `endpoint`(含 `/v1`);`broadcastCurrentStatus` 每次 webview 加载补推(rpc/index.ts:4638);面板 4s 轮询兜底(served-models-panel.tsx:45-53)。嵌入端口在段内漂移(18190/18191 均被测试断言),无法从配置推导。
- **H3**:各消费方各读各的源——KB 用 KB 行(knowledge.ts:937-945)、记忆用 `MEMORY_EMBEDDING_*`(memory.ts:98-107);`grep -rn "MEMORY_EMBEDDING" src/mainview` **0 命中**(记忆侧无可达 UI)。仓库自身注释已记录兜底链风险(knowledge.ts:693-696「没有嵌入实例时会落到聊天活动端口」)。

## Evidence Against / Missing Evidence

- **H1**:若用户实际想要的是**直连地址**出现在该页,则假设不成立(但那也不需要新 RPC,只需该页接入 `useServedStore`)。
- **H2**:反驳「已完全满足」——面板把嵌入实例与聊天模型混排,没有「这是你的嵌入端点/KB 用这个」的标注;用户此前正是靠 curl 才发现该地址。故**语义缺口真实存在**。
- **H3**:反驳「危险」——`MEMORY_EMBEDDING_*` 今天无 UI,用户需 `omi set` 才行;全局默认可能是**补缺口**而非添乱。且面板其余卡片是「调用期默认」语义(如 TTS/ASR 的 provider+model),CloudModelCard 模式**无法照抄**(嵌入没有 cloud_providers 行 / 无 EMBEDDING_PROVIDER_ID)。

## Per-Lane Critical Unknowns

- **Lane 1(网关页)**:**该行展示哪个地址**——网关代理路径 `{gatewayUrl}/v1/embeddings`(静态,零成本)还是直连实时实例 `http://127.0.0.1:{livePort}/v1/embeddings`(动态,数据已可得)。此决策直接翻转实现结论。次要:嵌入实例未运行时,该行渲染禁用态还是引导文案。
- **Lane 2(默认模型)**:**卡片的契约是哪一种**——(a) 解析期全局默认(KB+记忆都查,需定义优先级并改 3 处闸门)(b) 仅「新建 KB 的初始值」(无优先级问题,但不得宣称能改已有 KB)(c) 仅把 `MEMORY_EMBEDDING_*` 暴露到面板。代码与 i18n 均未回答;`defaults.hint` 的「地址与密钥在对应工具页配置」**没有嵌入版本**。
- **Lane 3**:未回传(报告缺失);主会话已自行验证其核心前提(面板已展示端点、KB 设置页存在、记忆无 UI)。

## Lane 3 Misplacement / SoT Ownership Scope

不适用(无 MOVE/SoT 类发现)。

## Rebuttal Round

- 对领先解释的最强反驳:「网关页那 9 行都带 `{gatewayUrl}` 前缀(标题为『网关地址』),所以加嵌入行=网关代理路径,不需要动态数据」——被 H2 部分削弱:直连地址才是用户实际会用 curl 打的那个,且此前正是靠它排障。
- 领先解释为何站住:两条路径**不互斥**——网关行是静态一行,直连地址是语义标注/复用已有数据,可同时做且成本都低。

## Convergence / Separation Notes

- L1 与 L2 收敛于同一结构性观察:**「数据/配置已经存在,缺的是让用户看见并理解」**——网关行缺的是列表同步(docs 已更新)、直连地址缺的是语义标注、嵌入默认缺的是可达 UI 与共享解析。
- 分离点:① 是纯展示(零风险),③ 触及 8+ 消费方的解析链(结构性风险),两者不可打包成同一「加个卡片/加一行」的简单改动。

## Most Likely Explanation

两个需求都成立,但**风险等级完全不同**:
- **① 网关页加嵌入行**:若指网关代理路径 → 静态数组 + 2 条 i18n,**零风险零动态数据**(甚至无测试负担)。若指直连地址 → 复用已存在的 served-models 快照,同样无新 RPC,但要处理「嵌入实例未运行」的空态。
- **③ 默认模型加嵌入配置**:是真缺口(记忆侧今天无 UI),但**不能只加卡片**——必须先抽共享的 `resolveEmbeddingModel()`(与既有 `resolveEmbeddingBase()` 配对)并定义优先级(行 > 全局 > 运行实例 > remote > 聊天端口?),否则新配置会被 KB 入库/检索/记忆/网关/CLI 共 8+ 处静默忽略,复刻刚修掉的「配置了但不生效」陷阱。

## Critical Unknown

两个决策点(① 展示哪个地址;③ 卡片的契约与优先级)。其余事实已由证据闭合。

## Recommended Discriminating Probe

直接问用户这两个问题(访谈阶段的核心),无需进一步本机探测:
1. 网关页那行要显示**网关代理地址**(`http://127.0.0.1:10001/v1/embeddings`)还是**直连嵌入实例地址**(`http://127.0.0.1:18190/v1/embeddings`)?还是两行都要?
2. 默认模型里的嵌入卡片,是**全局默认**(KB/记忆都继承,需定义优先级)还是**新建 KB 的初始值**?
