# Ralplan: OmniStudio 嵌入模型服务修复(③ A/B/C/D)

Status: **APPROVED**(共识第 2 轮:Architect SOUND 9/9 条件 PASS;Critic APPROVED,2H/6M 全关闭)→ 交接 Autopilot 执行(Phase 2 起)
Source spec: `.omc/specs/deep-dive-access-embedding-model.md`(歧义 8.7%,已确认)
Trace: `.omc/specs/deep-dive-trace-access-embedding-model.md`

## Requirements Summary

让「嵌入类模型」在 OmniStudio 中被正确服务,消除三层缺口:

1. **A 运行时**:embedding 类别模型经应用启动时自动附加 `--embeddings --pooling <P>`,使用专属端口段(基址 **18190**),**绝不触碰聊天活动状态**;`SERVER_EXTRA_ARGS` 不再是唯一出口
2. **B 网关**:gateway 新增 `POST /v1/embeddings`,后端=运行中的嵌入实例(进程内状态解析),沿用现有 authOk/Origin/Host 防线;endpoints 列表与 openApiSpec 同步
3. **C 分类/选择器**:修复「弱 chat 平台标签压过嵌入模型名」的分类陷阱(插桩点:image 与 chat 检查之间);模型详情可改类别;KB 嵌入选择器只列真正可服务的模型
4. **D 文档**:architecture.md 服务表+嵌入访问小节;**omi-cli.md 嵌入配方(经 cli-docs.ts 数据源落地,无条件)**;KB 设置页内联指引;存量模型 E2E 旅程说明

约束:Electrobun 架构、遵守仓库 Hard Rules(engines.ts + 单 Runtime 模型、shared 不 import electrobun、路径校验)、不改 llama-server 二进制、不动 vLLM/SGLang/MLX 引擎嵌入支持、不动网关鉴权体系、macOS arm64 验证。

## RALPLAN-DR Summary

### Principles
1. **类别信息经 RuntimeOverrides 流向运行时,而非运行时感知类别**:purpose 放进 types.ts:17-24 的 overrides(唯一消费者 llama.ts)——保持「加引擎 = engines.ts + 一个 Runtime」边界,且 buildCommandLine(:167-185)预览与真实命令一致
2. **发现机制以进程内注册表为准,端口段是文档化偏好而非契约**:嵌入基址 18190(+100 顺延),完全避让聊天扫描区 18080..18179;文档如实说明 +100 顺延语义
3. **嵌入与聊天的活动状态彻底隔离**:嵌入实例不进 setActiveServedId/不参与聊天 auto-promotion/不写 chat 设置——聊天行为在嵌入启动/停止的任何组合下与今日完全一致
4. **修根因不修表象**:501 根因在启动参数;分类陷阱根因在 tags-first 优先级
5. **每条修复可独立验收,验收分层**:阻断层=单测/组件测(必失败可证);真模型层=可选手动(17.9GB 加载成本,不阻塞)

### Decision Drivers(top 3)
1. **实测阻塞**:KB 导入对嵌入模型 501——用户工作流被完全阻断(501 响应体明示缺 `--embeddings`)
2. **陷阱性质**:KB 选择器主动列出不可用模型(knowledge.ts:681-715),用户无法自行避坑——A 与 C 必须一起修
3. **外部生态契约**:四种客户端统一说 OpenAI 方言;网关是带鉴权与稳定路径的入口——B 决定第三方工具能否零配置接入

### Viable Options

**Option 1(选定,v2 收紧版):purpose 走 RuntimeOverrides + 活动状态按 purpose 隔离 + 嵌入端口段 18190 + 网关新增嵌入路由(后端仅进程内实例)**
- v2 修订:①purpose 注入点从「buildArgs 参数」改为 **RuntimeOverrides**(types.ts:17-24)+ createRuntime(model-servers.ts:462-466);②嵌入实例跳过 model-servers.ts:508 makeActive 默认与 setActiveServedId(:307-338),getRequestTargetServedModel(:291-301)排除 purpose=embedding;③端口基址 18090→**18190**(避让聊天扫描区);④网关嵌入后端**只解析运行中嵌入实例,不引入 EMBEDDING_API_BASE 第三旋钮**(消 SSRF 矛盾与旋钮面)
- Pros:类型涟漪最小(一个 overrides 类型 + llama.ts 单消费者);聊天零扰动;网关零新增信任面;buildCommandLine 复制预览真实
- Cons:ServedModelInfo 需加 purpose 字段(shared/served-models.ts);设置键需注册 SettingsKey union(db/settings.ts:9,:193);getRequestTargetServedModel/setActiveServedId 需 purpose 分流(活动状态机制改动最深处)

