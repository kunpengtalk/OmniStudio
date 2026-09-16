# Deep Interview Spec: 知识库新建弹窗自动预填默认嵌入模型

## Metadata
- Interview ID: kb-create-prefill-20260914
- Rounds: 3(含 Round 0 拓扑门)
- Final Ambiguity Score: 7%
- Type: brownfield
- Generated: 2026-09-14
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.95 | 0.35 | 0.333 |
| Constraint Clarity | 0.90 | 0.25 | 0.225 |
| Success Criteria | 0.95 | 0.25 | 0.238 |
| Context Clarity | 0.90 | 0.15 | 0.135 |
| **Total Clarity** | | | **0.930** |
| **Ambiguity** | | | **7%** |

## Topology

| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| kb-create-dialog-prefill | active | 新建 KB 弹窗打开时,满足「全局默认已配置且探活通过」即自动填入默认嵌入模型 | 验收标准 ①-④ 全覆盖 |
| rerank-prefill | deferred | 新建弹窗的重排模型预填 | 用户确认延后(2026-09-14):重排没有全局默认配置(无 RERANK_MODEL 等键),属独立范围,未来有需要再做对称功能 |

## Goal

配置了全局默认向量模型(设置 → 默认模型 → 向量嵌入卡片,`EMBEDDING_MODEL` 等三键)且该模型**真实可访问**时,新建知识库弹窗打开后**自动把默认嵌入模型填进向量模型下拉**——把「后端已静默快照」变成「用户看得见」。弹窗不等待探活(秒开),探活异步返回后再填入;用户可随意改掉预填值,提交建库的结果与今天留空提交**完全一致**(快照中立)。

## Constraints

- **可访问 = 真实探活**:后端对解析出的嵌入地址(全局 `EMBEDDING_BASE`,缺失时走既有解析链落到运行中嵌入实例)发一次极小嵌入请求(复用 `kbTestEmbedding` 同款链路),探活通过才预填——预填了就一定能用,杜绝「填了但建库后嵌入失败」
- **异步时序**:弹窗立即打开,不等待探活;探活返回(几百 ms 内,本地实例)后填入。下拉短暂空白属正常,不加 loading 态转圈
- **用户优先**:探活返回前用户若已手动选了模型,探活结果**不覆盖**用户选择
- **探活失败(已配置但不可达)**:下拉留空(与今天一致),下方 hint 追加一句说明「已配置默认嵌入模型 X,但当前不可达」——用户知道为什么没填、去哪里修
- **未配置全局默认**:与今天行为**逐字节一致**,无新文案
- **候选外值照常显示**:预填的默认模型若不在候选列表(如自定义远程 base),`KbModelSelect` 既有的「当前值不在候选里也单独列出」行为照常工作(已验证 `model-select.tsx` `hasCandidate` 支持)
- **快照中立(硬约束)**:`createKb`(`knowledge.ts:257-262`)无条件快照 `defaults.base/apiKey`,预填只是把 `embeddingModel` 从「隐式留空」变成「显式传入同名值」,写库结果不得有任何分叉
- 弹窗每次打开都重新探活(不缓存上次结果——实例启停是常态)

## Non-Goals

- 重排模型的预填(拓扑已延后,需先新增全局重排默认配置)
- 不改 `createKb` 的快照语义、不改 `resolveEmbeddingBase` 四层链、不改 `globalEmbeddingDefaults` 读取点
- 不为探活结果做缓存/TTL 机制
- 不改既有 KB 设置页的「启用向量检索」按钮行为

## Acceptance Criteria

