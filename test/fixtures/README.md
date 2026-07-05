# Fixtures — Expected Outcomes

## Phase 1 — Loader and Resolver

Each fixture is a minimal app directory (`app.xml`, plus `components/` when a
composite is involved). These expected outcomes are what `test/loader.test.js`
asserts and what manual runs of `tools/load.js` should show.

Phase 1 scope notes (per the design doc's RESOLVED entries):

* A `type` that resolves to `components/<type>.xml` is a composite and is
  expanded (fresh instance per mount). Any other type is a leaf node — no
  primitives, manifests, or field-existence validation exist in Phase 1.
* The local scope of a bare-name reference is the innermost enclosing
  composite instance (or the app root); its local fields are the parameters
  bound at that instance's mount site (or the `<app>` element's attributes at
  app scope) plus any field declared by a defaulted reference,
  `{name = default}`, per RESOLVED (local field declaration). Locals are
  never created implicitly by a bare read.
* Every unresolved or ambiguous reference is a load-time error whose message
  names the reference site (file, line, and the reference text).

## double-mount/ — must load successfully

One composite (`contact-card`) mounted twice inside `directory`. Proves
definition-scoped resolution and exercises four reference forms:

| Reference site (in contact-card)  | entryOne instance binds to              | entryTwo instance binds to              |
| --------------------------------- | --------------------------------------- | --------------------------------------- |
| `{phoneField.value}` (named)      | `app.directory.entryOne.card.phoneField` | `app.directory.entryTwo.card.phoneField` |
| `{label}` (local, mount param)    | `entryOne` param `label` ("Alice")       | `entryTwo` param `label` ("Bob")         |
| `{^directory.heading}` (upward)   | `app.directory`                          | `app.directory`                          |
| `{note = ""}` (local declaration) | declares `note` on `entryOne`            | declares `note` on `entryTwo`            |
| `{note}` (local read)             | `entryOne`'s declared `note`             | `entryTwo`'s declared `note`             |

Plus `{app.title}` (absolute) in `app.xml` → the `<app>` element's `title`.

The decisive check: the two `{phoneField.value}` sites bind to **distinct**
target paths — each instance's internal reference finds its *own* inner
component, never the other instance's.

## fail-bare-name/ — must fail at load

`{search}` is a bare name; its scope is the app root, and `<app>` declares no
`search`. Bare names do not search outward. Error must name the site:
`app.xml`, the line of `Search: {search}`, and the reference `{search}`.

## fail-ambiguous/ — must fail at load

`contact-card` is mounted twice, so `phoneField` exists at two paths. The
composite's *internal* `{phoneField.value}` is legal (definition scope), but
the *app-level* reference `Selected phone: {phoneField.value}` in `app.xml`
is ambiguous app-wide. Error must name the app.xml site and should list the
candidate paths.

## fail-no-ancestor/ — must fail at load

`needs-workspace` references `{^workspace.budget}` but is mounted with no
ancestor named `workspace` anywhere above it. Error must name the site in
`components/needs-workspace.xml` and the missing ancestor name.

## fail-duplicate-local/ — must fail at load

`{search = ""}` declares the local `search` at app scope; the second
declaration `{search = "preset"}` in the same scope is a load-time error,
per RESOLVED (local field declaration). Error must name the second site
(`app.xml`, its line) and point at where the first declaration was made.

## fail-app-reserved/ — must fail at load

A component instance is named `app`, which is reserved for the root so that
`{app...}` always means "from the root." Error must name the offending
element and its location.

## fail-duplicate-sibling/ — must fail at load

Two children of the same parent share the name `item`. Identity is path, so
same-named siblings would collide at one path — a load-time error naming
the second element, per RESOLVED (sibling names are unique).

## fail-unknown-type/ — must fail at load (from Phase 3 on)

`type="does-not-exist"` resolves to no composite XML and no primitive
manifest. With real primitives in the tree, an unknown type is a load-time
error naming the mount site (Phase 1's any-unknown-type-is-a-leaf
permissiveness ended when primitives became real).

## fail-field-braces/ — must fail at load (from Phase 3 on)

`field="{typed}"` — per the design examples (`<input field=".title"/>`),
field attributes take a bare reference expression WITHOUT braces; braces
there are a load-time error naming the mount site.

---

## Phase 2 — Central Store and Watcher Engine

