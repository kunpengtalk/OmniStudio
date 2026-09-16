# Deep Interview Spec: 知识库多模态文件直嵌(图片/语音/视频)

## Metadata
- Interview ID: kb-multimodal-file-embed-20260914
- Rounds: 8(含 Round 0 拓扑门)
- Final Ambiguity Score: 15%
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
| Constraint Clarity | 0.88 | 0.25 | 0.220 |
| Success Criteria | 0.65 | 0.25 | 0.163 |
| Context Clarity | 0.92 | 0.15 | 0.138 |
| **Total Clarity** | | | **0.853** |
| **Ambiguity** | | | **15%** |

## Topology

| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| embedding-modality-detection | active | 嵌入模型模态能力判定:图片/语音/视频三个独立勾选,KB 级配置随建库快照,KB 设置可改;不探活、不名字分类 | 验收 ①③⑤ + Constraints |
| multimodal-direct-embed | active | 多模态直嵌管线:媒体与 OCR 文本联合嵌入(同一请求),按媒体单元一块;无 OCR 退化为纯媒体嵌入 | 验收 ①②⑤⑦ |
| av-file-intake | active | 音频/视频接入面:文件对话框与目录白名单扩音视频扩展名;三模态全做(生态风险知情接受) | 验收 ④ |
| local-mmproj-serving | active | 本地 mmproj 嵌入服务:识别 mmproj-*.gguf,嵌入实例启动匹配传 --mmproj(仅图片投影;音视频本地不支持) | 验收 ⑥ |
| retrieval-citation | active | 检索与引用展示:命中媒体块显示缩略图(图片)/图标+文件名(音视频)+ OCR 文本,点击打开原文件 | 验收 ⑦ |

## Goal

知识库添加文件时,当该库的嵌入模型被用户标记支持对应模态(图片/语音/视频)时,媒体文件不再走「VLM OCR → 纯文本嵌入」,而是把**媒体内容与 OCR 文本联合**(同一嵌入请求的多模态 content 数组)直接向量化入库;OCR 不可用时退化为**纯媒体嵌入**,不阻断入库。本地 llama.cpp 嵌入实例通过 mmproj 投影文件支持图片直嵌;语音/视频以自定义字节透传给远程嵌入服务。检索命中媒体块时展示缩略图/图标 + OCR 文本,聊天上下文注入使用 OCR 文本部分。

## Constraints

- **能力信号 = 用户手动勾选**(R2):图片/语音/视频三个独立勾选,**KB 级**配置,随建库与嵌入模型/地址/密钥一同快照入库(R7),建库后可在 KB 设置修改;不做运行时探活,不做名字模式分类
- **联合嵌入语义**(R1):先照常 OCR 成文本,嵌入请求里媒体 + 文本一起送(多模态 content 数组),向量由图文共同生成;**无 OCR 模型时仍可添加**——退化为纯媒体嵌入(文本部分为空)
- **按媒体单元一块**(R3):一张图片 = 一个块;PDF 一页 = 一个块(向量 = 该页图片 + 该页 OCR 文本);音频/视频整文件 = 一个块(R6 延伸)
- **首次导入即验证**(R4):勾选仅是声明;首次真实导入嵌入失败时明确报错并提示检查勾选/模型——失败可见可修复,不加专门探活机制
- **本地 mmproj 本期做**(R5):扫描识别 mmproj-*.gguf,嵌入实例(purpose=embedding)启动时自动匹配传 `--mmproj`;mmproj 仅支持图片投影——语音/视频本地不支持直嵌,相应勾选仅对远程嵌入地址有意义(UI 需明示)
- **三模态全做**(R6,知情决策):音频/视频以自定义字节透传给远程嵌入服务;接受生态不成熟、本地不可验证的代价;透传 JSON 形态由方案阶段按主流惯例定
- **聊天注入**:命中媒体块注入聊天上下文的仍是 OCR 文本部分;纯媒体块(无文本)不注入正文、仅可作引用
- **继承既有硬约束**:不改 `resolveEmbeddingBase` 四层链语义、不改 `createKb` 既有快照字段的行为(新增字段按同一快照模式扩展)、gateway 对 `/v1/embeddings` 的 JSON 透传行为保持

## Non-Goals

- 不做能力自动探活(勾选时/建库时发测试图)与名字模式分类判定
- 不做音频转写(whisper/ASR → 文本)入 KB 路径
- 不做视频关键帧拆解入 KB(整文件单块透传,不拆帧)
- 不做重排模型的多模态适配
- 不改纯文本文件/笔记/网页的现有摄取管线
- 不做能力勾选的全局默认与建库覆盖链(仅 KB 级)
- 不做媒体块的内嵌播放器(音频/视频命中只显示图标+文件名,不内嵌播放)

## Acceptance Criteria

