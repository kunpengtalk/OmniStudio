# Deep Dive Spec: 网关页嵌入地址 + 默认模型嵌入配置

## Metadata
- Interview ID: dd-gateway-embedding-ui-001
- Rounds: 4(含 Round 0 拓扑门)
- Final Ambiguity Score: 7.7%
- Type: brownfield
- Generated: 2026-09-14
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED
- Trace: `.omc/specs/deep-dive-trace-gateway-embedding-endpoint-and-default.md`
- 注:Lane 3(预期审计)未回传;其前提已由 L1/L2 证据 + 主会话验证覆盖

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.95 | 0.35 | 0.333 |
| Constraint Clarity | 0.88 | 0.25 | 0.220 |
| Success Criteria Clarity | 0.93 | 0.25 | 0.233 |
| Context Clarity | 0.92 | 0.15 | 0.138 |
| **Total Clarity** | | | **0.923** |
| **Ambiguity** | | | **7.7%** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| ①网关页嵌入地址 | active | 网关页端点列表新增两行:网关代理地址 + 直连嵌入实例地址(实时端口,可复制) | 验收 ①-1..①-3 |
| ②默认模型嵌入配置 | active | 默认模型面板新增嵌入卡片(全局默认),含共享解析抽取与既有 KB 显式启用路径 | 验收 ②-1..②-6 |

## Trace Findings
- **网关页那 9 行全是 `{网关地址} + 静态路径`**(gateway-screen.tsx:163-173),位于标题「网关地址」下;网关自己的根端点已列 `POST /v1/embeddings`(gateway.ts:2258),**/docs 与 openAPI 已含该路由**(gateway.ts:1882-1909)——React 列表是唯一过时展示面。
- **直连地址今天已可见**:`ServedModelInfo` 已带 `port`/`endpoint`/`purpose`(served-models.ts:11,20-58),`ServedModelsPanel` 已渲染 `EndpointCopy`(served-models-panel.tsx:236),用于 dashboard-screen.tsx:439 与 console-screen.tsx:36;webview 全局 `useServedStore` 已持有快照(lib/rpc.ts:66 推送)。**该页显示直连地址零新 RPC**。
- **默认模型面板**是场景卡片网格(default-models-panel.tsx:459-510:对话/语音通话/TTS/ASR/生图/OCR),无嵌入卡片;ModelCard 以单 `settingsKey` 持久化(:73),ChatModelCard 是「一卡需多键+副作用 RPC」的先例(:218 selectChatModel)。
- **结构性问题**:`resolveEmbeddingBase()` 只解析 base,**没有共享的 model 解析函数**;model 闸门三处各写一遍(knowledge.ts:937 / kb-ingest.ts:271 / memory.ts:99)。净爆炸半径:新增全局 `EMBEDDING_MODEL` 会被 **8+ 消费方静默忽略**(KB 全部、记忆全部、网关、CLI)。
- **记忆侧今天零 UI**:`grep -rn "MEMORY_EMBEDDING" apps/studio/src/mainview` → 0 命中;唯一出口是 `memoryStats().embeddingModel`(memory.ts:794)。
- 兜底链第 4 层落到**聊天活动端口**是「列得出调不通」的来源(knowledge.ts:693-696 自注)。

## Goal
让嵌入服务的**地址**与**默认配置**在应用内可见可配:① 网关页端点列表同时给出「网关代理地址」与「直连嵌入实例地址」(实时端口、一键复制,实例未运行时给出明确状态与引导);② 默认模型面板提供**全局默认嵌入模型**(含可选自定义地址/密钥),经 `globalEmbeddingDefaults()`(bun 侧唯一读取点)在**写入时快照**进 KB 行(新建 KB 预填、「启用向量检索」按钮),共享记忆在解析时读取——KB 与记忆都不再需要逐库配置或 `omi set`,且既有 KB 的端点零漂移。〔2026-09-14 修订:原「抽出共享 resolveEmbeddingModel() 并由 KB 闸门改走它」的解析期设计已否决,理由见 AC ②-5 修订记录〕