Scenario modules under `watchers/`, asserted by `test/store.test.js`. Pure
Node: no DOM, no server, no Wire. Watchers are registered programmatically
(`engine.watch({name, fields, run})`) — the XML `<watchers>` surface lands
with the phase that first needs it.

### watchers/diamond.js

A feeds B and C; both feed D. One external `set` of A settles with firing
order `AtoB, AtoC, sumD` — `sumD` exactly once, seeing the final B and C
(a=10 → d=31; a second settle at a=20 → d=61, sumD once again).

### watchers/same-value.js

The watcher's body writes the watched field with its current value: the
value-change guard stops the cascade after the one firing caused by the
external change. The watcher context carried `origin: "user"`, snapshot
`value: 5`, `oldValue: undefined`. A same-value write from the Wire receive
path (`store.applyServerWrite`) fires nothing; a changed value from it fires
once with `origin: "server"` — the echo-suppression hook. App code claiming
origin `"server"` through ordinary `set()` throws `ApskelStoreError` (the
origin is unforgeable, per RESOLVED (origins)) and applies nothing.

### watchers/cycle.js

chaseA increments what chaseB watches and vice versa; values never stop
changing. With `maxFiringsPerWatcher: 10`, each watcher fires exactly 10
times, then the engine throws `ApskelCascadeError` (never hangs) whose
message names the runaway watcher and includes the cascade trace — numbered
firings with watcher name, triggering path, old -> new value, and origin.
Per RESOLVED (aborted cascades): the deferred-effect queue is discarded
whole (chaseA enqueued one effect per firing; zero are delivered), while
store writes already applied stay applied — after the abort, `app.a` is 11
and `app.b` is 10. No rollback, no partial send.

### watchers/deferred-effects.js

Effects enqueued during the cascade are delivered only after settle:
observed queue length mid-cascade is 0. Delivery is coalesced per field to
the last enqueued value, in first-enqueue field order:
`[["app.a", 30], ["app.mid", 4]]`. Per RESOLVED (uniform effect timing), an
effect enqueued with no cascade frame in flight (`app.solo`) delivers
immediately.

### watchers/declared-locals.js (+ declared-locals/ app dir)

`store.seedDeclaredLocals(resolvedRoot)` initializes every `{name = default}`
local at its declaring scope's path, evaluating the literal default recorded
by Phase 1: `app.draft = ""`, `app.count = 7` (number), `app.active = true`
(boolean), and per-instance `app.workspace.padOne.note = "hi"` /
`app.workspace.padTwo.note = "hi"` at distinct paths. Seeding is silent — a
watcher on the seeded paths fires zero times.

---

## Phase 3 — Primitives and the Web Renderer

The Node-testable slice is asserted by `test/render.test.js` against
`apps/uppercase-demo/` (the browser behavior itself is personal
verification, per the plan). Expected outcomes:

* The demo loads; `sourceInput`/`mirrorInput`/`longInput` are primitives
  with manifests, and their `field=` expressions bind to store paths
  `app.typed` / `app.shout` / `app.typed`.
* `echo-pad` mounted twice yields distinct field paths
  `app.page.padOne.note` and `app.page.padTwo.note` — the no-cross-talk
  guarantee, at the binding level.
* Content segments preserve mixed-content order (text / ref / child), with
  whitespace collapsed; a `{name = default}` declaration site produces NO
  content segment (declarations declare, they do not display).
* `serializeApp(root)` is acyclic JSON carrying `primitiveTypes`, per-node
  `fieldPath`, locals, and content with `storePath` per ref segment;
  `hydrateApp` restores what `store.seedDeclaredLocals` needs, and seeding
  the hydrated tree initializes `app.typed = ""`, `app.page.padOne.note = ""`
  etc.
* `fail-unknown-type` and `fail-field-braces` fail at load naming their
  mount sites (see above).

---

## Phase 4 — The Wire, the Server, and Persistence

Asserted by `test/wire.test.js` against `apps/notes-demo/`, DB-free: the
database sits behind a narrow injected interface in the harness; real
PostgreSQL round-trips are the developer's personal verification in psql,
per the plan. Expected outcomes:

* notes-demo's bound fields collect to wire metadata: store paths
  `app.editor.title` / `app.editor.body`, table `notes`, record `1` (the
  Phase 4 row-selection stopgap), fields `title` / `body`.
* Send path (the Phase 2 seam consumed): a user-origin change to a bound
  field enqueues during the cascade and produces exactly ONE
  `apskel.data.set` envelope after settle, coalesced to the last value —
  two writes to the same field in one cascade send once. A server-origin
  change (`applyServerWrite`) sends NOTHING (echo suppression at the
  watcher level).
