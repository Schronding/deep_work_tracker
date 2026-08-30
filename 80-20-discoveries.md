# 80/20 Discoveries — Deep Work Tracker Audit

**Auditor role:** Principal/Staff engineering review. Read-only pass over the full repo plus
build/type-check/runtime probes. No application source was modified.

**Verdict:** This is not a working application. It is a set of well-commented fragments that
have never been run together. It does not install, does not build, has no mounted UI, and the
data layer crashes on every request in every configuration I could construct. The comments
describe a robust distributed system; the code implements roughly 30% of it.

The critical 20% below accounts for essentially 100% of "it doesn't work" and the most
dangerous 80% of what will bite you after it does.

---

## TIER 0 — Does not install, build, or render (blocks everything)

### 0.1 Missing runtime dependencies — `bun install` + `bun run build` fail immediately
`package.json` declares exactly one dependency: `astro`. But:
- `astro.config.mjs` imports `@astrojs/node` → `Cannot find module '@astrojs/node'` on config load.
- `src/db/client.ts` imports `@libsql/client` → unresolved.
- No `tailwindcss`, no `daisyui`, no `@tailwindcss/vite`, no `@astrojs/check`, no `typescript`.

A fresh clone cannot build. Verified: `bun install` pulls 200 packages (astro only); `bun run
build` dies on the config import before touching a single page.

### 0.2 `src/pages/analytics.astro` is not an Astro file — it breaks the entire build
The frontmatter fence contains **raw SQL**, not JS/TS:

```
---
-- Hours per project, last 7 days ...
SELECT p.name, p.color, ...
---
```

`astro build` → `CompilerError: Expected a semicolon ... analytics.astro:2:8`. `astro check`
reports **~115 errors** from this one file. One broken page fails the whole server build, so
**there is no deployable artifact at all** until this file is fixed or deleted. It is a
scratchpad of two queries with no template, no charting, no `db` call, no output.

### 0.3 There is no application UI — `index.astro` is the untouched starter
`src/pages/index.astro` renders `<h1>Astro</h1>`. `DeepTimer`, `CaptureModal`, and `SyncBadge`
are **never imported or mounted anywhere in `src/pages/`**. There is no `Layout`, no `<head>`
wiring, no CSS entrypoint. The entire front end is dead code. `README.md` is still the
"Astro Starter Kit: Minimal" boilerplate.

### 0.4 No Tailwind / DaisyUI — every component is unstyled even if mounted
100% of the component markup is DaisyUI (`btn`, `modal`, `kbd`, `input-bordered`, `kbd-xs`)
and Tailwind utilities (`grid place-items-center`, `text-[18vw]`, `fixed bottom-3 right-3`).
Nothing is installed, there is no `tailwind.config`, no vite plugin, no imported stylesheet.
`CLAUDE.md` states "Framework: Astro and TailwindCSS" — the stack described does not exist in
the repo.

---

## TIER 1 — Data layer crashes on every request (verified against the built server)

### 1.1 `client.ts` throws on import when env vars are unset → every DB route 500s
`src/db/client.ts:33`:
```js
url: process.env.TURSO_SYNC_URL!.replace(/^file:/, "")
```
With `TURSO_SYNC_URL` unset the non-null assertion passes `undefined` straight through:
`TypeError: Cannot read properties of undefined (reading 'replace')`, thrown at module import
of the `sync` chunk. **Verified**: built server boots, `GET /` → 200 (dead starter page),
`GET /api/session` → **500**, log shows the exact `TypeError`.

### 1.2 "Offline-first" is false on cold start — `createClient` pulls the primary synchronously
With `offline: true` + `syncUrl` set to an unreachable host, `createClient` **still tries to
pull the replica during construction**. **Verified**: with dummy env,
`GET /api/session` → 500, `Error: Sync(PullDb(404, "Host not found"))` thrown at import.
Consequence: if Turso is unreachable when the process starts, the embedded replica cannot be
created and **every DB route 500s** — the exact scenario the `offline:true` comment claims to
handle.

### 1.3 No local-only path, no env template, no migration runner
There is no `.env.example`, no config validation, no schema/migration tooling. `schema.sql`
says "Apply ONCE against the primary" by hand. A developer with no Turso primary gets an empty
replica file with no tables → `no such table: projects` on the first query, which is executed
in `DeepTimer.astro` frontmatter during SSR → page 500. `bun run dev` cannot succeed on a
clean machine.

### 1.4 Foreign keys are not enforced → unvalidated `projectId` permanently wedges the app
`PRAGMA foreign_keys = ON` in `schema.sql` only affects the connection that ran the schema
(the Turso shell). `@libsql/client` does **not** enable foreign keys per connection. `start()`
inserts `project_id` with **zero validation**. Send `{action:"start", projectId:"bogus"}`:
- The row is inserted (no FK check).
- It occupies the `ux_sessions_open` unique slot (`open_slot = 1`).
- `current()`'s `JOIN projects` returns 0 rows → API reports `session: null`, UI shows idle.
- Every future `start()` throws `SESSION_ALREADY_OPEN` (or hits the unique index).

