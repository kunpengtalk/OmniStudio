# Ralplan: 网关页嵌入地址 + 默认模型嵌入配置

Status: **APPROVED**(共识第 2 轮:Architect SOUND-WITH-CONDITIONS(阻断项经用户确认规格修订解除) + Critic APPROVED-WITH-IMPROVEMENTS(4 条收尾项已折入)→ 交接执行)
**规格修订记录(2026-09-14,用户确认)**:规格 AC ②-5/②-6 由「解析期共享 resolver + KB 闸门改走它」修订为**快照语义**——两轮 Architect 与 Critic 独立证明解析期层级会让既有 KB 的 `embeddingBase` 被静默改道(维度漂移只在检索时报错)。修订后:全局三键由 `globalEmbeddingDefaults()` 唯一读取(bun 侧),经写入时快照进入 KB 行;`resolveEmbeddingBase`/`resolveRerankBase` 保持原样。规格文件已同步更新。
Source spec: `.omc/specs/deep-dive-gateway-embedding-endpoint-and-default.md`(歧义 7.7%)
Trace: `.omc/specs/deep-dive-trace-gateway-embedding-endpoint-and-default.md`
基线:分支 `feat/embedding-serving`(上轮嵌入服务修复已提交 5 个原子提交,HEAD 4d94420)

## Requirements Summary

1. **①网关页嵌入地址**:端点区新增两行 —— 「网关代理」行(`{网关地址}/v1/embeddings`)与「直连嵌入实例」行(运行实例的实时 `http://127.0.0.1:{port}/v1/embeddings`);均可复制;无实例时直连行显示「未运行」+ 引导、复制禁用(不消失)
2. **②默认模型嵌入配置**:默认模型面板新增嵌入卡片(全局默认 = 模型 + 可选地址 + 可选密钥);**全局默认以「快照」语义落到各消费方**——新建 KB 与显式启用时把 model/base/key 写进 KB 行,记忆按显式 > 全局的规则读取;既有 KB 零行为变更

约束:零新 RPC(复用 `listServedModels`/`useServedStore`);不自动重嵌既有 KB;不引入 `EMBEDDING_PROVIDER_ID`/cloud_providers 行;中英双语;交付前 lint/typecheck/test 全绿。

## RALPLAN-DR Summary

### Principles
1. **默认的生效时机是「写入时」,不是「解析时」**(唯一例外:**共享记忆**——它是全局单例、没有「对象行」,故在解析时读取全局默认;哨兵可关):全局默认只在两个显式时刻进入数据——新建 KB、用户点「启用向量检索」;此后 KB 纯行驱动(`resolveEmbeddingBase` **不被改动**),既有 KB 的端点/维度绝不被静默改道
2. **全局键只有一个读取点(限 bun 侧)**:`globalEmbeddingDefaults()` 是 `EMBEDDING_MODEL/BASE/API_KEY` 的唯一 bun 侧读者;KB 预填、启用按钮、记忆配置全部经它取值——不再有「注册了没人读」的键。webview 侧卡片与按钮从 settings 直读(跨进程无法共享函数)
3. **一处数据通道复用**:直连地址取自已存在的 served 快照(`port`/`endpoint`/`purpose`),选择规则与主进程 `getActiveEmbeddingPort()` **同源**(最后一个 running 的嵌入实例),不新造订阅/RPC
4. **空态即引导**:不可用必须显式呈现并给下一步动作(直连行「未运行」、卡片空态、KB 选择器空态)
5. **可测的追溯边界**:既有 KB 不被静默切换、记忆的关键词兜底、②-4 真的触发重嵌——三者都要有**能失败的**断言锁住

### Decision Drivers(top 3)
1. **静默失效与静默改道是本特性的两类头号风险**:前者=注册了没人读的键(密钥)/设了没用的默认;后者=全局默认悄悄改掉既有 KB 的端点(维度漂移只在检索时报错)
2. **用户明确拒绝自动重嵌**:既有 KB 的切换必须显式,且点击后要真的重嵌(不是清空向量了事)
3. **成本极低的展示缺口**:直连地址数据与 webview 镜像都已存在,网关页缺的只是呈现

### Viable Options