## Constraints
- ① 代理行沿用现有行模式 `{gatewayUrl} + 静态 path`;直连行必须使用**运行实例的实时端口**(18190 段会漂移,不可从配置推导),不得新造 RPC(复用 `useServedStore` 快照;必要时该页加 `listServedModels` 查询兜底冷加载)
- ① 无嵌入实例运行时:直连行**不消失**,显示「未运行」+ 引导文案;复制按钮在该状态下不可用(不得复制出死地址)
- ② 优先级链(与既有 `resolveEmbeddingBase` 分层配对):**KB 行 > 全局默认(新建 KB 预填) > 运行中嵌入实例 > SERVER_MODE=remote 的 VLLM_API_BASE > active-port**
- ② **既有 KB 不得自动切换**:embeddingModel 为空的 KB 保持纯关键词,直到用户在 KB 设置页点「启用向量检索」(写入该 KB 行 + 触发重嵌)
- ② 共享记忆是全局单例:**设全局默认即视为对记忆的显式启用**(不再需要 `omi set`)
- ② 全局三键由 `globalEmbeddingDefaults()` 唯一读取(bun 侧),经**写入时快照**进入 KB 行;`resolveEmbeddingBase()` 与 rerank 链**保持不改**(既有 KB 端点零漂移)。〔修订:原「必须抽出共享 resolveEmbeddingModel() 并让 KB 闸门改走它」已否决——解析期层级会让既有 KB 的 base 被静默改道〕
- 新增 UI 字符串中英双语(shared/i18n.ts 双份);遵循仓库 Electrobun/React 既有模式与 Hard Rules(src/shared 不 import electrobun)
- 交付前 `bun run lint && bun run typecheck && bun test` 通过

## Non-Goals
- 不改网关路由本身(`/v1/embeddings` 已实现)
- 不引入 `EMBEDDING_PROVIDER_ID` / cloud_providers 行(嵌入不接云端厂商配置面)
- 不自动重嵌既有 KB(用户已明确拒绝静默行为变更)
- 不改记忆「未配置任何嵌入时退化为关键词检索」的既有兜底
- 不做逐 KB 默认模板、不做嵌入质量评测/模型推荐
- 不改 18190 端口段与分配语义

## Acceptance Criteria
**①网关页嵌入地址**
- [ ] ①-1 网关页端点列表出现「网关代理」嵌入行,地址为 `{网关地址}/v1/embeddings`,带复制按钮(与现有 9 行同构)
- [ ] ①-2 同页出现「直连嵌入实例」行,地址为 `http://127.0.0.1:{port}/v1/embeddings`(端口来自**运行中最后一个**嵌入实例,非配置;host 固定按 127.0.0.1 呈现),带复制按钮
- [ ] ①-3 无嵌入实例运行时:直连行显示「未运行」+ 引导(如「在模型页以嵌入类别启动模型」),复制按钮禁用;代理行不受影响
**②默认模型嵌入配置**
- [ ] ②-1 默认模型面板出现嵌入卡片(选择嵌入模型 + 可选自定义服务地址/密钥),与 TTS/ASR 等卡片视觉一致
- [ ] ②-2 卡片保存后:共享记忆无需任何额外设置即走向量检索(此后**新写入**的记忆;卡片文案说明既有记忆在后续写入/维护时补向量)
- [ ] ②-3 新建 KB 预填该全局默认(model + base + key 三字段)
- [ ] ②-4 既有 embeddingModel 为空的 KB **保持纯关键词**;KB 设置页提供「启用向量检索」按钮,点击后写入该 KB 行并按入重嵌(真的重嵌,不是只清空向量)
- [ ] ②-5 **全局三键由 `globalEmbeddingDefaults()` 唯一读取**(bun 侧),经**写入时快照**进入 KB 行(建库预填 / 启用按钮),记忆在解析时读取;网关无需改动(转发客户端自带 model,已核验)。〔2026-09-14 用户确认修订:原「共享 resolveEmbeddingModel + KB 闸门改走它」改为快照语义——两轮 Architect 与 Critic 独立证明解析期层级会让既有 KB 的 base 被静默改道〕
- [ ] ②-6 记忆优先级:禁用哨兵(`none`/`off`)> 显式值 > 全局默认;base/key 同规则。〔同批修订:原「KB 行 > 全局 > 实例 > remote > active-port」链描述的是已否决的解析期设计;快照语义下 base 继续走既有四层链不被改动〕
- [ ] ②-7(新增,守 Non-Goal)清空全局默认后,未显式配置的记忆恢复纯关键词
- [ ] ②-8(新增,防静默改道)既有 KB(显式 model + 空 base)在设全局 `EMBEDDING_BASE` 后,解析 base 与今日一致;rerank 链路对未被触碰的 KB 不变
- [ ] ③-E `bun run lint && bun run typecheck && bun test` 全绿(附命令与输出摘要)

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 网关页端点列表缺嵌入地址 | L1 实测:9 行全是网关地址+静态路径,/docs 已含该路由 | 加两行(代理行静态 + 直连行动态) |
| 显示直连地址需要新 RPC | L1:`listServedModels` 已带 port/endpoint/purpose,webview 已持有 | 零新 RPC,页面接入既有快照 |
| 「默认模型加个卡片」就行 | L2:model 闸门三处各写一遍,8+ 消费方会静默忽略全局默认 | 全局默认须有唯一读取点(`globalEmbeddingDefaults`,bun 侧)并在写入时快照进 KB 行〔修订:原定「抽共享 resolveEmbeddingModel」因会静默改道既有 KB 端点而否决〕 |
| 设全局默认会顺带改善既有 KB | Round 3 追问 | 否——既有 KB 需显式启用(避免静默重嵌) |
| 记忆侧也要显式启用 | Round 4 确认 | 否——记忆是全局单例,设默认即启用 |
| 直连行在实例未运行时应隐藏 | Round 4 验收确认 | 不隐藏:显示「未运行」+ 引导,复制禁用 |

