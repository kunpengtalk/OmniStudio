# RALPLAN: 知识库多模态文件直嵌(图片/语音/视频)

Status: **PENDING APPROVAL**(v3,Architect 6 必改 + Critic 4 必改 + Codex 外评 3 必改全部并入;盲评独立进行、Planner 综合两轮)
Spec: `.omc/specs/deep-interview-kb-multimodal-file-embedding.md`(模糊度 15%,PASSED)
Branch base: `feat/embedding-serving`(含嵌入服务体系与建库预填)

## Requirements Summary

KB 添加文件时,当该库被用户勾选声明嵌入模型支持对应模态时:媒体文件不再走「VLM OCR → 纯文本嵌入」,而是**媒体 + OCR 文本联合嵌入**(同一请求 content 数组);OCR 不可用退化为**纯媒体嵌入**,不阻断入库。按媒体单元一块(一图/一页/一音视频文件)。三模态全接(音视频字节透传远程)。本地 llama.cpp 嵌入实例识别 mmproj-*.gguf 并传 `--mmproj`。命中展示缩略图/图标 + OCR 文本。未勾选的库行为与今天逐字节一致。

## RALPLAN-DR Summary

### Principles
1. **chunk 表是唯一汇合点**:摄取、索引、召回、引用、治理、**导出导入**都在 `knowledge_chunks` 汇合——多模态以「列扩展」落进块表,不开第二套媒体表/第二条检索链;**全部消费方逐一盘点**(v2:kb-index / listChunks / chunkRows / recallKb / exportKb / importKb / kb-mcp / agent-tools / backup,见步骤 2/5/7)
2. **单一解析点继承**:多模态嵌入复用 `resolveEmbeddingBase`/`embeddingHeaders`(embeddings.ts:37-54),不新建地址解析;请求体只在 `input` 字段形态上扩展
3. **能力是声明不是探针**:三布尔随建库快照、KB 设置可改;首次真实导入失败即暴露(错误信息指向勾选与模型),零探活设施
4. **零回归**:未勾任何模态的库、text/note/web 管线、未变化的分块复用逻辑,全部逐字节保持今天行为;「自动继承」的每条流经路径(相邻合并、MCP 输出、聊天注入、导出往返)都必须**显式契约化**而非依赖未测试的巧合(v2 钢人吸收)
5. **生态适配最小面**:mmproj 只做「扫描排除 + 嵌入实例注入」两件事;音视频透传不做本地转码/抽帧

### Decision Drivers
1. 用户主用**本地**嵌入实例(wemm@18190)——不打通本地 mmproj,特性对主场景无效(访谈 R5)
2. llama.cpp 生态已有图文联合嵌入先例(GME 类模型 + mmproj,llama-server `/v1/embeddings` 接受 content 数组)——本地路径真实可验证(步骤 0 spike 实证)
3. 用户知情接受音视频生态不成熟(R6)——透传设计把不可验证性隔离在「远程服务端行为」里,客户端只负责声明+送达+可见失败

### Viable Options

**Option A(选定):扩展现有管线**
- `knowledge_chunks` 加 `modality/mediaPath/mediaIndex` 三列;`knowledge_bases` 加三个模态布尔列
- `kb-ingest.ts` 摄取分支产「媒体单元块」;`embeddings.ts` 增 `callEmbeddingsMultimodal`(与 `callEmbeddings` 并列,共享解析与维度校验)
- `runtimes/llama.ts` 嵌入实例注入 `--mmproj`;`model-scan.ts` 排除 mmproj 文件
- Pros:索引/召回/引用/治理/导出导入全链路继承(经 v2 契约化修补);回归面最小;迁移是加列(默认值,旧行无感)
- Cons:块表变宽且出现合法空文本块(语义扩展);`embedDocChunks` 内部分叉(文本批 vs 媒体单条)

**Option B(否决):独立媒体块表 `knowledge_media_chunks`**
- 否决理由:kb-index 加载、召回合并、导出导入、引用组装全部双表改造——违反 Principle 1,回归面反而更大;媒体表演化自由(时长/缩略图缓存列)的收益不抵双链路维护成本
- 钢人合理内核已吸收(v2):空值契约显式化、相邻合并规则、MCP/聊天注入契约——见各步骤与风险表