- [ ] ① 配好全局默认 + 探活通过:打开新建弹窗 → 向量模型下拉**自动选中**默认模型(不在候选列表也显示);用户可改;提交后建库结果(三字段、后续嵌入可用性)与今天留空提交**完全一致**
- [ ] ② 配好全局默认 + 探活失败:打开弹窗 → 下拉留空 + hint 显示「已配置默认嵌入模型 <模型名>,但当前不可达」类说明(zh/en 双语新 key)
- [ ] ③ 未配置全局默认:弹窗行为与今天**完全一致**(hint 原样、无新文案)
- [ ] ④ 弹窗秒开不等探活;探活异步返回后填入;探活返回前用户已手动选择时不覆盖
- [ ] 回归:`create-dialog.test.tsx` 既有用例全绿 + 新增预填场景用例(①②③④ 各至少一条可失败断言)
- [ ] 全套测试 0 失败,typecheck clean

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 「可访问」可以是候选命中 | 自定义 `EMBEDDING_BASE` 指向的远程服务列不进候选,候选命中会漏判 | 用户选:真实探活(最可靠) |
| 探活失败可仍预填+警示 | 填了用不了,建库后嵌入必失败 | 用户选:留空+说明 |
| 弹窗可同步等探活结果 | 远程服务时用户感知数百 ms~数秒延迟 | 用户选:异步填入,弹窗秒开 |
| 预填会改变建库快照行为 | `createKb` 无条件快照 base/key,显式传模型名不改变来源 | 代码证据关闭:快照中立 |

## Technical Context(brownfield)

- **弹窗**:`apps/studio/src/mainview/app/kb/index.tsx:44` `KbCreateDialog`——`embeddingModel` state 初始为空;`useKbModelCandidates("embedding","","",open)` 在弹窗开时拉候选;提交走 `kbCreate({embeddingModel: value || undefined})`
- **后端快照(已存在,不动)**:`apps/studio/src/bun/knowledge.ts:245-267` `createKb` 已按 `globalEmbeddingDefaults()` 快照三字段
- **探活可复用**:设置页 `kbTestEmbedding` RPC 链路(发极小嵌入请求回 dim);需一个不带 kbId、按「全局默认三键 + 既有解析链」取地址的探活入口(新 RPC 或既有 RPC 的参数化扩展,方案交由 plan 阶段定)
- **候选选择器**:`apps/studio/src/mainview/app/kb/model-select.tsx` `KbModelSelect` 已支持候选外值(`hasCandidate`)
- **既有测试**:`apps/studio/src/mainview/app/kb/create-dialog.test.tsx`(扩展点)
- **提示文案**:`kb.create.embeddingHint` 既有;不可达说明需要新 i18n key(zh/en,`shared/i18n.ts`)

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| KbCreateDialog | core domain | name, description, embeddingModel, rerankModel, createOpen | 提交 → kbCreate;读取 候选列表;被 探活结果 预填 |
| 全局默认嵌入配置 | core domain | EMBEDDING_MODEL, EMBEDDING_BASE, EMBEDDING_API_KEY | 由默认模型卡片写入;被 createKb 快照;被探活读取 |
| 可访问性探活 | core domain | 解析地址, 最小嵌入请求, ok/dim | 门控 预填;复用 kbTestEmbedding 链路 |
| 候选列表 | supporting | local[], remote[], service.base | 由 useKbModelCandidates 拉取;展示于 KbModelSelect |
| KB 行快照 | supporting | embeddingModel/Base/ApiKey | createKb 写入;预填不得改变其结果 |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 5 | 5 | - | - | N/A |
| 2 | 5 | 0 | 0 | 5 | 100% |
| 3 | 5 | 0 | 0 | 5 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (3 rounds + Round 0)</summary>

### Round 0(拓扑门)
**Q:** 拓扑确认:只做「新建弹窗的嵌入模型预填」,重排不纳入(需先新增全局重排默认配置)?
**A:** 仅嵌入预填,重排不做(推荐)

### Round 1
**Q:** 「该模型可访问时」的判定标准是什么?
**A:** 真实探活(推荐)——后端发一次极小嵌入请求,通了才预填
**Ambiguity:** 40%(Goal: 0.75, Constraints: 0.45, Criteria: 0.40, Context: 0.85)

### Round 2
**Q:** 探活失败(或全局默认未配置)时,新建弹窗的表现应该是什么?
**A:** 留空+说明(推荐)——下拉留空,hint 追加「已配置默认嵌入模型 X,但当前不可达」
**Ambiguity:** 27%(Goal: 0.85, Constraints: 0.70, Criteria: 0.50, Context: 0.90)

### Round 3
**Q:** 四条验收场景是否构成完整定义?第 4 条含探活异步时序决策
**A:** 四条全对+异步填入(推荐)——弹窗秒开不等探活,探活返回后再填入
**Ambiguity:** 7%(Goal: 0.95, Constraints: 0.90, Criteria: 0.95, Context: 0.90)✅ 低于阈值 20%

</details>