## Technical Context
- 网关页:`src/mainview/app/gateway-screen.tsx`(端点数组 :163-173、EndpointRow :33-62、url 来源 :99-107/:126)
- 直连地址数据:`src/shared/served-models.ts`(:11,20-58)、RPC `listServedModels`(`src/bun/rpc/index.ts:2405`,schema :353)、webview 镜像 `src/mainview/stores/served.ts` + 推送 `src/mainview/lib/rpc.ts:66`
- 既有展示参考:`src/mainview/components/served-models-panel.tsx`(:96 EndpointCopy、:236 渲染)
- 默认模型面板:`src/mainview/app/main-layout/default-models-panel.tsx`(ModelCard :39-188/持久化 :73、ChatModelCard :191-358、CloudModelCard :364-429、卡片列表 :459-510)
- 设置键:`src/bun/db/settings.ts`(SettingsKey union;MEMORY_EMBEDDING_* :133-135/:334-336;EMBEDDING_PORT/POOLING :194-195/:395-396)
- 嵌入解析:`src/bun/embeddings.ts`(resolveEmbeddingBase :19-29、callEmbeddings :42)、`src/bun/model-servers.ts`(resolveEmbeddingBackend :639-643)
- 闸门:KBs `src/bun/knowledge.ts:937-945`、`src/bun/kb-ingest.ts:271`(另 :143-148/:213);记忆 `src/bun/memory.ts:98-107`(另 :921-922/:668-679/:794)
- KB 行 schema:`src/bun/db/schema.ts:456`(embedding_{model,base,api_key,dim})
- 网关:`src/bun/gateway.ts`(:11,1348-1350 handleEmbeddings;:2258 根端点数组;:1882-1909 openAPI)
- i18n:`src/shared/i18n.ts`(settings.gateway.endpoints.* :1784-1795 zh / :4045-4056 en;defaults.* :1692-1711)

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| GatewayEmbeddingRow | core domain | 地址(网关代理)、复制按钮 | 属于默认模型面板?否——属于网关页端点列表 |
| DirectEmbeddingEndpoint | core domain | 实时 port、/v1、运行状态 | 由 running EmbeddingInstance 派生 |
| RunningEmbeddingInstance | core domain | port(18190 段)、purpose=embedding、endpoint | 来源 ServedModelsSnapshot;驱动 DirectEmbeddingEndpoint |
| GlobalEmbeddingDefault | core domain | model、可选 base、可选 apiKey | 唯一读取点 `globalEmbeddingDefaults()`(bun 侧);写入时快照进 KB 行;记忆解析时读取 |
| ResolveEmbeddingModel | core domain | 优先级链 | 与 ResolveEmbeddingBase 配对;被 KB/记忆/CLI/网关消费 |
| KB row embedding config | supporting | model/base/key/dim | 优先级最高;既有 KB 需显式写入 |
| MemoryEmbeddingConfig | supporting | MEMORY_EMBEDDING_* | 全局单例;空则回落 GlobalEmbeddingDefault |
| EnableVectorRetrieval action | supporting | 写入 KB 行 + 触发重嵌 | 既有 KB 的唯一切换路径 |
| EmbeddingCard | supporting | 模型选择 + 地址 | 写入 GlobalEmbeddingDefault |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 10 | 10 | - | - | N/A |
| 2 | 11 | 1(ResolveEmbeddingModel) | 0 | 10 | 91% |
| 3 | 12 | 1(EnableVectorRetrieval) | 0 | 11 | 92% |
| 4 | 12 | 0 | 0 | 12 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (4 rounds + Round 0)</summary>

### Round 0(拓扑门)
**Q:** 两个组件(①网关页地址 / ②默认模型嵌入配置)拓扑是否正确、哪些在范围?
**A:** 确认两个组件都在范围内。
### Round 1
**Q:** 网关页那行显示哪个地址?
**A:** 两行都要——网关代理地址 + 直连实例地址。
**Ambiguity:** 41%(Goal 0.68 / Constraints 0.48 / Criteria 0.40 / Context 0.88)
### Round 2
**Q:** 默认模型里的嵌入卡片是哪种契约?
**A:** 全局默认(解析期生效),含抽共享 resolveEmbeddingModel + 定义优先级链。
**Ambiguity:** 25%
### Round 3
**Q:** 设了全局默认后,既有空配置 KB 怎么处理?
**A:** 需显式启用(不自动切换、不静默重嵌)。
**Ambiguity:** 21.3%
### Round 4
**Q:** 验收标准确认?(含记忆侧「设默认即启用」语义)
**A:** 确认全部验收标准。
**Ambiguity:** 7.7% ✅
</details>