**Option 2(否决):SERVER_EXTRA_ARGS 文档化 + 网关-only**
- Invalidation rationale:trace 实证 `--embeddings` 使 llama-server 仅嵌入,全局设置废掉 llama.cpp 聊天服务;且该设置无 GUI/omi 入口(L2 grep 零命中)——不满足 ③-A

**Option 3(否决):独立 EmbeddingRuntime**
- Invalidation rationale:违反「引擎 = engines.ts 一条 + 一个 Runtime」模型(AGENTS.md:95 附近);嵌入不是新引擎而是同一二进制的另一用途;复制 spawn/detach/进程组 kill/日志全套,维护面翻倍

**Option 2'(评审中提出的备选,否决):UI 显式「以嵌入模式启动」launch-as 开关,不动分类**
- Invalidation rationale:可作为 C.8 类别改键之外的补充交互,但单独使用时用户仍需知道「这个模型该用嵌入模式」——分类自动修复(弱标签不压名)+ 显式改键两层都保留;launch-as 仅作 UI 快捷方式不计入本期范围(ADR Follow-up)

## Implementation Steps(路径基址:apps/studio/)

### A 运行时自动嵌入模式 + 活动状态隔离
1. `src/bun/runtimes/types.ts`:RuntimeOverrides(:17-24)增加 `purpose?: "chat" | "embedding"`;四个 runtime 构造器的 overrides 类型随之兼容(仅 llama.ts 消费)
2. `src/bun/runtimes/llama.ts`:overrides.purpose === "embedding" 时 buildArgs 追加 `--embeddings --pooling ${EMBEDDING_POOLING(default "last")}`;同时**裁剪聊天采样参数**(--temp/--top-p/--repeat-penalty/--repeat-last-n/--image-max-tokens 不发;保留 --ctx-size/--batch-size/--ubatch-size/--cache-type-k/v);buildCommandLine(:167-185)走同一 overrides 路径,预览自带 --embeddings
3. `src/bun/db/settings.ts`:SettingsKey union(:9)注册 `EMBEDDING_PORT`(default "18190")、`EMBEDDING_POOLING`(default "last",set 时校验枚举 last|mean|none|cls,非法即拒)并入 DEFAULTS(:193)
4. `src/shared/engines.ts`:新增嵌入端口段查询(独立于 ENGINE_PORT_KEYS 聊天键);llama spec 附 embedding 支持
5. `src/shared/served-models.ts`:ServedModelInfo 增加 `purpose` 字段
6. `src/bun/model-servers.ts`:
   - startServedModel(:408):读 model-store meta category;embedding → createRuntime 传 purpose=embedding、allocatePort 用 18190 段、**跳过 :508 makeActive 默认**(embedding 永不 setActiveServedId)
   - setActiveServedId(:307-338)与 getRequestTargetServedModel(:291-301):purpose=embedding 实例不参与聊天 auto-promotion
   - 新增嵌入侧活动注册:`getActiveEmbeddingPort()`(内存,镜像 settings.ts:471-479 activePortOverride 形态;**多实例规则:最近启动胜**,与聊天 active 语义同型);syncActivePort(:78-81)按 purpose 分流,聊天 override 语义不变
   - usesDefaultPort(:455)对 purpose=embedding 与 EMBEDDING_PORT 比较(修徽标误报)
   - 导出 `resolveEmbeddingBackend()`:返回运行中嵌入实例的 `http://127.0.0.1:{port}` 或 null(供网关与 KB 消费,单点可 mock)
