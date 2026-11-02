# OmniStudio

Desktop workstation for local LLMs — manage models, run inference servers (llama.cpp / vLLM / SGLang / MLX / oMLX), and use Chat / Agent / Voice / Image / Video / OCR / Translate apps, with a local knowledge base, shared memory, and Skills management. Built with Electrobun (NOT Electron — do not use Electron APIs).

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
  (JSONL, `<dataDir>/logs/app.log`, 2MB rotation, secrets redacted) for image / video / music /
  TTS / ASR / OCR, the inference server, downloads, the gateway, the Agent and webview-side errors.
  Read it with `omi logs` (falls back to the file when the app is down — crash triage),
  the control socket `logs` command, or RPC `getAppLogs`. Inference server stdout/stderr is
  deliberately **not** in there (per-instance 200k in-memory buffer, `omi server logs`).
  A failure path without a `logEvent` call is a bug: the next person cannot diagnose it.
  Full triage guide: `.agents/skills/omni-doctor/`; one-shot evidence dump:
  `bun run --cwd apps/studio scripts/omni-diag.ts`
- **Every local runtime the app installs is one catalog, managed in one place**
  (`shared/local-engines.ts` + `bun/engine-catalog.ts` → Settings → 引擎): the twelve engines —
  llama.cpp / vLLM / SGLang / MLX / oMLX (text inference; oMLX is the Homebrew / .dmg
  Apple-Silicon server, not a pip package), whisper.cpp, audio.cpp, PaddleOCR,
  Tesseract, mflux, laya-mlx (SystemOne typed judgments, its own `systemone` group — it is a
  *judgment* model, not a chat model, so it does not belong under inference) and cloudflared —
  each get one row with state, version, path, disk usage
  and 安装 / 升级 / 卸载. Adding an engine = one `LOCAL_ENGINE_SPECS` entry + one probe/install/
  uninstall adapter; the page, its groups and its buttons are derived from those two, and the
  id doubles as the setup-screen engine id (`EngineInstallEvent.engine` is a `LocalEngineId`).
  Three rules: **uninstall only ever removes the managed copy** under `<dataDir>/engines/<id>`
  (PATH / brew / conda installs are never touched, so those rows deliberately show no uninstall
  button), and a row's 「管理模型」 button must **reset the route** before switching `activeApp`
  (`useRouter.getState().setRoute({ path: "index" })`) — the content area dispatches on
  `route.path`, so from settings only changing `activeApp` leaves the user staring at the settings
  page, i.e. a button that visibly does nothing (this bit the voice / OCR / image / JEV rows),
  and **model weights are never deleted with an engine** (each spec points at the page that
  owns them), and **install/uninstall stops whatever was using the engine first** (served models,
  whisper-server, OCR / MLX workers) — cloudflared refuses while its tunnel is up instead.
  Upgrading is the same path as installing with `upgrade: true` (pip `--upgrade`, or re-download
  for engines whose version is pinned in code); progress reuses the setup-screen push channel
  (`engineInstallLog` / `engineInstallPhase`), and `startEngineLogBridge()` folds the other
  installers' own logs into it rather than adding a second channel.
