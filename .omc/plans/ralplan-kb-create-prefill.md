# RALPLAN: 知识库新建弹窗自动预填默认嵌入模型(探活门控)

Status: **PENDING APPROVAL**(v2,Architect SOUND-WITH-CONCERNS 修订项 + Critic APPROVED-WITH-IMPROVEMENTS 必改项均已并入)
Spec: `.omc/specs/deep-interview-kb-create-dialog-embedding-prefill.md`(模糊度 7%,PASSED)
Branch base: `feat/embedding-serving`(13 commits,含全局默认嵌入体系)

## Requirements Summary

配置了全局默认向量模型(`EMBEDDING_MODEL` 等,设置 → 默认模型 → 向量嵌入卡片)且**真实探活通过**时,新建知识库弹窗打开后自动把默认模型填进向量模型下拉;探活异步(弹窗秒开);探活失败留空+hint 说明;未配置则与今天一致;预填**快照中立**(建库结果与留空提交完全一致);用户在探活返回前/后的任何手动选择(含显式「不使用」)永不被覆盖。

## RALPLAN-DR Summary

### Principles
1. **单一解析点**:嵌入地址解析(base 回落链)只在 bun 侧——webview 不复制回落逻辑(308ed0d 修过两回的「空 base 陷阱」正是 webview 侧复制的产物)
2. **预填即可用**:预填的模型必须真的能嵌(真实探活门控),杜绝「填了但首次导入才失败」
3. **快照中立**:预填只改变 RPC 入参形态(隐式 undefined → 显式同名值),不改变 `createKb` 落库行为
4. **用户主权**:弹窗内任何手动选择(含「不使用」)永不被探活结果覆盖;探活只在字段未被碰过时填一次

### Decision Drivers
1. **正确性 > 简洁**:webview 侧复制 base 回落逻辑已两次出 bug;本特性绝不引入第三处
2. **弹窗打开延迟**:秒开,探活必须异步
3. **失败就近原则**:建库动作本身不嵌入,不可达若不在建库点拦住,失败会漂移到首次导入——探针的正当性来源

### Viable Options

**Option A(选定):bun 侧探活 RPC `kbDefaultEmbeddingProbe`**
- `Knowledge.probeDefaultEmbedding()`:`globalEmbeddingDefaults()` → 未配 `{configured:false}`;已配则调既有 `testEmbedding({base,apiKey,model})`(其 `callEmbeddings` 走 `resolveEmbeddingBase` 四层链,与建库后真实请求同一解析,`embeddings.ts:60`)→ `{configured:true, reachable, model, dim?, error?}`
- webview 只消费结论,不知道地址怎么解析
- Pros:解析单点;webview 零 base 知识;configured/reachable 分离使 hint 条件清晰
- Cons:+1 RPC(~10 行样板)

**Option B(否决):纯前端编排(getSettings + kbTestEmbedding 直拼)**
- 否决理由:①webview 成为 `EMBEDDING_*` 键的又一处解释者;②两趟往返;③回落链未来调整时 webview 拼参静默漂移——308ed0d 修过的 bug 类

**Option C(否决):以弹窗候选列表命中为门控**
- 否决理由:候选解析用 `resolveEmbeddingBackend()`(`knowledge.ts:708`),与运行期 `resolveEmbeddingBase` 是**两条不同的链**;自定义远程 base 列不进候选会漏判;违背「预填即可用」无法保证

## Implementation Steps

1. **bun 探活函数** — `apps/studio/src/bun/knowledge.ts`(紧邻 `testEmbedding` :618-636):
   ```ts
   export async function probeDefaultEmbedding(): Promise<
     | { configured: false }
     | { configured: true; reachable: boolean; model: string; dim?: number; error?: string }
   > {
     const defaults = globalEmbeddingDefaults();
     if (!defaults.model) return { configured: false };
     const r = await testEmbedding({ base: defaults.base, apiKey: defaults.apiKey, model: defaults.model });
     return { configured: true, reachable: r.ok, model: defaults.model, dim: r.dim, error: r.error };
   }
   ```