**Option C(否决):媒体仅作展示附属,不进向量(只 OCR 文本)**
- 否决理由:即现状行为,直接违背规格核心目标(媒体内容参与向量化);规格 Round 1 用户已明确选图文混合

## Implementation Steps

0. **能力验证 spike(先行,硬门)** — 动代码前手工实证本地多模态嵌入链路:
   - GME 类图文嵌入 GGUF + mmproj-*.gguf 放模型目录;`llama-server -m model.gguf --mmproj mmproj.gguf --embeddings --pooling last`
   - 验证四点(v2 扩充):① `/v1/embeddings` 接受 `input: [{type:"image_url",...},{type:"text",...}]` content 数组;② `--embeddings --pooling last` 与 `--mmproj` 共存(buildArgs :272-278 固定追加前两者,组合必须成立);③ 文本 query 检索图片向量的跨模态命中质量(验收 ⑦ 前提);④ 单请求多 input 是否被拒(决定批语义取证)
   - **若不支持**:本地图片直嵌降级为「与音视频同款:仅远程」,计划口径收缩(勾选 hint 与验收 ⑥ 改口径),其余步骤不变。结论写进本节
1. **DB schema + 迁移** — `src/bun/db/schema.ts`:
   - `knowledgeBases`(:451-481)加 `embedImage/embedAudio/embedVideo` int notNull default 0(照 `mcpExposed` :476 模式)
   - `knowledgeChunks`(:522-544)加 `modality` text 可空("image"|"audio"|"video"|null)、`mediaPath` text 可空、`mediaIndex` int 可空(图片文件 0 / PDF 页 0 起 / 音视频 0)
   - `bun drizzle-kit generate` 生成迁移(进 `src/bun/db/migrations/`;启动时 db/index.ts:54-59 自动应用,迁移前备份已有);ADD COLUMN 带默认值,既有行回填 0/null
2. **共享类型与视图** — `src/shared/knowledge.ts` + `src/bun/knowledge.ts`:
   - `KbCitation`(:16-27)加 `chunkId?: number`、`modality?`;`KbHit`(:30-54)加 `modality?`
   - `KbView`(knowledge.ts:63)/`KbUpdatePatch`(:121)加三布尔(kbToView :223 做 int→bool)
   - **v2 必改:Critic-2** `KbChunkView`(knowledge.ts:109-119)加 `modality/mediaPath/mediaIndex`;**SELECT 加列点名**:`listChunks`(knowledge.ts:540)、`chunkRows`(knowledge.ts:1048,KbHit 组装源)、`recallKb`(:954)三处查询必须取新列——否则 modality 根本到不了 RPC 层
3. **createKb/updateKb** — `src/bun/knowledge.ts`:
   - `createKb`(:245-272)input 加三布尔(显式传入默认 false;**不**从全局默认继承——全局无此配置)
   - `updateKb`(:278-319)patch 加三布尔,**模态勾选变更不触发** `embeddingChanged` 向量重置(:298-301 不动——模型没换向量仍可比;已入库媒体文件需手动重导入才走新路径,设置页 hint 说明)
   - **v2 必改:Arch-6/Critic-3** 目录导入白名单 `KB_FOLDER_FILE_RE` 在 **knowledge.ts:139-140**(非 kb-ingest.ts;过滤点 :437,错误文案 :445「支持文本 / Markdown / PDF / 图片」同步改)——扩音视频扩展名
4. **多模态嵌入客户端** — `src/bun/embeddings.ts` 新增 `callEmbeddingsMultimodal(cfg, inputs: EmbeddingInput[]): Promise<Float32Array[]>`(**v4 终版协议,spike 三轮迭代**):
   - `EmbeddingInput = { imageB64?: string; audioB64?: string; audioFormat?: string; videoB64?: string; videoFormat?: string; text?: string }`
   - **形态自适应**:①首次对某 base 先 `GET {base}/props`(短超时)读 `media_marker`(llama.cpp 每进程随机)→ 命中则用 **llama.cpp 形态**:`{model, input: [{prompt_string: "<marker>(+空格+text)", multimodal_data: [裸 b64]}]}`;②props 无响应(普通 OpenAI 兼容远程)→ **content 数组形态**(image_url/input_audio/input_video + text part);③所选形态 4xx/5xx → 换另一形态重试一次;④按 base 缓存 {形态, marker},marker 失效(服务重启换随机串)自动重取;**data-URI 字符串形态已证伪删除**(llama.cpp 会当文本编码,假成功)
   - 联合单向量:llama.cpp 形态 = prompt_string `<marker> 文本`(实测 326+3=329 tok);content 形态 = [image part, text part]
   - 多 input 单请求可行但维持逐条发送(内存与失败定位);**本地多模态嵌入要求 llama.cpp 较新版本**(b9410 会 SIGTRAP 崩,详见 Spike 记录)
   - 复用 `resolveEmbeddingBase`(:37-47)/`embeddingHeaders`(:49-54);维度校验照 :88-90 抄;**`callEmbeddings` 本体零改动**(纯文本路径与多模态共存已实证)