**Option 1(选定,v2 重写):快照式全局默认 + 行驱动 KB + 记忆显式覆盖 + 网关页两行**
全局默认只在**写入时**落进 KB 行(建库预填、启用按钮);记忆在解析时读取(显式哨兵 > 显式值 > 全局默认);`resolveEmbeddingBase` 与 rerank 链路**完全不动**;网关页加静态代理行 + 动态直连行(兄弟组件,带 disabled)。
- Pros:不产生「默认 vs 追溯」的不对称(规避 base 半边的静默改道);不引入 scope 布尔 ⇒ 无「可选参数默认 falsy」的失效模式;`EMBEDDING_API_KEY` 有明确归宿(快照进 KB 行 / 记忆 cfg);改动面小于 v1
- Cons:全局默认对既有 KB 无追溯效果(需点按钮)——这是**有意为之**,须在卡片文案与文档讲清楚;建库路径有第二个调用方(导入路径)需一并核对

**Option 2(否决):无共享读取点,各消费方直读设置键**
- Invalidation rationale:API 密钥与地址会出现多个手写读取点(v1 的 Critic HIGH-1/arch2b HIGH 正是「注册了没人读」);无法用单测断言「所有消费方都拿到同一份默认」

**Option 3(否决):全局默认作为解析期层级(既有一并生效)**
- Invalidation rationale:用户在访谈 Round 3 明确要求既有 KB 显式启用;且 arch2-review/arch2b 独立证明该方案会让既有 KB 的 base 被静默改道(`knowledge.ts:698/743` 三处调用点),维度漂移只在检索时以「向量维度不一致」暴露(`embeddings.ts:70-72`)

**Option 4(否决):直连地址新增 RPC/独立订阅**
- Invalidation rationale:`listServedModels` 已带 `port/endpoint/purpose` 且 webview 已有推送镜像(`lib/rpc.ts:66-70`、`rpc/index.ts:4636-4644`),再造是重复实现

## Implementation Steps(路径基址:apps/studio/src)

### ① 网关页嵌入地址
1. `mainview/components/served-models-panel.tsx`:`useServedModelsSync` 改为 `export`(或迁到 `mainview/stores/served.ts`)供网关页复用(推送 + 4s 轮询兜底冷加载);给 `EndpointRow`(`mainview/app/gateway-screen.tsx:33-62`)增加 `disabled?: boolean`(禁用复制)
2. `mainview/app/gateway-screen.tsx`:在端点区新增**独立的「嵌入服务」子块**(不改既有 9 行数组的类型):
   - 静态行:文字用**字面量** `t("settings.gateway.endpoints.embeddings")`(不用动态 `t(e.labelKey)`,以便 i18n 键集测试覆盖),地址 `${url}/v1/embeddings`
   - 直连行:从 served 快照取 `purpose === "embedding" && status === "running"` 的**最后一个**(`.at(-1)`,与主进程 `getActiveEmbeddingPort()`=`model-servers.ts:88-95` 的「最后 running 胜」同源),显示 `http://127.0.0.1:{port}/v1/embeddings` —— **host 固定写 127.0.0.1**(不用 `instance.endpoint` 的 host:`SERVER_HOST` 可能是 `0.0.0.0`,复制出去连不上);无实例 → 「未运行」+ 引导(「在模型页以嵌入类别启动模型」)+ `disabled` 复制
   - 子块加分隔/说明,避免直连行被误读为「网关端点」(既有 9 行都以网关地址为前缀)
3. `shared/i18n.ts`:新增 zh/en 各 4 条(`settings.gateway.endpoints.embeddings`、直连行标签、未运行、引导)
4. 组件测试 `mainview/app/gateway-screen.test.tsx`(新建):①有 1 个嵌入实例 → 直连行显示该实例端口且可复制;②**2 个嵌入实例 → 显示最后一个**(用例须按 served 快照的**真实遍历序**构造数据并断言,否则 mock 顺序与真实顺序不一致时会假绿);③无实例 → 「未运行」+ 复制 disabled;④代理行恒在

