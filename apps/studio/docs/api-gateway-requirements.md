# OmniStudio 本地 API 网关 & 设置页调整 需求文档

> 版本：v1（2026-09-09） · 范围：`apps/studio`
> 目标：调整设置页菜单结构与本地模型分类展示；新增一个默认随本地服务启动的 OpenAI 兼容 API 网关（默认端口 10000），并自带 FastAPI 风格的 OpenAPI 接口文档。

---

## 一、设置页菜单调整

### 1.1 菜单项重命名

| 现菜单项 | 新菜单项 | 说明 |
| --- | --- | --- |
| 服务器（`settings.server`） | **模型云服务** | 保留原「推理引擎 / 运行模式 / 端口 / 端点 / 网关」等内容，语义扩展为"本地推理 + 云端兼容 API"的统一入口 |
| 模型（`settings.model`） | **本地模型** | 保留原有模型选择/目录配置，新增下方分类展示 |
| 模型库（`settings.store`） | 模型库（保留） | 不变 |

### 1.2 「本地模型」页：按类别分组

在「本地模型」页增加已安装本地模型的分组展示，复用现有模型分类体系
（`ModelCategory`：`chat / tts / asr / image / other`），重点突出三类：

- **文本生图**（`image`）：Stable Diffusion / Kolors 等文生图模型
- **语音合成 TTS**（`tts`）：CosyVoice 等
- **语音识别 ASR**（`asr`）：Whisper / SenseVoice 等
- 其余保留：**对话 · VLM**（`chat`）、**其他**（`other`）

每组展示已下载的本地模型（文件名、仓库、体积、类别徽标、激活/删除操作），
未安装某类模型时显示空态提示。

---

## 二、本地 API 网关（核心）

### 2.1 概述

应用运行在**本地模式**时，默认启动一个 HTTP 网关：

- 默认监听 `127.0.0.1:10000`（端口可通过设置 `GATEWAY_PORT` 修改，可开关 `GATEWAY_ENABLED`）
- 对外暴露 **OpenAI 兼容**的模型服务接口，作为统一入口聚合本机各推理后端
- 提供 **FastAPI 风格**的接口文档：`/docs`（Swagger UI）、`/redoc`（ReDoc）、`/openapi.json`（OpenAPI 3.0）
- 启动时机：与应用自动启动推理服务一致（本地模式 + `AUTO_START_SERVER` 开启时）；应用退出时一并关闭

### 2.2 接口清单

| 方法 | 路径 | 说明 | 后端路由 |
| --- | --- | --- | --- |
| GET | `/` | 网关信息（JSON） | 网关自身 |
| GET | `/health` | 健康检查（含上游推理服务状态） | 网关自身 |
| GET | `/openapi.json` | OpenAPI 3.0 规范（FastAPI 风格，`info` / `paths` / `components`） | 网关自身 |
| GET | `/docs` | Swagger UI 文档页 | 网关自身 |
| GET | `/redoc` | ReDoc 文档页 | 网关自身 |
| GET | `/v1/models` | 模型列表（聚合上游 + 网关声明的 TTS/ASR/生图模型） | 主推理服务器 |
| POST | `/v1/chat/completions` | 对话补全（支持 `stream` 流式透传与非流式） | 主推理服务器（llama.cpp / vLLM / SGLang，`SERVER_PORT`） |
| POST | `/v1/audio/speech` | 文本转语音 TTS | 本地 audio.cpp TTS（`runTTSLocal`）→ 远端 TTS Provider 兜底 → 501 |
| POST | `/v1/audio/transcriptions` | 语音识别 ASR | whisper-server（`ASR_PORT`）→ 远端 ASR Provider → 501 |
| POST | `/v1/images/generations` | 文本生图（预留） | 501（后端待接入，文档中声明） |
| POST/GET | 其它 | 统一 404 JSON | — |

### 2.3 行为细节