2. **RPC 注册** — `apps/studio/src/bun/rpc/index.ts`:无 zod,编译期 TS 类型映射(`mainview/lib/rpc.ts:44/:317`);无参数按 `kbList` 先例(`rpc/index.ts:1978-1980`):`kbDefaultEmbeddingProbe: async () => Knowledge.probeDefaultEmbedding()`,schema 参照 `kbTestEmbedding`(:2034/:4454 区)
3. **弹窗接线** — `apps/studio/src/mainview/app/kb/index.tsx` `KbCreateDialog`(:44-151):
   - 探活 query:`useQuery({ queryKey:["kb-default-embed-probe"], queryFn: () => rpcClient.kbDefaultEmbeddingProbe(), enabled: open, staleTime: 0, retry: false })`
   - **打开时重置**(v2 新增,两位评审交叉确认 `KbCreateDialog` 常驻挂载、state 跨开合残留——`index.tsx:49-52` 的 useState,`:299/:316` 的挂载点;v1 的「卸载即重置」说法有误):
     ```tsx
     const touchedRef = useRef(false);
     useEffect(() => {
       if (open) { setEmbeddingModel(""); setRerankModel(""); touchedRef.current = false; }
     }, [open]);
     ```
     仅重置两个模型字段;name/description 的残留是既有行为,超范围不动
   - **一次性预填**(v2 改为 touched 守卫,替换 v1 的 `!embeddingModel`——后者会被「用户显式选『不使用』」穿透造成 snap-back 回环,违反规格 ①「可改」):
     ```tsx
     useEffect(() => {
       const d = probe.data;
       if (open && !probe.isFetching && d?.configured && d.reachable && d.model && !touchedRef.current) {
         setEmbeddingModel(d.model);
       }
     }, [probe.data, probe.isFetching, open]);
     ```
     `!probe.isFetching`:重开弹窗时避免拿上一次的陈旧缓存数据预填(refetch 在途时旧 data 仍在 TanStack 里)
   - **触碰标记**:嵌入下拉的 `onChange` 里 `touchedRef.current = true`(重排下拉不参与预填,不需要)
   - hint:`{probe.data?.configured && !probe.data.reachable && !probe.isFetching && (<p className="text-[10px] leading-4 text-muted-foreground/80">{t("kb.create.embeddingDefaultUnreachable", { model: probe.data.model })}</p>)}`,置于既有 `embeddingHint` 之后
4. **i18n** — `apps/studio/src/shared/i18n.ts`:`kb.create.embeddingDefaultUnreachable`
   - zh: `已配置默认嵌入模型 {model},但当前不可达;可启动嵌入服务后重新打开此窗口`
   - en: `Default embedding model {model} is configured but unreachable. Start the embedding service and reopen this dialog.`
5. **弹窗测试** — `apps/studio/src/mainview/app/kb/create-dialog.test.tsx`(扩展现有 `mock.module("@lib/rpc")` 桩,`:60-82` 区,加 `kbDefaultEmbeddingProbe`):
   - ①reachable + model="wemm-9b" → 下拉值=该模型(候选不含也显示);提交 → `kbCreate` 收到 `embeddingModel:"wemm-9b"`
   - ②configured && !reachable → 值空 + 新 hint 文案出现且含模型名
   - ③configured:false → 无新 hint、值空
   - ④用户先选 bge-m3,探活后返回 wemm → 值仍 bge-m3(不覆盖)——Radix Select 交互在 happy-dom 不稳时,退化为对「预填判定纯函数」的直接断言 + 手测清单
   - ⑤**snap-back 回归**(v2 必改):用户显式选「不使用」→ 探活返回 reachable → 值仍为空(touched 守卫生效)
   - ⑥**重开语义**(v2 新增):提交一次(值=wemm)→ 关闭 → 重开 → 模型字段已重置,探活重新发起,reachable 时再次预填
   - ⑦异步:探活 pending 渲染 → 不崩、值为空
6. **bun 侧单测** — `apps/studio/src/bun/knowledge` 相关测试文件(存在则扩展,否则新建,沿用 mock 骨架):
   - 未配置(`EMBEDDING_MODEL` 空)→ `{configured:false}` 且**不发起任何嵌入请求**(短路)
   - 已配置 → 透传 `testEmbedding` ok/error 两态
   - **快照中立**(v2 新增):显式传 `embeddingModel=defaults.model` 与不传,`createKb` 落库行三字段逐一相同
7. **CHANGELOG** — 新条目(含「打开时重置模型字段」这个随行小修的说明)

## Acceptance Criteria(承接规格四条 + 工程化)