5. **摄取管线** — `src/bun/kb-ingest.ts` + `knowledge.ts`:
   - 新 `fileModalityOf(ext): "text"|"image"|"audio"|"video"`;音视频扩展名常量与 UI accept 单一来源(放 shared)
   - `processDoc`(:184-286)ingest 分支:file kind 按 modality 分流——
     - `text`:今天路径原样(`extractFileText` :87-109 不动)
     - `audio|video`:kb 对应 flag 未开 → `throw`「该库未启用{语音|视频}直嵌(知识库设置 → 模态能力)」;开了 → 单 unit `{bytes, text:"", index:0}`,**不走 OCR**
     - `image` 且 `kb.embedImage`:`convertFileToImages`(vllm/input.ts:122-149)→ 逐页 OCR(照 :101-106 循环,**单页失败不再 throw**,text 降级 "")——**v2 必改:Arch-2 媒体分流显式绕过 :209 的空文本 throw**(纯媒体块合法,否则验收 ② 跑不通)。**绕过落点(v2.1,Codex 追评补死):分流发生在 processDoc 顶层、:207 调用 `extractFileText` 之前**——`processDoc` 读 `doc.sourcePath` 扩展名 + kb 三布尔,命中媒体模态且 flag 开启时走新的 `extractMediaUnits(doc.sourcePath, kb)` 路径,根本不调用 `extractFileText`、不经过 :209 判空;`extractFileText` 本体零改动,文本路径 :198-209 原样
   - 媒体 units → 每 unit 一行 chunk:`content` = OCR 文本(可为空串)、**`headingPath/charStart/charEnd` 落 null/null/null(v2 契约)**、`modality/mediaPath/mediaIndex` 落列、`contentHash` = hash(`modality|mediaPath|mediaIndex|text`);`seq` 照常 1 起
   - **doc 级 skip 判定(v2 必改:Arch-2)**:媒体 doc 的 :211-222 skip 条件**纳入 sourceMtime + sizeBytes 比对**(schema :508 已有列)——文件字节被替换而 OCR 输出巧合不变时必重建,杜绝旧向量错误复用
   - `embedDocChunks`(:321-370):while 批循环 limit 32 取出的**混合行按 modality 分组**——文本行照旧批 32 `callEmbeddings`;媒体行逐条 `callEmbeddingsMultimodal`(input=`{...b64, text: content 非空 ? contextText(docName, null, content) : undefined}`);`vectors` 对位按组分段。**首个媒体行失败 → 错误信息前缀「嵌入服务拒绝了多模态输入,请检查该库的模态勾选与嵌入模型」**(验收 ⑤)
   - 媒体文件大小上限:音视频 **100MB**(v2 收紧:base64 1.33× + JSON.stringify 峰值 ≈ 2.7×,200MB 单请求内存尖峰 540MB 不可接受)、图片沿用现状;超限 throw 明确错误
6. **本地 mmproj 服务** —
   - `src/bun/runtimes/llama.ts` `buildArgs`(:188-292):`embedding`(purpose)且 `model.kind==="local"`(:222-226;**model 对象来自 llama.ts:135-160 `resolveModel`(v3 行号修正:不在 model-servers.ts),local kind 才有 path,hf ref 走 :225 `-hf` 分支互斥**)时,`readdirSync(dirname(model.path))` 找 `/^mmproj-[^/]*\.gguf$/i` → `args.push("--mmproj", 该文件)`;**多文件选择规则(v2)**:`mmproj-f16` 优先,其余字典序首个,CHANGELOG 说明;找不到不传(行为不变);聊天实例永不注入;与 `SERVER_EXTRA_ARGS`(:288-289)用户手传重复的风险记入风险表
   - **v2 必改:Arch-3** `model-scan.ts` 排除落点:**`walkModelTree` 逐文件收集处(:316-318 files.push)**,mmproj-*.gguf 不作为已安装模型列出;**不动 `walkWeights`(:229-266)**——它服务仓库目录 files[] 聚合与 HF cache(:287/:468),在那里排除会让市场页「已下载」判定回归