7. `src/bun/embeddings.ts` resolveEmbeddingBase(:17-23)回退链钉死为:**显式 base > 运行中嵌入实例 > SERVER_MODE=remote 的 VLLM_API_BASE > active-port(原行为兜底)**。层级决策记录:运行实例提到 remote 之上,因 remote 模式下 KB 嵌入今天指向云端 chat provider 本就是坏的,而用户显式启动本地嵌入实例是最强意图信号
8. 单测(阻断层):llama buildArgs 快照(embedding/chat 两态,断言 --embeddings/--pooling 存在、--temp 缺席、端口来自 18190 段);resolveEmbeddingBase 四层链(含 remote+实例并存、无实例回落 active-port 两用例);model-servers 活动状态隔离(嵌入启动不改 SERVED_ACTIVE_ID/CHAT_MODEL/LOCAL_MODEL_PATH/getActiveServerPort;聊天停止不 auto-promote 嵌入实例;多嵌入实例最近启动胜)——mock 骨架沿用 model-servers.test.ts:1-135

### C 分类器/选择器修正(与 A 同批)
9. `src/shared/modelscope.ts` classifyModel(:884-913):**插桩点= image 检查(:902)与 chat 检查(:903)之间**——`classifyModelName` 判定 embedding 时压制其后的弱 chat 标签组(conversational/text-generation/image-text-to-text/chat);rerank/tts/asr/video/image 强标签仍在其前不受影响
10. 模型详情改类别:RPC(rpc/index.ts 模型 RPC 区)→ model-store setModelMeta(:104-115,category patch 已支持);UI 下拉(model-detail.tsx :267-271 下载区块旁);**范围限定:repo 下载模型**(直连单文件模型无 repo 目录,setModelMeta 静默无效——文档注明)
11. `src/bun/knowledge.ts` suggestEmbeddingModels(:681-715):本地候选改为查询 resolveEmbeddingBackend() 指向实例的 /v1/models;无嵌入实例时本地组为空 + 引导文案(「先在模型页以嵌入模式启动嵌入模型」)
12. 单测:classifyModel 新用例(①WeMM 名 + conversational → embedding;②名含 Embedding + text-to-image 标签 → **image**,锁插桩点位置);suggestEmbeddingModels 空态;类别改键 meta 往返(repo 模型夹具)

### B 网关嵌入路由
13. `src/bun/gateway.ts`:路由表(:2173-2196)新增 `POST /v1/embeddings`;后端= resolveEmbeddingBackend()(从 model-servers 导入,可 mock),null 时 **503** 结构化错误体(含可操作引导:「在模型页以嵌入模式启动嵌入模型后重试」);鉴权/Origin/Host 沿用现有链(authOk :126-134、:142-158);**endpoints 数组(:2173-2182)与 openApiSpec()(:1724+)同步登记**(守 gateway.test.ts:312 的 spec 完整性断言)
14. 测试:沿用 gateway.test.ts 的 inline Bun.serve 上游 mock 模式(:230-253 先例)+ mock resolveEmbeddingBackend;断言三态:透传(含 4096 维数组)/ 设 GATEWAY_API_KEY 后无 key 401 / 无实例 503;附 `GET /openapi.json` 含 /v1/embeddings 与 endpoints 列表含之
15. (fake-embed-server.ts 的 **18777 是端口**、路径 apps/studio/scripts/,仅当需要进程级夹具时使用;B 单测优先 inline mock)

### D 文档与引导
16. `docs/architecture.md`:服务表(:252-259)加嵌入端口行(18190 基址,**如实注明 +100 顺延与段位偏好语义**);新增「嵌入访问」小节:curl/OpenAI SDK 示例、网关 /v1/embeddings、KB embeddingBase 关系、llama-server 忽略 /v1/embeddings 的 model 字段与 VLLM_API_KEY 头两个事实
17. **omi-cli.md 无条件落地**:`src/shared/cli-docs.ts` 网关小节增加「嵌入服务 /v1/embeddings」条目(数据源驱动,含示例),跑 `bun run --cwd apps/studio scripts/omi-docs-smoke.ts --write` 再校验(③-D2 无条件)
18. KB 设置页(settings-tab.tsx :39-54)嵌入选择器旁引导文案;**存量模型 E2E 旅程写进文档**:已下载为 chat 的嵌入模型(如 WeMM)→ 模型详情改类别为 embedding → 重启模型 → KB 可用(meta 持久化且优先于文件名回退,model-store.ts:56-58,不会自愈)

