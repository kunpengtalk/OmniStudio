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
- All media (chat images, generated images, OCR page images, TTS/ASR audio, artifact and
  workspace previews) is served by the image server on a **fixed** loopback port
  (`imageServerPort()`, 127.0.0.1:19782). The webview cannot read the main process env, so
  every process must keep using that constant — a per-instance port would silently produce
  URLs pointing at nothing. When the port is taken, `startImageServer()` probes the holder's
  identity (`/__omni/media-id`) instead of degrading silently: same data dir = shared
  (harmless), different data dir = blocked (previews would hit someone else's files). The
  state goes to the top bar, and binding is retried every 5s so the app takes over once the
  other instance quits
- **Every subsystem failure goes to one log**: `src/bun/app-log.ts` writes event-level records
  (JSONL, `<dataDir>/logs/app.log`, 2MB rotation, secrets redacted) for image / video / TTS /
  ASR / OCR, the inference server, downloads, the gateway, the Agent and webview-side errors.
  Read it with `omi logs` (falls back to the file when the app is down — crash triage),
  the control socket `logs` command, or RPC `getAppLogs`. Inference server stdout/stderr is
  deliberately **not** in there (per-instance 200k in-memory buffer, `omi server logs`).
  A failure path without a `logEvent` call is a bug: the next person cannot diagnose it.
  Full triage guide: `.agents/skills/omni-doctor/`; one-shot evidence dump:
  `bun run --cwd apps/studio scripts/omni-diag.ts`
- **Cloud models are picked as `provider → model`, never as a per-page URL + key**: image,
  image-edit, video, TTS, ASR, live-translate and VLM OCR each store only a provider id
  (`IMG_PROVIDER_ID` / `TTS_PROVIDER_ID` / …) plus a model name; base URL and key come from
  the `cloud_providers` row (`resolveCloudProvider`). Providers are *enabled* individually
  (several at once — `enabled` column) and enabling runs a `/v1/models` key check, so a
  page never has to ask for credentials again. Each model entry carries a **purpose**
  (`CloudModelEntry.type`: image / video / tts / asr / chat / …; inferred from the id when
  absent) and every picker filters by it — a new cloud model selector must go through
  `CloudModelSelect` + `providersForType` instead of listing all providers.
  Video is the exception that proves the rule: video APIs are not standardized, so the
  provider row also carries `videoApi` ("minimax" | "seedance") and polling looks the
  submitter up by the record's `providerId`.
- **One proxy governs every outbound request** (Settings → Preferences → General):
  `bun/proxy.ts` wraps `globalThis.fetch` at startup, so cloud model calls (chat / image /
  video / TTS / ASR / OCR / translate), the model hubs, engine and weight downloads, web
  search and remote backup all honor `PROXY_MODE` (`system` / `custom` / `none`) +
  `PROXY_URL` without touching a single call site. Loopback always bypasses (local inference
  server, gateway, media server); LAN follows the `PROXY_ALLOW_LOCAL_NETWORK` toggle. The
  rules live in `shared/proxy.ts` and the settings page renders "who goes through the proxy"
  from that same code, so the UI cannot drift from the real behavior.
  Subprocesses (`pip`, python workers, `git lfs`, brew, and the four inference engines
  fetching weights) only read env vars: `syncProxyEnv()` keeps `HTTP(S)_PROXY` + `NO_PROXY`
  in the process env, and download spawns merge `proxyChildEnv()`.
  Three Bun quirks shape this: per-request `proxy` beats env, **socks is unsupported**
  (`UnsupportedProxyProtocol`), and env proxies are latched at startup while `NO_PROXY`
  ignores CIDR — hence "no proxy" is expressed as `NO_PROXY=*` instead of deleting variables.
  `bun run --cwd apps/studio scripts/proxy-smoke.ts` exercises the whole chain, including a
  real trip through a local HTTP proxy.

## Hard Rules

- `src/shared/*` is imported by both processes — never import `electrobun` there.
- `src/bun/paths.ts` and `src/bun/db/index.ts` must NOT import `electrobun/bun` at module
  scope (it starts a dev server + reads version.json as a side effect); they compute
  userData themselves via `getUserDataDir()`.
- Python helper scripts (`mlx-worker.py`, `mlx-model.py`, `ppocr-worker.py`) are spawned via
  `import.meta.dir` relative paths, so they must stay listed in `electrobun.config.ts`'s
  `build.copy`. Missing them exits Python with code 2 and surfaces as bogus model download failures.
  Same rule for `omni-landlock.c` (the Linux Landlock helper `landlock-helper.ts` compiles with
  `cc` on first use): if it is not copied into `bun/`, Linux silently degrades to "no compiler".
- Child processes are spawned `detached` and killed by process group (`kill(-pid)`) — killing
  only the direct child leaves VRAM-hogging orphans behind.
- Anything that resolves a user-supplied path (downloads, media, Skills deletes) must validate
  it against the data directory — inputs arrive from the webview and the control socket.
- Adding an inference engine means editing `src/shared/engines.ts` plus one `Runtime`
  implementation; do not hardcode engine checks elsewhere.
- Outbound HTTP goes through the global `fetch` (patched by `bun/proxy.ts`) or, when you must
  bypass it, per-request `proxy` — do not open raw sockets or side-channel HTTP clients for
  remote hosts, or that request silently ignores the user's proxy settings. Loopback IPC
  fetches (`unix:` control socket) are exempt and deliberately left untouched.
- `src/bun/backup/*` must not import `db/index.ts` or `electrobun` — that isolation is what
  lets `omi backup` work when the app won't start (migrations failed). Entry points that
  need the data layer belong in `src/cli/commands/backup.ts`, not in the kernel.
- Backup archives are untrusted input on restore: every extracted path goes through
  `path-safety` against the resolved root.

## CLI (`omi`)

- `apps/studio/bin/omi.ts` + `src/cli/*` is a standalone Bun CLI that talks to the
  running app over a Unix socket (`<dataDir>/omni-control.sock`, served by
  `src/bun/control-server.ts`). Commands: `start/stop/restart/serve/launch/memory/backup/model/
  cloud/models/model-info/status/server/logs/install/guide/version/update`.
  Data-dir resolution (`src/cli/data-dir.ts`) pings every channel's control socket and talks to
  whichever instance actually answers (dev/canary builds run from source or `build/` count too);
  only when nothing is running does it fall back to the most recently used channel. Checking a
  socket *file* is not enough — crashed instances leave them behind.
- When the app is not running, read-only data access falls back to direct
  SQLite imports (`src/cli/db.ts`) — it sets `OMNI_DATA_DIR`/`OMNI_DB_PATH` first.
- Install once with `cd apps/studio && bun link` to expose the `omi` command.
- CLI docs are data-driven: `src/shared/cli-docs.ts` feeds `omi guide`, `docs/omi-cli.md`,
  and the in-app Settings → Tools → Command line page. Regenerate the doc with
  `bun run scripts/omi-docs-smoke.ts --write`; the same script verifies sync.
- A legacy second CLI (`src/cli/omni.ts`, commands `chat`/`doctor`/`config`/`gateway`)
  still exists alongside `omi`; new work goes into `omi` only.

## Data Directory Layout

All user data lives under `<userData>` (macOS: `~/Library/Application Support/omni-studio.kunpengtalk.com/<channel>`):

```
omni-studio.db          SQLite (WAL) — 33 tables, Drizzle ORM
models/<repo>/...       Downloaded model weights
engines/{paddleocr,mflux,whispercpp,audiocpp,tessdata}/   Local engine binaries/data
images/{<docId>,chat,gen,edit,ocr,audio,videos}/          Media artifacts
uploads/                Uploaded source files for OCR / translation
backups/                *.omnibackup archives + temp restore dirs
mlx-downloads/          MLX weight download progress (.part resume)
omni-control.sock       CLI control channel (0600 permissions)
logs/app.log            JSONL app log (2MB rotation, secrets redacted)
```

**Never hardcode paths to these directories.** Use `src/bun/paths.ts` (`getUserDataDir()`) and `src/bun/db/index.ts` (`getDbPath()`). Both compute userData without importing `electrobun`.

---

## Frontend Conventions

- **Navigation is explicit dual-state, no URL routing:** `stores/app.ts` manages `activeApp` (~18 apps: chat, agent, voicecall, voice, image, video, ocr, translate, prompt, skills, kb, memory, automations, benchmark, gateway, usage, dashboard); `stores/router.ts` manages routes within each app.
- **State management is dual-track:** TanStack Query for data fetched from main process; Zustand for UI state and streaming data. Main-process push events write stores directly in `lib/rpc.ts` message handler (bypassing React render cycle), only calling `queryClient.invalidateQueries()` on terminal events.
- **RPC calls are direct:** ~220 call sites use `import { rpcClient }` then `rpcClient.xxx()` — no wrapper layer. Voice screen has the most (53+ calls). One light wrapper exists: `lib/use-engine.ts` for engine settings reads/writes.
- **Adding a new Screen:** Create `app/<name>-screen.tsx`, register it in `main-layout/settings.tsx`'s `TAB_DEFS` / `TAB_GROUPS`, add an icon to `app-rail`, and define RPC methods in `src/bun/rpc/index.ts`.

---

## Adding New RPC Methods

The RPC contract lives in `src/bun/rpc/index.ts` (~5,400 lines) which holds both type definitions AND all handlers. To add a new method:

1. Add `{ params: ..., response: ... }` to `bun.requests` schema section
2. Implement the handler function inside the same file's handler block
3. Call from frontend via `rpcClient.<methodName>(params)`
4. If the main process needs to push events back, add to `webview.messages` and subscribe with `initXxxBroadcast(win)` pattern

**Error convention is inconsistent:** Most handlers return `{ ok: false, error }` discriminated union; only transport-layer errors are Promise rejects. Check existing patterns before deciding.

---

## Database Migrations

Migrations live in `apps/studio/src/bun/db/migrations/` (currently 0000–0031). Generated by `drizzle-kit generate`:

```bash
cd apps/studio && bun run db:generate
```

**Critical rules:**
- **Always check migration ordering.** The `when` field determines execution order — if a new migration's `when` is less than a previous one, older databases skip it entirely during upgrade.
- New tables/columns go into SQL files; Drizzle schema lives in `src/bun/db/schema.ts`.
- WAL mode + `busy_timeout=5000` + `synchronous=NORMAL` supports concurrent reads from CLI/MCP bridge while app runs.

---

## Testing Conventions

### Unit Tests (`bun test`)

All tests auto-isolate via `test-preload.ts` which sets `OMNI_DATA_DIR` to a temp directory before any module loads. This prevents tests from touching the real database at import time.

```bash
# Run all unit tests
bun run test

# Run a single file
bun test src/bun/chat.test.ts
```

Test files are co-located with source: `src/bun/foo.ts` → `src/bun/foo.test.ts`. ~92 test files total (63 in bun/, 29 in mainview/).

### Smoke Tests (`test:smoke`)

End-to-end integration tests that exercise real DB operations, media pipelines, and Agent capabilities. Each script independently creates its own data dir:

```bash
cd apps/studio && bun run test:smoke
```

Runs: migrations-smoke, memory-smoke, kb-smoke, kb-chat-smoke, kb-rerank-smoke, kb-access-smoke, kb-governance-smoke, video-gen-smoke, backup-smoke, proxy-smoke, agent-capabilities-smoke, agent-live-check, agent-resilience-smoke, omi-docs-smoke, builtin-skills-smoke.

---

## Troubleshooting Guide

When something is broken, follow this order:

1. **Check app log:** `omi logs` or read `<dataDir>/logs/app.log` — every subsystem failure should have an entry here
2. **One-shot diagnostic dump:** `bun run --cwd apps/studio scripts/omni-diag.ts`
3. **OmniDoctor skill:** `.agents/skills/omni-doctor/` has a full triage procedure for each subsystem
4. **Inference server logs** are NOT in app.log (they use a separate 200k in-memory buffer): `omi server logs`
5. **Control socket status:** `omi status` to verify the running instance and channel

Common symptoms and their likely causes:
- **Image/audio preview 404** → Image server port conflict; check if another OmniStudio instance holds it
- **"Model download failed" en masse** → Python helper script missing from bundle (check `electrobun.config.ts` copy list)
- **Agent stuck / not responding** → Check permissions mode (`AGENT_APPROVAL_MODE`), sandbox settings, or context compaction issues
- **Migration fails on startup** → Check migration ordering in `db/migrations/`; try `omi backup` to save state before fixing

---

## Agent Tool Registration

New tools go through these files:

1. **Implementation:** Create `src/bun/<tool-name>.ts` — pure function that returns `{ ok: true/false, ... }`
2. **Registration:** Add tool definition to `agent-tools.ts` with name, description, parameters schema, and permission pattern
3. **Permission model:** Tools map to `(permission, pattern)` tuples — `bash` maps to command text, `write_file` to relative path, out-of-workspace access to `external_directory`, MCP to tool name
4. **Approval modes:** `smart` (default, only dangerous commands + workspace-outside), `manual` (all side-effect tools ask), `auto`, `strict`
5. **Credential blacklist:** Hard-blocked paths (`~/.ssh`, `~/.aws`, etc.) cannot be authorized even by user consent

See `permissions.ts` for the full authorization evaluation chain: built-in defaults → settings rules → workspace rules → session rules.

---

## i18n

All UI strings live in a single bilingual dictionary file: `shared/i18n.ts` (~3,000+ keys). Runtime language is stored in `stores/ui-lang.ts`. Default is Chinese with fallback chain zh → en → key. Uses simple `{name}` interpolation. When adding new UI elements, add both `zh` and `en` entries before shipping.

---

## Checks

Run what CI runs before committing:

```bash
bun run lint && bun run typecheck && bun run test
bun run --cwd apps/studio test:smoke
```
