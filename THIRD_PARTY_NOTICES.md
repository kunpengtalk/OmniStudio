# THIRD_PARTY_NOTICES — 第三方组件与许可声明

OmniStudio 以 MIT 许可发布（见根目录 `LICENSE`，Copyright (c) 2026 鲲鹏Talk）。
本应用分发包中包含下列第三方组件，按其原有许可使用；各组件版权归其各自作者所有。
若下方清单与组件实际许可有出入，以组件随附的许可文本为准。

## 随安装包分发的第三方组件

| 组件 | 用途 | 许可证 | 分发形态 |
|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js)（pdfjs-dist） | PDF 渲染 | Apache-2.0 | `bun/pdf.worker.mjs` |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas)（内含 skia） | 画布合成 | MIT | `bun/node_modules/@napi-rs/canvas` |
| [sharp](https://github.com/lovell/sharp) | 图像处理 | Apache-2.0 | 平台原生包 `@img/sharp-*` |
| ↳ libvips（sharp 预编译依赖） | 图像底层库 | **LGPL-3.0-or-later** | 随 `@img/sharp-libvips-*` 以动态库形式分发；依 LGPL 条款在此提供来源与许可声明，用户可按 LGPL 方式替换该库 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)（onnxruntime-web） | 本地抠图 / 超分推理 | MIT | `bun/ort-wasm-simd-threaded.{mjs,wasm}` |
| [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans)（@fontsource-variable） | 界面字体 | SIL OFL-1.1 | 随 npm 依赖打包 |

其余以 npm 依赖打包的 JavaScript 库均为 MIT / ISC / BSD / Apache-2.0 等宽松许可；
完整依赖清单见 `apps/studio/package.json` 与 `bun.lock`。

## 算法出处声明

- `apps/studio/src/bun/apply-patch.ts`：算法与补丁文法移植自
  [openai/codex](https://github.com/openai/codex) 的 apply_patch（**Apache-2.0**），
  以 TypeScript 重写；依 Apache-2.0 要求在此注明来源与许可。

## 运行时下载的第三方引擎与模型（不由本应用分发）

以下引擎 / 权重在用户本机上按需下载，由上游仓库直接提供，其许可与文档以上游为准：
llama.cpp、vLLM、SGLang、MLX 生态（mflux 等）、whisper.cpp、audio.cpp、
PaddleOCR、Tesseract、rembg、cloudflared、laya-mlx 权重，以及各 GGUF / safetensors
模型文件。本应用只负责下载、启动与调用，不修改、不随包携带这些二进制与权重。

## 开发期 vendored 内容（不随应用分发）

- `.agents/skills/shadcn/`：shadcn/ui 官方 Agent Skill 原样内嵌（MIT 生态），
  仅供本仓库开发期使用，见该目录 `SOURCE.md` 与根 `skills-lock.json`。

## 商标声明

`apps/studio/src/mainview/assets/logos/` 下的各 AI 云厂商图形标识为相应厂商的商标，
仅在服务商选择界面作指示性使用，不代表任何背书或合作关系；各商标归其权利人所有。