### 验证(③-E)
19. `bun run lint && bun run typecheck && bun test`(根)+ `bun run --cwd apps/studio test:smoke`
20. 真模型验收(可选层,不阻塞):ps 验证 --embeddings/--pooling 落在 18190 段实例;curl 网关与直连各一次

## Acceptance Criteria(自规格 ③,全部可测;阻断层=单测,可选层=真模型;✅=已验证,证据见括号)
- [x] ③-A1(a 阻断层):buildArgs/buildCommandLine 单测断言 --embeddings --pooling last、18190 段、--temp 等五参数缺席、chat 逐字节不变(llama.test.ts 6→8 用例;全量 678/0)
- [ ] ③-A1(b 可选层):真模型 ps 验证——未执行(计划允许;17.9GB 加载成本)
- [x] ③-A2:chat 命令行快照逐字节断言(llama.test.ts)
- [x] ③-A3:四层链 4 用例含 remote+实例并存、无实例回落(model-servers.embedding.test.ts:287-313)
- [x] ③-A4:活动状态隔离 7 用例(SERVED_ACTIVE_ID/CHAT_MODEL/LOCAL_MODEL_PATH/端口覆盖全不变;停 chat 不 promote;多实例;幂等重启)
- [x] ③-B1:网关三态 401/503 引导体/透传 + openapi.json 与 endpoints 登记(gateway.test.ts 39 用例)
- [x] ③-C1:classifyModel 4 用例(弱标签压制 + text-to-image 强标签锁位 + 2 条不回归)
- [x] ③-C2(repo 模型):类别改键 6 用例(meta 落盘回读/external 拒绝/非法类别不写脏)
- [x] ③-C3:选择器两态 4 用例 + i18n 双语 hint
- [x] ③-D1:architecture.md 服务表嵌入行 + 嵌入访问小节(omi-docs-smoke 15 项 ✓)
- [x] ③-D2:cli-docs.ts → omi-cli.md 同步校验通过
- [x] ③-E(阻断层):lint 0 errors(85 warnings 全在既有构造)/ typecheck 2/2 / bun test 678 pass 0 fail(69 文件)
- ⚠ ③-E(test:smoke):agent-capabilities-smoke 2 项失败——**先于本改动存在**(干净 HEAD worktree 同环境复现同样失败;由用户 llama-server 占 18080 使「无推理服务」场景无法构造,ensureServerReady 设计上复用端口上的外部服务)。停掉外部 llama-server 后重跑即绿;与本改动无关(diff 未触及 automation 链路),记为 follow-up。

## 验证评审补充(Autopilot Phase 4,2026-09-14)
三方全 APPROVED(架构=功能完整逐条核对/安全=零新增信任面+SSRF 无面/质量=测试真锁行为)。评审后追加修复:
- MED(质量):startServedModel 增加引擎能力守卫——embedding 类别 + 非 llama.cpp 引擎(如 safetensors→vLLM)拒绝启动并报可读错误,防「列得出调不通」陷阱在别家引擎复刻(model-servers.ts:476-483 + 2 用例)
- LOW:删除死导出 EMBEDDING_PORT_KEY/EMBEDDING_PORT_RANGE;syncActivePort 注释如实化为「插入序最后 running 胜(重启不重排)」;INFO(pooling 读侧复验、.omc/.gitignore、model-detail useMemo 警告)记 follow-up

