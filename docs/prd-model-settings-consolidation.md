# 需求文档：模型管理功能整合（融入现有设置分区 + 左侧导航常驻）

- 版本：v2.0（重写，替代 v1.0「模型中心」方案）
- 日期：2026-09-10
- 原则：**不新增一级结构，整合融合现有功能**；左侧导航在任何页面切换时始终存在

---

## 1. 现有功能盘点（本次整合的对象）

### 1.1 设置页已有的模型相关分区

设置页（`apps/studio/src/mainview/app/main-layout/settings.tsx`）现有 12 个分区，其中 4 个与模型直接相关，**已经具备完整能力，是整合的"容器"**：

| 现有分区 | 组件 | 已有能力 |
|---|---|---|
| 本地模型 `model` | `LocalModelsScreen` | 已装模型列表、激活、删除、目录管理、服务器启停 |
| 模型商店 `store` | `ModelsScreen` | ModelScope/HF 搜索、选文件、下载（走 DownloadManager） |
| 模型市场 `market` | `MarketScreen` | 模型详情、预设模型下载 |
| 模型云服务 `network` | `CloudProviderPanel` | 云端厂商/自定义 provider 配置、连接检测、模型列表 |

### 1.2 业务页里"重复造"的模型管理（应被整合掉的部分）

| 业务页 | 重复的模型管理功能 | 与设置页哪个分区同构 |
|---|---|---|
| `image-screen.tsx` | MLX 引擎安装卡、MLX 模型下载/进度/已下载列表、API/ComfyUI 配置块 | 引擎卡 + 本地模型行 + provider 配置 |
| `voice-screen.tsx` | TTS 三来源（local/edge/compat）的引擎卡、模型行下载、provider 配置；ASR 三引擎（whisper/audiocpp/api）同样一套 | 与上面几乎完全同构 |
| `ocr/tesseract-tab.tsx` | 语言包下载/启用/删除（无进度）、引擎状态轮询 | 本地模型行 |
| `ocr/vlm-tab.tsx` | remote provider 配置块、local 复用聊天模型 | provider 配置 + 本地模型 |

这四个页面的模型行、引擎卡、provider 配置块**互为拷贝**（模型行 4 份、引擎卡 4 处、provider 配置块 4 份、进度条 5 处、`formatBytes` ≥4 份），本质上是「本地模型管理」和「provider 配置」在业务页的重复实现。

### 1.3 已有的可复用资产（不要重造）

- **DownloadManager**（`bun/download-manager.ts`）：统一队列、暂停/续传/并发，LLM、whisper ASR、audio.cpp TTS/ASR 模型已接入；全局下载面板 `DownloadsButton` 已挂在主布局头部
- **`ocr/parts.tsx` 的 `StatusCard`**：OCR 已抽出的引擎状态卡，是统一引擎卡的现成雏形
- **`LocalModelsScreen` 的模型行**：激活/删除/徽标/操作区，可作为统一模型行的基础
- **`CloudProviderPanel`**：已支持原厂 + 自定义 provider 的完整配置机制
- 设置数据链路：`getSettings`/`updateSettings` + react-query 缓存失效，所有页面已在用

### 1.4 导航现状与问题

主布局（`main-layout/index.tsx` L77–78）：进入 `settings` 路由时**隐藏主侧边栏**（`showSidebar = route.path !== "settings"`），设置页改用自己的内部分类导航（w-44）。但模型详情（`model-detail`）、商店（`models`）是**独立主路由**——从设置点进去后，设置的左侧分类导航整个消失，换成聊天侧边栏，再点回设置又切回来。**左侧菜单随点击跳变/消失，这就是"点到应用里左侧就没了"的根因。**

---

## 2. 问题总结

1. **功能分散且重复**：生图/TTS/ASR/OCR 的模型管理 UI 是「本地模型」「provider 配置」在业务页的 4 份拷贝。
2. **下载通道不统一**：MLX 权重走独立通道（`mlxModelDownloadProgress`）、OCR 语言包无进度，全局下载面板看不到它们。
3. **导航断裂**：设置 ↔ 模型详情/商店之间跳主路由，左侧菜单（设置分类导航 / 主侧边栏）来回切换甚至消失。

---

## 3. 整合方案

### 3.1 布局整合：左侧导航常驻（对应用户反馈，P0）

**目标：无论点到哪里，左侧菜单始终存在且不跳变。**

具体做法（复用现有布局，不改信息架构）：