- **The 模型 group is five entries, one per question — don't add a sixth** (设置 → 模型):
  **模型库** (`library`), **运行模型** (`run`), **云端模型** (`cloud`), **默认模型** (`defaults`),
  **模型引擎** (`engines`).
  `mainview/app/model-library/` answers "what models do I have / where do they come from" with three
  horizontal tabs — **market** (ModelScope / HF search + recommended presets; downloads happen in
  model-detail), **downloaded** (the installed list, default tab) and **favorites** — and nothing
  else: engine choice and launch parameters are `mainview/app/local-models/` (运行模型), providers
  and their API keys are `CloudProviderPanel` (云端模型), the per-scene defaults (chat / embedding /
  voice call / TTS / ASR) are `main-layout/default-models-panel.tsx` (默认模型 — its own entry,
  *not* stacked under the cloud panel: credentials and "which model for which job" are two
  different questions), engine install/upgrade/uninstall is `main-layout/engines-tab.tsx`
  (模型引擎). A model-related surface belongs in one of those five, not in a new entry — the earlier
  six parallel entries (模型云服务 / 默认模型 / 本地模型 / 引擎 / 模型库 / 在线模型市场) forced users
  to hop pages for one task. Two rules that cost real bugs if broken: external jump targets still use
  the old ids
  (`network` → cloud, `model` → run, `store` → library, `market` → library's market
  tab, plus mini-app `omni.openSettings("network")` and `omi`'s `navigate` with `tab` / `sub`;
  `defaults` is a real tab again, so it no longer needs a legacy hop),
  so `settings.tsx`'s `LEGACY_TABS` must keep resolving them — an unmapped id lands on a blank pane;
  and every user-facing "configure it over in …" string (bun error messages, `cloud.where`, CLI
  help, the omni-doctor playbooks, whose left column matches raw error text) must name
  设置 → 云端模型 (厂商与密钥) / 设置 → 默认模型 (各场景用哪个模型) / 设置 → 模型引擎, not the
  retired names.
- **"This file is already downloaded" is a question about a repo, never about a bare file name**:
  the market's install check is `installedFilesForRepo(models, repo)`
  (`mainview/lib/installed-models.ts`) and it must stay repo-scoped — repo ids are normalized
  (`safeRepoId`, so the market's `org/repo` matches the on-disk `org__repo` dir and the HF-cache
  `org/repo` entry) and a file only counts for *its own* repo. `model-00001-of-00002.safetensors`
  is the same name in nearly every safetensors repo, so a global name set makes "download the whole
  model" skip the real weights: the repo lands with config/tokenizer only, and since
  `isRepoModelDir()` needs actual weights it then shows up nowhere — not in 运行模型 and not in the
  market, which prints 已下载 (真机丢过 K2-Horizon-7B-Uno-oQ6e 的 5.0+2.5 GB 与
  Qwen3.8-27B-4bit-MTP-MLX 的 ~16 GB). Two companions on the same path: `supportFiles` from the
  scan (config / tokenizer) must be counted too, or a complete repo still shows "还有 N 个文件要下";
  and a stale failed task must not stop the missing files from being enqueued — the download card's
  action补队列（`models.continueDownload`）resumes failed tasks *and* starts files that were never
  queued.
- **Cloud models are picked as `provider → model`, never as a per-page URL + key**: image,
  image-edit, video, TTS, ASR, live-translate and VLM OCR each store only a provider id
  (`IMG_PROVIDER_ID` / `TTS_PROVIDER_ID` / …) plus a model name; base URL and key come from
  the `cloud_providers` row (`resolveCloudProvider`). Providers are *enabled* individually
  (several at once — `enabled` column) and enabling runs a `/v1/models` key check, so a
  page never has to ask for credentials again. Each model entry carries a **purpose**
  (`CloudModelEntry.type`: image / video / tts / asr / chat / …; inferred from the id when
  absent) and every picker filters by it — a new cloud model selector must go through
  `CloudModelSelect` + `providersForType` instead of listing all providers.
  **The provider entries themselves are a built-in catalog, not something users assemble**:
  every entry in `CLOUD_PRESETS` (`shared/cloud-providers.ts`, grouped by `section`:
  official / cn / aggregator / global) is seeded into the table on first read
  (`ensureBuiltinProviders`, idempotent — existing rows are never touched), so the settings
  page lists all of them up front and the user only pastes an API key. A built-in row whose
  `baseUrl` still equals the preset's is an *app-maintained* address (`isBuiltinBaseUrl`):
  read-only in the panel, rejected by `updateCloudProvider`, and `deleteCloudProvider`
  refuses built-ins (they would just be re-seeded). Legacy rows whose address the user
  already changed stay editable. Adding a vendor = one `CLOUD_PRESETS` entry (with
  `section` + `apiKeyUrl`), never a UI or schema change; the first-run setup screen
  (`mainview/app/setup-screen/remote-flow.tsx`) reuses the same catalog and ends in
  `cloudProviderConfigure`, so a key typed there is the same row the settings page shows.
  Video and music are the exceptions that prove the rule: those APIs are not standardized, so
  the provider row also carries a protocol — `videoApi` ("minimax" | "seedance") and `musicApi`
  ("stepfun" | "minimax") — and it is the *only* dispatch switch (`bun/music-gen.ts` never
  branches on a vendor name). A new vendor = one protocol value + one submit/poll pair. Music
  also shows why per-protocol dispatch is not cosmetic: `stepfun` is async (submit + poll) while
  `minimax` is synchronous (one blocking request, so it runs in a background job and the record
  is backfilled), and both live in the same `music_records` table. Adding a *local* engine is a
  reserved slot already: settings (`MUSIC_LOCAL_*`), the record's `localBase`, and the UI toggle
  exist, and `localUnavailable()` states plainly that no engine is wired up rather than faking
  a result.