### ② 默认模型嵌入配置(快照式)
5. `bun/db/settings.ts`:SettingsKey union + DEFAULTS 注册 `EMBEDDING_MODEL`("")、`EMBEDDING_BASE`("")、`EMBEDDING_API_KEY`("")
6. `bun/embeddings.ts`:新增 `globalEmbeddingDefaults(): { model: string; base: string; apiKey: string }` —— **全局三键的唯一读取点**(注释写明:只在写入时/记忆解析时被消费,不作为运行时层级插入 `resolveEmbeddingBase`)
7. **`resolveEmbeddingBase` 与 `resolveRerankBase` 不改**(`knowledge.ts:740-744` 保持委派现状)——既有 KB 端点零漂移,rerank 语义零变化
8. `bun/memory.ts:98-107` `memoryEmbeddingConfig()` 改为:
   - `MEMORY_EMBEDDING_MODEL` 为**禁用哨兵**(`none`/`off`,大小写不敏感)→ 返回 `null`(纯关键词,保留既有兜底)
   - 否则 `MEMORY_EMBEDDING_MODEL || globalEmbeddingDefaults().model`;base = `MEMORY_EMBEDDING_BASE || defaults.base`;apiKey = `MEMORY_EMBEDDING_API_KEY || defaults.apiKey`
   - **哨兵只作用于 model**(明确决策):`MEMORY_EMBEDDING_BASE` / `_API_KEY` 的哨兵不实现——它们的语义就是「显式值 || 全局」,字面值 `none` 会被当作普通地址(会显式报连接失败,不会静默);②-6 措辞按此写,并加测试锁定「`MEMORY_EMBEDDING_BASE` 为空 → 落到全局 base」
   - `embeddingHeaders` 无需改动(记忆 cfg 已带 key;KB 行走快照 key)
9. `bun/knowledge.ts` `createKb`(:239-261):建库时把 `globalEmbeddingDefaults()` 的 model/base/apiKey **快照进 KB 行**(非空字段才写)。**第二调用方(导入路径 `:1300`)的决策:同样快照**(两条建库路径行为一致,避免分叉);注意导入路径 `:1306-1319` 随后会覆盖 `embeddingModel`——按「显式导入参数优先,缺省时用快照」的顺序实现,并加注释
9b. **空 base 陷阱防护(第二轮 Architect Finding 3)**:卡片里模型候选若来自**运行中的嵌入实例**而全局 `EMBEDDING_BASE` 为空,保存时把该实例的 `http://127.0.0.1:{port}/v1` **预填进 `EMBEDDING_BASE`**——否则快照写进 KB 行的 base 为空,实例一停 `resolveEmbeddingBase` 就落回**聊天**活动端口(`knowledge.ts:694` 自注的「列得出调不通」陷阱),②-4 重嵌会以维度/连接错误失败且不易定位
9c. ②-4 触发前**校验存在可解析的嵌入后端**(webview 可判据,零新 RPC):**存在 running 的嵌入实例(served 快照)或 `EMBEDDING_BASE` 非空** —— 二者皆 webview 已有数据。注意 `resolveEmbeddingBase` 是 bun 侧且**永远有返回值**(兜底落到聊天活动端口),故「非空」不能作为判据;也不引入可达性探针 RPC。不满足则按钮禁用 + 提示(「先启动嵌入模型或填写服务地址」)
10. **②-4 启用按钮**:KB 设置页新增「启用向量检索」——条件:该 KB `embeddingModel` 为空**且** webview 从 settings 读到 `EMBEDDING_MODEL` 非空(webview 不能 import bun 模块,读设置而非调解析函数),且步骤 9c 的后端校验通过;动作 = 现有 KB 更新 RPC(`rpc/index.ts:4405-4416`)写入 model/base/apiKey **+** 调 `kbEmbedMissing`(`rpc/index.ts:4448-4449` → `embedMissing`)真的排入重嵌;按钮文案写明将重新嵌入全部文档(耗时/占用)。
    **rerank 连带影响(第二轮 Architect Finding 4)——决策:接受并断言**:`resolveRerankBase`(`knowledge.ts:741-744`)在 KB 未单独配 rerank base 时回落 `cfg.embeddingBase`,故 ②-4 写入 base 会同时改变该 KB 的 rerank base。这是**改进**(此前它落在聊天端口,那里既没有嵌入也没有 rerank 服务),但必须在测试里断言该连带效果,不允许"rerank 语义零变化"这类笼统说法覆盖被触碰的 KB
