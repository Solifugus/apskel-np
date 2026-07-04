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
