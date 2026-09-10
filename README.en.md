<p align="center">
  <img src=".github/assets/logo.png" alt="OmniStudio" width="128" />
</p>

<h1 align="center">OmniStudio</h1>

<p align="center">
  <b>A desktop workstation for local LLMs</b><br/>
  Manage models, run inference servers, and build with Chat / Voice / Image / OCR / Translate apps — all local-first.
</p>

<p align="center">
  <a href="./README.md">中文</a> · <b>English</b>
</p>

<p align="center">
  <a href="https://kunpengtalk.com">Website</a> ·
  <a href="https://kunpengtalk.com/assets/kunpengtalk-studio-demo.mp4">Demo</a> ·
  <a href="https://github.com/kunpengtalk/OmniStudio/releases/latest">Download</a> ·
  <a href="./CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  ⭐ <a href="https://github.com/kunpengtalk/OmniStudio">Star</a> · License: <a href="LICENSE">MIT</a> · Author: 鲲鹏Talk
</p>

---

## 📸 Screenshots

<table>
  <tr>
    <th align="center">Home</th>
    <th align="center">Model Download</th>
  </tr>
  <tr>
    <td><img src="docs/images/screenshot-home.png" alt="Home" width="100%"/></td>
    <td><img src="docs/images/screenshot-model-download.png" alt="Model Download" width="100%"/></td>
  </tr>
  <tr>
    <th align="center">Chat</th>
    <th align="center">Chat · Web Search</th>
  </tr>
  <tr>
    <td><img src="docs/images/screenshot-chat.png" alt="Chat" width="100%"/></td>
    <td><img src="docs/images/screenshot-chat-websearch.png" alt="Chat with Web Search" width="100%"/></td>
  </tr>
</table>

---

## ✨ Features

### Model Hub

- **Search & browse** — ModelScope model search with repository file listings and detail pages (parameters, size, downloads, license, tags).
- **Full-format downloads** — GGUF (llama.cpp), safetensors (vLLM / SGLang), bin / pt / ckpt / onnx; single file or whole-repo "download all"; HuggingFace as the source for audio.cpp GGUF models.
- **Download manager** — Queue-based concurrent downloads with pause / resume / cancel, byte-accurate resumable transfer (HTTP 206), favorites, and multi-directory model storage.
- **Capability categories** — Auto-classified as Chat / TTS / ASR / Image / Other from model metadata and persisted, surfaced as badges and filters.

### Inference Engines

- **Unified runtime** — llama.cpp (default: GGUF from local files or HuggingFace, GPU offload, KV cache quantization, multimodal mmproj), vLLM, and SGLang behind one runtime abstraction with hot engine switching.
- **Remote mode** — Directly connect any OpenAI-compatible endpoint (base URL / API key / model) with built-in connection testing.
- **Unified gateway** — A single local endpoint that routes each model to the local inference server or a cloud API, speaking three protocols: OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages (including bidirectional tool calling). Optional API-key auth and interactive OpenAPI docs.
- **Endpoints** — Chat Completions `/v1`, Responses, Anthropic Messages, `/health`, `/metrics`, one-click copy from settings.

### Five Built-in Apps

- **Chat** — streaming responses with reasoning display, image attachments (multimodal), web search (Bing / DuckDuckGo / Tavily with results injected as cited context), and text-file attachments (whitelisted formats wrapped into context); auto-titled conversations, per-app session isolation, usage tracking.
- **Voice** — TTS from multiple sources (audio.cpp local engine, Edge-TTS, OpenAI-compatible TTS) plus a voice clone library, and multi-engine ASR (whisper.cpp / audio.cpp / OpenAI-compatible transcription), all logged as records with an embedded player.
- **OCR** — Two engines: local Tesseract (multilingual LSTM language packs, word/line bounding boxes) and VLM (Chandra / GLM-OCR / LightOnOCR-class models on the inference server). Upload PDF / images and get structured Markdown — GFM tables, KaTeX math, code blocks, captions, and bounding-box-cropped image regions — with a document queue, search, and a two-pane workspace.
- **Image** — Generation via cloud OpenAI-compatible APIs, ComfyUI, or the local MLX (mflux) engine on Apple Silicon. MLX weights are pre-downloaded with live progress before generation.
- **Translate** — Translate text through the current chat model across 22 languages, with source auto-detection, language swap, and one-click copy.