11. `mainview/app/main-layout/default-models-panel.tsx`:新增 `EmbeddingModelCard` —— 模型候选复用 `kbEmbeddingModels` RPC(`rpc/index.ts:2038-2041/:4458`,只列运行中嵌入实例提供的模型,并按来源标注本地/云端/宽松候选);可选「服务地址」「API Key」输入;写入 `EMBEDDING_MODEL/BASE/API_KEY`;无嵌入实例时给空态引导(与 KB 选择器同源文案)
12. `shared/i18n.ts`:卡片标题/描述/地址与密钥标签/按钮/确认文案/「记忆将开始向量检索(可用 `none` 关闭)」(zh+en)
13. 单测(阻断层,**每条断言都必须能失败**):
    - `globalEmbeddingDefaults()` 读取三键;`memoryEmbeddingConfig()`:隐藏时回落全局默认 → **非 null**;`MEMORY_EMBEDDING_MODEL=none` → **null**(纯关键词)
    - 设全局默认 + 写入一条记忆后断言 `embedded > 0` —— **必须先显式排空**:记忆向量化是后台定时任务(`memory.ts:922-926` 的 `embedMissingMemories`,写入后 1.5s 防抖、每轮上限 200),测试内需调用 `embedMissingMemories()`(或维护入口 `:1028`)排空后再断言,否则实现者会把它弱化回恒真的 `embeddingModel` 非空
    - **清空全局默认 → 记忆回到关键词**(对应规格 Non-Goal 的守门测试)
    - 新建 KB 预填 model/base/key 三字段;既有空配置 KB 在设了全局默认后**仍走 keyword**(防静默切换)
    - 既有「显式 model + 空 base」的 KB:设全局 `EMBEDDING_BASE` 后**解析出的 base 与今日一致**(防回归;因 `resolveEmbeddingBase` 未改,此测试同时锁住 rerank 语义)
    - ②-4 按钮:写入 KB 行 **且 `embedMissing` 被调用**;`awaitKbIdle` 后 `vectorCount > 0`
14. 逐条核对规格 Non-Goals(spec:53-59)未被触碰:特别确认「不改记忆未配置嵌入时的关键词兜底」在**全局默认也为空**时成立(哨兵保证可显式关闭)——写进验证步骤 2

### 验证
15. `bun run lint && bun run typecheck && bun test`(根)+ i18n 键集测试;附**命令原文与输出摘要**(不写回 checklist 空格,单独段落)
16. 逐条核对 Non-Goals(见步骤 14);`git diff --stat` 核对账目:①=served-models-panel(export)/gateway-screen/i18n/+1 测试;②=settings/embeddings/memory/createKb/kb-settings-tab/default-models-panel/rpc(仅新增调用)/i18n/+测试

