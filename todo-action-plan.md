# Deep Work Tracker — Action Plan to Production

Sequential, atomic checklist. Each phase leaves the app in a strictly better, verifiable
state. Do not start a phase until the previous phase's "Gate" passes. Commands assume `bun`
(per `CLAUDE.md`).

Cross-references point at [80-20-discoveries.md](80-20-discoveries.md).

---

## Phase 0 — Make it install and build (blocks everything)

- [ ] `bun add @astrojs/node @libsql/client` — add the two imported-but-undeclared runtime deps (0.1).
- [ ] `bun add -d @astrojs/check typescript@~5.7` — type-check tooling; pin TS `<6` until `astro check` supports the native compiler (7.2).
- [ ] Fix `package.json`: set a real `"name"`, delete the non-standard `"allowScripts"` block, add `"trustedDependencies": ["esbuild", "@libsql/client", "libsql"]` if postinstall scripts are actually needed.
- [ ] Add scripts: `"check": "astro check"`, `"lint": "eslint ."`, `"test": "vitest run"` (wire the tools in Phase 7; the entries can land now).
- [ ] Decide the Astro version story (7.2): either pin exact versions and commit a lockfile that resolves cleanly from `package.json`, or downgrade to a released Astro line. `bun install` from a clean checkout must reproduce a working tree.
- [ ] Deal with `src/pages/analytics.astro` (0.2): **delete it now** (move the two SQL queries into `src/db/analytics.ts` as string constants for Phase 3). It is not recoverable as-is and it fails the whole build.
- [ ] Remove the committed `CLAUDE.md` → `AGENTS.md` symlink situation (7.3): commit a real `CLAUDE.md`, restore or intentionally drop `AGENTS.md`/`README.md`, get `git status` clean.

**Gate:** `bun install` on a clean clone succeeds; `bun run build` exits 0; `dist/` is produced.

---

## Phase 1 — Configuration and environment (stop the 500s)

- [ ] Create `.env.example` with every variable the code reads: `TURSO_SYNC_URL`, `TURSO_AUTH_TOKEN`, `DEVICE_ID`, `LOCAL_REPLICA_PATH`, `HOST`, `PORT`.
- [ ] Add `src/lib/env.ts` (zod or `astro:env` schema) that validates required env once at startup and throws a single readable error listing what is missing (1.1).
- [ ] Rework `src/db/client.ts` (1.1, 1.2, 7.4):
  - [ ] Remove the `process.env.TURSO_SYNC_URL!.replace(/^file:/, "")` derivation for `remote`; derive the HTTP URL explicitly and only construct `remote` when a sync URL exists.
  - [ ] Wrap `createClient` (the embedded replica) in try/catch. On failure, fall back to a **local-only** `file:` client with `syncInterval: 0` and no `syncUrl`, and set a module flag `SYNC_DISABLED = true`.
  - [ ] Enable foreign keys on the connection: `await db.execute("PRAGMA foreign_keys = ON")` immediately after construction (1.4).
- [ ] Make `src/db/sync.ts` a no-op when `SYNC_DISABLED` (return `state: "offline"`/`"local"` without calling `db.sync()`), so local dev and a down primary don't 500 or storm (1.2, 3.1).
- [ ] Guard the `sync` singleton and its `setInterval` behind a `globalThis.__dwSync` check, mirroring the db client (5.1).

**Gate:** `bun run dev` with **no `.env`** serves `/` and `GET /api/session` → 200 `{session:null}`. With a valid `.env`, same. With a deliberately unreachable `TURSO_SYNC_URL`, still 200 (degraded), not 500.

---

## Phase 2 — Database bootstrap and migrations

- [ ] Add `scripts/db-push.ts` + `"db:push"` script: apply `src/db/schema.sql` to the primary **and** to a fresh local file, idempotently (1.3).
- [ ] Add `scripts/db-seed` or fold the `INSERT OR IGNORE` project rows into the push so a fresh local DB has the four projects.
- [ ] Document the one-time setup in `README.md`: create Turso DB, set env, `bun run db:push`.
- [ ] Add a startup check: if `SELECT count(*) FROM projects` throws, log a clear "run `bun run db:push`" message instead of a raw SQL error.
- [ ] Confirm `PRAGMA foreign_keys` is actually ON at runtime (`PRAGMA foreign_keys;` → 1).

**Gate:** Fresh machine, no existing DB file: `bun run db:push && bun run dev` → `/api/session` 200, projects present. Inserting a session with a bogus `project_id` is **rejected** by the FK, not silently accepted (1.4).