- **流式透传**：`chat/completions` 请求体含 `stream: true` 时，网关把上游 SSE 流原样转发，
  `Content-Type: text/event-stream`，保持 `data:` 分片格式；非流式则透传 JSON。
- **模型名**：`/v1/models` 返回上游模型列表，并附加网关声明的本地能力模型
  （如 `omni-tts`、`omni-asr`、`omni-image` 之类占位 ID 仅用于文档与能力声明，实际生成走对应后端）。
- **认证**：网关本机使用，不强制鉴权；仍透传 `Authorization` 头到上游。
- **CORS**：跨域放开（`Access-Control-Allow-Origin: *`），便于浏览器/其他工具调用。
- **错误约定**：统一 `{ "error": { "message", "type", "code" } }` JSON（OpenAI 风格错误体）。
- **安全**：默认仅绑定 `127.0.0.1`，不暴露公网。
- **端口冲突**：配置端口（默认 10000）若被本机其它程序占用（如网盘类软件常占 10000），
  网关自动顺延监听下一个空闲端口（最多尝试 +20），并在设置页提示 `notice` 与真实端口；
  `getGatewayStatus` 返回的 `host / port` 始终是实际监听地址。

### 2.4 设置项（新增）

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `GATEWAY_ENABLED` | `1` | 网关总开关（本地模式下） |
| `GATEWAY_HOST` | `127.0.0.1` | 监听地址 |
| `GATEWAY_PORT` | `10000` | 监听端口 |

### 2.5 网关状态与 UI

- 「模型云服务」设置页新增「本地 API 网关」区域：
  - 开关（`GATEWAY_ENABLED`）、端口（`GATEWAY_PORT`）
  - 运行状态徽标（运行中 / 已停止 / 错误）
  - 端点列表（`/docs`、`/v1/chat/completions`、`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/models`、`/health`）与复制按钮
  - 「打开 API 文档」按钮（系统浏览器打开 `http://127.0.0.1:10000/docs`）
- 网关状态通过 RPC 查询（`getGatewayStatus`）与广播（`gatewayStatusChanged`）驱动。

### 2.6 RPC 新增

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `getGatewayStatus` | — | `{ enabled, status, host, port, url, upstreamStatus, error? }` |
| `startGateway` / `stopGateway` / `restartGateway` | — | `{ ok, error? }` |
| `openGatewayDocs` | `{ url }` | `{ ok }` |
| 广播 `gatewayStatusChanged` | `{ status }` | — |

---

## 三、验收标准

1. 设置页三菜单分别显示「模型云服务 / 本地模型 / 模型库」。
2. 「本地模型」页按 文本生图 / TTS / ASR / 对话·VLM / 其他 分组展示已安装模型。
3. 本地模式启动后 `http://127.0.0.1:10000` 可访问，`/openapi.json` 返回合法 OpenAPI 3.0 文档，
   `/docs` 打开 Swagger UI 并列出全部接口。
4. 推理服务器运行中，`/v1/chat/completions` 流式与非流式均可正常对话；
   whisper-server 运行中，`/v1/audio/transcriptions` 可转写；本地 TTS 激活时 `/v1/audio/speech` 可合成。
5. 修改 `GATEWAY_PORT` / 开关后保存即生效（重启网关）。

---

## 四、TODO List

- [x] 1. 需求文档（本文）
- [x] 2. i18n：设置页菜单重命名（模型云服务 / 本地模型）+ 网关文案
- [x] 3. 设置页：菜单名生效；「本地模型」页按类别分组展示已安装模型
- [x] 4. 新增设置项 `GATEWAY_ENABLED / GATEWAY_HOST / GATEWAY_PORT`
- [x] 5. 实现 `src/bun/gateway.ts`（OpenAI 兼容端点 + OpenAPI 文档 + CORS）
- [x] 6. 主进程接入：自动启动/退出清理、RPC、状态广播
- [x] 7. 前端：「模型云服务」页网关状态/端点/文档入口
- [x] 8. 类型检查与自测（`tsc --noEmit` 通过；`bun test src/bun/` 20/20 通过）
