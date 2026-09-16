# Deep Interview Spec: 知识库与问答召回的图片查看

## Metadata
- Interview ID: kb-image-viewing-20260915
- Rounds: 8（含 Round 0 拓扑门）
- Final Ambiguity Score: 11%
- Type: brownfield
- Generated: 2026-09-15
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 0.35 | 0.322 |
| Constraint Clarity | 0.88 | 0.25 | 0.220 |
| Success Criteria | 0.85 | 0.25 | 0.213 |
| Context Clarity | 0.90 | 0.15 | 0.135 |
| **Total Clarity** | | | **0.890** |
| **Ambiguity** | | | **11%** |

## Topology

| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| kb-docs-image-view | active | KB 文档列表侧图片查看：文档行内缩略图 + 点击应用内大图弹窗；分块弹窗现有 56px 缩略图点击升级为同一弹窗 | 验收 ①②④ |
| chat-recall-image-view | active | 问答召回侧图片查看：聊天引用胶囊带缩略图，点击 → 同一大图弹窗 | 验收 ③④ |
| （延后）pdf-page-view | deferred | PDF 页块（多模态直嵌每页一块）的查看——现状 sharp 解不了 PDF，统一图标兜底 | 用户确认后续立项（R5） |
| （延后）recall-tab-view | deferred | KB 回测页（recall-tab）命中行的缩略图+大图——媒体命中现在只显示图标标签 | 用户在 R3 选择只做聊天侧，回测页未纳入 |
| （延后）音视频播放 | deferred | 沿用上一轮 spec 的 Non-Goal：不做媒体块内嵌播放器 | 继承 deep-interview-kb-multimodal-file-embedding |

## Goal

为知识库中的图片提供**应用内查看**能力，覆盖两个入口：① 知识库文档列表——图片类文档在行内直接显示缩略图，点击弹出应用内大图查看器（可缩放），「分块」弹窗里现有的小缩略图点击也从「跳系统程序」升级为同一查看器；② 聊天问答——知识库召回引用中的图片引用在引用胶囊上带缩略图，点击弹出同一查看器。查看器内容 = 高清压缩大图 + 文件名 + OCR 文本（多模态块若有）+「用系统程序打开」按钮，支持点击放大/滚轮缩放。两个入口共用同一套查看组件与取图 RPC。

## Constraints

- **查看形态 = 应用内弹窗大图**（R1）：不做"仅系统程序打开"；弹窗内保留「用系统程序打开」按钮（复用既有 `openPath` RPC）
- **大图数据源 = 高清压缩图**（R4）：`kbChunkMedia` RPC 增加尺寸参数（约 2048px、q85），复用既有安全路径（服务端读 `mediaPath` + sharp 重编码 → base64）；**不走** image-server 原图直出路由（不扩大本地 HTTP 服务的文件暴露面）
- **缩略图与大图分离取**（R6 默认假设，用户未异议）：列表行/引用胶囊用现有 512px 缩略图（复用 10 分钟 staleTime 缓存），点开弹窗才按需拉 2048px
- **查看器能力 = 基础 + 缩放**（R6）：大图 + 文件名 + OCR 文本（若有）+ 系统打开按钮 + 点击/滚轮缩放；**不做**多图块翻页
- **降级沿用现状**（R6 默认假设）：文件缺失 / >64MB / 解码失败 → dataUrl null，UI 图标兜底，不拖垮列表
- **范围 = 图片文件块**（R5）：仅 `modality === "image"` 且 mediaPath 为图片文件的块；PDF 页块本期继续图标兜底
- 继承既有硬约束：不改 `resolveEmbeddingBase`、不改嵌入管线与检索语义（`KbHit`/`KbCitation` 既有字段不动，仅 UI 消费）

## Non-Goals

- 不做 PDF 页块的图片查看（后续立项）
- 不做 KB 回测页（recall-tab）的缩略图/大图
- 不做音视频的查看/播放（图标+文件名+系统打开，维持现状）
- 不做大图翻页（同文档多图片块切换）
- 不做 image-server 的 KB 媒体路由 / 原图直出
- 不改多模态直嵌入库、嵌入、检索、聊天注入的任何行为

## Acceptance Criteria

