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
`value: 5`, `oldValue: undefined`. A second external write of the same value
fires nothing.

### watchers/cycle.js

chaseA increments what chaseB watches and vice versa; values never stop
changing. With `maxFiringsPerWatcher: 10`, each watcher fires exactly 10
times, then the engine throws `ApskelCascadeError` (never hangs) whose
message names the runaway watcher and includes the cascade trace — numbered
firings with watcher name, triggering path, old -> new value, and origin.
Nothing in the deferred-effect queue is delivered for a failed cascade.

### watchers/deferred-effects.js

Effects enqueued during the cascade are delivered only after settle:
observed queue length mid-cascade is 0. Delivery is coalesced per field to
the last enqueued value, in first-enqueue field order:
`[["app.a", 30], ["app.mid", 4]]`.

### watchers/declared-locals.js (+ declared-locals/ app dir)

`store.seedDeclaredLocals(resolvedRoot)` initializes every `{name = default}`
local at its declaring scope's path, evaluating the literal default recorded
by Phase 1: `app.draft = ""`, `app.count = 7` (number), `app.active = true`
(boolean), and per-instance `app.workspace.padOne.note = "hi"` /
`app.workspace.padTwo.note = "hi"` at distinct paths. Seeding is silent — a
watcher on the seeded paths fires zero times.