* Receive path: `apskel.data.changed` with my own `sourceClient` is
  recognized and ignored (echo); a foreign change applies via
  `applyServerWrite` with origin `server`; an unbound table/field is
  ignored without error.
* Server dispatch: a valid `apskel.data.set` updates the row (allowlisted
  table.field pairs only — identifiers come from the app's own resolved
  bindings, never raw from the client) and broadcasts
  `apskel.data.changed` over SSE to all clients including the originator,
  tagged `sourceClient`.
* Server survival: malformed JSON -> 400 with a coherent body; unknown
  wire type -> 400; table/field outside the app's bindings -> 400 with the
  DB untouched; the server keeps answering afterward.

---

## Phase 5 — Identity: Register, Login, Device Credential

Asserted by `test/auth.test.js`, DB-free (fake db records queries; the real
register/restart-the-browser/psql round-trip is personal verification, per
the plan). Fixtures and expected outcomes:

### action-call/ — must load successfully

A button with `action="apskel.auth.loginUser(email, password)"` — the
brace-less function-call reference, per RESOLVED (action grammar). Loads
with the action bound at load time: function name `apskel.auth.loginUser`,
both arguments resolved as local reads to store paths `app.email` and
`app.password` (`panel` is a plain layout, not a composite mount, so the
declarations scope to the app root). The serialized node carries
`action: { name, args: [{kind: "ref", storePath}, ...] }` so the browser
invokes without any runtime lookup.

### fail-unknown-function/ — must fail at load

`action="apskel.auth.becomeAdmin(email)"` names no framework function.
Unknown function names are load-time errors naming the site (`app.xml`,
the button's line, the reference text), per RESOLVED (action grammar).

### fail-action-not-function/ — must fail at load

`action="email"` is a plain reference, not a function call. An action must
be a function call; error names the site.

### fail-fn-bad-arg/ — must fail at load

`action="apskel.auth.loginUser(email, password)"` where only `password` is
declared in scope. Function arguments resolve with the same rules at the
same site — the bare name `email` fails exactly like any other undeclared
bare read, sited at the button.

### fail-identity-reserved/ — must fail at load

A top-level component named `identity` collides with the reserved framework
store region `app.identity.*`, per RESOLVED (identity store region). Error
names the element and its location.

### Framework composites and the litmus test

`components/login.xml` and `components/register.xml` load as pure
composites: declared locals (`{email = ""}` ...), input primitives bound to
them, one button whose action calls `apskel.auth.loginUser` /
`apskel.auth.registerUser`. The harness asserts **neither file contains
`<functions`** — the litmus test from the design doc. `{app.identity.*}`
references resolve to the reserved region (store paths `app.identity.email`
etc.) without any component named `identity` existing.

### apps/auth-demo/ — usesAuth detection

The demo mounts `login` + `register` + a bound editor (`table="journal"`,
`record="1"`). `collectUsesAuth(root)` is true because the resolved tree
calls `apskel.auth.*`; for notes-demo it is false — Phase 4 apps serve
exactly as before, tokenless.

### Crypto (server/authServer.js, node:crypto only)

* Password: scrypt hash/verify round-trip; wrong password fails; two hashes
  of the same password differ (per-user salt).
* Access token: mint -> verify returns `{userId, deviceId}`; an expired
  token verifies to null; a tampered payload or signature verifies to null;
  garbage verifies to null. Stateless — verification recomputes the HMAC,
  no table.

### Server dispatch (fake db over real HTTP)

* `apskel.auth.register`: creates the user (scrypt hash, parameterized),
  stores the device's credential **hash** (never the secret), links
  `user_devices`, answers `{ok, userId, email, displayName, token}`.
  Duplicate email -> 409 with a coherent body.
* `apskel.auth.login`: correct password -> ok + token and the device is
  linked; wrong password -> 401, no broadcast, and the same body as an
  unknown email (no account enumeration).
* `apskel.auth.token`: valid device id + secret -> fresh token for the most
  recently linked user (the v0.1 stopgap); wrong secret or unknown device
  -> 401. This silent re-mint is what survives a full browser restart.
* With auth attached, `apskel.data.set` without a token -> 401 and the DB
  untouched; with a forged/expired Bearer token -> 401; with a valid token
  -> 200 + broadcast, exactly Phase 4 behavior.
* Without auth attached (notes-demo), `apskel.data.set` still works
  tokenless — Phase 4 regression pinned.

### Client function invocation

`evaluateArgs` resolves bound action args against the store (literals pass
through, refs read their storePath). `createFrameworkFunctions` with
injected transport: `loginUser` success writes `app.identity.*`
(`status: "authenticated"`, userId/email/displayName, `error: ""`) with
origin `system`; failure writes `app.identity.error` and leaves status
`anonymous`. The identity region is written only by this machinery.

---

## Phase 6 — Slice Completion: Draft, Autosave, Two-Tab Sync

Asserted by `test/slice.test.js`, DB-free (a stateful fake db carries the
revision counter); the six v0.1 acceptance criteria are personal
verification against `apps/knowledge-foyer/`. Fixtures and expected
outcomes:

### kf-broken-name/ / kf-broken-ancestor/ / kf-broken-ambiguous/ — must fail at load

Criterion 1's three deliberate breaks, each a copy of the FULL
knowledge-foyer app (login + register + text-editor all mounted):

* `kf-broken-name`: app-scope `{articleEditorX.title}` matches no component
  — error names the app.xml site.
* `kf-broken-ancestor`: `{^workspace.title}` written in `aside`, which has
  no ancestor named `workspace` — error names the site and the missing
  ancestor.
* `kf-broken-ambiguous`: two components named `articleEditor` in different
  subtrees plus an app-scope bare `{articleEditor.title}` — error names the
  site and lists both candidate paths.

### fail-bad-conflict/ — must fail at load

`conflict="merge"` is outside the closed menu (`offline-readonly`,
`detect`, `lww`), per RESOLVED (conflict declaration surface). Load-time
error naming the element and listing the menu.

### knowledge-foyer bindings

The app loads; bound metadata carries store paths
`app.workspace.articleEditor.title` / `.body` (criterion 6's addressable
path), table `article_editions`, record `1`, conflict `detect`. Contexts
that declare no `conflict=` (notes-demo) collect as `offline-readonly` and
their wire behavior is byte-identical to Phase 4 (no `baseRevision` key in
envelopes).

### Revision machinery (`detect`)

* Send: a user-origin change to a detect-bound field carries `baseRevision`
  from the client's revision bookkeeping (seeded from the bundle, updated
  by every broadcast — including the client's own echo, which updates the
  revision even though the store write is ignored; otherwise the next
  write would false-conflict).