- [ ] ① 勾「图片」的 KB + 本地嵌入实例(带 mmproj)→ 添加 PNG:产生**单个**媒体单元块,向量 = 图文联合嵌入;文档列表该块显示图片缩略图,OCR 文本可见,点击可打开原文件
- [ ] ② 同库但 OCR 端点不可用(未配置/调用失败)→ PNG 仍成功入库:纯图片嵌入(无文本部分),不阻断
- [ ] ③ 未勾「图片」的 KB → PNG/PDF 走今天的 OCR→文本→切块路径,行为与现在**完全一致**
- [ ] ④ 勾「语音」「视频」的 KB + 远程嵌入地址 → 添加 mp3/mp4:整文件单块,字节透传嵌入;命中展示图标+文件名;本地嵌入地址下勾选语音/视频时有「本地暂不支持」明示
- [ ] ⑤ 首次导入嵌入失败(勾错/模型拒收)→ doc 进入失败态,错误信息明确提示检查能力勾选与模型
- [ ] ⑥ mmproj 识别:模型目录存在 mmproj-*.gguf → 嵌入实例启动参数带 `--mmproj`;不存在 → 参数不变,行为与今天一致
- [ ] ⑦ 聊天检索:文本 query 经同一嵌入模型可命中媒体块(跨模态);引用 = 缩略图/图标 + OCR 文本;上下文注入 = OCR 文本
- [ ] ⑧ 回归:文本文件/笔记/网页管线不变;未勾任何模态的 KB 与今天行为逐字节一致;全套测试 0 失败,typecheck clean

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 「向量化」= 跳过 OCR 纯图片嵌入 | OCR 文本已可检索,混合还是替代? | 用户选:图文混合(同请求联合嵌入,R1);并补充无 OCR 时仍可添加(纯媒体退化) |
| 能力信号可自动判定 | 探活/名字分类/手动? | 用户选:用户手动指定(R2) |
| 勾选即信任 | 勾错了怎么办(Contrarian)? | 用户选:首次导入即验证,失败可见(R4) |
| 本地实例能直嵌 | llama.cpp 不传 mmproj、文件不被扫描 | 用户选:本期做 mmproj 识别+传参(R5) |
| 三模态都是真需求 | 生态现实:音视频嵌入模型几乎为零(Simplifier) | 用户知情选择:三模态全做,音视频远程透传(R6) |
| 勾选放全局 | 快照语义怎么对齐? | 用户选:KB 级随建库快照,KB 设置可改(R7) |
| 命中展示完整预览 | 信息量 vs 实现面? | 用户选:缩略图+OCR 文本,点击打开原文件(R8) |

## Technical Context(brownfield)

- **唯一分流点**:`apps/studio/src/bun/kb-ingest.ts:87-109` `extractFileText`——文本扩展名直读;PDF/图片 → `convertFileToImages` → 逐页 VLM OCR(`generate()`,kb-ingest.ts:101-106)→ 拼文本;音视频无分支(目录白名单 `KB_FOLDER_FILE_RE` 在 **knowledge.ts:139-140**,过滤点 :437,只收文本+PDF+图片;单文件进来在 sharp loadImage 抛错)
- **嵌入调用纯文本**:`apps/studio/src/bun/embeddings.ts:57-95` `callEmbeddings`,请求体 `{model, input: string[]}`(:69),120s 超时;base 解析 `resolveEmbeddingBase`(:37-47)四层链
- **无任何能力判定**:全库无 detectVision/isMultimodal;`classifyModelName`(shared/modelscope.ts:350-541)分类无 vision/modality 位;`InstalledModel`(modelscope.ts:260-272)无 modality 元数据
- **本地服务**:`runtimes/llama.ts` 嵌入模式追加 `--embeddings --pooling`(272-278);从不传 `--mmproj`(唯一相关 `--no-mmproj-offload` :284-286);model-scan 不识别 mmproj-*.gguf;嵌入实例判定 model-servers.ts:469-478(purpose=embedding,仅 llama.cpp)
- **OCR 端点解析**:`ocrEndpoint()` kb-ingest.ts:70-85——OCR 云厂商 > remote VLLM_API_BASE > 本地活动端口;端点无视觉能力从不校验,失败 → throw「OCR 识别失败」
- **DB schema**:knowledge_bases(db/schema.ts:451-481,embeddingModel/Base/ApiKey/Dim 快照);knowledge_docs(:483-520,kind=file|note|web);knowledge_chunks(:522-544,content/headingPath/embedding)——均无 modality/媒体字段,需扩展
- **UI**:docs-tab.tsx:318-328 accept 列表(含 8 种图片扩展名,无音视频);UI 不分流,全部走 `kbAddFiles` RPC(rpc/index.ts:4432);新建弹窗 KbCreateDialog(kb/index.tsx:44)与 KB 设置为勾选接入点;引用展示现状=文档名›标题路径+块文本
- **gateway**:`gateway.ts:1348-1384` handleEmbeddings 原样透传 JSON body(多模态 content 数组可自然通过,无需改)

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| 嵌入模型·模态能力 | core domain | 支持图片/语音/视频(三个独立布尔) | 由用户勾选声明;随建库快照;门控直嵌路由 |
| 媒体单元块 | core domain | 媒体引用(路径/页号), OCR文本, 混合向量 | 一图/一页/一音视频文件 = 一块;命中产生引用 |
| 图文混合嵌入请求 | core domain | content 数组(媒体 base64 + 文本) | 送往 KB 快照的嵌入地址;无 OCR 时退化为纯媒体 |
| 能力勾选(KB级) | core domain | 图片/语音/视频三布尔 | 建库弹窗+KB 设置写入;首次导入验证 |
| mmproj 投影文件 | supporting | mmproj-*.gguf 路径 | 嵌入实例启动匹配传参;仅图片投影 |
| KB 媒体文件 | supporting | 路径, 类型(图/音/视频), 扩展名白名单 | 接入面(accept/目录白名单)扩音视频 |
| 无 OCR 回退 | supporting | 纯媒体 content 数组 | OCR 不可用时替代混合嵌入,不阻断 |
| 检索引用(媒体) | supporting | 缩略图/图标, 文件名, OCR文本 | 命中展示;聊天注入只用 OCR 文本 |
| OCR 端点 | supporting(既有) | base/apiKey/model | 联合嵌入的文本来源;不可用时触发回退 |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 6 | 6 | - | - | N/A |
| 2 | 7 | 1 | 0 | 6 | 86% |
| 3 | 8 | 1 | 0 | 7 | 88% |
| 4 | 8 | 0 | 0 | 8 | 100% |
| 5 | 8 | 0 | 0 | 8 | 100% |
| 6 | 9 | 1 | 0 | 8 | 89% |
| 7 | 9 | 0 | 0 | 9 | 100% |
| 8 | 9 | 0 | 0 | 9 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (8 rounds + Round 0)</summary>

