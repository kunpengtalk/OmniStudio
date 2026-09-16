# RALPLAN: 知识库与问答召回的图片查看（文档列表 + 聊天引用）

> Status: **pending approval**（共识达成：Architect APPROVE ×2 轮，Critic REVISE→APPROVE 第 2 轮）
> Source spec: `.omc/specs/deep-interview-kb-image-viewing.md`（歧义 11%，8 轮访谈）
> Mode: consensus --direct（short RALPLAN-DR；非高风险：纯展示层 UI + 1 个 RPC 参数，无 auth/迁移/破坏性改动）

## Requirements Summary

两处入口共用一个应用内图片查看弹窗：
1. **KB 文档列表**：图片类文档行内显示缩略图（512px），点击 → 查看弹窗（2048px 高清压缩图、可缩放）；分块弹窗里现有 56px 缩略图点击从「跳系统程序」升级为同一弹窗
2. **聊天引用**：图片类引用胶囊带缩略图，点击 → 同一弹窗

弹窗 = 大图 + 文件名 + OCR 文本（若有）+「用系统程序打开」按钮 + 点击/滚轮缩放；无翻页。
不做：PDF 页块查看、回测页、音视频播放、翻页、image-server 原图直出。

## RALPLAN-DR Summary

### Principles（原则）
1. **两入口一组件**：DocRow / ChunksDialog / CitationBar 三处接入同一个查看器，行为完全一致
2. **数据最小够用**：大图用 2048px q85 高清压缩图；不引入原图直出
3. **失败永远兜底**：文件缺失/超 64MB/解码失败/查询出错 → 图标兜底，绝不拖垮列表与聊天渲染
4. **复用既有安全路径**：服务端经 sharp 重编码出 base64（kbChunkMedia 既有模式），不扩大 image-server 的文件暴露面
5. **不动检索与嵌入语义**：纯展示层改动 + 一个可选 RPC 参数；`KbHit`/`KbCitation`/入库管线零改动

### Decision Drivers（决策驱动，Top 3）
1. 验收 ①②③ 要求三处入口同一弹窗（用户 R1–R3 决策）
2. 清晰度 vs 本地 HTTP 暴露面的权衡已由用户裁定（R4：高清压缩图，否决原图直出）
3. 改动面最小化：`KbCitation` 已带 `chunkId`+`modality`（`shared/knowledge.ts:41-56`，代码注释明确预留取缩略图），`kbChunkMedia` 管道现成

### Viable Options
- **Option A（选定）**：`kbChunkMedia` 加尺寸档位参数 + 新建共享 Dialog 查看器 + 三处接入
  - Pros：后端只加一个参数与两个返回字段；缩略图/大图分离（512 缓存复用 / 2048 按需）；全部走已验证的降级管道
  - Cons：大图 base64 约 0.5–3MB/张（RPC 桥历史最大载荷为数十 KB 缩略图，需最坏用例实测——见 Risks 与 Step 5 降档曲线）；缩放交互需自实现（应用内无现成组件，预算约 120 行含边界）
- **Option B（否决）**：image-server 新增 KB 媒体路由，按 `mediaPath` 流式出原图
  - 否决理由：image-server 现行设计只服务固定根（`image-server.ts:357` safeJoin 越界 403），暴露用户任意绝对路径需新建路径安全体系；用户 R4 已明确选择高清压缩图方案
- **Option C（否决）**：仅升级分块弹窗为查看器，不做列表行/引用胶囊缩略图
  - 否决理由：不满足验收 ①③（用户 R2/R3 明确要求两处入口的行内可见缩略图）

## Implementation Steps