* Server: the UPDATE is guarded (`WHERE id = $2 AND revision = $3`) and
  increments the revision; the broadcast carries the new revision. A stale
  `baseRevision` → 409 with the current revision, database untouched. A
  missing `baseRevision` on a detect context → 400.
* `apskel.data.get`: allowlisted read returning `{value, revision}` for
  detect contexts (revision omitted otherwise); unbound table/field → 400;
  with auth attached, tokenless data.get → 401 like data.set.

### Watcher-fire counters (criterion 5's instrumentation)

`engine.fireCounts()` maps watcher name → total firings. A server-origin
`applyServerWrite` to a bound field fires the display watchers but NOT the
wire send watcher (its count is unchanged — echo suppression made
observable; in the browser this is read through `window.__apskel`).

---

## Phase 7.1 — Record Selection, Views, and Routing

Asserted by `test/nav.test.js`, DB-free (fake `call` for fetches, fake
location/history for the router); the browser behavior is personal
verification against knowledge-foyer v0.2. Fixtures and expected outcomes:

### record-ref/ — must load successfully

`record="app.currentEditionId"` is a brace-less reference (bound at load);
`record="1"` stays a fixed row. Bound metadata carries `record: 1` for the
fixed context and `recordPath: "app.currentEditionId"` for the dynamic one.

### visible-domain/ — must load successfully

Three visibility forms: `visible="app.view: landing"` (single-value
domain), `visible="app.view: editor, article"` (set membership), and
`visible="app.panelOpen"` (bare = truthy). Serialized nodes carry
`visible: {storePath, domain}` — domain null for the bare form, the parsed
value list otherwise.

### app-local-absolute/ — must load successfully

`{app.view}` referenced from a nested layout resolves to the app-scope
declared local `{view = "landing"}` — previously a load error (absolute
references validated root fields against `<app>` attributes only), per
RESOLVED (absolute references reach app-scope locals).

### fail-record-braces/ — must fail at load

`record="{app.currentId}"` — like `field=` and `action=`, `record=` takes
a bare reference expression without braces.