## Acceptance Criteria(全部可测;✅=阻断层自动化)
- [ ] ①-1 网关页出现「网关代理」嵌入行,地址为 `{网关地址}/v1/embeddings`,可复制(✅组件测试)
- [ ] ①-2 同页出现「直连嵌入实例」行,地址为**运行中最后一个**嵌入实例的 `http://127.0.0.1:{port}/v1/embeddings`(host 固定 127.0.0.1,端口来自 served 快照;✅组件测试含「2 个实例取后者」用例)
- [ ] ①-3 无嵌入实例:直连行显示「未运行」+ 引导、复制 disabled、代理行不受影响(✅组件测试)
- [ ] ②-1 面板出现嵌入卡片(模型 + 可选地址/密钥)且写入三键(✅组件测试断言渲染与写入);视觉一致性人工核对
- [ ] ②-2 设全局默认后**新写入**的记忆走向量(✅单测断言 `embedded > 0`);卡片文案说明既有记忆将在后续写入/维护时补向量
- [ ] ②-3 新建 KB 预填 model/base/key(✅单测;并断言有效 base 解析到全局地址)
- [ ] ②-4 既有空配置 KB 保持纯关键词;「启用向量检索」写入行 **并按入重嵌**(✅单测断言 `embedMissing` 被调用 + `awaitKbIdle` 后 `vectorCount > 0`)
- [ ] ②-5 **bun 侧**全局三键的唯一读取点是 `globalEmbeddingDefaults()`(✅单测:KB 预填、启用按钮、记忆三处取值一致);webview 侧卡片与按钮从 settings 直读 `EMBEDDING_MODEL`(跨进程无法共享函数,已在计划中写明);显式断言**网关无需改动**——`gateway.ts:1348-1349` 转发客户端自带 model,已核验
- [ ] ②-6 记忆优先级:哨兵 `none` > 显式值 > 全局默认;base/key 同规则(✅单测,含清空全局后回到关键词)
- [ ] ②-7(新增,守规格 Non-Goal)清空全局默认后,未显式配置的记忆恢复纯关键词(✅单测)
- [ ] ②-8(防静默改道)既有 KB(显式 model + 空 base)在设全局 `EMBEDDING_BASE` 后,解析 base 与今日逐字节一致;未被触碰的 KB 其 rerank 链路不变(✅单测——因 `resolveEmbeddingBase` 未改,此测试同时是 rerank 语义的守门测试)
- [ ] ②-9(新增,空 base 陷阱)卡片从运行实例选模型且全局 base 为空时,**保存后 `EMBEDDING_BASE` 已预填该实例地址**(✅单测:快照不落空 base)
- [ ] ②-10(新增,rerank 连带)对**被 ②-4 触碰**的 KB,断言其 rerank base 随之落到该 KB 的 embedding base(✅单测,明确接受并锁定该改进)
- [ ] ②-11(新增,后端可解析性)无可用嵌入后端时「启用向量检索」按钮禁用 + 提示(✅组件/单测)
- [ ] ③-E lint + typecheck + 全量测试 + i18n 键集测试全绿(附命令原文)

## Risks and Mitigations
| 风险 | 缓解(可检验) |
|---|---|
| 全局密钥注册了没人读 | 唯一读取点 `globalEmbeddingDefaults()`;KB 行快照 key、记忆 cfg 带 key;②-5 单测断言三处一致 |
| 既有 KB 端点被静默改道 | `resolveEmbeddingBase`/rerank 链**不改**;②-8 防回归单测逐字节锁定 |
| 记忆被静默启用且无法关闭 | 哨兵 `none`/`off` 显式关闭 + ②-7 守门测试;卡片文案写明 |
| ②-4 只清空不重嵌(验收恒真) | 按钮 = 写入 + `kbEmbedMissing`;断言 `embedMissing` 被调用且 `vectorCount > 0`,而非断言 `embeddingsReset`(后者是既有返回值,恒真) |
| 多嵌入实例时显示错端口 | `.at(-1)` 与主进程 `getActiveEmbeddingPort()` 同源;①-2 双实例用例 |
| 网关页冷加载时快照为空 | 复用 `useServedModelsSync`(推送+轮询);①-3 空态用例 |
| i18n 动态 key 逃过键集测试 | 新增两行用**字面量** `t()`;键集测试实际覆盖 |
| 全局默认对既有 KB 无追溯,用户以为已生效 | 卡片描述 + KB 设置页按钮文案讲清「新建生效 / 既有需点按钮」;②-4 测试锁行为 |
| 建库预填遗漏 base/key | 步骤 9 明确写三字段;②-3 断言有效 base 解析到全局地址 |
| 未知状态字面量 | 实现前先读 `shared/served-models.ts` 的 `ServedModelStatus` 成员,按实际枚举写判据 |
| 快照落空 base → 实例停后落到聊天端口(「列得出调不通」) | 步骤 9b 从实例选模型时预填 `EMBEDDING_BASE`;②-9 单测锁快照不含空 base;②-11 后端不可解析时禁用按钮 |
| ②-4 写 base 连带改变该 KB 的 rerank base | 已决策为接受(此前 rerank 落在聊天端口更糟);②-10 单测显式断言该效果,不再宣称「rerank 零变化」 |
| ①-2 host 来自 `SERVER_HOST`(可能是 0.0.0.0)复制不可连 | 直连行 host 固定 127.0.0.1;组件测试断言字符串 |