### Step 1 — 后端：kbChunkMedia 尺寸档位 + 视图补字段
文件：`apps/studio/src/bun/rpc/kb-media.ts`、`apps/studio/src/bun/rpc/index.ts:2103-2106`（契约）、`:4534-4536`（转发）
1. `kb-media.ts:19-20` 旁新增 `FULL_MAX_EDGE = 2048`、`FULL_JPEG_QUALITY = 85`
2. `chunkMediaForRpc(chunkId, size: "thumb" | "full" = "thumb")`（:41）按档位选 resize 边长与质量；护栏全部沿用（`THUMB_MAX_INPUT_BYTES` 64MB :22、`THUMB_LIMIT_INPUT_PIXELS` :24、stat 预检 :56-63、catch 兜底 :76-79）；`size` 缺省 = thumb 档，行为逐字节不变
3. `KbChunkMediaView`（:26-33）增加 `mediaPath: string | null`（系统打开用；webview 本已收到 mediaPath——`KbChunkView.mediaPath` 经 listChunks 下发，`docs-tab.tsx:119` 在消费，不扩大暴露面）与 `text: string | null`（块 content 列 = OCR 文本；schema NOT NULL，实际恒为 string，纯媒体块合法为空串——UI 对空串隐藏 OCR 区）；SELECT（:43）补 `content` 列
4. RPC 契约（rpc/index.ts:2104-2105）params 加 `size?: "thumb" | "full"`，转发处（:4534-4536）透传
测试（`src/bun/rpc/kb-media.test.ts` / `kb-media.tests.ts`，沿用子进程隔离骨架）：
- full 档返回更大边长 jpeg（2048/q85）；thumb 档行为逐字节不变
- 新字段 mediaPath/text 正确；空串 text 场景
- 降级路径不变：缺文件 / 超 64MB / 音视频 / **PDF 输入 → null**（sharp 解不了 PDF，为验收 ⑤「PDF 页块行为不变」提供测试锚点）

### Step 2 — 前端：共享图片查看器组件
新建：`apps/studio/src/mainview/components/kb-image-viewer.tsx`
1. `KbImageViewer({ chunkId, open, onClose })`：Dialog（`components/ui/dialog.tsx`）+ `useQuery({ queryKey: ["kb-chunk-media-full", chunkId], queryFn: () => rpcClient.kbChunkMedia({ chunkId, size: "full" }), enabled: open, staleTime: 10 * 60_000, gcTime: 5 * 60_000 })`
2. **降级判式**：`isError || dataUrl == null` → 图标 + 文件名兜底（照抄 `MediaChunkBlock` 成熟判式 `docs-tab.tsx:111`）——覆盖过期 firstImageChunkId / 块已删除时查询 reject 的故障路径；加载中 Spinner
3. 图片区缩放（自实现，预算 ~120 行含边界）：
   - **wheel 必须经 ref + 原生 `addEventListener("wheel", h, { passive: false })`**（useEffect 挂载/清理）——React 根节点对 wheel 按被动监听，JSX `onWheel` 里 `preventDefault()` 无效
   - 滚轮 `scale = clamp(0.5, 4)`，transform-origin 跟随光标
   - **单击切档与双击复位的冲突消解**：单击用 250ms 定时器延迟切 1x/2x，双击（onDoubleClick）取消定时器并复位——避免双击复位时先跳 2x 的闪烁
   - `scale > 1` 时拖拽平移（pointer 事件维护 translate；与 Radix 焦点管理无冲突——dismiss 由 pointerdown-outside 触发）
4. 底部：文件名（等宽截断）+ OCR 文本（`text` 非空才渲染，max-h 限高滚动）+「用系统程序打开」按钮 → `rpcClient.openPath({ path: view.mediaPath })`（`mediaPath` 为空禁用）
5. i18n（`shared/i18n.ts` zh+en）：`kb.viewer.title`「查看图片」、`kb.viewer.openExternal`「用系统程序打开」、`kb.viewer.zoomHint`「滚轮缩放 · 双击复位」

### Step 3 — KB 文档列表：行内缩略图 + 分块弹窗升级
文件：`apps/studio/src/bun/knowledge.ts`、`apps/studio/src/mainview/app/kb/docs-tab.tsx`
1. `KbDocView`（knowledge.ts:98-118）加 `firstImageChunkId: number | null`；`kbDocList` 实现（rpc/index.ts:4447 → knowledge.ts:567 listDocs）用**一条分组 SQL** 取各文档首个图片块：`select min(id), doc_id from knowledge_chunks where kb_id = ? and modality = 'image' group by doc_id`——**必须带 `kb_id = ?` 过滤**（`kbIdx` 索引 schema.ts:551），避免全库分块扫描；读时派生不落库，块删除后下次刷新自然消失
2. `DocRow`（docs-tab.tsx:223-342）：`firstImageChunkId` 非空 → 图标位渲染 40px 圆角缩略图（`useQuery(["kb-chunk-media", chunkId])` 512px 档，staleTime 10min——与 MediaChunkBlock :99-106 同 queryKey 共享缓存；同样处理 isError 兜底）；点击缩略图 `stopPropagation` 后打开查看器（实例挂载在 docs-tab 列表容器层，单实例受控）；行其余区域点击行为不变（进分块弹窗）
3. `MediaChunkBlock`（docs-tab.tsx:96-153）：图片缩略图点击（:114-121 现走 openPath）改为打开查看器；音视频块维持 openPath
4. 测试：
   - `docs-tab.test.tsx`：更新 :256（点击缩略图断言查看器 Dialog 出现而非 openPath）；新增图片文档行缩略图渲染 + 非图片文档行无缩略图断言
   - **`knowledge-multimodal.tests.ts`（数据层，真 db 子进程隔离骨架）新增 listDocs 用例，断言 3 条边界**：① 多图片块文档 → `firstImageChunkId = min(id)`；② 无图片块文档（纯文本/无块）→ null；③ 纯音视频块文档 → null（不误选）