### Round 0(拓扑门)
**Q:** 拓扑确认:5 个顶层组件(①嵌入模型模态能力判定 ②多模态直嵌管线 ③音频/视频接入面 ④本地 mmproj 嵌入服务 ⑤检索与引用展示)?
**A:** 五组件正确,全部访谈

### Round 1
**Q:** 当嵌入模型支持图片时,往 KB 添加一张 PNG,新行为具体是什么?
**A:** 图文混合嵌入(选项3),且补充:无 OCR 模型时,仍然可添加到知识库
**Ambiguity:** 55%(Goal: 0.55, Constraints: 0.35, Criteria: 0.20, Context: 0.80)

### Round 2
**Q:** 「嵌入模型支持图片/语音/视频」这个门控信号从哪里来?
**A:** 用户手动指定
**Ambiguity:** 47%(Goal: 0.65, Constraints: 0.45, Criteria: 0.25, Context: 0.82)

### Round 3
**Q:** 图文混合嵌入与切块怎么组合?
**A:** 按媒体单元一块(一图一块,一 PDF 页一块)
**Ambiguity:** 41%(Goal: 0.75, Constraints: 0.50, Criteria: 0.30, Context: 0.85)

### Round 4(Contrarian)
**Q:** 手动勾选的能力标记需要系统验证吗?
**A:** 首次导入即验证——失败明确报错并提示检查,不加探活
**Ambiguity:** 36%(Goal: 0.78, Constraints: 0.62, Criteria: 0.32, Context: 0.86)

### Round 5
**Q:** 本地 llama.cpp 嵌入实例的多模态支持(mmproj)本期做吗?
**A:** 本期做 mmproj(识别 mmproj-*.gguf + 启动传参)
**Ambiguity:** 31%(Goal: 0.80, Constraints: 0.75, Criteria: 0.35, Context: 0.88)

### Round 6(Simplifier)
**Q:** 本期三模态做到哪一步?(生态现实:llama.cpp 仅图片投影;音视频嵌入模型几乎为零)
**A:** 三模态全做——音视频自定义字节透传给远程服务,知情接受生态风险
**Ambiguity:** 26%(Goal: 0.88, Constraints: 0.78, Criteria: 0.40, Context: 0.90)

### Round 7
**Q:** 图片/语音/视频三个能力勾选放在哪里配置?
**A:** KB 级,随建库快照,KB 设置可改
**Ambiguity:** 22%(Goal: 0.90, Constraints: 0.85, Criteria: 0.45, Context: 0.92)

### Round 8
**Q:** 检索命中媒体块时,引用与展示形态是什么?
**A:** 缩略图+OCR 文本(音视频=图标+文件名),点击打开原文件;聊天注入用 OCR 文本
**Ambiguity:** 15%(Goal: 0.95, Constraints: 0.88, Criteria: 0.65, Context: 0.92)✅ 低于阈值 20%

</details>