Result: **silent permanent deadlock** — can't start a session, nothing is displayed, no error
surfaced. `start()` even returns `(await current())!` (line 45), so a null-join makes it
return `null` past a non-null assertion.

---

## TIER 2 — The "cross-device" invariant, which is the whole point, does not hold

### 2.1 "At most ONE open session across all devices, enforced by the engine" — false
`schema.sql:39-45`. The partial unique index on the generated `open_slot` column is enforced
**per replica**. Under the offline-first model every device has its own replica:

1. Device A (offline) starts session → row A, `open_slot = 1`, valid locally.
2. Device B (offline, hasn't synced) starts session → row B, `open_slot = 1`, valid locally.
3. Both sync. Primary now receives two rows with `open_slot = 1` → unique-constraint
   violation on push, or divergent replicas.

There is **no conflict-resolution code anywhere**. `db.sync()`'s result is discarded
(`sync.ts:35`). The invariant the schema comment leans on is unenforceable in this
architecture.

### 2.2 `DeepTimer` never polls — a focused tab never learns the session changed elsewhere
`connectedCallback` calls `#pull()` **once**, then a pure `requestAnimationFrame` paint loop.
Refreshes happen only on `visibilitychange`, `focus`, `online`. A tab that stays open and
focused while another device pauses/stops the session **keeps counting forever**. The
server-side `sync.ts` heartbeat (`PULL_MS = 30_000`) pulls DB frames but the browser never
re-reads them. A multi-device timer needs polling, SSE, or WebSockets — none exist.

### 2.3 Out-of-order `fetch` + optimistic state → silent client/server divergence
`#onToggle` mutates `this.#session` optimistically, then fires `fetch`. Rapid pause→resume
sends two POSTs with no ordering guarantee. Server mutations are CAS
(`WHERE ... AND status = 'active'`); if they land reversed, one silently updates 0 rows.
Client believes "active", server is "paused". With no periodic `#pull` (2.2) the two stay
out of sync indefinitely. All `catch` blocks are empty — the user is never told.

---

## TIER 3 — Sync supervisor: backoff is dead, stamping is wrong

### 3.1 `force = true` bypasses backoff on the only two paths that use it
`flush(force)` skips the `Date.now() < this.#nextAt` guard when forced. Both
`freshRead()` (read path) and `afterWrite()` (write path) call `flush(true)`. The
`BACKOFF = [1s,3s,8s,20s,60s]` array is therefore **never consulted for real traffic**. When
Turso is unreachable, **every GET `/api/session` and every mutation triggers a fresh
`db.sync()` network timeout**. `lastSyncAt` starts at 0, so `freshRead` forces a sync on the
very first request and keeps forcing (offline → `lastSyncAt` never advances).

### 3.2 `synced_at` stamping mixes two clocks → the "pending push" set is unreliable
`sync.ts:32-39`: `cutoff = Date.now()` (raw), but rows are written with
`updated_at = now()` = `Date.now() + offset` (calibrated, `clock.ts`). A non-zero `offset`
means the `WHERE synced_at IS NULL AND updated_at <= cutoff` filter is skewed: rows can be
marked synced that `db.sync()` never pushed (offset < 0), or never marked (offset > 0),
diverging from `ix_sessions_unsynced`. `synced_at` is also set to raw `Date.now()`, violating
the schema's "all timestamps are the calibrated ms-epoch" convention.

### 3.3 `db.sync()` return value ignored; push conflicts undetectable
No inspection of `frames_synced` / frame numbers. A rejected push (see 2.1) looks identical to
a clean sync.

### 3.4 Sync storm + blocking endpoint
`SyncBadge` POSTs `/api/sync` (forced flush) every 5s **plus** on `online`, `visibilitychange`,
and every `deepwork:mutated`. `/api/sync` POST does `await sync.flush(true)` — the HTTP
response blocks on a full round-trip, so when Turso hangs, the request hangs, 5s apart,
forever.

---

## TIER 4 — Clock authority

### 4.1 `offset` is per-process, not "shared by every device"
`clock.ts` comment: "wall-clock authority shared by every device." It is a module-level
`let offset` in one Node process. Each device runs its own server and its own calibration.
Single-sample NTP estimate, no min-RTT filtering, no sanity clamp.

### 4.2 `calibrate()` only runs from `start()`
`pause`, `resume`, `stop`, `annotate` all call `now()` directly with a possibly hours-stale
offset (`TTL = 1h`, only refreshed at session start). On failure `calibratedAt` is **not**
updated, so a failing primary makes every `start()` re-attempt the network probe.

### 4.3 `elapsedMs` clamp turns clock skew into a silent frozen timer
`timer.ts:14`: `Math.max(0, now - resumed_at)`. If `resumed_at` was written by a device whose
clock was ahead, every other device renders the timer **stuck at `accumulated_ms`** until wall
time catches up. The comment frames this as "never runs backwards"; the actual UX is "looks
hung, no explanation."

---

## TIER 5 — Memory leaks / element lifecycle

### 5.1 Zero cleanup anywhere
`grep` confirms: no `disconnectedCallback`, no `removeEventListener`, no `clearInterval`, no
`AbortController` in the codebase.
- `DeepTimer` adds `keydown`/`online`/`focus`/`visibilitychange` listeners to `window`/
  `document` — never removed.
- `SyncBadge` starts `setInterval(..., 5000)` — handle discarded, never cleared — plus 4
  listeners.
- `CaptureModal` adds a `document` `deepwork:ended` listener + dialog listeners — never
  removed.
- `sync.ts` runs `sync.start()` (another `setInterval`) at module scope with no `globalThis`
  guard, unlike the db client.

Any client-side navigation, Astro View Transitions, or dev HMR re-runs `connectedCallback`
and/or re-imports `sync.ts` → **duplicated listeners, multiplied polling intervals, doubled
event dispatch, doubled `db.sync()` timers**. The `#loop` rAF is also never cancelled.

---

## TIER 6 — Security / information disclosure

### 6.1 No auth, no CSRF, no rate limiting on state-changing endpoints
`POST /api/session` accepts any `action`/`id`/`projectId` from anyone. `output: "server"` in
standalone Node with no host binding and no note that this is localhost-only. If it is ever
port-forwarded or deployed, it is fully open. (SQL is parameterized — no injection — but see
1.4 for the unvalidated-`projectId` wedge.)

### 6.2 Internal error + sync-error strings leaked to clients
`session.ts:32`: the 409 body includes `error: String(e)` and `sync.snapshot().error`, which
is the raw `db.sync()` failure message — it can contain the Turso sync URL and auth-failure
detail. Any client can read your infra topology by triggering a sync error.

### 6.3 No server-side input validation
`difficulty` and `notes` are validated only by client `maxlength`/button set. API bypass →
unbounded `TEXT` writes; a bad `difficulty` hits the DB `CHECK` and surfaces as a 409 with a
constraint-error string (6.2). `action` has a `default:` 400, which is the only guard.

---

## TIER 7 — Smaller, still real

| # | Issue |
|---|---|
| 7.1 | `package.json` `"name": ""` (invalid); `"allowScripts"` is not a bun field (it's `trustedDependencies`); no `lint`/`check`/`test` scripts. |
| 7.2 | `astro: "^7.2.7"` with a lockfile full of renamed internals (`rolldown`, `obug`, `satteri`, `piccolore`, `tinyclip`, `@astrojs/compiler-rs`). `astro check` refuses to run without downgrading TypeScript to 5.x. Toolchain is non-standard and not reproducible from `package.json` alone. |
| 7.3 | Committed `CLAUDE.md` is a **symlink to `AGENTS.md`**; the working tree has diverged (both `AGENTS.md` and `README.md` deleted, `CLAUDE.md` replaced with a real file) and is uncommitted. |
| 7.4 | `stop()` returns a bare `SELECT *` row typed as `SessionRow` (which promises `project_name`/`project_color` from a join that isn't there). The type lies; a future consumer that reads those fields gets `undefined`. |
| 7.5 | i18n is split: `CaptureModal` UI is Spanish ("Fácil/Medio/Difícil", "¿Qué se logró?"), everything else is English. |
| 7.6 | `index.astro` and `analytics.astro` have no `prerender` flag → SSR'd on every hit despite being effectively static. |
| 7.7 | No tests, no CI, no lint/format config. `timer.ts` is pure and trivially testable and has no tests. |
| 7.8 | `analytics.astro` implies Chart.js ("stacked bar", "doughnut") — no charting dependency is present. |
| 7.9 | `DeepTimer` display uses `text-[18vw]` / `md:text-[9rem]` with an inline `min-width: 8ch`; at the `md` breakpoint an 8-char monospace string at 9rem (~690px) can overflow a ~700px column. The keyboard project-picker keeps a dead `const btn` (ts 6133) and matches projects by `textContent.startsWith(key)`, which breaks if a project name starts with a digit. |
| 7.10 | `public/favicon.svg` is the stock Astro logo. `<title>` is "Astro". |
| 7.11 | `@astrojs/node` standalone silently enables filesystem-backed Astro sessions (seen in build log) though the app never uses `Astro.session`. |

---

## The single sentence

Fix the four Tier-0 blockers to get a page on screen, the four Tier-1 blockers to get data
in and out without a 500, and Tier-2 to make the word "cross-device" mean anything — until
then the sync/clock sophistication in the comments is decoration on software that has never
executed end to end.