7. **RPC** — `src/bun/rpc/index.ts`:
   - `kbCreate`(:1982)/`kbUpdate`(:1986)params 加三布尔;响应类型经 AppRPC 自动派生到 mainview(无需手改 rpc.ts,v2 修正措辞)
   - `kbDocList`/`kbChunks`/`kbRecall`(:4458)响应透传 chunk 级 `modality/mediaPath/mediaIndex`(数据源=步骤 2 的三处 SELECT);`KbCitation` 组装点带 `chunkId+modality`
   - 新 RPC `kbChunkMedia({chunkId}) → {dataUrl, modality, fileName}`:图片 → sharp 缩略(最长边 ≤512,JPEG q80)→ data URL;音视频返回 `{dataUrl:null, modality, fileName}`(UI 图标+文件名);**复用既有 `openPath` RPC(:513/:2787)打开原文件,不新增**(v2 修正)
8. **建库弹窗** — `src/mainview/app/kb/index.tsx` `KbCreateDialog`(:44-151):嵌入模型选择区下加三个勾选(图片/语音/视频),提交进 `kbCreate`;语音/视频勾选旁**静态 hint**「本地 llama.cpp 暂不支持语音/视频直嵌,需远程嵌入服务」(零逻辑)
9. **KB 设置页** — `src/mainview/app/kb/settings-tab.tsx`(form :44-70,提交 :362-367):三勾选 + 同款 hint + 「模态能力变更后需重新导入媒体文件才生效」说明
10. **文档/命中展示** —
    - `src/mainview/app/kb/docs-tab.tsx`:accept(:318-328)扩音视频;分块视图 `modality` 块:图片 lazy 拉缩略图(kbChunkMedia + TanStack cache),音视频图标+文件名;点击 `openPath` 打开原文件
    - `src/mainview/app/kb/recall-tab.tsx`:命中块 modality 同款标识
    - `src/mainview/app/chat-screen.tsx` `CitationBar`(:269-):modality 显示类型图标,悬浮 snippet 照旧
    - **v2 必改:Critic-4 聊天注入契约**:`buildChatContext`(knowledge.ts:1122-1152)对空 content 媒体命中**保留编号引用行、正文行为空**——对齐规格「纯媒体块不注入正文、仅可作引用」
    - **v2 必改:Arch-5/Critic-5 MCP 输出契约**:`kb-mcp.ts` kb_search(:101-104 hits.map 行)与 `agent-tools.ts` knowledge_search(:692-697 formatted map)对媒体命中加「[图片]/[音频]/[视频] 文件名」标记 + OCR 文本,防空正文空呈现(v3 行号校准;gateway.ts:2317 仅路由 /mcp,kb_search 实现确在 kb-mcp.ts)
    - **相邻合并规则落点(v3 必改:Codex-1)**:`mergeNeighbors` 在 **knowledge.ts:903**(kb-index.ts 无合并逻辑),被 recallKb :1041 调用;规则落在其 `groups.find` 谓词(:907-913):`g.head.modality || hit.modality` 非空即不并组(开新组)——媒体块单块成组
11. **导出导入(v2 必改:Arch-1/Critic-1,数据损坏路径)** — `src/bun/knowledge.ts`:
   - `KbExportPayload`(:1179-1224)补 KB 三布尔与 chunk 三列(可选字段向后兼容,`?? null`/`?? 0` 读取;KB_EXPORT_VERSION :1177 现=1,提升为 2)
   - `exportKb`(:1225-1285,chunk 组装 :1267-1277)/`importKb`(:1311 起)逐字段映射补齐
   - **关键防损坏(v3 措辞精化:Codex-4)**:importKb 既有入队点在 knowledge.ts:1419(`enqueueDoc`);**新增 chunk-scan 必须放在 enqueueDoc 之前**——doc 内存在 modality 非空且无向量的块时逐块检查 mediaPath:文件存在 → 正常 `enqueueDoc`(kind=embed),由步骤 5 的 `embedDocChunks` 按 modality 路由多模态;**任一文件缺失(跨机导入)→ 该 doc 置 failed,错误「媒体文件缺失:<path>」,不入队**——绝不把空 content 媒体块当纯文本嵌成静默错误向量(若 scan 放在入队之后,错误语义会错成「嵌入失败」而非「媒体文件缺失」)