- [ ] ① 配好默认 + 探活通过:弹窗自动选中默认模型(候选外也显示);提交后建库三字段与留空提交**完全一致**(测试⑦-bun 侧逐字段断言)
- [ ] ② 配好但探活失败:留空 + hint(zh/en)含模型名
- [ ] ③ 未配置:无新 hint、无探活请求,行为与今天一致(仅「模型字段开窗重置」这一随行小修除外,已在 CHANGELOG 说明)
- [ ] ④ 弹窗秒开;探活返回前用户已选(含选「不使用」)→ **永不覆盖**(测试④⑤)
- [ ] 重开弹窗 → 模型字段重置 + 重新探活(测试⑥)
- [ ] 既有 create-dialog 测试全绿;新增 ≥7 条可失败断言(①-⑦)
- [ ] 全套测试 0 失败;`bun run typecheck` clean
- [ ] 硬约束零改动:`resolveEmbeddingBase` 链 / `createKb` 快照语义 / `globalEmbeddingDefaults` / gateway.ts / runtimes/*

## Risks and Mitigations(v2 修正版)

| 风险 | 评估与缓解 |
|------|-----------|
| ~~Radix Dialog 卸载即重置~~(**v1 事实错误,v2 已改**) | `KbCreateDialog` 常驻挂载,只有 `DialogContent` 卸载——已改为显式「开窗重置模型字段」effect(测试⑥覆盖) |
| snap-back 回环(**v1 设计缺陷,v2 已改**) | touched 守卫替代 `!embeddingModel`;测试⑤锁定 |
| 探活对「模型名与实例不符」不敏感(llama-server 忽略未知模型名) | 接受:探活语义=「该地址能嵌」;摄取首批即学习并持久化维度(`kb-ingest.ts:360-364`),此后强制校验(`embeddings.ts:88-90`)——错名自愈,不扩散 |
| 探活最坏 120s(`AbortSignal.timeout(120_000)`,`embeddings.ts:70`) | 本地端点通常即刻失败/成功;病态悬挂的远程地址会让 hint 迟到——v1 接受,列为 Follow-up(探活专用短超时需穿 `callEmbeddings`,涉敏文件不值当先做) |
| TanStack 重开时残留上一次 data | `staleTime:0` 强制重取 + 预填/hint 都加 `!probe.isFetching` 门(等新数据落定) |
| 测试④的 Radix Select happy-dom 交互脆断 | 退化路径:抽「预填判定」为纯函数直接断言;手测清单兜底 |

## Verification Steps

1. `cd apps/studio && bun test src/mainview/app/kb/create-dialog.test.tsx`(新旧用例全绿)
2. `cd apps/studio && bun test`(全套,基线 718/0 → 预期 725+/0)
3. `cd apps/studio && bun run typecheck`(clean)
4. `git diff --stat` 确认未触碰硬约束文件(resolveEmbeddingBase/createKb/globalEmbeddingDefaults/gateway.ts/runtimes)
5. (可选,手动)重打包后:配默认+WeMM 在跑 → 开弹窗见预填;停 WeMM → 重开弹窗见 hint;选「不使用」后探活返回 → 仍为「不使用」

## ADR

- **Decision**: 新增 bun 侧探活 RPC `kbDefaultEmbeddingProbe`(Option A),弹窗纯消费结论;开窗重置模型字段 + touched 守卫一次性预填
- **Drivers**: 单一解析点;预填即可用;弹窗秒开;失败就近原则
- **Alternatives considered**:
  - Option B 纯前端编排——否决(webview 复制解释权,308ed0d bug 类)
  - Option C 候选命中门控——否决(候选链 `resolveEmbeddingBackend` ≠ 运行期链,自定义 base 漏判)
- **与既有先例的关系(正面回应 settings-tab.tsx:218-220 的「零新 RPC、不引入可达性探针」)**:该先例的对象是「启用向量检索」按钮——它的动作**自带验证**(点击即重嵌,不可达在重嵌结果里立刻可见),探针冗余;本特性的对象是**建议性预展示**,建库动作不嵌入,不可达若不在建库点拦住,失败漂移到首次导入(远离决策点)——探针在此有正当性。两条决策并存不矛盾:自验证动作用静默判据,预展示动作用真实探活
- **Why chosen**: 消除 webview 第三处 base 回落复制点;契约自描述(configured/reachable 分离);单次 RPC 往返
- **Consequences**: +1 RPC(~10 行);开窗重置模型字段是与今天行为的一处**有意**小偏差(修「残留上次的模型」这个 papercut,CHANGELOG 说明);探活最坏延迟继承 120s
- **Follow-ups**: 重排预填(需先建全局重排默认配置,拓扑延后项);探活短超时(需穿 callEmbeddings);探活结论可复用于设置页按钮的后端判据(统一两处判定)

---
## Changelog(共识过程修订)
- v1: Planner 初稿
- v2(综合 Architect SOUND-WITH-CONCERNS + Critic APPROVED-WITH-IMPROVEMENTS,盲评交叉命中后合并):
  - 【必改】预填守卫 `!embeddingModel` → `touchedRef` touched 守卫(两位评审独立发现 snap-back 回环;违反规格①「可改」)+ 测试⑤
  - 【必改】修正 v1 事实错误:「卸载即重置」不成立(常驻挂载);新增开窗重置 effect + 测试⑥;name/desc 残留明确超范围
  - 【修正】RPC 无 zod(编译期类型映射,kbList 先例);params 为空
  - 【补强】测试:rpc 桩扩展、bun 侧快照中立用例、具体验证命令
  - 【补强】ADR 正面回应 settings-tab「零探针」先例;风险表修正(120s 探活最坏延迟、TanStack 残留 data 的 isFetching 门)