## Verification Steps
1. 逐条跑 ①-1..③-E,证据(命令原文 + 输出摘要)单独成段附在计划末尾
2. **逐条核对规格 Non-Goals(6 条)未被触碰**:尤其「不改记忆未配置时退化为关键词的兜底」——全局默认也为空/显式哨兵时该兜底成立(②-7 测试为证)
3. `git diff --stat` 核对账目无计划外文件;确认未改 `resolveEmbeddingBase`/`gateway.ts`
4. 提交前跑完整检查套件;在本分支既有 5 个提交之上追加原子提交(按 ①/② 拆两个)

## ADR(共识第 2 轮通过;Architect SOUND-WITH-CONDITIONS→阻断项经用户规格确认解除;Critic APPROVED-WITH-IMPROVEMENTS,4 条收尾项已折入)

- **Decision**:全局默认嵌入配置采用**快照语义**——`globalEmbeddingDefaults()`(bun 侧唯一读取点)只在**写入时**把 model/base/apiKey 落进 KB 行(建库预填、用户点「启用向量检索」按入重嵌);共享记忆在解析时读取(禁用哨兵 `none`/`off` > 显式值 > 全局默认,哨兵只作用于 model);`resolveEmbeddingBase` 与 rerank 链**完全不改**。① 网关页在既有端点区新增独立「嵌入服务」子块:静态代理行 + 动态直连行(`.at(-1)` 与主进程 `getActiveEmbeddingPort()` 同源,host 固定 127.0.0.1,无实例显示「未运行」)。
- **Drivers**:静默失效(注册了没人读的键 / 设了没用的默认)与静默改道(全局默认悄悄改掉既有 KB 端点,维度漂移只在检索时报错)是本特性两类头号风险;用户明确拒绝自动重嵌;直连地址数据已存在、只差呈现。
- **Alternatives considered**:①解析期共享 `resolveEmbeddingModel()` + scope 布尔(规格原案)——被两轮 Architect 与 Critic 独立否决:base 半边无守卫会静默改道既有 KB(`knowledge.ts:698/743`),且可选布尔默认 falsy 本身就是新的静默失效模式;②无共享读取点、各消费方直读设置键——密钥/地址会出现多个手写读取点;③直连地址新增 RPC——`listServedModels` 已带 port/endpoint/purpose 且 webview 已有推送镜像。
- **Why chosen**:快照语义让默认的生效时机显式(写入时),既不产生追溯副作用,也不需要调用点布尔;全局键仍有唯一读取点;既有 KB 端点零漂移可被测试逐字节锁定。用户在第二轮明确确认了这项规格修订(原 AC ②-5/②-6 已按修订同步)。
- **Consequences**:全局默认对既有 KB 无追溯效果(需点按钮)——卡片与按钮文案必须讲清;`resolveEmbeddingBase` 不动意味着 KB 的 base 仍走既有四层链(实例 > remote > active-port),故从实例选模型时必须把实例地址快照进 base(步骤 9b/②-9),否则实例停止后会落回聊天端口;②-4 写 base 会连带改变该 KB 的 rerank base(已决策接受并断言,②-10)。
- **Follow-ups**:`EMBEDDING_PORT`/`EMBEDDING_POOLING` 仍无 UI(本轮不做);云厂商嵌入(无 cloud_providers 行,Non-Goal);记忆禁用哨兵的 UI 化(目前仅设置键/CLI)。

## Changelog
- v3(2026-09-14):吸收第二轮 Architect(5 条)与 Critic(4 条必改 + 4 条建议)——规格正文(Goal/Constraints/Assumptions/Ontology)与 AC 同步为快照语义;哨兵明确只作用于 model(base/key 为「显式 || 全局」);②-2 断言前置显式排空(`embedMissingMemories`);②-11 判据改为 webview 可读的「有 running 嵌入实例 或 EMBEDDING_BASE 非空」;①-2 host 固定 127.0.0.1 且用例按真实遍历序构造;createKb 第二调用方(导入路径)决策为同样快照;新增 ②-9/②-10/②-11;补 ADR
- v2(2026-09-14):改为快照语义(消除 base 半边静默改道、去掉 scope 布尔);`globalEmbeddingDefaults()` 唯一读取点;记忆哨兵;②-4 真重嵌;新增 ②-7/②-8
- v1(2026-09-14):Planner 初稿(解析期共享 resolver + scope 布尔)