12. **i18n** — `src/shared/i18n.ts`:kb.create.embedImage/Audio/Video + localOnlyHint;kb.settings 同款 + 变更后需重导说明;kb.docs.mediaChunk 标签;错误文案(未启用直嵌/超限/多模态被拒/媒体文件缺失)
13. **测试** —
    - bun:模态路由(音视频无 flag 拒/有 flag 单 unit 零 OCR;图片 flag-on 逐页 unit、单页 OCR 失败降级空文本;flag-off 走老路径);`:209` 绕过(纯媒体块不 throw);doc skip 纳入 mtime/size(换文件字节 OCR 巧合同 → 重建);`callEmbeddingsMultimodal` 请求体形态(单 unit content 数组)+ 维度校验 + 错误前缀 + 重试 3 次错误信息不变(mock fetch);`buildArgs` mmproj 注入(有/无/多文件选 f16/非 embedding 不注);model-scan 排除且仓库 files[] 不受损;`createKb/updateKb` 三布尔快照与不重置向量;**相邻合并:媒体块单块成组不并入**(mergeNeighbors knowledge.ts:903 谓词);**导出导入往返:媒体块字段 + 三布尔 + 缺失媒体文件 → doc failed(错误语义=媒体文件缺失,非嵌入失败)**;MCP/agent-tools 输出标记;**媒体块文件名 token 关键词命中(headingPostings,文件名 query 可命中空文本媒体块)**;迁移后既有行默认 0
    - webview:create-dialog 三勾选入参;settings-tab patch;docs accept 含音视频
    - mock 隔离沿用 `.tests.ts` 子进程先例(model-store.embedding.test.ts:4-13)
14. **CHANGELOG** 条目(含声明式配置说明、mmproj 选择规则、模态勾选变更需重导)

## Spike 实测记录(步骤 0,2026-09-14,llama-server b9410 brew + b10964 源码编译对照)

**最终协议(三轮迭代后落定)**:
1. `GET {base}/props` → `media_marker` 字段——**每进程随机**(默认 `<__media_<random>__>`,可用 `LLAMA_MEDIA_MARKER` env 钉死);字面量硬编码 `<__media__>` 必失败(mtmd 报「number of media markers in text (0) does not match number of bitmaps」)
2. `POST /v1/embeddings`,`input: [{ prompt_string: "<marker>" (+可选空格+文本), multimodal_data: ["<b64 裸 base64>"] }]`;多个媒体=多个 marker 出现串里+多个 b64;**OpenAI content 数组被 llama.cpp 拒(500)**;**data-URI 字符串被当纯文本编码(假阳性死亡路径)**——b64 长度与 token 数 0.63-0.73 tok/char 线性、同像素 JPEG/PNG token 数不同,实锤
3. 联合(图+文单向量):prompt_string = `<marker> 文本`(实测 326+3=329 tok);退化纯媒体:prompt_string 仅 marker
4. 多 input 单请求 ✅(2 图 490 tok);维度 1536(GME-Q4_K_M)

**版本要求(硬)**:brew b9410 协议可走通但 **512px 照片直接 SIGTRAP 崩服务**(mtmd×embeddings 旧实现不稳;PaddleOCR 同崩);b10964 三图全稳。**本地多模态嵌入要求 llama.cpp 升级**(用户环境动作:brew upgrade llama.cpp;应用文档/CHANGELOG 注明最低版本)。Runtimes 侧无代码依赖该事实——`--mmproj` 注入两版通用。

**跨模态质量(点③)**:GME-Qwen2-VL-2B Q4_K_M、512px 真实图(logo/照片/图表),裸 query 2/3 top-1 正确(logo/chart ✅,photo 弱)——机制成立(图像内容真实进入向量,logo 与 chart 可被文本检索);绝对相似度差距温和(0.2 vs 0.17),生产检索质量取决于模型与量化,非协议问题。**结论:PASS(带模型依赖注记)**