---

## Phase 3 — Wire up the actual UI (there currently is none)

- [ ] `bun add -d tailwindcss @tailwindcss/vite daisyui` (0.4).
- [ ] Add `@tailwindcss/vite` to `astro.config.mjs` `vite.plugins`; create `src/styles/global.css` with `@import "tailwindcss";` and the DaisyUI plugin directive.
- [ ] Create `src/layouts/Layout.astro`: full `<html data-theme="…">`, `<head>` (charset, viewport, `<title>`, favicon), imports `global.css`, `<slot />`.
- [ ] Rewrite `src/pages/index.astro` to use `Layout` and mount `<DeepTimer />`, `<CaptureModal />`, `<SyncBadge />` (0.3).
- [ ] Replace `public/favicon.svg`/`.ico` and the "Astro" `<title>` (7.10).
- [ ] Pick one language for the UI and translate `CaptureModal` accordingly (7.5).
- [ ] Rebuild `analytics.astro` as a real page: `Layout` + server-side data via `src/db/analytics.ts`, rendered as HTML/SVG bars or a pinned charting lib (add the dependency explicitly) (0.2, 7.8).
- [ ] Fix the timer component's responsive sizing: cap the display with `clamp()` / a `max-width` container so the `md` breakpoint can't overflow (7.9).
- [ ] Remove the dead `const btn` in `DeepTimer`'s keydown handler; match projects by `data-project` + a `data-hotkey` attribute instead of `textContent.startsWith` (7.9).
- [ ] Add `prerender` decisions for `index`/`analytics` (7.6).

**Gate:** `bun run dev` → homepage shows styled project buttons, a running timer, and the sync badge. Play → pause → resume → stop → annotate round-trips, and each step is visible in the DB (`SELECT * FROM sessions`). `/analytics` renders a chart from real rows.

---

## Phase 4 — Timer and sync correctness

- [ ] `DeepTimer`: add a visibility-gated `setInterval(() => this.#pull(), 20_000)` (or an SSE/`EventSource` subscription to a new `/api/session/stream`) so cross-device state converges on an idle focused tab (2.2).
- [ ] `DeepTimer`: serialize outbound mutations — queue actions, `await` the in-flight request before sending the next, drop redundant intermediate toggles (2.3).
- [ ] `DeepTimer`: surface failures — replace empty `catch {}` with a visible error state on the component (2.3).
- [ ] `clock.ts`: call `calibrate()` before every mutation (not just `start`); set `calibratedAt = Date.now()` even on failure; take ~5 samples per calibration and keep the one with the lowest RTT (4.1, 4.2).
- [ ] `clock.ts`: clamp `offset` to a sane bound (e.g. ±5 min) and log when it exceeds it.
- [ ] `sessions.ts`: use one clock source consistently. Either write `updated_at`/`synced_at` with raw `Date.now()` everywhere, or route every timestamp through `now()` including `sync.ts`'s `cutoff` (3.2, 4.3).
- [ ] `sync.ts`: only stamp `synced_at` for rows confirmed pushed — inspect `db.sync()`'s return (frame numbers) or re-query after sync (3.2, 3.3).
- [ ] `sync.ts`: honor backoff — `freshRead`/`afterWrite` should request a sync but respect `#nextAt`; add a hard ceiling on forced syncs per minute (3.1).
- [ ] `api/sync.ts` POST: return the current snapshot immediately and trigger the flush in the background instead of `await`ing it (3.4).
- [ ] `SyncBadge`: debounce forced polls; drop the 5s interval to ~15s and rely on `deepwork:mutated` + connectivity events (3.4).
- [ ] Cross-device open-session conflict resolution (2.1): move the authoritative single-open-session check to the **primary** (a trigger or a server action that runs against `remote`), or add a deterministic reconciliation on sync ("keep the open row with the latest `start_time`, force-complete the rest") and reflect it in the UI.

**Gate:** Two browser profiles pointed at the same DB: starting/pausing/stopping in one is reflected in the other within one poll interval. Kill the network mid-session: timer keeps painting, badge goes offline, no request pile-up (observe with devtools). Restore network: one sync catches up, `synced_at` is set only on rows that actually pushed.

---

## Phase 5 — Lifecycle and leaks

