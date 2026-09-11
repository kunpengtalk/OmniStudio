# OmniStudio

Desktop workstation for local LLMs — manage models, run inference servers (llama.cpp / vLLM / SGLang), and use Chat / Voice / Image / OCR apps. Built with Electrobun (NOT Electron — do not use Electron APIs).

## Stack

- **Desktop:** Electrobun + Bun
- **Frontend:** React 19, Tailwind, shadcn/ui, Zustand, TanStack Query
- **AI:** Vercel AI SDK (`ai`), `@ai-sdk/openai-compatible`
- **DB:** Drizzle ORM + SQLite
- **Build:** Vite, Turborepo, Bun workspaces

## Structure

```
apps/
├── studio/               # Electrobun desktop app
│   └── src/
│       ├── bun/          # Main process (RPC, DB, inference runtimes, OCR pipeline, queue)
│       └── mainview/     # React UI (components, stores, lib)
└── landing/              # Marketing site (kunpengtalk.com)
```

## Electrobun

Full API reference: https://blackboard.sh/electrobun/llms.txt
Getting started: https://blackboard.sh/electrobun/docs/

Import patterns:

- Main process (Bun): `import { BrowserWindow } from "electrobun/bun"`
- Browser context: `import { Electroview } from "electrobun/view"`

Use `views://` URLs to load bundled assets (e.g., `url: "views://mainview/index.html"`).
Views must be configured in `electrobun.config.ts` to be built and copied into the bundle.

## Key Patterns

- RPC via `BrowserView.defineRPC` for main ↔ webview communication
- Document pipeline: upload → PDF/image → Sharp → VLM OCR → HTML → Markdown
- Settings and documents stored in SQLite via Drizzle
- Image regions cropped from source using bounding boxes, stored as WebP

## CLI (`omi`)

- `apps/studio/bin/omi.ts` + `src/cli/*` is a standalone Bun CLI that talks to the
  running app over a Unix socket (`<dataDir>/omni-control.sock`, served by
  `src/bun/control-server.ts`). Commands: `start/stop/restart/serve/launch/model/
  cloud/models/model-info/status/server/install/version/update`.
- When the app is not running, read-only data access falls back to direct
  SQLite imports (`src/cli/db.ts`) — it sets `OMNI_DATA_DIR`/`OMNI_DB_PATH` first.
- `src/bun/paths.ts` and `src/bun/db/index.ts` must NOT import `electrobun/bun`
  at module scope (it starts a dev server + reads version.json as a side effect);
  they compute userData themselves via `getUserDataDir()`.
- Install once with `cd apps/studio && bun link` to expose the `omi` command.