**副产物**:llama-server 内置 HF 下载器不走 HTTPS_PROXY(直连挂死)——应用先下载再 `-m` 启动的既有模式正确;GME 下载耗时 17 分钟(12 路并行分片经代理,~2.3MB/s);Qwen-VL 系 mmproj worst-case 内存 ~1.5GB(日志)。

## Acceptance Criteria(承接规格 ①-⑧)

- [ ] ① 勾「图片」KB + 本地嵌入实例(模型目录有 mmproj-*.gguf)→ 添加 PNG:单块(modality=image),向量来自图文联合请求(断言请求体含 image_url+text 两个 part);块内容=OCR 文本,展示缩略图
- [ ] ② 同库 OCR 不可用 → PNG 仍入库:单块纯图嵌入(请求体仅 image part),OCR 文本空串,**不触发 :209 空文本 throw**
- [ ] ③ 未勾「图片」库 → PNG/PDF 走 `extractFileText` OCR 路径,块行无 modality,行为与今天一致
- [ ] ④ 勾「语音」「视频」+ 远程嵌入 base → mp3/mp4 各产 1 块(input_audio/input_video 透传,断言请求体);本地地址勾选有静态 hint;未勾选的库添加音视频 → 明确报错;超 100MB → 明确报错
- [ ] ⑤ 首个媒体块嵌入失败 → doc failed(经 MAX_ATTEMPTS=3 退避重试后),错误信息含「检查模态勾选/嵌入模型」且重试间不变(v2)
- [ ] ⑥ 模型目录有 mmproj-*.gguf → 嵌入实例启动参数含 `--mmproj`(多文件 f16 优先);无 → 不含;聊天实例永不注入;**hf ref(-hf 下载)嵌入模型不注入(已知边界)**;mmproj 文件不出现在模型列表且仓库 files[] 判定不受损
- [ ] ⑦ 文本 query 命中媒体块:KbHit 带 modality(经 chunkRows SELECT);回测页与文档块列表显示缩略图/图标+文件名;聊天 CitationBar 图标+snippet;**空 content 媒体命中注入=编号行+空正文**;kb_search/knowledge_search 输出带 [图片] 类标记
- [ ] ⑧ 回归:text/note/web 管线不变;未勾选库逐字节一致;**相邻合并对既有文本块行为不变,媒体块单块成组**;既有测试全绿;全套 0 失败;typecheck clean
- [ ] 导出→导入往返:媒体块三列与 KB 三布尔无损;无向量媒体块重嵌入走多模态;**mediaPath 缺失 → doc failed 带路径,零静默错误向量**(v2)
- [ ] 硬约束零改动:`resolveEmbeddingBase`/`callEmbeddings` 本体/`globalEmbeddingDefaults`/`createKb` 既有快照语义/gateway 透传;`runtimes/llama.ts` 仅新增 mmproj 注入分支(本特性显式授权范围)

## Risks and Mitigations(v2 修订)