- **A cloud model's context window is one number, resolved by `shared/model-context.ts`** (user
  override on the model entry → size suffix in the id → catalog of known models → 256K default).
  It is the single source for the Agent's compaction budget (`bun/chat-context.ts` →
  `agent.ts` / `agent-context.ts`), for what the settings page shows, and for the `context_window`
  `omi launch` writes into the Codex / ChatGPT catalogs — so none of them can disagree; the
  override lives on `CloudModelEntry.contextLength` (looked up with
  `cloud-providers.ts`'s `contextLengthForModel`) and is edited in the 上下文 column of
  设置 → 云端模型. Cloud mode must never read `SERVER_CTX_SIZE` (that is the local
  llama.cpp KV knob; reading it once pinned `max_tokens` to 1 and produced empty cloud turns),
  and cloud output caps go through `CLOUD_MAX_OUTPUT_TOKENS`, never the window. Don't set 1M for
  models that are really 128K (DeepSeek) — an over-declared window pushes the compaction line
  past the vendor's real limit and turns into hard `context_length_exceeded` 400s.
- **JEV / SystemOne is a second protocol on the gateway, not another chat model**
  (`shared/systemone.ts` is the single source: types, validation, model catalog, error bodies,
  request ids). It answers *typed* questions — `choice` / `score` / `noul` — and returns
  probabilities instead of generated text, over TypeSafe's wire protocol, aligned field-by-field
  with the official API (verified against the live service, not paraphrased from docs):
  `POST /v1/systemone` with `{state, model, questions}`, `{model, answers, usage}` back,
  **403 for a missing key vs 401 for an invalid one** (both `{"detail":{"error_type","message"}}`),
  FastAPI-shaped 422, and `x-typesafe-request-id` on every response. That is what lets the
  official SDKs (`typesafe-sdk` / `@typesafe-ai/sdk`) reach the gateway by changing only
  `TYPESAFE_BASE_URL` and `TYPESAFE_API_KEY` — `gateway.systemone.test.ts` and
  `scripts/systemone-smoke.ts` call the real `@typesafe-ai/sdk` to keep that true, including
  its error classification. Three entries (the **JEV page** — its own rail entry between Agent
  and Voice Call, `app/jev/` / the `jev_evaluate` agent tool / `POST /v1/systemone`) all go
  through one `runSystemOne` (`bun/systemone.ts`), so the page and an external agent cannot
  disagree. It is a rail app and *not* an Agent right-panel tab on purpose: the page needs full
  width (editor + probability distributions), and two half-identical surfaces is the duplication
  the menu rules warn about. Two rules: `/v1/models` deliberately returns a
  **superset** (OpenAI's `data` *and* TypeSafe's `models` — each client reads only its own field,
  and two endpoints would break "just change the base URL"), and backend resolution normalizes
  the requested model name to what the chosen backend understands (a `laya-*` name on the cloud
  backend becomes the cloud default, a cloud alias on the local backend becomes the local model)
  because a drop-in client will not have edited its `model` string. The page is laid out like the TTS page (parameters
  left, output right): its left column starts with a judgment-engine switch — **local** (install
  the laya-mlx engine, download a checkpoint, start it) vs **cloud** (base URL + key), then the
  state and the question list; the right column is the probability distributions; the app sidebar
  holds the built-in examples (bilingual — Chinese examples under a Chinese UI, while identifiers
  like `noul` / `jev-latest` / `/v1/systemone` stay English because they get copied verbatim).
  Local deployment is the managed `laya-mlx` venv under `<dataDir>/engines/laya`
  (`bun/systemone-laya.ts` + `systemone-laya-worker.py`, Apple Silicon only, declared in
  electrobun's copy list; its protocol is `predict` / `models` / `download` / `load` / `unload` —
  `models` probes the HF cache with `local_files_only`, `download` reports real on-disk bytes from
  a polling main thread, `load` makes a checkpoint resident without running inference);
  **uninstall deletes only the venv, never the weights** in the HF cache, and the runtime
  timeout is separate (`SYSTEMONE_LOCAL_TIMEOUT_MS`, 600s) because the first call downloads
  weights. Price is a constant 0 (`SYSTEMONE_PRICING`); the usage ledger records tokens and
  count under channel `systemone`, never money. Both keys are in `ENCRYPTED_SETTINGS_KEYS`, and
  `SYSTEMONE_CLOUD_API_KEY` matches `REMOTE_SECRET_KEY`, so they are ciphertext at rest and
  blanked for web clients. Maintainer doc: docs/jev-systemone.md; bundled skill with examples:
  `builtin-skills/jev-typed-decisions/`.
- **Public exposure goes through `bun/tunnel.ts`, never through `GATEWAY_HOST=0.0.0.0`**:
  Settings → Services → Remote Access runs a supervised `cloudflared` child process
  (`bun/cloudflared.ts` downloads the official binary into `<dataDir>/engines/cloudflared/`;
  `--no-autoupdate` and detached + process-group kill are required) so the gateway is
  reachable from the internet over an outbound connection with no inbound port. Three
  invariants must not be relaxed: a **gateway API key is mandatory** before a tunnel starts
  (and is re-checked on every reconcile — a cleared key takes the tunnel offline), the
  gateway only accepts the tunnel's own hostname via `setGatewayPublicExposure()`
  (DNS-rebinding protection stays on, and `/` + `/health` additionally require the key while
  exposed), and the tunnel target port is always the gateway's **actually bound** port.
  Protocol fallback is the `TUNNEL_TRANSPORT_PROTOCOL` env var — cloudflared has no
  `--protocol` flag. Details and the failure modes already hit: docs/architecture.md §5.
- **Gateway API keys are a managed list, not a setting** (`bun/gateway-keys.ts`,
  `gateway_keys` table): each key has a name and can be enabled / disabled / deleted from
  Settings → Gateway, and the gateway checks every *enabled* key on each request, so
  revoking one takes effect immediately without a restart. `settings.GATEWAY_API_KEY`
  survives as a **mirror** of the oldest enabled key because tunnel gating, `/health`,
  `/docs`, `omi launch` and the KB access page read that slot (all keys disabled = tunnel
  goes offline); a value written there from outside (`omi serve --api-key`) is **adopted**
  into the list on the next read, so no key can stay usable-but-invisible. With no enabled
  key the historical behavior returns: open access for local processes, 401 while publicly
  exposed. Key values are shown masked (`shared/gateway-key.ts`) — never plaintext by
  default.
- **The web pages (`/chat`, `/agent`) are the app's own frontend, never a second UI**: the gateway
  serves the vite build of `mainview` as static files, and `mainview/lib/remote.ts` swaps the RPC
  transport for HTTP + SSE when `window.__electrobun` is missing (`lib/rpc.ts` keeps everything above
  the transport identical). Pushes reuse the existing `init*Broadcast(win)` wiring by feeding it a
  **fake window** whose `webview.rpc.send.<name>` becomes an SSE frame — never hand-copy a push list.
  Two rules when touching it: browser clients may only call `REMOTE_METHODS` in `bun/rpc/index.ts`
  (host dialogs, disk writes, engine installs and approval-mode changes stay closed), and
  `getSettings` must keep scrubbing credential fields (`REMOTE_SECRET_KEY`) before leaving the
  process. Remote clients intentionally skip the right panel (terminal / browser / review), the
  automations & plugins views, and the settings entry.
- **Mini apps are sandboxed single-file HTML pages, and the host hands them capabilities one by
  one** (app rail → 小应用 / `AppId = "apps"`): each one is `src/mainview/miniapps/<id>.html`
  (self-contained, `?raw`-imported into an `<iframe sandbox srcdoc>` **without**
  `allow-same-origin`, so it can never reach the host DOM / store / localStorage), plus one entry
  in `shared/miniapps.ts`. The host injects base styles, a boot config and the `window.omni`
  runtime (`mainview/lib/miniapp-bridge.ts`); every call comes back as a postMessage action that
  `dispatchMiniAppRequest` translates into a specific RPC. Two rules: the action list in
  `shared/miniapps.ts` is the *entire* surface (never add a "call RPC by name" pass-through — an
  iframe script would then own the whole RPC surface), and parameters from the page are untrusted
  (clamp lengths/ranges; `miniappReadFile` only accepts paths the user just picked in the system
  dialog). Capability readiness (`getMiniAppCapabilities` in `bun/miniapps.ts`) is checked before a
  card lets you in, mini-apps get the host language/theme via the `ready` event, and every failure
  lands in `app.log` under source `miniapp` (the page's own console is invisible to the host).
  Mini apps that must *keep* data go through host storage, not the iframe (an opaque origin has no
  `localStorage`): the Notes mini app writes bodies to the `miniapp_notes` table and attachments to
  `images/notes/<attachmentId>/` via the `notes.*` actions, so both travel with `omi backup`. Two
  rules on that path: the notes page renders Markdown itself (no bundler, so no parser dependency —
  it escapes the whole body first and only then applies markers, and allows http(s) links only, since
  the body is user input), and an attachment ref is only accepted in the host-generated shape
  `notes/<id>/<file>.<png|jpg|webp|gif>` (deleting a note removes that directory — a loose shape
  means "delete anything"), and size is clamped host-side (12MB decoded, long edge compressed to 2048).
  Notes are also the one mini-app that writes into the shared **memory** store: every save sinks an
  index-level memory (`笔记《title》(date)：body excerpt`, `sourceRef = note:<id>`, ≤500 chars — memories
  are single-line and get injected into every agent's context, so they carry a pointer, not the full
  text). Same note id updates the same memory, deleting the note deletes the memory, secret-looking
  notes are skipped while the body still saves, and `NOTES_AGENT_ACCESS` (on by default, shown in the
  notes settings) is the kill switch — it also gates the three read-only agent tools
  (`note_list` / `note_search` / `note_read` in `bun/notes-tools.ts`). Those exist because a 500-char
  memory only lets the agent *remember* a note; without a read path it improvises (grepping the
  workspace) and tells the user it cannot open the note. The memory text therefore ends with
  `（完整正文：note_read #<id>）` so recall leads straight into the tool. Tools are read-only, capped
  (8 items / 140-char excerpts / 12k chars of body) and given in plan mode too.
  Mini-app data is also invisible to backups until it is registered: a new table needs a scope in
  `shared/backup.ts`'s `BACKUP_SCOPES`, and new media needs a `BACKUP_FILE_ROOTS` entry — files that
  match no root are silently skipped, and the `media` root is off by default (notes therefore have
  their own default-on scope plus a `note-images` root under `images/notes`).
  Image work that spans several calls goes through `bun/miniapp-image.ts` (动态表情包:
  照片 → 16 张贴纸 → GIF). Four invariants: a **session ref** — the host signs refs
  (`image.stage`) and only accepts its own back (`image.edit`'s `ref`, `gif.make`'s frames),
  per app id; without that, `ref` would be an interface for a sandboxed page to send any
  image in the user's library to a cloud vendor. Staging is **cached per (app, path)** so a
  16-piece pack copies the source photo once instead of sixteen times. **The model is picked
  inside the page, from a host-owned catalog** (`omni.image.models`: what exists, what is
  usable — MLX weights downloaded? provider key filled? — and `supportsReference` per
  backend), because "which models exist" is knowledge only the main process has; the page
  only reports its choice and `resolveMiniAppImageChoice` re-validates it (MLX presets only,
  existing+configured providers, no `..` in a ComfyUI checkpoint name) while never writing the
  user's saved image config. `supportsReference` is also what switches the prompts between
  "redraw the person in this photo" (cloud) and "draw this described character" (local MLX /
  ComfyUI, which are text-to-image only) — do not infer that from the backend name in the page.
  GIF assembly happens **in the host** (sharp; frames are resized individually *before* `join`,
  because resizing a joined animation silently collapses it to one page) and the page only
  decides frame order — `S + reverse(S)[1:-1]`, where S starts with the source sticker itself in
  reference mode, so loops join seamlessly for the price of two generated frames. Prompts live
  in the page (`PROMPT` in `sticker.html`): base rules + style + per-sticker pose/caption,
  because a pack is only a pack if every image is the same person in the same art style.
  To look at a page without booting the desktop app: `bun run --cwd apps/studio miniapps:preview`
  (the pages, with a stub host in a plain browser) and `miniapps:center` (the app center, rendered
  against the built stylesheet).
- **Music is a playlist library, not a record list** (音乐 app): the left sidebar is playlists
  (`bun/music-playlists.ts` + `music_playlists` / `music_playlist_items`), the right side is the
  selected playlist's track page, and a bottom player bar (`stores/music-player.ts`) stays put
  across all three views. Three invariants: the **default playlist is a real builtin row** — every
  new record is added to it by `insertMusicRecord`, so a song can never exist only in the creation
  log; songs are recorded once and belong to *N* playlists, which is why membership is its own table
  (removing one there must stick, so the old-record backfill runs **only** when that row is created,
  never on later reads); and the **audio element is a module-level singleton outside React** whose
  queue is a snapshot taken when the user hits play, refreshed by `patchQueue` from the
  `["music-records"]` query — a track that finishes generating must become playable without
  restarting playback. Album art does not exist in either upstream API, so covers are deterministic
  gradients (`app/music/cover.tsx`); a playlist cover is a 2×2 mosaic of its first four tracks.
  Playlists are user-authored structure, so they get their own default-on `BACKUP_SCOPES` entry.
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
omni-studio.db          SQLite (WAL) — 44 tables, Drizzle ORM
models/<repo>/...       Downloaded model weights
engines/{paddleocr,mflux,whispercpp,audiocpp,tessdata}/   Local engine binaries/data
images/{<docId>,chat,gen,edit,ocr,audio,videos,music,notes}/   Media artifacts
                        (notes/ = 笔记小应用的附件，目录名即附件 id，删笔记时整目录删掉)
uploads/                Uploaded source files for OCR / translation
backups/                *.omnibackup archives + temp restore dirs
mlx-downloads/          MLX weight download progress (.part resume)
omni-control.sock       CLI control channel (0600 permissions)
logs/app.log            JSONL app log (2MB rotation, secrets redacted)
```

**Never hardcode paths to these directories.** Use `src/bun/paths.ts` (`getUserDataDir()`) and `src/bun/db/index.ts` (`getDbPath()`). Both compute userData without importing `electrobun`.

---

## Frontend Conventions

- **Navigation is explicit dual-state, no URL routing:** `stores/app.ts` manages `activeApp` (~18 apps: chat, agent, voicecall, voice, image, video, music, ocr, translate, prompt, skills, kb, memory, automations, benchmark, gateway, usage, dashboard); `stores/router.ts` manages routes within each app. The **id list of the left primary menu** (`AppId`, the 15 rail entries) lives in `shared/app-rail.ts` — together with the layout rule below — so the rail and the settings card that configures it can never disagree.
- **The left primary menu is user-configurable** (`APP_RAIL_LAYOUT` = one JSON array of `{id, hidden}`, edited in 设置 → 外观 → 左侧一级菜单): order = display order, each entry can be hidden, and the **settings gear stays pinned** at the bottom (never part of the list — hiding the way back into settings would be a trap). Parse/serialize/move are pure functions in `shared/app-rail.ts`, with three tolerance rules that must not be relaxed: unknown ids are dropped, duplicates keep the first, and ids missing from the stored layout are **appended in default order and visible** (a new app must not ship invisible because the user once saved an old layout). Empty string = default; `resolveRailLayout` never returns a partial list.
- **State management is dual-track:** TanStack Query for data fetched from main process; Zustand for UI state and streaming data. Main-process push events write stores directly in `lib/rpc.ts` message handler (bypassing React render cycle), only calling `queryClient.invalidateQueries()` on terminal events.
- **RPC calls are direct:** ~220 call sites use `import { rpcClient }` then `rpcClient.xxx()` — no wrapper layer. Voice screen has the most (53+ calls). One light wrapper exists: `lib/use-engine.ts` for engine settings reads/writes.
- **Adding a new Screen:** Create `app/<name>-screen.tsx`, register it in `main-layout/settings.tsx`'s `TAB_DEFS` / `TAB_GROUPS`, add its id to `shared/app-rail.ts`'s `APP_RAIL_IDS` **and** an icon to `app-rail.tsx`'s `APP_ICONS` (both are `Record<AppId, …>` — TS will point at the missing one; the settings card derives its rows from the same list, so a new app needs no UI work to be reorderable), and define RPC methods in `src/bun/rpc/index.ts`.
- **Model ids are shown in full, never as `…`:** the id is the only thing telling
  `stepaudio-3-asr-max` from `stepaudio-2.5-asr`, and it is what a user retypes into an API call —
  a column of `stepaudi…` makes the list useless. Let the id wrap when the column is narrow
  (`wrap-anywhere`, which shrinks the column's min-content so auto table layout still fits the
  card) and treat `title` as a bonus, not as the only way to read it. Ellipsis is for secondary
  text only — a `name` alias or a remark. List / management surfaces must obey this; a narrow
  fixed-height picker trigger (`CloudModelSelect`) cannot wrap, so the tooltip stays the fallback.

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

Migrations live in `apps/studio/src/bun/db/migrations/` (currently 0000–0040). Generated by `drizzle-kit generate`:

```bash
cd apps/studio && bun run db:generate
```

**Critical rules:**
- **Always check migration ordering.** The `when` field determines execution order — if a new migration's `when` is less than a previous one, older databases skip it entirely during upgrade.
- **The migrator compares one number, read once**: drizzle takes `SELECT … ORDER BY created_at DESC LIMIT 1`
  before the loop and never updates it, so any migration whose `when` is not greater than that value is
  **permanently unreachable** for that database — it will not be re-tried on later starts. Two mechanisms
  in `db/index.ts` exist for that, and both run before `migrate()`: `normalizeMigrationTimestamps()`
  rewrites applied rows' `created_at` to the journal's `when` (matched by SQL hash), and
  `repairUnreachableMigrations()` re-runs entries whose `when` is ≤ the DB's max but which have no applied
  row. A merged branch that renumbers migrations (main keeps its numbers, ours shift to the end —
  `when` taken from the introducing commit's ms) is exactly when these fire; regression coverage is
  `db/db-migrate-timestamps.tests.ts` (four cases: fresh, poisoned, released 0.1.0, local canary).
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

Runs: migrations-smoke, memory-smoke, kb-smoke, kb-chat-smoke, kb-rerank-smoke, kb-access-smoke, kb-governance-smoke, video-gen-smoke, music-gen-smoke, backup-smoke, proxy-smoke, agent-capabilities-smoke, agent-live-check, agent-resilience-smoke, omi-docs-smoke, builtin-skills-smoke.

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