- [ ] ① KB 文档列表：含图片块的文档在行内显示缩略图（512px 现有缓存），点击缩略图 → 应用内弹窗大图（2048px 高清压缩图，可点击/滚轮缩放），弹窗含文件名、OCR 文本（若有）、「用系统程序打开」按钮
- [ ] ② 分块弹窗（ChunksDialog）：现有 56px 缩略图点击不再直接跳系统程序，而是打开同一大图弹窗；弹窗内「系统打开」按钮承担原功能
- [ ] ③ 聊天引用：图片类引用胶囊显示缩略图，点击 → 同一大图弹窗（与 KB 侧完全同一组件）
- [ ] ④ 大图 RPC：`kbChunkMedia` 支持尺寸参数，返回约 2048px q85 JPEG；文件缺失/超大(>64MB)/解码失败 → null 降级为图标，行为与现状一致
- [ ] ⑤ 回归：音视频引用/块（图标+文件名）、文本块、PDF 页块（图标兜底）行为不变；纯文本 KB 与未勾模态的库不受影响；全套测试 0 失败，typecheck clean

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 「查看」= 点击用系统程序打开 | 应用内还是系统打开？ | 应用内弹窗大图；系统打开降级为弹窗内按钮（R1） |
| 现有 512px 缩略图放大即可当大图 | 512px 拉全屏会糊（Contrarian R4） | kbChunkMedia 加尺寸参数出 2048px q85 高清压缩图；不做原图直出 |
| sharp 管道天然支持所有图片块 | PDF 页块怎么办？（代码核查：sharp 解不了 PDF，现状 PDF 块已图标兜底） | 本期只做图片文件块，PDF 后续立项（R5） |
| 弹窗要做全功能（缩放+翻页+下载） | 最简有价值版本是什么？（Simplifier R6） | 基础版 + 缩放；无翻页 |
| 「召回的图片目录」指文件夹路径 | 词义确认（R3） | 确认为「问答召回引用里的图片」，非文件夹路径 |
| KB 侧入口只需要升级分块弹窗 | 列表行要不要直接见图？ | 上轮 spec 验收①的"列表缩略图"补齐：列表行缩略图 + 两处大图（R2） |

## Technical Context（brownfield，侦察实证）

- **KB 媒体存储**：原文件按引用不复制，`knowledge_docs.source_path` / `knowledge_chunks.mediaPath` 存绝对路径（`db/schema.ts:492-493, :542`）；媒体块带 `modality`（image/audio/video）与 `mediaIndex`（`schema.ts:540-544`）
- **现有取图 RPC**：`kbChunkMedia`（定义 `rpc/index.ts:2103-2106`，实现体 `rpc/kb-media.ts:41-80`）——sharp 缩到 `THUMB_MAX_EDGE=512` q80（:19-20），>64MB/缺失/解码失败降级 null（:22, :56-79）；**PDF 块必然走 catch 兜底**（sharp 不解 PDF）
- **KB 前端**：文档列表行 `DocRow`（`docs-tab.tsx:223-342`）只有类型图标+文件名，无缩略图；唯一图片渲染点在分块弹窗 `MediaChunkBlock`（`docs-tab.tsx:96-153`）：56px 缩略图 + 点击 `openPath` 系统打开（:118-120）；测试 `docs-tab.test.tsx:256` 锁定了点击 openPath 行为（需同步更新）
- **聊天引用**：`CitationBar`（`chat-screen.tsx:279-305`）只有模态图标+`[n]`+docName+`#seq`；`KbCitation`（`shared/knowledge.ts:41-56`）已带 `chunkId`+`modality`，注释明确预留「媒体引用可据此取缩略图」——聊天侧从未消费
- **检索返回**：`KbHit`（`shared/knowledge.ts:59-85`）含 `chunkId`/`modality`，不含 mediaPath（不需加——kbChunkMedia 按 chunkId 取）
- **无可复用 lightbox**：全应用无 zoom/ImageViewer 组件；最接近范例 = 提示词库详情弹窗（`prompt-screen.tsx:310-417`，Dialog + object-contain 大图）；通用 Dialog 在 `components/ui/dialog.tsx`
- **图片 URL 体系**：聊天图/生成图走 image-server(19782) `chatImageUrl(ref)`（`shared/server-info.ts:60-62`）；KB 媒体刻意不走该体系（RPC base64），本期维持
- **缩放实现注意**：应用内无现成缩放交互；可用 CSS transform/滚轮自实现（大图为单张 2048px JPEG，性能可控）

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| 图片查看弹窗 | core domain | 高清大图, 文件名, OCR文本, 系统打开按钮, 缩放交互 | 两入口共用；由缩略图点击唤起 |
| 列表行缩略图 | core domain | 512px dataUrl, chunkId | DocRow 行内展示；点击唤起查看弹窗 |
| 引用胶囊缩略图 | core domain | 512px dataUrl, chunkId | 聊天 CitationBar 内展示；点击唤起查看弹窗 |
| 高清压缩图数据源 | core domain | 2048px q85 JPEG, chunkId | kbChunkMedia 尺寸参数；弹窗按需拉取 |
| kbChunkMedia RPC | supporting | chunkId → {dataUrl, modality, fileName} | 现有 512px + 新尺寸参数双档 |
| 原文件引用 | supporting | mediaPath(绝对路径), modality, mediaIndex | 按引用不复制；系统打开走 openPath |
| OCR 文本 | supporting | 媒体块 text 列 | 弹窗内展示；聊天注入仍只用它 |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 5 | 5 | - | - | N/A |
| 2 | 6 | 1 | 0 | 5 | 83% |
| 3 | 6 | 0 | 0 | 6 | 100% |
| 4 | 7 | 1 | 0 | 6 | 86% |
| 5 | 7 | 0 | 0 | 7 | 100% |
| 6 | 7 | 0 | 0 | 7 | 100% |
| 7 | 7 | 0 | 0 | 7 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (8 rounds + Round 0)</summary>

