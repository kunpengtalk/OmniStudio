# OmniStudio

Desktop workstation for local LLMs — manage models, run inference servers (llama.cpp / vLLM / SGLang / MLX), and use Chat / Agent / Voice / Image / Video / OCR / Translate apps, with a local knowledge base, shared memory, and Skills management. Built with Electrobun (NOT Electron — do not use Electron APIs).

Architecture overview for maintainers: [docs/architecture.md](./docs/architecture.md). Planning and open work: [ROADMAP.md](./ROADMAP.md).

## Stack

- **Desktop:** Electrobun + Bun
- **Frontend:** React 19, Tailwind, shadcn/ui, Zustand, TanStack Query
- **AI:** `@earendil-works/pi-agent-core` + `pi-ai` drive the agent loop; Vercel AI SDK (`ai`) + `@ai-sdk/openai-compatible` for OCR/translation one-shot calls
- **DB:** Drizzle ORM + SQLite (WAL)
- **Build:** Vite, Turborepo, Bun workspaces

## Structure

```
apps/
├── studio/               # Electrobun desktop app
│   ├── bin/omi.ts        # CLI entry
│   └── src/
│       ├── bun/          # Main process (RPC, DB, runtimes, agent, media pipelines, servers)
│       ├── shared/       # Shared by BOTH main process and webview (no electrobun imports)
│       ├── cli/          # omi CLI (standalone process)
│       └── mainview/     # React UI (app/, components/, stores/, lib/)
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

- RPC via `BrowserView.defineRPC` for main ↔ webview communication; the contract type
  `AppRPC` lives in `src/bun/rpc/index.ts` and is shared with the webview
- Document pipeline: upload → PDF/image → Sharp → VLM OCR → HTML → Markdown
- Settings and documents stored in SQLite via Drizzle
- Image regions cropped from source using bounding boxes, stored as WebP
- Streaming pushes are throttled (chat 40ms, download progress 400ms, logs 80ms) because
  every event re-renders the webview — flush before emitting a terminal event

## Hard Rules

- `src/shared/*` is imported by both processes — never import `electrobun` there.
- `src/bun/paths.ts` and `src/bun/db/index.ts` must NOT import `electrobun/bun` at module
  scope (it starts a dev server + reads version.json as a side effect); they compute
  userData themselves via `getUserDataDir()`.
- Python helper scripts (`mlx-worker.py`, `mlx-model.py`, `ppocr-worker.py`) are spawned via
  `import.meta.dir` relative paths, so they must stay listed in `electrobun.config.ts`'s
  `build.copy`. Missing them exits Python with code 2 and surfaces as bogus model download failures.
- Child processes are spawned `detached` and killed by process group (`kill(-pid)`) — killing
  only the direct child leaves VRAM-hogging orphans behind.
- Anything that resolves a user-supplied path (downloads, media, Skills deletes) must validate
  it against the data directory — inputs arrive from the webview and the control socket.
- Adding an inference engine means editing `src/shared/engines.ts` plus one `Runtime`
  implementation; do not hardcode engine checks elsewhere.

## CLI (`omi`)

- `apps/studio/bin/omi.ts` + `src/cli/*` is a standalone Bun CLI that talks to the
  running app over a Unix socket (`<dataDir>/omni-control.sock`, served by
  `src/bun/control-server.ts`). Commands: `start/stop/restart/serve/launch/memory/model/
  cloud/models/model-info/status/server/install/guide/version/update`.
- When the app is not running, read-only data access falls back to direct
  SQLite imports (`src/cli/db.ts`) — it sets `OMNI_DATA_DIR`/`OMNI_DB_PATH` first.
- Install once with `cd apps/studio && bun link` to expose the `omi` command.
- CLI docs are data-driven: `src/shared/cli-docs.ts` feeds `omi guide`, `docs/omi-cli.md`,
  and the in-app Settings → Tools → Command line page. Regenerate the doc with
  `bun run scripts/omi-docs-smoke.ts --write`; the same script verifies sync.
- A legacy second CLI (`src/cli/omni.ts`, commands `chat`/`doctor`/`config`/`gateway`)
  still exists alongside `omi`; new work goes into `omi` only.

## Checks

Run what CI runs before committing:

```bash
bun run lint && bun run typecheck && bun run test
bun run --cwd apps/studio test:smoke
```
