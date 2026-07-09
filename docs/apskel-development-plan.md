# Apskel-NP Development Plan — v0.1 (Draft-and-Sync Slice) and Beyond

Companion to `apskel-design.md`. The design doc says *what*; this says *in what
order*, *what proves each step*, and *what must not be built yet*.

Working method assumed: design decisions live in the design doc; Claude Code
implements one phase at a time; every phase ends with an independent
verification the developer runs personally — decisive values checked directly,
never taken from an implementation summary. A phase is not complete until its
verification passes in the developer's own terminal/browser.

Global rules for every phase:

* Dependencies: an XML parser is acceptable; `pg` is acceptable; Express is in
  the constraints. No reactive libraries, no ORMs, no client frameworks, no
  build toolchain beyond `node`. Anything else gets justified in writing first.
* Components hold no state, ever. If `write()` feels awkward, the answer is in
  the runtime, not in giving the primitive a variable. Any drift toward
  component-held state is a re-read of the Component API section, not a patch.
* Each phase's tests remain green in all later phases. Regressions block.

---

## Phase 1 — Loader and Resolver (no DOM, no server, no database)

The most load-bearing code in the framework, built first, alone.

Deliverables:

* `runtime/loader.js`: parse `app.xml`, expand composite mounts recursively
  (fresh instance per mount), build the instantiated component tree in memory,
  every node carrying a parent pointer, name, type, path, and naming scope.
* `runtime/pathResolver.js`: classify every reference site (local / `.bound` /
  named / `^name` / `app.` / function call), run the matching search strategy
  (definition scope / upward chain / root), bind each site to its concrete
  target, and store the binding on the site.
* A pure-Node test harness (`node test/loader.test.js`) — no browser.

Test fixtures (write these before the code):

* A minimal app with one composite mounted twice, each instance containing an
  inner named component — proving scoped resolution (each instance's internal
  reference binds to its *own* inner component).
* The three mandatory failure cases, each failing at load with a message
  naming the reference site: bare name not local; named reference ambiguous
  app-wide; `^name` with no matching ancestor.
* An `app.`-reserved-name violation (component named `app`) failing at load.

Verification (run personally):

* Run the harness; count the assertions yourself.
* Feed the three broken fixtures by hand; read the three error messages.
* Dump the instantiated tree (`--dump-tree`) for the double-mount fixture and
  visually confirm two distinct paths with distinct bound targets.

Do NOT build yet: any rendering, any DOM, watchers, the Wire, the store.

## Phase 2 — Central Store and Watcher Engine (still no DOM)

Deliverables:

* `runtime/store.js`: one store keyed by path; local, bound, and app-global
  fields all live here. `get(path)`, `set(path, value, origin)`.
* `runtime/watchers.js`: value-change guard (same-value writes do not fire);
  synchronous cascade to completion; cascade deduplication; snapshot
  `(value, oldValue)` into watcher bodies; bounded-depth cycle detection that
  errors with a cascade trace.
* Origin marking on `set` (`user` / `server` / `system`) carried into watcher
  context — the hook Phase 6's echo suppression will use.
* Deferred-effect queue: effects enqueued during a cascade run only after the
  cascade settles (the cascade-then-send seam, testable now without a network).

Test fixtures:

* Diamond dependency (A feeds B and C, both feed D): D fires once per settle.
* Watcher writing a watched field with the *same* value: cascade terminates.
* A genuine cycle (A increments what B watches, B increments what A watches):
  cycle error with trace, not a hang.
* Effects enqueued mid-cascade observably run after settle, coalesced
  per-field to the last value.

Verification: run the harness; deliberately write the same value twice and
confirm one firing; read the cycle trace output personally.

Do NOT build yet: DOM, Wire, primitives.

## Phase 3 — Primitives and the Web Renderer

Deliverables:

* The four slice primitives — `layout`, `text-input`, `text-area`, `button` —
  each a folder with `client.js` implementing exactly
  `create(ctx, el)` / `write(ctx, field, value)` / `destroy(ctx)` plus
  `ctx.input(field, value)`, and a small `manifest.json`. Structural CSS only.