| 风险 | 评估与缓解 |
|------|-----------|
| **llama.cpp 多模态嵌入能力未实证**(spike 未跑前) | 步骤 0 硬门验四点;不支持则本地图片降级远程-only,口径收缩,不做死设计 |
| **导出导入数据损坏路径**(v2 双评审交叉命中) | 步骤 11 显式契约:modality 非空无向量块按媒体路径重嵌;文件缺失 → doc failed 可见;测试锁定 |
| wemm 无现成 mmproj 文件 | 用户自行下载放模型目录(unsloth 等发布 GME 类附带);hint/CHANGELOG 说明 |
| 大文件内存尖峰(base64 1.33× + stringify 峰值 ≈2.7×) | 音视频上限 100MB + 逐条发送 + 超限明确报错(v2 从 200MB 收紧);图片经 sharp 重编码 |
| OCR 静默降级(直嵌模式单页 OCR 失败→空文本) | 规格 R1 决策;块文本空在 UI 可见;无 OCR 多页 PDF 在相邻合并开启时**媒体块单块成组不并成单条空命中**(v2 契约化) |
| 媒体块关键词语义(**v3 修正:Codex 证伪「天然跳过」**) | 空 content 媒体块仍会经 docName 的标题 token(kb-index.ts:108-113 `tokenizeHead(contextText(docName,null,""))` → headingPostings,HEADING_WEIGHT)被**文件名命中**——视为特性(按文件名找图合理),正文 token 无;OCR 文本非空时正文照常参与;tokenJaccard 空集返 0,无误去重 |
| 仓库目录/HF cache 布局下 repos[].files 仍含 mmproj(v3:Codex 残留) | `walkWeights` 保持不动(保市场页「已下载」判定);mmproj 混入仅影响仓库成员列表展示与体积估计,不会被当模型启动;CHANGELOG 说明排除只对平面目录生效 |
| `--mmproj` 与 `--no-mmproj-offload` 耦合(默认 true,llama.ts:50) | 同时存在时 mmproj 走 CPU——功能正确但投影慢;CHANGELOG 提示关闭 no-mmproj-offload 获 GPU 投影;后续可条件互斥(Follow-up) |
| `--mmproj` 与 `SERVER_EXTRA_ARGS` 手传重复 | 启动失败即 llama-server 报错可见;风险表声明 + CHANGELOG 提示去掉手传 |
| `-hf` 下载的嵌入模型不注入 mmproj(仅 local kind) | Non-Goal 显式声明(llama.cpp -hf 自管缓存,应用不知路径);hint 引导用本地文件 |
| minScore 过滤可能丢弃跨模态低分命中 | 默认 minScore=0 不过滤;风险表声明,用户自查 |
| 媒体 chunk 复用判定 | contentHash 含 modality+path+index+text;doc 级 skip 加 mtime/size(v2) |
| 嵌入 ctx 溢出(大图 token 超限) | 嵌入 batch=ctx(llama.ts:218);报错即首导验证路径 |
| mock 泄漏 | `.tests.ts` 子进程隔离先例 |

## Verification Steps

1. 执行前先重跑基线:`cd apps/studio && bun test`(当前 729/0,若有漂移以实测为准)→ 完成后全套 0 失败(预期 760+)
2. `cd apps/studio && bun run typecheck` clean
3. `git diff --stat` 确认零改动文件清单:embeddings.ts(仅新增函数)/ gateway.ts / db/settings.ts / resolveEmbeddingBase 与 callEmbeddings 本体;允许区:runtimes/llama.ts 仅 mmproj 分支
4. 手动:GME 类模型+mmproj 起嵌入实例 → 建库勾「图片」→ 导 PNG(断 18190 日志含 image_url)→ 回测命中 → 缩略图;未勾库导同图 → OCR 路径如旧;导出→导入往返字段无损
5. 迁移回归:旧库 DB 启动 → 自动迁移,既有库三 flag=0,行为不变
6. (spike 结论)步骤 0 四点验证记录附于计划尾部

## ADR

- **Decision**: Option A 扩展现有管线——chunk 表加 `modality/mediaPath/mediaIndex` 三列 + KB 三布尔;`callEmbeddingsMultimodal` 与 `callEmbeddings` 并列;mmproj 仅嵌入实例注入;媒体块空值契约与全部流经路径显式化
- **Drivers**: 本地主场景必须打通(mmproj);chunk 唯一汇合点;零回归;生态适配最小面;声明式能力 + 首导可见失败
- **Alternatives considered**:
  - Option B 独立媒体表——否决(kb-index/召回/导出/引用全双表改造,违反 P1)
  - Option C 媒体仅展示——否决(即现状,违背规格核心)
  - **钢人吸收**(Architect antithesis「空值实例污染强类型表,自动继承是流经未审视路径」):不换方案,把每条流经路径升为显式契约——空值落列(null/null/null)、媒体块单块成组、MCP/聊天注入标记、导出导入防损坏、:209 绕过、doc skip 加 mtime/size——每条一行测试锁定
- **Why chosen**: 回归面最小且消费方继承经契约化修补后语义完备;迁移加列安全;多模态客户端并列保住 callEmbeddings 硬约束
- **Consequences**: 块表语义扩展(合法空文本块);媒体块不参与相邻合并;导出格式版本升级(向后兼容);音视频上限 100MB;hf-ref 嵌入模型与聊天视觉模型均不含 mmproj(显式 Non-Goal)
- **Follow-ups**: 聊天视觉模型 mmproj 注入(独立特性);GME 类模型市场下载含 mmproj 配套引导;minScore 跨模态分数校准;探活结论复用(设置页/建库弹窗统一判据)