### Round 0（拓扑门）
**Q:** 拓扑确认：2 个顶层组件（① KB 文档列表图片查看 ② 问答召回图片查看）？
**A:** 两个都对

### Round 1
**Q:** 「查看」具体指什么交互形态？（现状：KB 分块弹窗只有 56px 缩略图+点击跳系统程序；文档列表和聊天引用栏连图都没有）
**A:** 应用内弹窗大图
**Ambiguity:** 54%（Goal: 0.60, Constraints: 0.30, Criteria: 0.20, Context: 0.85）

### Round 2
**Q:** KB 文档列表侧，「查看」的入口放在哪里？
**A:** 列表缩略图 + 两处大图（DocRow 行内缩略图→大图弹窗；分块弹窗 56px 点击升级为同一弹窗）
**Ambiguity:** 55%（①已 0.9，瓶颈转移到②；Goal: 0.55, Constraints: 0.30, Criteria: 0.20, Context: 0.85）

### Round 3
**Q:** 问答召回侧，图片查看的入口和范围怎么定？（「图片目录」词义确认）
**A:** 胶囊带缩略图（点击缩略图→大图弹窗；不做回测页）
**Ambiguity:** 46%（Goal: 0.85, Constraints: 0.30, Criteria: 0.20, Context: 0.85）

### Round 4（Contrarian）
**Q:** 弹窗大图用什么数据源？（512px 拉全屏会糊 vs 原图直出的体积与安全代价）
**A:** 高清压缩图（kbChunkMedia 加尺寸参数 ~2048px q85）
**Ambiguity:** 38%（Goal: 0.85, Constraints: 0.60, Criteria: 0.20, Context: 0.85）

### Round 5
**Q:** PDF 页块要不要纳入本期查看范围？（代码核查：sharp 解不了 PDF，现状 PDF 块已图标兜底）
**A:** 只做图片文件，PDF 后续立项
**Ambiguity:** 33%（Goal: 0.88, Constraints: 0.70, Criteria: 0.20, Context: 0.88）

### Round 6（Simplifier）
**Q:** 查看弹窗的最小能力集怎么定？
**A:** 基础版 + 缩放（无翻页）
**Ambiguity:** 29%（Goal: 0.90, Constraints: 0.85, Criteria: 0.20, Context: 0.88）

### Round 7
**Q:** 5 条验收标准是否准确代表你想要的成果？
**A:** 5 条全部认可
**Ambiguity:** 11%（Goal: 0.92, Constraints: 0.88, Criteria: 0.85, Context: 0.90）✅ 低于阈值 20%

</details>
