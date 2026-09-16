# Deep Dive Spec: 访问 OmniStudio 嵌入模型 + 嵌入服务产品修复

## Metadata
- Interview ID: dd-access-embedding-9b-001
- Rounds: 5(含 Round 0 拓扑门)
- Final Ambiguity Score: 8.7%
- Type: brownfield
- Generated: 2026-09-14
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED
- Trace: `.omc/specs/deep-dive-trace-access-embedding-model.md`

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.95 | 0.35 | 0.333 |
| Constraint Clarity | 0.85 | 0.25 | 0.213 |
| Success Criteria Clarity | 0.92 | 0.25 | 0.230 |
| Context Clarity | 0.92 | 0.15 | 0.138 |
| **Total Clarity** | | | **0.913** |
| **Ambiguity** | | | **8.7%** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| ①即时访问方案 | active | 今天就能用的嵌入调用配方(curl/Python/JS-TS/第三方工具)+ 独立服务器启动方式 | 验收标准 ①-1..①-5 |
| ②应用内 KB 接入 | active | KB 设置页配 embeddingBase+模型+维度,导入与检索可用 | 验收标准 ②-1..②-3 |
| ③产品修复 | active | A 运行时自动嵌入模式 / B 网关嵌入路由 / C 分类器与选择器修正 / D 文档引导 | 验收标准 ③-A..③-D |

## Trace Findings
- **决定性实测**:POST `/v1/embeddings` → HTTP 501 `"This server does not support embeddings. Start it with --embeddings"`;llama-server(build 9410)支持该标志但默认禁用。
- **根因**:`apps/studio/src/bun/runtimes/llama.ts` buildArgs(205-251)对模型类别无感知,从不传 `--embeddings`/`--pooling`;唯一出口 `SERVER_EXTRA_ARGS`(llama.ts:250-251,engines.ts:46)是全局设置,且 `--embeddings` 会把服务器限制为仅嵌入——会连带废掉 llama.cpp 聊天服务,不可作为方案。
- **网关无嵌入路由**:gateway.ts:2173-2196 仅 models/chat/responses/messages/audio/images/memories/media/mcp;网关实跑 10001(10000 被占顺延,真实端口仅存内存,gateway.ts:55/2262-2280)。
- **分类陷阱**:HF 仓库 tags 含 `conversational`(经代理实测确认),tags-first 分类器(modelscope.ts:884-913)将其归为 chat;KB 嵌入选择器按名过滤(knowledge.ts:681-715 → filterModelIds:550-563)反而会列出 `wemm-embedding-9b-bf16` → 选中必 501。
- **端口/生命周期**:推理端口首选 18080、冲突顺延 +1..+100(model-servers.ts:210-223),活动端口仅内存(settings.ts:473-479);服务随应用退出而停,强杀留孤儿;`omi` CLI 经 Unix socket 提供稳定发现。
- **模型实况**:WeMM-Embedding-9B-BF16.gguf(17.9GB,架构 qwen35,底模 tencent/WeMM-Embedding-9B 多模态),目录无 mmproj → 当前加载为纯文本;n_embd 4096。

## Goal
让用户今天就能通过独立 OpenAI 兼容嵌入端点(curl/Python/JS-TS/第三方工具)调用 WeMM-Embedding-9B,让应用内知识库用上该模型完成导入与检索;并把根因缺口修进 OmniStudio:嵌入类模型自动以嵌入模式服务、网关代理嵌入端点、分类/选择器陷阱消除、文档补全。

