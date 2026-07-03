# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Apskel-NP is a declarative web/mobile application framework (XML app spec + SQL schema → running app). **The repository is currently design-only — there is no code yet.** All work is governed by two documents:

- `docs/apskel-design.md` — the authoritative design (*what* to build). Design decisions are recorded as `RESOLVED (...)` entries; treat these as binding.
- `docs/apskel-development-plan.md` — the phase plan (*in what order*, what proves each step, and explicitly what must NOT be built yet in each phase).
- `docs/apskel-design_Until20260608.md` is a superseded snapshot; do not work from it.

The working method: implement one phase at a time; every phase ends with verification the developer runs personally (rows in `psql`, errors in the terminal, sync in two real browser tabs, forbidden writes via `curl`). An implementation summary is a claim, not evidence. If an implementation wants something the design forbids (a primitive holding state, a runtime reference lookup, an extra lifecycle method), the answer is to re-read the relevant RESOLVED entry — and if it genuinely doesn't fit, change the design doc first, never patch around it.

## Commands

- `npm test` — all harnesses; pure Node, no test framework. Individually: `node test/loader.test.js` (Phase 1: loader/resolver), `node test/store.test.js` (Phase 2: store/watchers), `node test/render.test.js` (Phase 3: the Node-testable renderer slice). Expected outcomes per fixture are recorded in `test/fixtures/README.md`.
- `node tools/load.js <path/to/app.xml> [--dump-tree]` — load an app and resolve all references; `--dump-tree` prints the instantiated tree with each reference site's bound target. Broken fixtures exit 1 with an error naming the reference site.
- `node tools/serve.js <appDir> [--port 3000]` — Phase 3 static server: resolves the app at startup, serves the bundle at `/app.json` and the runtime as unmodified ESM. Browser debug handle: `window.__apskel` (`store`, `engine`, `root`, `byPath`). Demo app: `apps/uppercase-demo/`.

## Hard Constraints

- Frontend: vanilla HTML/CSS/JS. Backend: Node.js + Express + PostgreSQL.
- Allowed dependencies: an XML parser, `pg`, Express. **No reactive libraries, no ORMs, no client frameworks, no build toolchain beyond `node`.** Anything else gets justified in writing first.
- Test harnesses are pure Node scripts (e.g. `node test/loader.test.js`); the app runs via `node run.js <app-name>`.
- Each phase's tests must stay green in all later phases; regressions block.

## Core Architecture

An application is one `app.xml` + `schema.sql` (+ rarely, custom JS functions). The framework pieces to know:

**Two kinds of components, and only two.** *Composites* are single XML files written in the same grammar as `app.xml` — no JS, no manifest (the XML is the manifest). *Primitives* are framework-shipped leaves (`layout`, `text-input`, `text-area`, `button`, `select`, `rich-text`) and are the only place HTML/CSS/JS lives. Litmus test: `login` must be expressible as pure XML plus `apskel.auth.*` calls — if a shipped component needs bespoke JS, the primitive set is wrong, not the rule.

**The runtime owns all state.** Components never hold field state. Every field — local, bound, app-global — lives in one central store keyed by path (`runtime/store.js`). A primitive is a two-way valve implementing exactly `create(ctx, el)` / `write(ctx, field, value)` / `destroy(ctx)`, with `ctx.input(field, value)` as the only way a value enters from the DOM. If `write()` feels awkward, the fix is in the runtime, never a variable in the primitive.

**References bind at load time, never at runtime.** Local scratch fields exist only if bound as mount-site parameters or declared once by a defaulted reference (`{search = ""}`); a bare read never creates a field implicitly, and a named reference inside a composite definition never falls back to app-wide search. The reference forms: `{field}` local scratch, `{.field}` bound data context, `{name.field}` named component (unique within its naming scope), `{^name.field}` nearest named ancestor, `{app.x.y}` absolute, `{fn(args)}` function call. There is no implicit outward search and no positional parent reference. The loader expands composite mounts recursively (fresh instance per mount; composite definitions are naming scopes), then binds every reference site to its concrete target. Unresolved/ambiguous references are **load-time errors naming the reference site**. `app` is a reserved name.

**Watchers are synchronous, value-change-triggered cascades.** Same-value writes don't fire; cascades run to completion in one tick with deduplication; watcher bodies get `(value, oldValue)` snapshots; runaway cycles are a bounded-depth error with a cascade trace, not a hang.

**The Wire sits after the cascade, never inside it.** Network effects enqueue during a cascade and send after it settles, coalesced per-field (last value wins). Client→server is REST; server broadcasts accepted writes over SSE to all clients *including* the originator, tagged `sourceClient`. Incoming changes apply to the store marked with origin (`user`/`server`/`system`) so sync-outward watchers (autosave) don't echo server changes back; the `server` origin enters only through `store.applyServerWrite` (the Wire receive path) — ordinary `set` rejects it as unforgeable.

**Identity is a device-held credential, not a session.** Core tables are `users`, `devices`, `user_devices` plus a credential/token mechanism; there is deliberately **no `sessions` table** (its absence is a test). The device holds a durable credential and mints short-lived access tokens.

**Data policy is per data context, not global.** Autosave for drafts, explicit publish; conflict policy is a declared attribute per context from a closed menu: `offline-readonly` (default), `detect` (revision token, prompt on mismatch), `lww`. Relational columns for anything load-bearing; JSONB only for the sparse tail — a JSONB column you query into is the line not to cross.

**Collections bind by repetition.** Binding a component to a collection repeats its content per row; instances are keyed by primary key (never ordinal) in their paths; INSERT/DELETE broadcasts create/destroy instances, with the resolver re-run locally over inserted subtrees.

## Planned Layout

```
runtime/   loader.js, pathResolver.js, store.js, watchers.js, binder.js, wireClient.js
server/    wireServer.js
components/  *.xml composites; primitives/<name>/client.js (+ manifest.json, structural CSS only)
apps/<name>/ app.xml, schema.sql, optional client.js/server.js/style.css, components/
tools/     run.js (applies schema.sql), build.js, deploy.js
test/      pure-Node harnesses
```

Styling: one app-level theme carries all appearance; primitive CSS is structural only; composites normally carry no CSS.

## Phase Discipline

Phases 1–6 build the v0.1 "draft-and-sync" slice (loader/resolver → store/watchers → primitives/renderer → Wire/persistence → identity → autosave + two-tab sync). Each phase in the development plan lists deliverables, test fixtures to write *before* the code, and a "Do NOT build yet" list — respect it. v0.1 ships and is tagged at the end of Phase 6; Phases 7+ (record selection, routing, permissions, multi-value fields, collection sources) require design sessions producing RESOLVED entries before any implementation.