1. `settings`、`models`、`model-detail` 三个路由统一由**设置壳（SettingsShell）**渲染：左侧固定为设置的分类导航，右侧为内容区。即 `main-layout/index.tsx` 中这三个路径不再走"隐藏侧边栏 / 显示聊天侧边栏"的分支，而是始终渲染 `<SettingsScreen />`，由其内部根据子路由显示列表或详情。
2. 模型详情从"主路由跳转"改为**设置内子页**：在设置壳内以内部状态（或路由参数）打开，左侧分类导航不动；返回即回到来源分区。
3. `AppRail`（最左侧图标栏）本来就一直存在，保持不变。

效果：进入设置后，左侧分类导航在 本地模型 / 商店 / 市场 / 详情 / 网关 / 日志 之间切换时**永远固定**。

### 3.2 功能整合：把业务页的模型管理并入现有分区

**不新增分区**，扩展现有两个分区的覆盖面：

**A. 「本地模型」分区（`LocalModelsScreen`）→ 按能力分组的统一管理**

- 现有：只列聊天 LLM。
- 整合后：列表按能力分组 —— **聊天 / 生图 / 语音合成 / 语音识别 / 文字识别**。
  - 生图组：MLX 已下载模型（`getDownloadedMlxModels`），行操作：设默认 / 删除；组顶部放 MLX 引擎状态卡（迁移自 `image-screen.tsx`，复用 `StatusCard` 样式）。
  - 语音合成组：audio.cpp TTS 模型行 + 引擎卡（迁移自 `voice-screen.tsx` 的 `LocalModelRow`）；vLLM 部署类 TTS（`listTTSModels`）同组展示，启停/删除操作不变。
  - 语音识别组：whisper 模型行 + whisper 引擎卡、audio.cpp ASR 模型行（迁移 `AsrModelRow`/`AsrAudioCppModelRow`）。
  - 文字识别组：Tesseract 语言包行（迁移 `LangModelRow`），并**补上进度条**（见 3.3）；VLM local 模式在此提示"使用聊天模型"，链接到聊天组。
- 四份近同构模型行合并为**一个模型行组件**（在 `LocalModelsScreen` 现有行的基础上扩展：分组标题 + 引擎卡插槽 + 下载进度），业务页四份拷贝删除。

**B. 「模型商店 / 模型市场」分区（`ModelsScreen` / `MarketScreen`）→ 全能力下载入口**

- 现有：只搜/下聊天与通用模型。
- 整合后：增加**能力分类**（聊天/生图/语音/识别/OCR），把目前只有业务页才知道的模型目录接进来：
  - MLX 生图模型目录（`listMlxGenModels`：FLUX、Z-Image）
  - vLLM TTS 模型目录（`TTS_MODEL_CATALOG`）、audio.cpp TTS/ASR 目录、whisper ASR 预设（`ASR_PRESETS`）
  - OCR 语言包目录（`OCR_LANG_CATALOG`）
- 这些目录数据后端都已存在，只是前端入口在业务页；迁移后商店成为唯一下载入口，业务页不再出现下载按钮。

**C. 「模型云服务」分区（provider 配置机制复用）**

- `image-screen` 的 API/ComfyUI 配置、`voice-screen` 的 TTS compat / ASR api 配置、`vlm-tab` 的 OCR remote 配置，是 4 份同构表单（Base URL + Key + 模型 + 保存 + 拉取模型列表）。
- 整合方式：在「模型云服务」分区内**按能力分组**（聊天 / 生图 / 语音合成 / 语音识别 / 文字识别），每组复用现有的 provider 配置 UI 模式（厂商选择 + base/key/模型 + 连接检测），保存仍走各自已有的 `saveImageGenConfig` / `saveTTSProviderConfig` / `saveASRProviderConfig` / `saveOcrProviderConfig` RPC（**后端不变**）。
- 4 份表单合并为一个配置块组件。

**D. 业务页瘦身（image / voice / ocr）**

- 删除：引擎安装卡、模型下载/进度 UI、provider 配置块。
- 保留：已就绪模型的选择下拉、生成/合成/识别操作。
- 未就绪时：空状态 +「前往设置」按钮，跳转设置并**定位到对应分组**（设置壳支持 tab + 分组锚点参数，如 `settings?tab=model&group=tts`）。

### 3.3 下载通道整合（后端小改，前端无感）