## Constraints
- Electrobun 架构(禁用 Electron API);遵守仓库 Hard Rules(`src/shared/*` 不得 import electrobun;路径校验;进程组 kill 等)
- llama-server 二进制不改;homebrew build 9410 已支持 `--embedding/--pooling`
- 弃用 `SERVER_EXTRA_ARGS` 路线(全局性 + 嵌入专用限制会破坏聊天服务)
- 17.9GB BF16 模型常驻内存为用户明确接受的成本(Apple Silicon)
- 现阶段纯文本嵌入(无 mmproj);多模态嵌入为未来非目标
- 独立服务器用固定端口 18400(避开 18080 推理段与 10000 网关段)
- ③ 只做 llama.cpp 引擎的嵌入模式;vLLM/SGLang/MLX 嵌入支持不在本期
- 提交前须过 `bun run lint && bun run typecheck && bun test` + `test:smoke`

## Non-Goals
- 不做 mmproj/多模态嵌入加载与质量调优
- 不改 SERVER_EXTRA_ARGS 语义、不做嵌入模型选型评测(用户已确认坚持 WeMM-9B)
- 不动网关鉴权体系(B 仅沿用现有可选 GATEWAY_API_KEY)
- 不重构现有 active-port 跟随机制(仅新增嵌入专属端口)
- 不做 Windows/Linux 侧验证(本机 macOS arm64)

## Acceptance Criteria
**①即时访问方案**
- [ ] ①-1 独立 llama-server 启动命令(`--embeddings --pooling <按模型定> --port 18400 --alias wemm-embedding-9b-bf16`)可直接复制执行;curl POST `/v1/embeddings` 返回 4096 维向量
- [ ] ①-2 Python(openai SDK,`base_url=http://127.0.0.1:18400/v1`)`embeddings.create` 可用
- [ ] ①-3 JS/TS(openai npm 包)同样可用
- [ ] ①-4 第三方工具按 OpenAI 兼容嵌入端点配置可用
- [ ] ①-5 常驻机制文档化(手动启动 + tmux/launchd 可选配方)

**②应用内 KB 接入**
- [ ] ②-1 KB 设置页 embeddingBase=`http://127.0.0.1:18400`、模型 `wemm-embedding-9b-bf16`,内置测试按钮通过(返回 4096 维)
- [ ] ②-2 文档导入不再 501,知识库检索返回相关结果
- [ ] ②-3 dim 4096 首次嵌入自动锁定;切换模型/base 触发重嵌为已知接受行为

**③产品修复**
- [ ] ③-A 类别为 embedding 的模型经应用启动时,llama.cpp 运行时自动附加 `--embeddings`(及正确 pooling);嵌入模型使用专属端口,不与聊天模型抢 18080;`SERVER_EXTRA_ARGS` 不再是唯一出口
- [ ] ③-B 网关新增 `/v1/embeddings` 路由代理到嵌入服务器,遵循网关可选 API key
- [ ] ③-C 分类修正:模型名含 embedding 关键词时不再被平台 `conversational` 标签压成 chat(或允许用户在模型详情改类别);KB 嵌入选择器不列出当前无法产出嵌入的模型
- [ ] ③-D architecture.md 服务表补嵌入端口;omi-cli.md 与应用内指引补嵌入访问配方
- [ ] ③-E 全部检查通过:`bun run lint && bun run typecheck && bun test && bun run --cwd apps/studio test:smoke`

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 「已启动嵌入模型」 | 501 实测 | 实为 completion 服务器;根因是运行时从不传 --embeddings |
| 可用 SERVER_EXTRA_ARGS 修复 | trace:全局性+嵌入专用限制 | 弃用(会废掉聊天服务);改独立服务器 + 产品修复 |
| 网关可代理嵌入 | 路由表静态+实测 | 无路由;列入修复 B |
| WeMM-9B 适合本场景 | 🃏 Contrarian(逆向挑战) | 用户确认坚持:多模态预留 + 接受 17.9GB 常驻 |
| 需要小模型替代 | 同上 | 否;不用 bge-m3/Qwen3-Embedding 替代 |