## Risks and Mitigations
| 风险 | 缓解(可检验) |
|---|---|
| purpose 进 overrides 影响 4 个 runtime 构造器 | 字段可选,vLLM/SGLang/MLX 仅类型兼容零逻辑;typecheck 全量兜底 |
| 活动状态隔离改错导致 chat 回归 | ③-A4 专项单测锁「嵌入启动/聊天停止」两组合;既有 model-servers 测试套零改动通过 |
| 18190 段与第三方服务冲突 | 沿用 +100 顺延与 reservedPorts;EMBEDDING_PORT 可设;文档注明段位偏好语义 |
| remote 用户被实例改道 | 层级决策显式化(实例>remote)+ ③-A3 双向用例钉死;文档说明 |
| --pooling 不适配特定模型家族 | EMBEDDING_POOLING 设置 + set 时枚举校验;文档给出 last/mean 选择指引 |
| 网关新增路由信任面 | 后端仅进程内实例(无 EMBEDDING_API_BASE、无用户可控 host);SSRF 面为零(消解 R6 矛盾) |
| 分类规则误伤 instruct+embed 双用模型 | 名字规则只压制弱 chat 标签组;强标签(image/video 等)仍胜;C.10 手改兜底;③-C1 强标签用例锁位 |
| 存量 chat 类别 meta 不自愈 | 文档 E2E 旅程(改类别→重启);不做自动迁移(误分类波风险),ADR 记 Follow-up |
| 17.9GB 真模型验收耗时 | 阻断层全部单测化(③-A1a);真模型仅可选层 |

## Verification Steps
1. 逐条跑 ③-A1..E,证据(命令+输出)记入本文件 checklist
2. `git diff --stat` 核对账目:A=types/llama/settings/engines/served-models/model-servers/embeddings(+3 测试文件);C=modelscope/model-store(不改)/rpc/model-detail/knowledge(+2 测试);B=gateway(+1 测试);D=architecture.md/cli-docs/settings-tab(文档性)
3. 提交前完整检查套件(③-E)

## ADR(已确认:共识第 2 轮双方通过)
- **Decision**:Option 1 v2——purpose 经 RuntimeOverrides 注入 llama.cpp 运行时;嵌入活动状态与聊天彻底隔离;嵌入端口基址 18190;网关 /v1/embeddings 仅代理进程内嵌入实例
- **Drivers**:实测 501 阻塞 / KB 选择器陷阱 / OpenAI 方言生态契约(见上)
- **Alternatives considered**:Option 2(SERVER_EXTRA_ARGS,实证废聊天)、Option 3(独立 Runtime,违引擎边界)、Option 2'(纯 launch-as UI,不消除分类陷阱且本期验收不依赖)、网关 EMBEDDING_API_BASE 第三旋钮(被否:SSRF 面+互洽负担,remote 场景走 KB 显式 base 即可)
- **Why chosen**:类型涟漪最小、聊天零扰动、零新增信任面;评审双方独立命中的 HIGH 全部以此消解
- **Consequences**:ServedModelInfo/SettingsKey 有小扩展;存量 chat 类别嵌入模型需一次手改类别(文档化);vLLM/SGLang/MLX 嵌入支持留待后续
- **Follow-ups**:launch-as UI 快捷方式;存量 meta 一次性重分类迁移评估;vLLM safetensors 嵌入模型支持;EMBEDDING_API_BASE(若未来确需远端嵌入代理)

## Changelog
- v2.1(2026-09-14):Architect 复审 LOW 注记吸收(--image-max-tokens 入 A.2 裁剪清单);共识达成,Status→APPROVED,ADR 确认
- v2(2026-09-14):吸收 Architect 9 条件与 Critic 2H/6M/5L——purpose 注入点改 RuntimeOverrides(消 buildArgs 接口误述);新增活动状态隔离与 ③-A4;端口 18090→18190 避让聊天扫描区;③-A1 拆阻断/可选两层;classifyModel 插桩点钉死于 image:chat 之间+强标签用例;网关后端砍 EMBEDDING_API_BASE 改纯进程内实例(消 SSRF 矛盾);endpoints/openApiSpec 同步入 ③-B1;omi-cli.md 无条件经 cli-docs.ts 落地;resolveEmbeddingBase 四层链含 remote 双向用例;多实例最近启动胜规则;路径全部改 apps/studio/src 前缀;18777 更正为端口;C2 限定 repo 模型;存量模型 E2E 旅程文档化
- v1(2026-09-14):Planner 初稿