### Step 4 — 聊天引用胶囊缩略图
文件：`apps/studio/src/mainview/app/chat-screen.tsx:272-305`、新建 `apps/studio/src/mainview/app/chat/citation-bar.tsx`
1. 把 `CitationBar` + `MODALITY_ICONS`（chat-screen.tsx:272-305）原样抽到 `chat/citation-bar.tsx`（chat-screen 改 import；行为不变——为可测试性，chat-screen 无既有 UI 测试）
2. 胶囊内 `modality === "image"` 且 `chunkId` 存在 → 渲染 24px 缩略图（同 512px 档 queryKey 缓存，isError 兜底）；点击缩略图 `stopPropagation` 打开查看器（实例挂载在 CitationBar 容器层）；**`chunkId` 缺失（历史消息旧引用）→ 无缩略图、零请求**——兼容语义显式化
3. 胶囊其余部分行为不变
4. 新测试 `chat/citation-bar.test.tsx`：图片引用渲染缩略图并打开查看器；文本/音视频引用不变（无缩略图请求）；**旧引用（无 chunkId）零请求断言**

### Step 5 — 回归验证
1. `bun test src/bun/rpc/kb-media.test.ts src/bun/knowledge-multimodal.tests.ts src/mainview/app/kb/docs-tab.test.tsx src/mainview/app/chat/citation-bar.test.tsx src/shared/i18n.test.ts`
2. 全量 `bun test` + `bun run typecheck`（apps/studio）
3. 手动验收（dev 实例）：
   - a) 勾「图片」的 KB 添加 PNG → 列表行缩略图 → 点击弹窗缩放 → 系统打开
   - b) 降级：删除源文件后刷新 → 图标兜底
   - c) 聊天命中图片块 → 胶囊缩略图 → 同一弹窗
   - d) 未勾图片模态的库（OCR 文本路径）列表无缩略图、行为不变
   - e) **最坏用例实测（RPC 桥载荷假设降级为事实）**：24MP 照片走 `size:"full"`，实测弹窗打开延迟并确认 >1MB base64 完整到达 webview；**降档曲线（预约定）**：若桥测不过（截断/挂起/延迟不可接受），降为 ~1600px q80（目标 base64 ≤1.5MB）——R4 用户意图内的调参，不是重新设计

## Acceptance Criteria（继承 spec，可测化）

- [ ] ① `kbDocList` 返回 `firstImageChunkId`（分组 SQL 带 kb_id 过滤，3 条边界有数据层测试）；图片文档行内 40px 缩略图可点，弹窗为 2048px 档、含文件名/OCR 文本/系统打开按钮/缩放
- [ ] ② ChunksDialog 缩略图点击打开同一查看器（不再直接 openPath）；「系统打开」由弹窗内按钮承担（音视频块 openPath 不变）
- [ ] ③ 图片引用胶囊带 24px 缩略图，点击打开同一查看器；其他引用类型渲染不变；旧引用（无 chunkId）零请求
- [ ] ④ `kbChunkMedia` `size:"full"` 返回 ~2048px q85 JPEG；缺失/超 64MB/解码失败/非图片/PDF → null 降级，与现状一致；`size` 缺省 = thumb 档行为不变
- [ ] ⑤ 全量 `bun test` 0 失败、`bun run typecheck` clean；音视频/文本块/PDF 页块/纯文本库行为不变

## Risks and Mitigations