- **MLX 权重下载**：`mlx-gen.ts` 的 Python 下载实现**不动**，只把进度上报适配为 DownloadTask 形态，并入 `modelDownloadProgress`/`downloadsChanged`；`mlxModelDownloadProgress` 通道与 `useMlxModelDownloadStore` 废弃。
- **OCR 语言包下载**：`downloadOcrModel` 增加字节进度回调，同样以 DownloadTask 上报，消灭"无进度 spinner"。
- 结果：所有下载（LLM/MLX/TTS/ASR/OCR）在全局 `DownloadsButton` 面板统一可见、可管理 —— 这是现有组件，直接受益，无需新做。

---

## 4. 详细需求

| 编号 | 需求 | 优先级 |
|---|---|---|
| F1 | 设置壳：settings/models/model-detail 路由统一渲染，左侧分类导航在所有这些页面间切换时始终固定存在 | P0 |
| F2 | 模型详情改为设置内子页，不再引起左侧导航跳变 | P0 |
| F3 | 「本地模型」分区按能力分组（聊天/生图/TTS/ASR/OCR），迁移业务页全部模型行与引擎卡，合并为单一模型行组件 + StatusCard | P0 |
| F4 | 「模型商店」增加能力分类，接入 MLX/TTS/ASR/OCR 模型目录，成为唯一下载入口 | P0 |
| F5 | 「模型云服务」按能力分组，4 份 provider 表单合并为一个组件迁移进去 | P1 |
| F6 | image/voice/ocr 业务页删除全部管理 UI，仅保留已就绪模型选择 + 未就绪空状态跳转设置（带 tab+group 定位） | P0 |
| F7 | MLX、OCR 下载进度并入 DownloadManager 通道，全局下载面板可见可管理 | P1 |
| F8 | `formatBytes` 等重复工具函数下沉为一份；删除 `useMlxModelDownloadStore` 等重复 store | P1 |
| F9 | 全部迁移后 i18n 文案补齐（`shared/i18n.ts`），现有 key 尽量复用 | P0 |
| F10 | 用户已有配置（settings 表 key）与已下载模型/引擎完全无损，纯入口迁移 | P0 |

### 交互细则

- 设置页内切换任何分区/子页，左侧分类导航**不卸载、不闪烁**，仅右侧内容切换。
- 下载中切走页面：任务在 DownloadManager 后台继续（现有行为），全局面板可见。
- 删除模型二次确认；被运行中服务占用的模型先提示停止服务（沿用现有逻辑）。
- 业务页空状态跳转设置后，目标分组自动展开并滚动定位。

---

## 5. 实施计划

| 期 | 内容 | 验收 |
|---|---|---|
| P1 布局整合 | 设置壳 + 路由统一（F1/F2） | 设置内任意点击左侧导航常驻；详情页返回正常 |
| P2 下载通道 | MLX/OCR 进度适配 DownloadTask（F7） | 全局面板显示 MLX/OCR 任务，可取消 |
| P3 本地模型整合 | 能力分组 + 模型行/引擎卡迁移合并（F3/F8） | 四类能力模型均可在「本地模型」完成下载后管理；业务页对应代码删除 |
| P4 商店与云服务 | 商店能力分类（F4）、provider 配置合并（F5） | 商店可下载四类模型；四处旧表单删除 |
| P5 业务页瘦身 | F6 + i18n（F9）+ 回归 | voice-screen 预计净减 600+ 行；主流程回归通过 |

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 路由改设置壳影响现有深链（如 OCR 跳 models） | 保留路由 path 不变，只改渲染归属；逐个核对 `setRoute` 调用点 |
| `voice-screen.tsx`（2585 行）拆分易破坏交互 | 按 TTS/ASR/克隆分三次迁移，每次回归 |
| MLX 下载与 DownloadManager 模型差异 | 只适配进度上报，不动 Python 下载实现 |
| 能力分组后「本地模型」列表变长 | 分组折叠 + 默认展开聊天组，沿用现有列表样式 |

## 7. 验收清单

- [ ] 设置内所有页面切换（含模型详情、商店）左侧分类导航始终存在
- [ ] 生图/TTS/ASR/OCR 模型的下载、启用、删除均可在设置的「本地模型」「模型商店」完成
- [ ] image/voice/ocr 页面无任何下载按钮与进度条，未就绪可一键跳转设置对应分组
- [ ] MLX/OCR 下载在全局下载面板可见、可管理
- [ ] 模型行/引擎卡/provider 表单全仓库各仅一份实现
- [ ] 已有用户配置与已下载模型无损，中英文案齐全