## Non-Goals(v2 补全)

- 不做能力自动探活与名字分类判定
- 不做音频转写(whisper/ASR→文本)入 KB;不做视频抽帧(整文件单块透传)
- 不做重排模型多模态;不改纯文本/笔记/网页管线
- 不做模态勾选的全局默认与覆盖链
- 不做媒体块内嵌播放器
- **hf ref(-hf 下载)嵌入模型不注入 mmproj**(llama.cpp 自管缓存,应用不知文件路径;引导用户用本地 GGUF 文件)
- **聊天视觉模型的 mmproj 注入划出范围**(现状聊天实例也从不传,独立后续工作,非遗漏)
- 不改 gateway `/v1/embeddings` 透传行为(content 数组天然通过)

---
## Changelog(共识过程修订)
- v1: Planner 初稿(2026-09-14)
- v2(综合 Architect SOUND-WITH-CONCERNS 6 必改 + Critic APPROVED-WITH-IMPROVEMENTS 4 必改,盲评独立进行、Planner 唯一综合):
  - 【交叉命中·必改】导出导入链路补全:KbExportPayload/importKb 三列+三布尔+空媒体块防静默错误向量+跨机 mediaPath 缺失可见失败(Arch-1=Critic-1)
  - 【必改】KB_FOLDER_FILE_RE 归属修正:knowledge.ts:139-140(非 kb-ingest.ts),目录过滤点 :437 与错误文案 :445 同步(Arch-6=Critic-3;错误源自规格,已同步修规格)
  - 【必改】model-scan 排除落点修正:walkModelTree :316-318 逐文件收集处,不动 walkWeights(防市场页「已下载」回归)(Arch-3)
  - 【必改】processDoc :209 空文本 throw 显式绕过;doc 级 skip 纳入 sourceMtime/size(Arch-2)
  - 【必改】媒体块空值契约(null/null/null)+ 相邻合并单块成组(Arch-4)
  - 【必改】kb-mcp/agent-tools 媒体命中标记(Arch-5=Critic-5)
  - 【必改】KbChunkView + listChunks/chunkRows/recallKb SELECT 加列点名(Critic-2)
  - 【必改】buildChatContext 空 content 媒体命中=编号行+空正文(Critic-4)
  - 【修正】音视频上限 200MB→100MB(内存尖峰);callEmbeddingsMultimodal 签名语义明确;复用 openPath;rpc 类型自动派生措辞;hf-ref/聊天 mmproj Non-Goal 显式;验收 ⑤ 重试语义;spike 扩为四点;硬约束文件清单化;执行前重跑基线
- v2.1(Codex 外评第一轮,会话截断但引用核实与两条发现有效):媒体分流绕过 :209 的落点补死(processDoc 顶层、:207 extractFileText 之前,extractFileText 本体零改动);exportKb 行号校准(:1225-1285);chunkRows :1048
- v3(Codex 外评第二轮完成,APPROVED-WITH-IMPROVEMENTS 3 必改 + 3 建议全并入):
  - 【必改:Codex-1】mergeNeighbors 文件归属修正:**knowledge.ts:903**(kb-index.ts 无合并逻辑),规则落在 groups.find 谓词 :907-913
  - 【必改:Codex-2】resolveModel 行号修正:**llama.ts:135-160**(非 model-servers.ts)
  - 【必改:Codex-3】**证伪「空 content 天然跳过关键词索引」**:tokenizeHead 对 contextText(docName,null,"") 仍从文件名拆标题 token 进 headingPostings——改语义为「文件名命中是特性」;测试补文件名关键词命中
  - 【建议并入】importKb chunk-scan 明确放在 enqueueDoc(knowledge.ts:1419)之前,错误语义=「媒体文件缺失」非「嵌入失败」;repos[].files 残留 mmproj 风险行;--mmproj 与 --no-mmproj-offload 耦合风险行;kb-mcp(:101-104)/agent-tools(:692-697)行号校准;消费方盘点经 Codex 全局扫描确认完整(backup 仅表名清单,CLI 无 kb 命令)