* `runtime/binder.js`: walk the instantiated tree, call `create` on
  primitives, push store values via `write`, route `ctx.input` into
  `store.set(..., 'user')`.
* One app-level theme stylesheet; primitives carry no appearance.
* Static file serving via Express sufficient to load the page (no Wire yet).

Test app: a page with two text-inputs and a watcher that uppercases one into a
local field displayed in the other.

Verification (in the browser, personally):

* Type in one field, watch the other update — synchronously, per keystroke.
* Confirm in devtools that no primitive holds a value: state inspection goes
  through a `window.__apskel.store` debug handle, and the DOM inputs are
  write-through.
* Mount the same composite twice on one page; confirm the instances do not
  cross-talk (Phase 1's scoping, now observable).

Do NOT build yet: rich-text, select (not needed for the slice), server
persistence.

## Phase 4 — The Wire, the Server, and Persistence

Deliverables:

* `runtime/wireClient.js`: REST send of type-routed envelopes; the deferred
  queue from Phase 2 becomes the send path (cascade settles → coalesced
  per-field messages go out).
* `server/wireServer.js`: type-routed dispatch ("handler does the best it can
  with what it receives"); PostgreSQL write path for bound-field updates;
  `schema.sql` applied by `tools/run.js`.
* SSE broadcast channel: every accepted write broadcasts, including to the
  originating client, with `sourceClient`.
* Client SSE receive: apply to store with origin `server`.

Verification (personally):

* Edit a bound field; confirm the row in `psql` directly — the decisive value
  is the column content in the database, not a log line.
* Kill the tab mid-typing; confirm the loss window is the settle window only.
* `curl` a malformed Wire message; server survives and answers coherently.

## Phase 5 — Identity: Register, Login, Device Credential

Deliverables:

* Core tables from the design doc: `users`, `devices`, `user_devices`,
  credential/token mechanism. No `sessions` table — its absence is a test.
* `login.xml` and `register.xml` as pure composites (the litmus test: XML plus
  `apskel.auth.*` framework functions, zero bespoke JS files).
* Device-held durable credential minting short-lived access tokens; Wire
  messages authenticated by device identity.

Verification (personally):

* Register, log in, quit the browser entirely, reopen: still identified.
* Inspect the schema in `psql`: confirm no sessions table exists.
* Confirm `login.xml` contains no `<functions src=...>` — if it does, the
  primitive set or framework function set is wrong, and that goes back to
  design, not into a patch.

## Phase 6 — Slice Completion: Draft, Autosave, Two-Tab Sync

Deliverables:

* `text-editor.xml` composite; `articles` / `article_editions` tables with
  the `detect` revision token in place (even though the slice won't exercise
  conflict, the column and the base-revision send are cheap now and expensive
  retrofitted).
* Autosave watcher (draft context, per the autosave-draft resolution).
* Echo suppression: origin-marked server changes do not re-trigger the
  autosave watcher.

Verification — the six acceptance criteria from the design doc, run
personally, with emphasis on the two that implementation summaries most often
overclaim:

* Criterion 1: feed the three broken-reference fixtures against the *full*
  app; read the errors.
* Criterion 5: two real browser tabs, side by side, with your own eyes. Type
  in tab A; see tab B update within one broadcast; confirm tab A does not
  visibly re-apply its own echo (no cursor jump, no double watcher firing —
  check the watcher-fire counter in the debug handle).
* Criterion 6: run the provided test script that reads and sets
  `app.workspace.articleEditor.title` through the Wire.

**v0.1 ships here.** Tag it. Everything below is post-slice.

---

## Phase 7 — Design Sessions (not code): the Five Gaps

Before further building, resolve in the design doc (sketched defaults exist in
"Remaining Semantics Needed for Knowledge Foyer"):

1. Record selection / single-record context (`record=`) — together with
2. Views, navigation, routing — one concept viewed twice: routing is state
   sync with the URL bar. Do these first; they shape everything after.
3. Permissions/authorization — server-side enforcement on Wire writes;
   declarative per-context rules in `<data>`.
4. Multi-value fields (graph-edge-bound fields, join-table set semantics).
5. Collection sources: `filter=` semantics plus named server-defined queries.

Each session ends with RESOLVED entries in the design doc, then one
implementation phase per resolution.

## Phase 7.1 — Record Selection, Views, and Routing (implementation)

Implements design session 1 (items 1–2 of the five gaps). Deliverables:

* `record=` as a brace-less reference (integer literal remains legal);
  selection-change machinery per the RESOLVED entry — suspend sends, fetch
  via `apskel.data.get`, seed silently, adopt revision, resume; writes
  target the row selected at keystroke time; null/empty selection is an
  empty context.
* `visible=` bare (truthy) and domain (`visible="app.view: editor"`) forms;
  hidden is a display-none wrapper, instances and state preserved.
* `<routes>` with load-validated `<set>` children; two-way URL↔state sync
  (boot and popstate inward, declaration-order reverse match outward); the
  server serves the shell for any route path.
* Absolute references reach app-scope declared locals.
* `apskel.field.set` (write-target first argument) and `apskel.nav.go`.
* Demo: knowledge-foyer v0.2 — landing/editor/article views, two edition
  rows, record switching by button and by deep link, no lists.

Do NOT build yet: collections/repetition, `filter=`, `read="public"` or any
permissions, the offline queue.

Verification (personally): type into draft 1, switch to draft 2 by button,
switch back — both rows correct in psql, zero cross-bleed; URL bar follows
selection; back/forward walks it; deep link `/edit/2` opens draft 2 cold;
`__apskel.fireCounts()` shows the wire watcher NOT firing on a record
switch; two tabs on different records don't cross-talk while two tabs on
the same record still sync.

## Phase 7.2 — Permissions (implementation)

Implements design session 2 (item 3 of the five gaps). Deliverables:

* Loader parses `<data><graph>`; permission rules (`read=`/`write=`, closed
  menus) on graph nodes; load-time validation — bad rule value, a table's
  rules on more than one node, rules on identity tables, an `owner` rule
  with no graph path to `users`.
* Startup FK introspection builds each owner chain from the live schema;
  ambiguous edges are startup errors naming the candidates (`via=` column
  attribute disambiguates).
* Wire enforcement: read rule on `apskel.data.get`, write rule on
  `apskel.data.set`; 401 (no identity where required) vs 403 (identity but
  rule unsatisfied, naming table and rule); identity tables fixed at
  `read="owner" write="none"`.
* SSE: `/events?token=` identifies the connection at connect; broadcasts
  delivered per-connection by read rule; owner id stamped internally by the
  write handler, stripped from the frame. Client reconnects the event feed
  when its token changes (login/re-mint) so the connection's identity is
  current.
* Client: 403 on autosave logs a warning without retry (401 keeps its
  silent re-mint path).
* Demo: knowledge-foyer v0.3 — `<data><graph>` with
  `articles`/`article_editions` at `read="public" write="owner"` (interim:
  drafts publicly readable until row-state-conditional read lands with
  named queries).

Do NOT build yet: row-state-conditional read (session 5), INSERT/ownership
at creation (Phase 8), collections, `filter=`, the offline queue, comment
tables.

Verification (personally): a logged-out browser opens `/article/1` and sees
title and body (public read, genuinely shareable URL) and watches live
edits arrive while the owner types in another window; `curl` a data.set
with no token → 401; register a second account, its token → 403 naming the
rule; editing 403s for everyone while `created_by` is NULL (safe floor),
then a psql UPDATE claims article 1 for your account and editing works
again — second account still 403; `curl` a data.get on `users` with your
own id and token → your row, another id → 403, any data.set on `users` →
403.

## Phase 7.3 — Multi-Value Fields (implementation)

Implements design session 3 (item 4 of the five gaps). Deliverables:

* Edge-bound set fields: `{.tags: tags.id->tags.name}` binds to the graph
  edge when the context table has a graph child of that name — edge
  classification is by graph declaration at load, never reclassified; a
  declared-edge-name vs. actual-column collision is a startup error naming
  both. Arrow form mandatory on an edge (stored column validated against
  the join FK's referenced column at startup); bare form, missing domain,
  and literal/mixed domains on an edge are load errors naming the site.
* Two edge kinds in the graph: FK edges (7.2, ownership-walkable) and join
  edges (join table introspected at startup; `join=` disambiguates;
  declaring a join table as a graph node is an error; the owner walk
  refuses to cross a join edge — load-time when a set field marks the
  edge, startup otherwise; one-to-many edges cannot be set fields).
* Wire: `apskel.data.setMembers` (whole-set replace, one transaction,
  canonical stored-key order, lww-at-set-level), `apskel.data.getMembers`,
  `apskel.data.membersChanged` broadcast scoped by the parent's read rule;
  parent-row permissions govern, options list governed by the options
  table's read rule; row id captured at interaction time; sends suspended
  during the selection-change fetch window; empty selection reads
  undefined with sends suppressed.
* `apskel.data.options` -> (value, label) pairs ordered by label,
  delivered to the widget instance's own `options` path via
  applyServerWrite; fetch failure = empty options + console warning, no
  retry.
* `multi-select` primitive (two fields: value, options; structural CSS
  only); ordered-element array equality in the store.
* Demo: knowledge-foyer v0.4 — `tags` seeded (`read="public"
  write="none"`), `article_tags` join table, tag picker on a fixed
  `table="articles" record="1"` context (a derived "this edition's
  article" selection is collection-sources territory).

Do NOT build yet: tag creation from the widget (needs INSERT — Phase 8),
option filtering, edge attribute columns, ordering within a set, set-level
conflict detection, collections.

Verification (personally): two tabs on the same article — toggle a tag in
A, B's chips update within one broadcast, and A's
`__apskel.fireCounts()` shows no echo cascade; a forced refetch of an
unchanged set fires no display watchers (canonical order proven); curl
`setMembers` as a second account → 403 naming articles' rule, no token →
401, `getMembers` likewise; psql confirms a mid-flight failure leaves no
partial set (single transaction); curl `apskel.data.options` returns
(value, label) ordered by label; devtools confirms the primitive holds
nothing — value and options both live at store paths.

## Phase 8 — Collection Binding Implementation

Implements the Collection Binding RESOLVED entries plus design session 4
(item 5 of the five gaps — the four `filter=`/`order=`/`limit=`/query
entries and RESOLVED (apskel.data.select and collection freshness)).

**First deliverable block — query/source infrastructure, before any
repetition:**

* `<query>` declarations parsed and validated at load (closed read menu
  `public`/`users`, mandatory `tables=`, params list); SQL bodies in
  `queries/<name>.sql`; startup validation: file exists, single SELECT,
  LIMIT-0 execution proving it runs and exposes an `id` column.
* `source=` mounts via the call grammar (bare or parameterized, arity
  load-checked); query-sourced contexts read-only by grammar (`field=` or
  `conflict=` under one is a load error); `apskel.data.get` through the
  query wrap.
* `filter=` (domain syntax on a column, literals + absolute references,
  table sources only), `order=`, `limit=`; column existence at startup.
* `apskel.data.select` gated by table/query read rules, returning id +
  bound columns only.

**Second block — repetition itself:** template resolved at load, per-row
instantiation at runtime, PK-keyed instance paths, per-row scratch state,
INSERT/DELETE broadcasts creating/destroying instances (the resolver
re-run locally over inserted subtrees); table-sourced membership
maintained client-side against the filter; query-sourced collections
re-fetching on `tables=` broadcasts and param changes; dynamic filter
references re-running the fetch like a selection change.

Do NOT build yet: row INSERT/DELETE *origination* beyond what the list
demo needs (a minimal new-row composer is in scope; full create/publish
workflow is Phase 9), AND/OR filters, pagination, functions in domains,
the KF read-rule flip (Phase 9), the offline queue.

Verification (personally): a live list in two tabs — insert in one, watch
the instance appear in the other; delete likewise; confirm addressing an
instance by PK path survives a reorder; a filtered list gains/loses a row
in both tabs when a broadcast flips the filtered column; a query-sourced
list refreshes when a `tables=` table changes; curl `apskel.data.select`
anonymously against a `read="users"` query → 401, against the public one
→ rows with only bound columns; the startup fixtures (missing file,
non-SELECT, id-less query) fail in the terminal naming the query.

## Phase 9 — Knowledge Foyer Completion

Design session 5's entries govern: publish is a status write; published
editions are immutable at the schema; identity-bound query parameters
(`@user`); `apskel.field.set` takes pairs; create actions declare insert
targets; the KF v1.0 shape.

**Framework deliverables (small, by design):** the `@user` query
parameter (filled server-side from the token, excluded from call-site
arity, 401 anonymous, load error in a no-auth app, any other `@` name a
load error); `field.set` pair grammar (even arity load-checked,
write-target odd slots, all assignments before one cascade); the insert
allowlist extended to tables and columns named by resolved
`apskel.data.create` actions, with startup validation (column existence,
ownership stamps, born-unowned-and-dead) covering them; `apskel.data.set`
and `.delete` mapping database rejections to a 400 carrying the
database's message, as insert already does.

**App deliverables (KF v1.0, in order):** publish workflow (status write
+ next-edition composer + immutability trigger in `schema.sql`) → public
article view and routing (`/article/:id` as query-sourced record
context; the read flip: `article_editions` `read="owner"`, public
reading only through `publishedArticles`-style queries) → comments (flat
filtered collection, insert-only) → pro/con marks (create action,
insert-once, tallies live via a query whose `tables=` names
`comment_marks`) → my-drafts list (`myDrafts` declaring `@user`) →
expositions (`/exposition/:id` route, `expositionArticles` query, rules
editor as an ordinary collection with a composer) → landing page
(published list, row click via `field.set` pairs, URL following by
reverse match).

Fixtures first, expected outcomes in the README before code: load —
`fail-fieldset-odd-args`, `fail-fieldset-literal-target`,
`fail-user-param-passed` (a call site supplying a value for `@user`),
`fail-user-param-noauth` (`@user` declared in a tokenless app),
`fail-user-param-unknown` (an `@`-name other than `@user`); startup —
`startup-create-badcolumn` (a create action naming a nonexistent
column), `startup-create-unowned` (a create-target table with
`write="owner"` and no direct users FK).

Do NOT build yet: upsert / mark-changing, row-state-conditional write
rules as graph grammar, nested collection instantiation, row editing
inside lists, the offline queue, `select`/`rich-text` primitives (all
Phase 10 or later).

Verification (personally), against the KF role rules — forbidden acts
attempted directly, not inferred from absent UI: **logged-out browser
profile** — the landing page lists only published articles; `curl`
`apskel.data.get` on a draft edition → 401; `apskel.data.select` against
`myDrafts` → 401; an anonymous comment insert via `curl` → 401.
**Logged-in non-owner** — reading someone else's draft via `curl` → 403
naming table and rule; editing a published edition through `poke.js` →
400 carrying the trigger's message; marking the same comment twice →
second attempt 400, tally unchanged. **Cross-profile liveness** —
publish in the owner's tab: the owner's own drafts/landing lists move
live (the owner hears the edition broadcast); the logged-out profile
sees the article after a reload — a recorded consequence, not a bug:
broadcasts obey read rules, `article_editions` is `read="owner"`, so
anonymous connections never hear the publish and the `publishedArticles`
refetch has no trigger. Comments and marks are `read="public"`, so THOSE
move live in the logged-out profile — post a comment or mark in one
profile and watch the anonymous reader's list and tallies update on the
broadcast. `psql`: `comment_marks` rows
carry the token's user id regardless of what the client claimed, and no
`sessions` table has appeared. Startup fixtures read as errors in the
terminal, per the standing discipline.

## Phase 10 — Hardening for the WorkSplicer Era

Subdivided like Phase 7; each sub-phase keeps the standing discipline
(fixtures before code, personal verification, regressions block). The
MCP façade decision came due here and is RESOLVED (design session 6):
deferred to the WorkSplicer era, where its first real consumer lives —
the namespace stays clean and every Wire message stays 1:1
tool-translatable in the meantime.

## Phase 10.1 — Primitive-Set Completion: select and rich-text

Implements design session 6 — RESOLVED (a select is a domain-bearing
column reference), RESOLVED (rich text is stored markup, rendered to
content nodes, never HTML), RESOLVED (rich-text primitive; mode is
load-checked). Deliverables:

* `runtime/markup.js`: the markup subset parsed to renderer-neutral
  content nodes; no dependencies; scheme allowlist on links; no HTML
  pass-through.
* `select` primitive (native select element, structural CSS only):
  literal domains become bundle-baked static options; a single arrow
  item becomes an `apskel.data.options` source at the widget's own
  `<path>.options`. Load errors: domainless select, mixed or multi-arrow
  domains, mismatched arrow tables, select on a graph edge. Startup:
  LIMIT-0 probe of arrow tables/columns naming the site.
* `rich-text` primitive: `mode="edit|view|split"` from the manifest's
  closed menu, default `edit`; value is the markup source in every
  mode; `view` mounts are displays (legal under query-sourced record
  contexts), `edit`/`split` are inputs.
* Framework seams touched: loader (manifest mode menu, load-time
  inputness), resolver (select domain validation), serializer (static
  options, options descriptors on nodes), binder (static option
  seeding), boot (arrow-select option fetch beside the edge-widget
  fetch), wireServer (options allowlist union, startup probe).
* App integration: the `text-editor` composite's body becomes
  `rich-text mode="split"`; the Knowledge Foyer reader renders `.body`
  through a `view`-mode rich-text; the KF exposition rule composer
  swaps its type-a-tag-id text inputs for the two select forms.

Fixtures first, expected outcomes in the README before code: load —
`select-widget` (the good shapes, serialization asserted),
`fail-select-nodomain`, `fail-select-mixed`, `fail-select-edge`,
`fail-richtext-mode`; startup — `startup-select-badcolumn` (an arrow
domain naming a nonexistent column, run against real PostgreSQL).

Do NOT build yet: WYSIWYG/toolbars, mixed (combo) domains, option
filtering, widget inference, the `date-picker` composite, anything
offline-queue.

Verification (personally): in the KF exposition view, the rule composer
picks a tag **by name** and `psql` shows the row carrying the tag's
integer id; a published article's body renders headings/bold/lists
formatted in a logged-out profile, and a `<script>` or `javascript:`
link typed into a draft arrives as inert plain text; two tabs on the
same draft — typing markup in one repaints the other's split preview
within one broadcast with no echo cascade (`__apskel.fireCounts()`);
`curl` `apskel.data.options` with a column pair the XML never declared
→ 400; the startup fixture fails in the terminal naming the site;
devtools confirms both new primitives hold nothing — value and options
live at store paths.

## Phase 10.2 — Offline Queue, Resync, and the detect Prompt

Implements design session 7 (complete — all five questions closed in
the design doc's Phase 10.2 block): the durable local shape (replica +
queue in wire vocabulary, IndexedDB per app+identity, four object
stores), the flush protocol (lock-is-leadership, dequeue-on-ack, insert
idempotency keys, per-lineage replay, the live temp-id translation
mapping), the conflict prompt (a framework composite over the reserved
`app.sync.*` region), `sync_receipts` (insert idempotency receipts
only, low-water-mark retention), and the edge deferral (edges stay lww;
no set-level detect). `detect` graduates from log-only to the prompt.
Deliverables, in dependency order:

* `runtime/queue.js` — the queue's pure logic, storage-agnostic (an
  injected store; IndexedDB in the browser, in-memory in tests):
  enqueue with coalescing (`set` per table:id:field, last value wins,
  **first** baseRevision pinned; `setMembers` per edge, no
  baseRevision; `insert`/`delete` never coalesce), the `conflict=`
  queueing gate (offline-readonly refuses per the autosave-403
  pattern), monotonic seq, negative-integer temp ids from the meta
  counter, enqueue-time translation through the live T→R mapping,
  the queue-only rewrite on insert ack (declared-binding recognition,
  including setMembers members arrays), lineage partition (transitive
  temp-id connectivity), delete-does-not-prune.
* Reconcile + the `app.sync.*` derivation, same module or a sibling:
  given pulled revisions, partition lineages clean/conflicted; derive
  the head conflict (`pending`, `table`, `id`, `field`, `mine`,
  `theirs`) from queue + replica, never duplicated state; keep-mine
  (act-time revision pinning) and take-theirs (entry removal) as pure
  queue operations the framework functions will call.
* `server/sync.sql` + wireServer: the `sync_receipts` table (PK
  `(db, device_id, seq)`), applied after `identity.sql` only when the
  app uses auth; insert accepts an idempotency key and commits the
  receipt in the insert's own transaction; a replayed key returns the
  original `assigned_id` without re-inserting or re-broadcasting;
  delete answers success on an already-missing row; the
  `dequeuedThrough` watermark prunes receipts.
* Load/startup errors: `conflict="detect"`/`"lww"` on a context with
  an insert target in a tokenless app (names the missing identity
  machinery); `conflict="detect"` anywhere without both an
  `app.sync.*` reference site and a resolution-function call site.
* Browser wiring: IndexedDB persistence as a deferred-effect consumer
  at settle; the `replay` origin (engine-enforced single minter, boot
  overlay only); boot = instantiate, bind, replica through
  `applyServerWrite`, queue overlay through `replay`, connect, resync;
  Web Locks flush leadership (lock covers pull → reconcile → flush
  clean only); the shipped `conflict-prompt` composite and the
  `apskel.sync.keepMine`/`takeTheirs` framework functions
  (check-then-act, bound to the seen conflict).

Fixtures first, expected outcomes in the README before code: DB-free —
`test/queue.test.js` (coalescing, pinning, gate, temp ids, translation
mapping, rewrite, lineages, reconcile/derivation, keep-mine/take-theirs
as queue ops); load — `fail-detect-noauth`, `fail-detect-no-prompt`,
plus a passing `conflict-prompt` mount fixture; DB — receipt
idempotency, same-transaction commit, replayed key, idempotent delete,
watermark prune (via `run.js` against real PostgreSQL, like the
`startup-*` fixtures).

Do NOT build yet: device revocation (no revocation event exists; the
receipts FK is an anchor, not a cleanup), set-level detect for edges
(deferred to a shared-mutable-set app), CRDT/merge reconciliation,
BroadcastChannel local echo (explicitly rejected), account switching on
a shared device, any general audit/observability log beyond
`sync_receipts`, store-backed collection repetition for the prompt.

Verification (personally): two real tabs on a `detect` draft — kill the
server, type in both tabs, restart, and watch the leader tab flush while
the other's edit arrives via echo; DevTools Application tab shows the
four object stores and the queue draining on reconnect; a conflict
staged from a second device/profile surfaces the prompt with mine/theirs
correct, keep-mine lands my value in `psql`, take-theirs repaints
without re-enqueueing (`__apskel.fireCounts()` shows the wire watcher
quiet); a replayed insert (crash between ack and dequeue, simulated)
lands exactly one row in `psql` and `sync_receipts` shows the receipt;
`curl` an insert with a forged `@user`-style claim or a stale binding →
400 with the entry visible in dead-letter; a tokenless app declaring
`detect` on an insert target fails at load naming identity.

## Phase 10.3 — WorkSplicer Groundwork

Dynamic component loading / registry groundwork (asset types as
composites + registry rows) — undesigned, WorkSplicer-shaped, and the
MCP façade rides along per the session-6 deferral. Only then does
WorkSplicer's own plan get written.

---

## Standing verification discipline

* Decisive values are checked at the source: rows in `psql`, errors in the
  terminal, sync in two real tabs, forbidden writes via `curl`. A green
  summary from the implementing agent is a claim, not evidence.
* Any moment a primitive wants state, a component wants a lifecycle method
  beyond the contract, or a reference wants to resolve at runtime — stop,
  re-read the corresponding RESOLVED entry, and if it genuinely doesn't fit,
  the change goes through the design doc first.