| 风险 | 缓解 |
|---|---|
| 文档列表缩略图 N+1 请求 | 列表单条分组 SQL 取 firstImageChunkId（带 kb_id 索引过滤）；缩略图按 chunkId 走 react-query 缓存（与分块弹窗共享 queryKey）；仅图片文档发起 |
| 2048px base64 内存（0.5–3MB/张）与 RPC 桥载荷 | 仅弹窗打开时 enabled 拉取；单图会话；**显式 `gcTime: 5min`**（回收由 gcTime 驱动、自查询失活起算；staleTime 只控制过期重取）；Step 5.e 最坏用例实测 + 预约定降档曲线（~1600px q80） |
| 滚轮缩放与 Dialog 滚动冲突 | ref + 原生 `addEventListener({ passive: false })`（React onWheel 的 preventDefault 无效）；弹窗正文不滚动（文本区独立 overflow） |
| 过期 firstImageChunkId / 已删块点击 | 查看器与缩略图查询 `isError` 与 dataUrl null 同分支兜底（图标 + 文件名），查询 reject 不炸 UI |
| `KbDocView` 加字段的既有消费者 | 已核：`kbDocList` 全仓唯一消费者是 `docs-tab.tsx:399`（recall-tab 不消费）；新字段可空，`toDocView`（knowledge.ts:375，5 个生产点单一收口）统一补 null 默认；typecheck 全量把关 |
| kb-media 测试走子进程隔离模式 | 沿用 kb-media.test.ts 既有隔离骨架，只加用例不换结构 |

## Verification Steps

1. 定向测试四文件全绿（Step 5.1 命令）
2. 全量 bun test 0 fail + typecheck clean
3. 手动场景 a–e（含最坏用例实测与降档曲线）

## ADR

- **Decision**: Option A——`kbChunkMedia` 增加尺寸档位参数（thumb 512 / full 2048 q85）+ 共享 Dialog 查看器组件（自实现缩放）+ 三处接入（DocRow 行内缩略图 / ChunksDialog 升级 / CitationBar 缩略图）；`KbDocView` 增读时派生的 `firstImageChunkId`（单条分组 SQL，带 kb_id 过滤）。
- **Drivers**: ① 三处入口同一弹窗（用户 R1–R3）；② 高清压缩图否决原图直出（用户 R4，兼安全考量）；③ 复用 `KbCitation.chunkId/modality` 预留字段与 kbChunkMedia 现成降级管道。
- **Alternatives considered**: Option B（image-server 原图路由——需新建任意路径安全体系，扩大本地 HTTP 暴露面，R4 已否决）；Option C（仅升级分块弹窗——不满足验收 ①③）。
- **Why chosen**: 后端改动最小（1 参数 + 2 可空字段）且全部落在已验证的降级管道与单一收口（toDocView）内；chunkId 驱动与既有 KbCitation/KbHit 数据结构零冲突；Architect 事实核对（引用 100% 真实）与 Critic 质量评审（B/C 非稻草人、验收对位无遗漏）均确认。
- **Consequences**: 大图载荷较现状大 1–2 个数量级——以 Step 5.e 最坏用例实测 + 预约定降档曲线（~1600px q80）约束；缩放交互为自实现代码（~120 行）需覆盖 wheel 被动监听 / 单击双击去抖 / 拖拽平移边界；内存三角（staleTime × gcTime × 桥流量）显式配置。
- **Follow-ups**: PDF 页块查看（sharp 不可解，需接页渲染管线，用户已确认后续立项）；KB 回测页缩略图；RPC 桥大载荷上限的正式文档化（若 5.e 实测暴露 electrobun 限制）。

## Changelog

- 2026-09-15 Planner 初稿
- 2026-09-15 评审第 1 轮：Architect APPROVE（4 必改 + 3 建议）、Critic REVISE（1 Major + 4 Minor）。已合并：分组 SQL kb_id 过滤；isError 兜底分支；wheel 原生被动监听；gcTime 显式化与风险表更正；PDF → null 测试锚点；listDocs 数据层测试落点（knowledge-multimodal.tests.ts，3 条边界断言）；旧引用无 chunkId 零请求语义；单击/双击去抖方案；kbDocList 消费者核查（仅 docs-tab）；Step 5.e 最坏用例实测与降档曲线；缩放代码预算修正（60→120 行）；ADR 补全
- 2026-09-15 评审第 2 轮：Architect 维持 APPROVE（7/7 落实，新增事实断言 3/3 属实，无新问题）；Critic 升级 APPROVE（5/5 落实，新引用 4/4 实证，无 blocker/major）。**共识达成，计划定稿 pending approval**
