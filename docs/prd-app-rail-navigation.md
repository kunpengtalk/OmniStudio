# PRD：左侧图标导航栏（App Rail）

> 状态：已实现 · 版本：v1.0 · 日期：2026-09-10

## 1. 背景与原型分析

参考原型（Cherry Studio 类桌面 AI 客户端）的整体布局为三段式：

```
┌────────┬──────────────┬─────────────────────────────┐
│ 图标栏  │  二级面板     │  主内容区                     │
│ (Rail) │ (会话/记录列表) │  (对话 / 生图 / 语音 …)       │
│  ~48px │  ~260px      │  自适应                       │
└────────┴──────────────┴─────────────────────────────┘
```

原型界面要点：

1. **最左侧是一条窄图标栏**：纵向排列功能入口（对话、生图、语音、知识库等），底部放设置/个人入口。点击图标即切换主功能，无需文字。
2. **图标栏右侧是二级面板**：随当前功能变化（对话功能下是智能体/会话列表，OCR 下是文档列表等）。
3. **右侧为主内容区**：承载当前功能页面，底部是对话输入框。

### OmniStudio 现状问题

- 当前应用切换器（`AppSwitcher`）是侧边栏顶部一排 5 个带文字的小按钮（grid 布局），挤占了会话列表空间，视觉层级不清晰；
- 切换器与会话列表耦合在同一个 Sidebar 里，Sidebar 折叠后就失去了功能切换入口；
- 设置入口埋在 Sidebar 底部，进入设置页后整个导航消失，没有全局一致的导航骨架。

## 2. 目标

- 抽象出全局**应用图标栏（App Rail）**：固定在窗口最左侧，永远可见（包括设置页），作为全应用的一级导航骨架；
- 把对话、语音、生图、OCR、翻译五个功能入口移入图标栏，点击即切换到对应菜单（二级面板 + 主内容区联动切换）；
- 图标采用更抽象的几何风格图标，**不与参考原型使用相同图标**；
- 原 Sidebar 退化为纯二级面板（各功能的会话/记录列表），**永远展开、不可折叠**。

## 3. 范围

**包含**

- 新增 `AppRail` 组件（`main-layout/app-rail.tsx`）；
- `MainLayout` 布局改造：Rail 常驻最左；
- 移除 Sidebar 顶部的旧 `AppSwitcher`；
- 图标与交互状态（激活高亮、Tooltip）。

**不包含（Non-goals）**

- 不改变五个功能页面本身的内部实现；
- 不引入 react-router，仍沿用 zustand 双 store 路由（`route.path` + `activeApp`）；
- 不做智能体（Agent）管理面板（原型中的"添加智能体"，属后续需求）。

## 4. 详细需求

### 4.1 布局结构

```
SidebarProvider (flex row)
├── AppRail          w-12，常驻，border-r
├── AppSidebar       二级面板（collapsible="none"，永远展开、不可折叠），设置页隐藏
└── SidebarInset     header + Outlet（主内容区）
```

- Rail 宽度 48px（`w-12`），垂直排列，背景 `bg-muted/40` 与内容区区分；
- Rail 顶部预留 `h-10` 拖拽区（`electrobun-webkit-app-region-drag`），避让 macOS 红绿灯按钮；
- 功能图标居上，设置图标通过 `mt-auto` 沉底。

### 4.2 图标规范（抽象化，区别于原型）

统一使用 lucide-react 线性图标，`size-5`，选择**几何/抽象风格**，避免与参考原型（气泡对话、麦克风、风景画图标）雷同：

| 功能 | 旧图标（侧边栏） | 新 Rail 图标 | 设计意图 |
|------|------------------|--------------|----------|
| 对话 chat | MessageSquare | **MessageCircleDashed** | 虚线圆泡，抽象化对话 |
| 语音 voice | Mic | **AudioWaveform** | 声波线条，不直接画麦克风 |
| 生图 image | Image | **Shapes** | 几何形体组合，隐喻"生成" |
| OCR ocr | ScanText | **ScanSearch** | 扫描框 + 放大镜 |
| 翻译 translate | Languages | **Earth** | 抽象地球，隐喻多语言 |
| 设置 settings | Settings（齿轮） | **SlidersHorizontal** | 滑杆，非齿轮 |

### 4.3 交互需求

| 编号 | 场景 | 行为 |
|------|------|------|
| R1 | 点击未激活的功能图标 | 切换 `activeApp`，清空对话临时状态（`setActiveConversation(null)` / `setActiveMessages([])` / `setStreaming(false)`），路由回到 `index`，二级面板切换为对应列表 |
| R2 | 点击已激活的功能图标 | 无操作（不重复切换；二级面板永久展开，不提供折叠能力） |
| R3 | 点击底部设置图标 | 路由切到 `settings`（一级页面，隐藏二级面板），设置图标高亮 |
| R4 | 悬停图标 | 显示 Tooltip（i18n 文案：`apps.*` / `nav.settings`） |
| R5 | 激活态视觉 | 图标按钮 `bg-primary/10 text-primary`，非激活 `text-muted-foreground hover:bg-muted` |
| R6 | 二级面板 | 永远默认展开且不可折叠（无折叠按钮、无折叠交互），任何页面切换都不会使其消失 |
| R7 | 设置页中 | Rail 仍可见，点击任一功能图标可退回对应功能页 |

### 4.4 文案与 i18n

复用现有 key，无需新增：`apps.chat` / `apps.voice` / `apps.image` / `apps.ocr` / `apps.translate` / `nav.settings`（zh/en 均已存在）。

### 4.5 兼容与边界

- 首次运行 Setup 向导（`SetupScreen`）不显示 Rail（未进 MainLayout）；
- `models` / `model-detail` / `server` / `stats` / `document` 等二级路由下 Rail 不高亮任何功能图标，但保持可点击；
- 不影响现有 `SidebarTrigger` 折叠按钮。

## 5. 验收标准

1. 窗口最左侧常驻 48px 图标栏，5 个功能图标 + 底部设置图标；
2. 点击图标 1 次内切换到对应功能页，且二级面板内容随之变化；
3. 设置页内 Rail 依然可用，可一键切回任意功能；
4. 所有图标均为抽象风格且与参考原型不同；
5. 二级面板始终展开，界面上不存在任何折叠入口（按钮/图标点击/快捷键均不使其消失）；
6. 中英文界面下 Tooltip 文案正确。