- [ ] Add `disconnectedCallback()` to `DeepTimer`, `CaptureModal`, `SyncBadge` (5.1).
- [ ] Create one `AbortController` per element in `connectedCallback`; pass `{ signal }` to every `addEventListener`; call `controller.abort()` in `disconnectedCallback`.
- [ ] `DeepTimer`: store the rAF id and `cancelAnimationFrame` on disconnect.
- [ ] `SyncBadge`: store the interval id and `clearInterval` on disconnect.
- [ ] `sync.ts`: return the interval handle from `start()`, expose `stop()`, and only auto-start once via the `globalThis` guard from Phase 1.
- [ ] Add an `astro:page-load` guard (or a `data-initialized` attribute) so View Transitions / client nav don't double-initialize custom elements.

**Gate:** Repeatedly navigate away and back (or toggle a wrapping `{show && <DeepTimer/>}`); devtools shows listener count and active timers returning to baseline each cycle.

---

## Phase 6 — Security and hardening

- [ ] Decide the deployment model. If network-reachable: add auth (a shared passphrase → signed httpOnly SameSite=Strict cookie, checked in `src/middleware.ts` for `/api/*`). If strictly local: bind `HOST=127.0.0.1`, document it, and still do the below (6.1).
- [ ] Add an `Origin`/`Referer` check (or a per-session CSRF token) to `POST /api/session` and `POST /api/sync` (6.1).
- [ ] Server-side input validation in `api/session.ts` (zod): `action` enum, `id` is a UUID, `projectId` exists in `projects`, `difficulty ∈ {easy,medium,hard}|null`, `notes` length ≤ 240, trimmed (6.3, 1.4).
- [ ] Stop leaking internals (6.2): log `e` / `sync.lastError` server-side; return `{ error: "conflict" }` / generic codes to clients. Remove `sync.snapshot().error` from any client-facing payload (keep it in a server-only log/metric).
- [ ] Add basic rate limiting to `/api/*` (in-memory token bucket per IP is fine for a single-user app).

**Gate:** `curl` with a bad `projectId`, oversized `notes`, unknown `action`, and a cross-origin `Origin` header each get a clean 4xx with no stack trace, no SQL text, no Turso URL.

---

## Phase 7 — Quality gates

- [ ] Add ESLint (`eslint`, `@typescript-eslint`, `eslint-plugin-astro`) + Prettier or Biome; commit config; `bun run lint` clean.
- [ ] Add Vitest. Unit tests:
  - [ ] `timer.ts` — `elapsedMs` across active/paused/completed, clock-skew clamp, `formatHMS` (7.7).
  - [ ] `sessions.ts` state machine against an in-memory libsql file: start→pause→resume→stop→annotate, CAS no-ops, `SESSION_ALREADY_OPEN`, FK rejection.
  - [ ] `sync.ts` — `synced_at` stamping picks the right rows; backoff is respected; `SYNC_DISABLED` short-circuits.
- [ ] Integration test: boot the built server with a temp local DB, drive the full API sequence over HTTP, assert DB state.
- [ ] Add `.github/workflows/ci.yml`: `bun install --frozen-lockfile`, `bun run build`, `bun run check`, `bun run lint`, `bun run test`.

**Gate:** CI is green on a clean checkout.

---

## Phase 8 — Deploy readiness

- [ ] `Dockerfile` (or documented process-manager setup); expose `HOST`/`PORT`; run `node ./dist/server/entry.mjs`.
- [ ] Add `GET /api/health` returning build id + sync state + DB reachability.
- [ ] Structured logging for the sync supervisor (state transitions, errors, frame counts) to stdout.
- [ ] Document the Turso primary backup/restore procedure.
- [ ] Load-check: one device, tab open 24h — confirm no unbounded growth in the server process (sync interval, Astro filesystem sessions) and no replica-file bloat.
- [ ] Decide whether Astro filesystem sessions (auto-enabled by `@astrojs/node`) should be disabled (7.11).

**Gate:** Fresh environment: `docker build` → `docker run` with env → homepage works, `/api/health` green, survives a primary outage and recovery without a restart.

---

## Suggested commit slicing

1. Phase 0 (build) — one PR.
2. Phase 1 + 2 (env + bootstrap) — one PR.
3. Phase 3 (UI) — one PR, reviewable screen-by-screen.
4. Phase 4 (sync/clock) — one PR, needs the two-device test in the description.
5. Phase 5 (leaks) + Phase 6 (security) — one PR.
6. Phase 7 (CI/tests) — one PR, ideally opened early and grown.
7. Phase 8 (deploy) — one PR.