## Technical Context
- 运行时:`src/bun/runtimes/llama.ts`(buildArgs 205-251);引擎注册 `src/shared/engines.ts`(spec 40-76、extraArgsKey :46);服务器管理 `src/bun/model-servers.ts`(startServedModel :408、allocatePort :210-223、active 切换 :508)
- 网关:`src/bun/gateway.ts`(路由 2173-2196、authOk 126-134、startGateway 2262-2280)
- KB:`src/bun/knowledge.ts`(选择器 681-715、测试 :606-623、dim 锁定 kb-ingest.ts:362-366)、`src/bun/embeddings.ts`(callEmbeddings :33-66、base 解析 :17-23)
- 分类:`src/shared/modelscope.ts`(classifyModel :884-913、classifyModelName :367-390、filterModelIds :550-563);下载元数据 `.vllm-meta.json`(download-manager.ts:398 → model-store.ts:104-115)
- CLI:`apps/studio/bin/omi.ts`、`src/cli/commands/serve.ts`;文档 `docs/architecture.md`(:252-259 服务表)、`docs/omi-cli.md`
- 测试参照:`scripts/fake-embed-server.ts`(:18777 假嵌入服务器,smoke 测试用)

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| StandaloneEmbeddingServer | core domain | port 18400, --embeddings/--pooling, alias | serves WeMM-Embedding-Model; targeted by Client×4; backs KB embeddingBase |
| ManagedInferenceServer | core domain | 18080 首选(+1..+100), active-port 内存态 | spawned by OmniStudio-App; 类别盲(修复 A 对象) |
| Gateway | core domain | 10000→顺延, 可选 API key | 修复 B 补 /v1/embeddings 代理 |
| /v1/embeddings Endpoint | core domain | OpenAI 兼容, 4096 维 | exposed by StandaloneEmbeddingServer; 缺于 Gateway/ManagedServer |
| WeMM-Embedding-Model | core domain | 17.9GB BF16, qwen35, 无 mmproj, category=chat(误) | served by both server kinds |
| KB(知识库) | supporting | embeddingBase/model/dim(4096) | calls callEmbeddings → StandaloneServer |
| Client(curl/Python/JS-TS/第三方) | supporting | OpenAI 兼容配置 | → StandaloneEmbeddingServer |
| SERVER_EXTRA_ARGS | external system | 全局、嵌入专用陷阱 | 弃用路径 |
| ProductFix(A/B/C/D) | core domain | 验收 ③-A..E | modifies llama.ts/gateway.ts/modelscope.ts/docs |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 8 | 8 | - | - | N/A |
| 2 | 9 | 1(Standalone 拆出) | 1(EmbeddingServer→Managed) | 7 | 89% |
| 3 | 9 | 0 | 0 | 9 | 100% |
| 4 | 9 | 0 | 0 | 9 | 100% |
| 5 | 9 | 0 | 0 | 9 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds + Round 0)</summary>

### Round 0(拓扑门)
**Q:** 三个顶层组件(①即时访问/②KB 接入/③产品修复)是否正确、哪些在范围?
**A:** 全部三者在范围内。
### Round 1
**Q:** 从哪里访问嵌入模型?
**A:** curl 临时验证 + Python + JS/TS + 第三方工具(全选)。
**Ambiguity:** 47.5%(Goal 0.60/Constraints 0.40/Criteria 0.35/Context 0.85)
### Round 2
**Q:** 服务器策略?(含 SERVER_EXTRA_ARGS 全局陷阱说明)
**A:** 独立专用服务器(推荐项)。
**Ambiguity:** 38.5%
### Round 3
**Q:** ③产品修复包含哪些项?
**A:** A+B+C+D 全选。
**Ambiguity:** 27%
### Round 4(🃏 Contrarian)
**Q:** 逆向挑战:真的需要 9B WeMM 做嵌入吗,小模型是否更合适?
**A:** 坚持 WeMM-9B(多模态预留,接受 17.9GB 常驻)。
**Ambiguity:** 17.8%
### Round 5
**Q:** 三组件验收标准按拟定确认?
**A:** 确认全部验收标准。
**Ambiguity:** 8.7% ✅
</details>