### Ops & Telemetry

- **Live dashboard** — Prefill / generation tokens and speed (tok/s), request counts, active models, memory and CPU load, server uptime, model disk usage — polled every 2s.
- **Benchmarks** — Context-length sweeps (1K–200K) with TTFT / TPOT / TPS, results in tables and charts, for local or remote servers.
- **Server logs** — Live tail with ANSI colors, auto-scroll, truncation guard, copy / clear.
- **CLI integrations** — Generated launch commands for Claude Code (local / cloud, Opus–Sonnet–Haiku model mapping), Codex, OpenCode, OpenClaw, Hermes, Pi, and Copilot CLI, each bound to a default model.
- **Updates & i18n** — Stable / beta channels with in-app updates, a setup wizard, zh / en UI language, SQLite-backed session stores.

## 🚀 Getting Started

**Requirements**

- [Bun](https://bun.sh) 1.3+
- macOS (Apple Silicon); Linux / Windows support planned

```bash
bun install

# development with HMR (recommended)
cd apps/studio && bun run dev:hmr

# development without HMR
cd apps/studio && bun run dev

# build for production
cd apps/studio && bun run build:dev
```

## 💻 omni CLI

`omni` is a global command-line tool wrapping the backend: model management, chat, inference servers, unified gateway, and config — **sharing the same database as the desktop app** (models and settings stay in sync).

```bash
cd apps/studio && bun link    # install the global omni command (~/.bun/bin)
omni --help                    # list all commands
omni help <command>            # help for one command

omni model list                # list installed models
omni chat "Hello" --reasoning  # chat via local/remote inference (auto-starts the server)
omni serve                     # inference server + unified gateway (foreground, CTRL+C to exit)
omni doctor                    # environment health check
omni config get INFERENCE_ENGINE
```

Full manual: [docs/omni-cli.md](./docs/omni-cli.md).

## 🧩 Tech Stack

| Layer | Technology |
|---|---|
| Desktop | [Electrobun](https://blackboard.sh/electrobun) + Bun |
| Frontend | React 19, Tailwind, shadcn/ui, Zustand, TanStack Query |
| AI | Vercel AI SDK (`ai`), `@ai-sdk/openai-compatible` |
| Inference engines | llama.cpp, vLLM, SGLang, OpenAI-compatible |
| Voice & OCR | audio.cpp, whisper.cpp, Tesseract, Edge-TTS, VLM |
| Database | Drizzle ORM + Bun SQLite |
| Document processing | Sharp, pdfjs-dist, @napi-rs/canvas, Cheerio, Turndown |
| Model hub | ModelScope OpenAPI, HuggingFace |
| Build | Vite, Turborepo, Bun workspaces |
| Code quality | oxlint, oxfmt |

## 📁 Project Structure

```
apps/
├── studio/               # Electrobun desktop app
│   └── src/
│       ├── bun/          # Main process (RPC, DB, inference runtimes, OCR pipeline, queue)
│       └── mainview/     # React UI
└── landing/              # Marketing site (kunpengtalk.com)
```

## 🗺 Roadmap

- [ ] **Cloud sync** — sync conversations and settings across devices
- [ ] **Plugin system** — extensible tool / plugin SDK for third-party integrations
- [ ] **Linux / Windows ports** — extend desktop support to other platforms
- [ ] **Server mode** — headless server deployment (SSH / Docker)

## 📄 License

MIT — maintained by 鲲鹏Talk. See [LICENSE](LICENSE).