### fail-route-field/ — must fail at load

A route `<set field="app.nosuch" .../>` targeting a field that resolves to
nothing — same error class as any unresolved absolute reference, naming
the route's site.

### fail-route-param/ — must fail at load

`<set param="id"/>` under `path="/editor"`, which declares no `:id` —
load-time error naming the route and the missing parameter.

### fail-route-identity/ — must fail at load

A route targeting `app.identity.*` — the identity region is written only
by the auth machinery, per RESOLVED (identity store region).

### Router (fake location/history)

* Boot: the initial URL's route applies **silently** (route state is
  initial state; no watcher fires); `:id`-style params that are all digits
  arrive as numbers.
* An unmatched URL applies the first declared route and corrects the URL
  via replaceState.
* State→URL: after a state change, routes reverse-match in declaration
  order — the first route whose `value=` assignments equal current state
  wins; `param=` fields substitute into the path; pushState only when the
  path actually changes (the loop-breaker).
* popstate applies the URL's route non-silently (watchers fire; views
  switch).
* `apskel.nav.go(path)` = applyUrl + pushState, exactly as typing the URL.

### Selection-change machinery

* Changing the selection field: sends for that context suspend, each bound
  field fetches via `apskel.data.get`, values apply through the
  **server-origin door** — display watchers repaint (the DOM must show the
  new row; a silent seed here was the cross-bleed bug verification caught)
  while the wire watcher's fireCount is unchanged (no autosave echo of the
  fetch) — the row's revision is adopted, sends resume.
* A user keystroke during the loading window is discarded with a console
  warning, never sent.
* Writes carry the row id captured at keystroke time, not send time.
* Null/empty selection: fields seed undefined, sends are suppressed.
* Receive with a dynamic record: a broadcast for the currently selected
  row applies; a broadcast for a different row of the same table is
  ignored as unbound.
* `apskel.field.set(target, value)`: assigns with origin `user`; the first
  argument must be a reference (a literal there is a load-time error).

---

## Phase 7.2 — permissions (design session 2)

### data-graph/ — must load successfully

`<data>` with two graphs. Loader output (`root.data.permissions`), per
RESOLVED (permission rules live on the data graph) and RESOLVED (owner is
a graph walk):

* `article_editions`: `read=public write=owner`, ancestor hops
  `article_editions→articles` (no `via`), `articles→users`
  (`via="created_by"`).
* `articles`: `read=public write=owner`, hop `articles→users`
  (`via="created_by"`).
* `notes`: `read=users write=users`, no hops (graph root; legal because
  neither rule is `owner`).
* `users` carries no rules — it is the ownership anchor, nothing more.

FK **columns** are absent here: the loader records `via=` only; column
resolution against the live schema is server startup's job.

### fail-bad-rule/ — must fail at load

`read="everyone"` — the closed read menu is `public`, `users`, `owner`,
validated at load exactly like `conflict=`.

### fail-write-public/ — must fail at load

`write="public"` — anonymous writes are not on the write menu (`users`,
`owner`, `none`). The menus differ by direction on purpose.

### fail-rule-twice/ — must fail at load

`notes` carries rule attributes on nodes in two different graphs —
identical rules, still an error: a table's rules live on at most one node
across all graphs. Traversal multiplicity is fine; permission multiplicity
is not.

### fail-rule-on-identity/ — must fail at load

`<users read="public">` — the identity tables' rules are fixed
(`read="owner" write="none"`) and not overridable, per RESOLVED (framework
identity tables are Wire-locked).

### fail-owner-unrooted/ — must fail at load

`write="owner"` on a graph-root `articles` node with no `users` ancestor —
`owner` is a graph walk, so a rule-bearing node without a path to `users`
cannot mean anything.

### Wire enforcement (fake db, real HTTP)

* No-auth apps: tokenless end to end, exactly Phase 4 — no rule checks at
  all.
* Auth apps, table with no declared rules: defaults `read=users
  write=users` — any valid token passes, no token is 401 (pre-7.2 behavior
  preserved).
* `read=public`: `apskel.data.get` succeeds with no token.
* `write=owner`: a token whose userId matches the graph-walk owner → 200;
  a different user's token → **403 naming table and rule**; no token →
  401; owner NULL anywhere in the chain → 403 for everyone (unowned
  denies).
* The owner walk emits one parameterized SQL query joining up the resolved
  hop columns.
* `write=none` → 403 regardless of identity.
* Identity tables: `apskel.data.get` on `users.email` with the row-owner's
  token → the value; another user's token → 403; `users.password_hash` →
  400 (fixed column set, never widened by bindings); any `apskel.data.set`
  on `users` → 403.
* SSE: `/events?token=` stamps the connection's identity at connect.
  Broadcasts filter per-connection by the table's read rule: `public` →
  every connection, `users` → identified connections only, `owner` → only
  the owner's connections.
* `/app.json` initialData: only `read=public` tables ship rows; a
  non-public fixed-record context is absent from initialData and fetches
  through the wire once a token exists.

---

## Phase 7.3 — multi-value fields (design session 3)

### edge-domain/ — must load successfully

`{.tags: tags.id->tags.name}` in an `articles` data context, with `tags` a
graph child of `articles`. The reference binds to the **edge**, not a
column, per RESOLVED (a set field is a domain-bearing edge reference):

* The site's binding is edge-kind: parent `articles`, child (edge) `tags`,
  stored column `id`, label column `name`.
* Serialize emits a set-field entry: parent table `articles`, edge `tags`,
  the context's record, and an options descriptor
  `{table: "tags", value: "id", label: "name"}`.
* The widget's `options` path is the instance's own store path — checked
  in the harness, owned by the runtime, filled via `applyServerWrite`.
* `tags` carries `read="public" write="none"` but **no owner rule**, so
  its ancestor hops are NOT FK-resolved at startup — a join edge between
  `tags` and `articles` is not an error here. (Hop columns resolve only
  for tables whose read or write rule is `owner`; anything else would make
  every join-edge child a spurious startup failure.)

### fail-edge-no-domain/ — must fail at load

`{.tags}` where `tags` is a graph child of the context table — an edge
reference REQUIRES a domain (that is where the stored/display contract
lives); no implicit key, no implicit set-ness.

### fail-edge-bare-form/ — must fail at load

`{.tags: tags.name}` — on an edge the **arrow form is mandatory**: the
stored value is not the author's choice (it must be the join FK's
referenced column, checked at startup; the form itself is checked here).

### fail-edge-literal/ — must fail at load

`{.tags: "urgent", tags.id->tags.name}` — a literal cannot be a membership
row; literal and mixed domains are column-domain features only.

### fail-owner-past-join/ — must fail at load

`<tags write="owner"/>` whose only path to `users` crosses the
`articles→tags` edge — which the set-field reference in the same app has
marked as a join edge. The owner walk refuses to cross a join edge; same
error class as "no graph path to users". (Without a set-field reference
marking the edge, the same mistake surfaces at startup instead, when
introspection finds no child→parent FK.)

### Startup checks (fake introspection in the harness — schema-dependent,
### so no loader fixture is possible)

* Join-edge resolution for a set field: zero join-table candidates →
  startup error; two candidates → startup error naming both; `join=` on
  the child graph node picks one; `join=` naming a non-candidate → error.
* Stored-column contract: the domain's stored column must equal the column
  the join table's FK references — mismatch is a startup error naming the
  site and both columns.
* A join table declared as a graph node → startup error naming it (only
  the schema identifies join tables).
* A one-to-many FK edge used as a set field → startup error (membership
  requires a join edge).

### Wire membership (fake db, real HTTP)

* `apskel.data.setMembers {table, id, edge, members}`: whole-set replace
  in ONE transaction — DELETE missing + INSERT new (`ON CONFLICT DO
  NOTHING`) between BEGIN/COMMIT; a failure mid-diff rolls back (no
  partial set).
* Members are canonically sorted by stored key: in `membersChanged`, in
  `getMembers` responses, and in what the client sends — so the store's
  ordered-element array equality behaves as set equality, and an echo or
  refetch of an unchanged set does not cascade (fire counters prove it).
* Permissions ride the PARENT row: `setMembers` checks the parent table's
  write rule (owner walk on the parent id — a second account gets 403
  naming the rule; no token 401); `getMembers` checks its read rule;
  `membersChanged` broadcasts scope by the parent's read rule.
* `apskel.data.options {table, value, label}` → `(value, label)` pairs
  ordered by label, governed by the options table's own read rule;
  columns validated against the load-time options descriptor (arbitrary
  column pairs are 400).
* Client: row id captured at interaction time; sends suspended during the
  selection-change fetch window; empty selection reads `undefined` (not
  `[]`) with sends suppressed; options fetch failure → empty options +
  console warning, no retry.
