# Apskel-NP Design Draft

## Purpose

Apskel-NP is a framework and application skeleton system for rapidly building production-quality web and mobile applications.

The system is designed around:

* low boilerplate
* maintainable code
* declarative application structure
* minimal dependencies
* strong data synchronization
* AI-assistable interfaces
* reusable component-based UI

The design goal is to allow an application to be mostly described through a single XML application specification and SQL schema.

---

# Goals

* High quality maintainable code
* Rapid application development
* Strong structure and consistency
* Declarative application definition
* Built-in synchronization between clients
* Simple extensibility
* AI integration readiness
* Minimal framework complexity

---

# Technical Constraints

## Frontend

* Vanilla HTML
* Vanilla CSS
* Vanilla JavaScript

## Backend

* Node.js
* Express
* PostgreSQL

## Dependencies

* Minimal necessary dependencies

---

# Architecture

## Application Model

Applications are primarily defined through:

* one XML application specification
* one or more SQL schema files
* optional client-side JavaScript functions
* optional server-side JavaScript functions
* reusable components

The XML specification defines:

* UI structure
* data graphs
* bindings
* synchronization behavior
* Wire communication
* watchers
* reusable component usage

---

# Application Lifecycle

## Intended Development Process

1. Copy template to new folder
2. Modify XML application specification
3. Modify SQL schema if necessary
4. Add custom client/server functions if necessary
5. Deploy
6. Test
7. Iterate
8. Put into production

The framework should automate as much of this process as reasonably possible.

---

# Core Concepts

## Components

The primary UI abstraction is a component.

A component is:

* a UI component
* an addressable runtime object
* optionally bound to data
* optionally synchronized through the Wire (SSE)
* reusable and extensible

Components are implemented through reusable component types.

Example:

```xml
<mainEditor type="text-editor"/>
```

Where:

* `mainEditor` is the component instance name
* `text-editor` is the reusable component type

---

# Initial Component Types

The initial framework should keep the built-in component set intentionally small.

## Layout

```xml
<section type="layout" orient="vertical"/>
```

Purpose:

* vertical containers
* horizontal containers
* spacing
* scrolling
* alignment

## Date Picker

```xml
<articleDate type="date-picker" include="date,time"/>
```

Supports:

* date
* time
* datetime

## Text Editor

```xml
<articleEditor type="text-editor"/>
```

Purpose:

* article writing
* rich text editing
* lightweight markup editing

## Login

```xml
<applogin type="login"/>
```

Purpose:

* login/logout
* device-credential authentication (no server-held session)

## Register

```xml
<appregister type="register"/>
```

Purpose:

* user registration
* account creation

---

# Future Component Types

Later component types may include:

* table
* tabs
* modal
* date-range-picker
* kanban
* graph-view
* chat
* calendar
* notifications
* AI assistant panel

WorkSplicer will likely require a much broader component ecosystem.

---

# Component Extensibility

RESOLVED (two kinds of component types): there are exactly two kinds of
component type, and the distinction is the backbone of the whole component
model.

## Composite components

A **composite** component is defined in a single XML file using the *same
grammar as `app.xml`*: component instances, field bindings, watchers,
optionally a `<functions>` block and (rarely) a `<style>` block. A composite
component file is a miniature application specification. It has no `client.js`
and no `manifest.json` — **the XML is the manifest**, because its declared
parameters, fields, watchers, and any `^name` ancestor expectations are
visible in the markup itself.

All shipped non-leaf components — `login`, `register`, `date-picker`,
`text-editor` — are composites, built from primitives. Application authors and
framework component authors alike write composites; nobody writes lifecycle
methods to make a component.

## Primitive components

A **primitive** component is a leaf the framework ships, and primitives are the
*only* place HTML/CSS/JS lives. The v0.1 primitive set is intentionally single
digit:

```text
layout
text-input
text-area
button
select
rich-text
```

Everything else is a composite. The litmus test for the primitive set: `login`
must be writable in pure Apskel XML plus a call to `apskel.auth.loginUser`. If
a shipped component cannot be expressed as a composite, either the primitive
set is missing a genuine leaf or the component is smuggling in complexity.

## Directory shape

```text
/components
    login.xml            composite — one file each
    register.xml
    date-picker.xml
    text-editor.xml
    /primitives
        /layout          primitive — client.js (+ structural CSS)
        /text-input
        /text-area
        /button
        /select
        /rich-text
```

A primitive folder contains a `client.js` implementing the primitive contract
(see Component API) and optionally structural CSS. Composite components are
one file. This is the "as few files as reasonably possible" rule made
concrete: files per composite component = 1.

## Styling split

Uniform application appearance comes from **one app-level theme** (semantic
tokens/classes). A primitive's own CSS is **structural only** — flexbox
mechanics of `layout`, the reset on a `rich-text` surface — never appearance.
Composites normally carry no CSS at all; a `<style>` block inside a composite
file is the escape hatch: present, legal, and rare. Uniformity is therefore the
enforced default rather than a discipline.

---

# Component Design

Components should remain:

* small
* self-contained
* framework-aware
* path-addressable
* reusable
* overridable

A component should automatically have access to:

* framework functions
* field resolution
* Wire messaging
* watcher registration
* app-global state
* permissions/auth context
* shared runtime behavior

Standard components such as login/register may rely on standard framework
tables. See **RESOLVED (minimal core tables, JSONB at the edges)** in Core
Semantics for the v0.1 core: `users`, `devices`, `user_devices`, plus a
credential/token mechanism. Note that there is deliberately no `sessions` table
— identity is device-held (see the auth-context resolution), not a server-held
cookie session.

---

## Component File Structure

RESOLVED (one file per composite): a composite component is a single XML file.

```text
components/
    login.xml
    register.xml
    text-editor.xml
    date-picker.xml
    primitives/...
```

The XML file defines:

* layout (as nested component instances, bottoming out in primitives)
* fields and field bindings
* watchers
* actions/events
* optional `<functions>` (inline or `src=` reference) and, rarely, `<style>`

A companion `.js` file (via `<functions src="...">`) is only for custom logic
that cannot reasonably remain declarative; a companion `.css` is discouraged in
favor of the app theme. Neither is required, and the common case is neither
existing.

---

## Component XML Structure

Tentative component structure:

```xml
<component name="text-editor">

    <layout>
        <section orient="vertical">
            <input field=".title"/>
            <textarea field=".body"></textarea>
            <button action="save">Save</button>
        </section>
    </layout>

    <watchers>
        <watch fields=".title,.body" run="markDirty"/>
        <watch event="save" run="saveDocument"/>
    </watchers>

    <functions src="text-editor.js"/>

</component>
```

Components may contain:

* framework components
* standard HTML
* fields
* field references
* watchers
* actions
* optional inline JavaScript

---

## Functions Inside Components

Framework functions should already be available to every component.

Components may additionally:

* use framework functions
* define inline functions
* reference external JavaScript files
* call app-level functions

Tentative examples:

```xml
<functions>
    <use name="apskel.auth.loginUser"/>
</functions>
```

Inline:

```xml
<functions>
    <function name="normalizeEmail">
        return value.trim().toLowerCase();
    </function>
</functions>
```

External:

```xml
<functions src="login.js"/>
```

Tentative function lookup order:

1. inline component functions
2. component JavaScript file
3. app-level functions
4. shared framework functions

DECISION-POINT: Decide whether inline JavaScript should be allowed in v0.1 or deferred until later.

DECISION-POINT: Decide whether component JavaScript should be referenced through `<functions src="..."/>` or automatically discovered.

---

## Application Workspace Structure

Tentative overall workspace structure:

```text
apskel/
    core/
        client/
        server/
        runtime/

    components/
        login.xml
        register.xml
        text-editor.xml
        date-picker.xml
        primitives/
            layout/
            text-input/
            text-area/
            button/
            select/
            rich-text/

    apps/
        knowledge-foyer/
            app.xml
            schema.sql
            client.js
            server.js
            style.css
            components/

        worksplicer/
            app.xml
            schema.sql
            client.js
            server.js
            style.css
            components/

    tools/
        build.js
        run.js
        deploy.js

    package.json
```

The shared `components/` directory contains reusable framework components.

Each application may optionally contain its own `components/` folder for overrides or custom components.

Tentative component resolution order:

1. app-specific component
2. shared framework component
3. framework fallback/default

Application overrides should remain relatively rare.

DECISION-POINT: Decide whether component overrides should fully replace shared components or allow inheritance/extension.

---

# XML Application Specification

## Example

```xml
<app title="Knowledge Foyer" version="1.0" copyright="2026 By Matthew Tedder">

    <client style="myapp.css" functions="myclient.js" orient="vertical">

        <myheader type="layout" orient="horizontal" space="between">
            Knowledge Foyer
            <applogin type="login"/>
            <appregister type="register"/>
        </myheader>

        <landingPage type="layout" orient="vertical">
            ...
        </landingPage>

        <myfooter type="layout" orient="horizontal" space="around">
            Copyright (C) {app.copyright}
        </myfooter>

    </client>

    <data source="postgres" schema="schema.sql">

        <graph name="knowledge">
            <users>
                <articles>
                    <comments/>
                    <tags/>
                </articles>
            </users>
        </graph>

    </data>

    <server functions="myserver.js">

        <wire name="article.save"
              direction="client-to-server"
              run="saveArticle"/>

        <wire name="article.changed"
              direction="server-to-client"
              table="articles"/>

    </server>

</app>
```

---

# Data Graphs

The `<data>` section defines:

* SQL schema source
* relationship graphs
* valid traversal structures
* synchronization topology

Example:

```xml
<data source="postgres" schema="schema.sql">

    <graph name="knowledge">
        <users>
            <articles>
                <comments/>
                <tags/>
            </articles>
        </users>
    </graph>

</data>
```

Graphs may define multiple valid traversals using the same tables.

Example:

```xml
<graph name="member-products">
    <members>
        <accounts>
            <products/>
        </accounts>
    </members>
</graph>

<graph name="product-members">
    <products>
        <accounts>
            <members/>
        </accounts>
    </products>
</graph>
```

---

# Field Binding Model

References resolve by **identity or explicit direction**, never by an implicit
walk through the tree. A bare name resolves only in the current component; any
cross-component reference must say *which* component (by name), *from the root*
(`app.`), or *upward by name* (`^name`). This keeps every reference legible on
its own: a reader can tell what a reference points at without understanding the
surrounding tree, and a reference cannot silently re-bind to a different target
as the app grows.

There are five reference forms.

## Local Fields

```text
{search}
```

A local (scratch) field in the current component. Resolves in the current component
only.

## Bound Fields

```text
{.title}
```

A field bound to the current data context. The leading `.` is the visible
marker that distinguishes a bound field from a local one; the distinction lives
at the reference site on purpose, so a reader never has to look elsewhere to
know whether a field is local scratch state or a bound data column. Resolves in
the current component's data context only.

## Named Component References

```text
{articleEditor.title}
```

References a field on another component *by the component's name*, regardless of where
that component sits in the tree (up, down, or sideways — direction does not matter
because resolution is by identity). The component name must be unambiguous; see the
Path and Reference System section for the uniqueness rule and the `app.`
fallback when a short name is not unique.

## Absolute App References

```text
{app.copyright}
```

An absolute path from the app root. Always resolves from the root, can never be
captured by a nearer name, and reads identically wherever it is written. This
is the preferred form for app-global, well-known state (for example user
preferences) that components deep in the app need to read without a backend call.

## Upward Named References

```text
{^projectRecord.budget}
```

The nearest enclosing ancestor named `projectRecord`, searching strictly
upward; the first match wins. This is a *named* upward reference, so it is
robust to changes in nesting depth — it finds the named ancestor wherever it
is above the current component. It is the narrow tool for the case where a
component must reach something several levels up that is neither its direct
parameter source nor app-global, but *is* nameable.

A component that uses an upward reference declares the ancestor name it expects
in its manifest, so the dependency stays inspectable. If no matching ancestor
is found, this is a load-time error.

Note: there is deliberately **no positional upward form** (no `^.field` or
`../field`). Positional upward references depend on tree position rather than
identity and silently break when nesting changes, which is exactly the
fragility this model avoids. When a component needs values from whatever mounts
it, those values are passed *in* as parameters (see below) rather than reached
*up* for.

## Parameters Passed In

The primary mechanism for a reusable component that needs values from its
surrounding context is **downward parameter binding**: the mount site supplies
the component's declared inputs, and the component reads them as local fields.
The component never reaches up into, or needs to know the name of, whatever
uses it.

A component declares the parameters it requires in its manifest. Each mount
site binds them:

```xml
<!-- in the phone directory: parent's own fields are name / phone -->
<phoneEntry type="contact-card" name="{.name}" phone="{.phone}"/>

<!-- under a project contact record: parent's fields are named differently -->
<phoneEntry type="contact-card" name="{.contactName}" phone="{.contactPhone}"/>
```

Inside `contact-card`, those inputs are simply local fields — `{name}`,
`{phone}` — regardless of which mount site supplied them. Because the binding
happens at the mount site (the one place that knows both the component's
vocabulary and the parent's data shape), differing field names between parents
are absorbed there, and the component works identically everywhere it is
mounted.

This is preferred over upward references for the reusable-component case
because the component's dependency surface is fully declared and legible: its
required parameters (and any `^name` ancestor expectations) are visible in its
manifest, rather than hidden as ad-hoc reaches into ancestors discoverable only
by reading the component body.

Parameter bindings are **live**, not one-shot copies — a change to the
parent's source field propagates to the child's local field. See **RESOLVED
(parameter bindings are live)** in the Component API section for the full
contract.

---

# Collection Binding

RESOLVED (repetition is what it means to bind to a collection): a component
whose mount declares a collection — `table="articles"`, or later a graph
traversal — **repeats its content once per row**, and each repetition's data
context *is* that row. `{.title}` inside means "this row's title." There is no
separate `<for-each>` construct and no loop syntax: the binding *is* the
iteration — one concept instead of two.

```xml
<thread type="layout" table="topics" orient="vertical">
    Topic: {.title}
    <messages type="layout" table="messages" orient="vertical">
        <msg type="message-card" author="{.author_name}" body="{.body}"/>
    </messages>
</thread>
```

RESOLVED (nested collections follow graph edges): a collection binding inside
a row context resolves **through the data graph, relative to that row** —
`messages` under a `topics` row means "this topic's messages," because the
`<graph>` section declares that edge. An inner collection binding that does
not correspond to a declared edge from the enclosing context is a **load-time
error**. This is the payoff of declaring graphs at all: nesting in the UI
follows edges in the graph.

RESOLVED (instances are keyed by primary key, never ordinal): the path to one
repeated instance uses the row's primary key —
`app.thread[7].messages[42].msg.body` is a stable address. Ordinals shift
under insert/delete/reorder; keying by them would break every Wire message,
watcher subscription, and AI operation targeting a row the moment someone
posts. PK keying also makes server sync mechanical:

* `...changed, id 42` → update instance `[42]`
* an INSERT broadcast → create instance
* a DELETE broadcast → destroy instance

RESOLVED (per-row local state is free): a local (scratch) field written inside
the repeated scope — `{expanded}` — is per-instance. "Collapse this one
message" requires no additional design.

RESOLVED (resolution vs instantiation): the repeated content is a *template*,
resolved once at load like everything else (see the compile-time resolution
procedure). What happens per row at runtime is **instantiation, not
resolution**: stamping the resolved template with a concrete row context and
key. Rows arriving over SSE are simply the most common case of dynamic subtree
insertion, handled by the same "load time, again, locally" rule.

RESOLVED (content repeats, not the component): the repeated unit is the bound
component's **content**. There is no second form where the component itself
repeats (`<msg type="message-card" table="messages"/>` meaning N cards); that
is expressible as the first form with a one-line wrapper, and one rule beats
two.

RESOLVED (insertion is not a repetition concern): "add a new row" is an
ordinary sibling component — e.g. a new-message composer — whose save action
creates the row. The new instance then appears via the same broadcast path as
any remote insert: your own insert and someone else's insert render through
one code path.

Collection bindings admit declarative `order=`, `filter=`, and `limit=`
attributes (a forum wants newest-first and pagination; better as declared
attributes than as function-call escape hatches). The exact v0.1 forms are
resolved in design session 4 — see RESOLVED (`filter=` is the domain
syntax on a column) and RESOLVED (`order=` and `limit=` closed forms) in
Core Semantics.

---

# Field Domains

A field may optionally define a domain after a colon.

## Example

```text
{.status: "draft", "published"}
```

The domain determines:

* allowed values
* validation
* suggested widget type

---

# Domain Types

## Literal Values

```text
{.status: "draft", "published"}
```

## Boolean Toggle

```text
{.active: true, false}
```

Two-value domains may render as:

* checkbox
* toggle switch
* button pair

## Regex Validation

```text
{.email: /.+@.+\..+/}
```

## Table-Based Values

```text
{.assigned_user_id: users.id->users.name}
```

Where:

* stored value = users.id
* display value = users.name

## Mixed Domains

```text
{.tag: "urgent", "blocked", tags.name}
```

A domain is a single combined list of selectable options. Every domain item is
**flattened into one option list**, including an item that is itself a list
(such as a column drawn from a table): its rows are flattened in alongside the
literals.

Stored-vs-display contract:

* A **literal** item (`"urgent"`) stores its own value as-is and displays the
  same value.
* A **table** item written `table.value->table.label` stores the `value`
  (e.g. `tags.id`) and displays the `label` (e.g. `tags.name`). Written as a
  bare `table.column` (e.g. `tags.name`), the column serves as both stored and
  displayed value.
* In a mixed domain, the literals store as-is and any table item stores its key.
  The app author is responsible for **column compatibility** — i.e. ensuring the
  bound column can hold both the literal values and the table item's stored
  values. (Combining string literals like `"urgent"` with an `id->name` table
  item in the same domain would mean one column holding both arbitrary strings
  and foreign-key ids, which is the author's call to make coherent.)

---

# Widget Inference

Widget type should usually be inferred automatically.

Examples:

| Domain            | Widget               |
| ----------------- | -------------------- |
| none              | text input           |
| two values        | toggle               |
| multiple values   | dropdown/select      |
| regex             | validated text input |
| table values      | dynamic select       |
| mixed             | combo input          |
| edge-bound domain | multi-select         |

---

# Watchers

Watchers react to field changes.

Example:

```xml
<watch name="autosave"
       fields="app.articleEditor.title, app.articleEditor.body"
       run="autosaveDraft"/>
```

Watchers may:

* update fields
* validate values
* synchronize data
* trigger UI updates
* call Wire handlers

## Watcher Execution Model

RESOLVED (execution semantics): watcher semantics follow the position already
established in the author's language work (HiLow, gBASIC) — this is the family
position, restated for Apskel:

* **Value-change triggering.** A watcher fires only when a watched field's
  value actually changes; writing the same value does not fire. This guard is
  also the base cycle-breaker: a self-stabilizing cascade terminates when
  values stop changing.
* **Synchronous, immediate firing.** When a field changes, its dependent
  watchers run synchronously, to completion, before control returns. There is
  no microtask queue and no deferred tick to reason about.
* **Cascades run in the same tick, with deduplication.** If watcher A's body
  changes a field that watcher B watches, B fires within the same synchronous
  cascade. Within one cascade, a watcher fires at most once per distinct value
  change of its subscription (cascade deduplication), so diamond-shaped
  dependency graphs do not multiply firings.
* **Snapshot values.** A watcher body receives the watched fields' values as
  snapshots at firing time — exactly as if called like a function — including
  the old value alongside the new (`value`, `oldValue`).
* **Cycle detection.** A cascade that revisits the same watcher with a
  changing value beyond a bounded depth is a runtime error (reported with the
  cascade trace), not a hang.

RESOLVED (the Wire sits *after* the cascade, never inside it): a watcher
cascade is purely local and synchronous; network effects are **enqueued during
the cascade and sent after it settles**. Consequences:

* Local reactivity is never blocked on the network.
* A burst of cascading field changes coalesces into fewer Wire messages
  (per-field, last value wins within the settle window).
* On the receive side, an incoming SSE update applies to the central store and
  triggers the same synchronous cascade — but the change is **marked with its
  origin**, so watchers whose job is to sync outward (autosave) recognize a
  server-originated change and do not echo it back out. This is the
  watcher-level counterpart of the `sourceClient` echo rule in the Wire
  section.

RESOLVED (coalesced watcher snapshot): if further watched fields change while
a watcher is pending within a cascade, it still fires once; `ctx.changes`
carries every triggering change since the watcher last ran, in order, and
`ctx.value`/`ctx.oldValue`/`ctx.field` are conveniences reflecting the most
recent. No triggering change is invisible to the body.

RESOLVED (seeding is silent): declared-local defaults are initial state, not
changes. The store initializes them without change notification; no watcher
fires on a default. A field comes into existence already holding its default
— there is no old value.

RESOLVED (origins): every `set` carries an origin — `user`, `server`, or
`system`. Watcher-body writes default to `system`. The `server` origin is
reserved to the Wire receive path; the engine rejects any other writer
claiming it, because echo suppression trusts this origin and must not be
forgeable by app code.

RESOLVED (uniform effect timing): every `set` opens a cascade frame, even
with zero registered watchers; deferred effects enqueued during any frame
deliver at settle, coalesced per field to last value. Effects enqueued with
no frame in flight deliver immediately. There is exactly one timing rule for
set-consequent effects.

RESOLVED (aborted cascades): a cascade that aborts (cycle detection)
discards its entire deferred-effect queue — nothing partial is sent — but
store writes already applied are not rolled back; there is no
transactionality. Local state may therefore diverge from the server until
the next successful write. This is accepted: a cascade abort is a
developer-error class, not a runtime condition to recover from.

---

# Functions

The framework should remain mostly declarative.

However, functions are allowed when necessary.

## Function Calls in Fields

Allowed:

```text
{count(products)}
{sum(accounts.balance)}
{format_money(.balance)}
```

Not allowed:

* chaining
* arbitrary JavaScript
* inline anonymous functions
* complex expressions

Function calls should remain intentionally simple.

---

# Client and Server Functions

## Client Functions

```xml
<client functions="myclient.js">
```

Contains app-specific client behavior.

These functions are merged with the standard Apskel client runtime.

## Server Functions

```xml
<server functions="myserver.js">
```

Contains app-specific server behavior.

These functions are merged with the standard Apskel server runtime.

---

# Message Protocol (the Wire) and MCP

Apskel-NP has **two distinct consumers and one transport**:

* the frontend talking to the backend, and
* an AI agent that may talk to *both* the frontend and the backend.

To keep "as few protocols as possible," there is **one wire format**, used for
everything internal, exposed through **two surfaces**.

> Naming note: the internal message format is called the **Wire** here. The
> name is a placeholder — pick whatever you like (Wire / AppBus / Sync) — but
> the doc deliberately does **not** call the internal bus "MCP." "MCP" is
> reserved for an actual Model Context Protocol surface (see below), so that
> door stays available for real LLM agents without a naming collision.

## The Wire (internal message format)

The Wire is a single reflective envelope routed by a `type` field. It carries:

* REST request/response
* SSE synchronization
* client/server coordination
* UI automation

It follows the long-standing single-stream-routed-by-request-type approach:
one envelope shape, dispatched to a handler by its `type`, where each handler
takes whatever parameters it is given and does the best it can with what it
receives. This keeps upgrades piecemeal — handlers can change what they accept
over time without breaking the transport.

## MCP surface (AI-facing door)

When a real LLM agent should drive the app, it speaks **actual MCP**. The MCP
surface is a thin façade: each MCP tool (`component.focus`, `field.set`,
`data.get`, …) translates one-to-one into a Wire message. No second protocol is
built — the MCP surface is an adapter over the existing Wire. This gives any
MCP-capable model access to both the frontend and the backend through one
well-known door, with zero bespoke glue.

RESOLVED (the MCP façade is deferred to the WorkSplicer era) — design
session 6, closing the DECISION-POINT that stood here: v0.1 shipped
without the façade, and nothing on the roadmap before WorkSplicer has an
LLM agent to drive an app. A façade with no consumer cannot pass the
standing verification discipline — there would be nothing to verify
personally, only an implementation summary's claim that the adapter
adapts. So the façade lands inside WorkSplicer's own plan, next to its
first real consumer. Three rules hold in the meantime, so the deferral
stays cheap:

1. The internal bus keeps not being named "MCP" — the namespace stays
   free, as it has since Phase 4.
2. Every Wire message keeps the 1:1-tool-translatable shape: typed
   envelope in, plain result out, no client-only semantics smuggled into
   the protocol. The Wire's message vocabulary (`apskel.data.*`,
   `apskel.field.set`, `apskel.auth.*`, ...) IS the future tool list.
3. A proposed Wire message that would not make sense as an MCP tool is a
   design smell to catch at review time, not at façade-building time.

---

# Client-to-Server Wire Message

Example:

```json
{
  "type": "article.save",
  "path": "app.articleEditor",
  "table": "articles",
  "id": 42,
  "field": "title",
  "value": "New Title"
}
```

---

# Server-to-Client Wire Message

Example:

```json
{
  "type": "article.changed",
  "path": "app.articleEditor",
  "table": "articles",
  "id": 42,
  "field": "title",
  "value": "Updated Title"
}
```

This enables:

* multi-client synchronization
* real-time updates
* reactive interfaces

Note on scope: while online, synchronization in v0.1 is **field-level**, with the
server's broadcast as the authority and the server's **receipt order** (never any
client wall-clock) as the tiebreaker. How concurrent writes are resolved is **not
a single global rule** — it is a per-data-context conflict policy (see **RESOLVED
(conflict policy is per data context)** in Core Semantics). Character-level
collaborative editing of a text body (simultaneous cursors, as in Google Docs) is
**explicitly out of scope** for now; it would require CRDT/OT machinery and is
deferred to a later version. "Collaborative editing" in this doc means field-level
co-editing, not character-level co-authoring.

---

# AI Integration

Apskel-NP is designed to support AI-assisted interfaces.

Because the UI is fully addressable and declarative, an AI agent can interact
with the interface semantically rather than scraping the DOM. The agent reaches
the app through the MCP surface described above, whose tools map onto Wire
messages.

Example AI operations (MCP tool → Wire message):

```json
{
  "type": "client.focus",
  "target": "app.articleEditor.title"
}
```

```json
{
  "type": "client.setField",
  "target": "app.articleEditor.title",
  "value": "The Shape of Thought"
}
```

Potential AI operations:

* focusing fields
* blinking/highlighting controls
* entering data
* navigating components
* validating forms
* assisting the user in workflows
* field-level collaborative editing assistance

---

# Addressable Interface Model

Every component and field should be addressable.

Examples:

```text
app.articleEditor.title
app.myheader.applogin
app.landingPage.search
```

This unified addressing model supports:

* data binding
* synchronization
* watchers
* validation
* testing automation
* AI assistance
* Wire messaging

---

# Core Semantics Needed Before Implementation

Before implementation begins, Apskel-NP needs a small set of core semantics defined clearly enough that the first vertical slice can be built without the framework shifting underfoot.

The following areas should be decided or at least given tentative v0.1 rules.

---

## XML Grammar

The XML specification should define the entire application at a high level.

Tentative structure:

```xml
<app>
    <client>
        <componentInstance type="component-type"/>
    </client>

    <data>
        <graph>
            ...
        </graph>
    </data>

    <server>
        <wire/>
    </server>
</app>
```

Tentative grammar rules:

* `<app>` is the root element.
* `<client>` defines client-side UI structure.
* `<data>` defines schema references and data relationship graphs.
* `<server>` defines server-side functions and Wire message declarations.
* Any custom tag inside `<client>` is a component instance.
* The custom tag name is the component instance name.
* The `type` attribute identifies the reusable component type.
* Attributes configure the component instance.
* Text inside a component may include static text and field references.
* Child elements define nested components.

Example:

```xml
<articleEditor type="text-editor" table="article_editions">
    Title: {.title}
    Body: {.body}
</articleEditor>
```

DECISION-POINT: Confirm whether custom tag names should always be component instance names, or whether a separate `name` attribute should also be allowed.

DECISION-POINT: Confirm whether field references may appear in all text nodes, or only inside specific component types.

RESOLVED: Component instance names used as the target of a bare named reference
(`{componentName.field}`) must be unambiguous app-wide. When two components genuinely
need the same short name in different subtrees, references to them use the full
absolute path (`{app.path.to.component.field}`) instead of the bare name. This is
what makes named references trustworthy: a name resolves to exactly one component,
by identity, so a reference cannot change meaning as the app grows.

---

## Path and Reference System

The path and reference system is one of the most important parts of the framework. It should be shared by fields, watchers, Wire messages, synchronization, validation, AI operations, and tests.

Reference rules:

```text
{field}              local (scratch) field in the current component
{.field}             bound field in the current data context
{componentName.field}    a named component, resolved by identity (any direction)
{^name.field}        nearest enclosing ancestor named `name`, searching upward
{app.x.y}            absolute reference from the app root
{function(args)}     simple function call
```

Examples:

```text
{search}
{.title}
{articleEditor.title}
{^projectRecord.budget}
{app.copyright}
{format_money(.balance)}
```

Core principle: references resolve **by identity or by explicit direction,
never by an implicit walk through the tree.** A bare name resolves only in the
current component. Anything cross-component must name its target (`componentName.field`),
search upward by name (`^name.field`), or anchor at the root (`app.x.y`). There
is no implicit upward-and-outward search, and no positional upward reference
(`^.field` / `../field`) — both make a reference's meaning depend on tree
position, so it can silently re-bind when nesting changes. This is the specific
fragility the model exists to prevent.

Resolution rules:

1. A bare name (`{field}`) resolves in the current component only — local scratch
   state. If not found locally, it is a load-time error; it does **not** search
   outward.
2. A dotted bare name (`{.field}`) resolves in the current component's bound data
   context only.
3. A named reference (`{componentName.field}`) resolves to the one component with that
   name, wherever it sits (up, down, or sideways). The name must be
   unambiguous app-wide; otherwise use the absolute form.
4. An upward reference (`{^name.field}`) searches strictly upward from the
   current component and stops at the **nearest** enclosing component named `name`.
   First (nearest) match wins. Robust to nesting depth because it matches by
   name, not by level. Load-time error if no matching ancestor exists.
5. An absolute reference (`{app.x.y}`) always resolves from the app root.

For the common case where a reusable component needs values from whatever
context uses it, prefer **parameters passed in at the mount site** over any
upward reference (see Field Binding Model). Upward references are the narrow
tool for reaching a nameable ancestor several levels up; they are not the
default way a component gets its inputs.

RESOLVED (`{field}` vs `{.field}`): `{field}` is local scratch state in the
current component; `{.field}` is a field bound to the current data context. The
distinction lives at the reference site (the leading `.`) so locality is
visible at a glance without consulting anything else.

RESOLVED (local field declaration): a component's local (scratch) fields are
its mount-site parameters plus any field declared by a defaulted reference —
`{search = ""}` — written once inside the definition (or at app scope, inside
`app.xml`). Other bare references to that name are reads of the declared
field. A bare reference matching neither a parameter nor a declared local is
a load-time error; locals are never created implicitly by reference, so a
typo fails loudly rather than minting an empty field. Declaring the same
local twice in one scope is likewise a load-time error.

RESOLVED (declaration sites do not display): a defaulted reference
`{name = ""}` is a declaration, not a display site — it renders nothing.
Only reads (`{name}`) display the value. A component that wants to declare a
field and show it writes both: the declaration and a read.

RESOLVED (relative search vs explicit paths): cross-component references require an
explicit form — a component name, `^name`, or `app.`. There is no automatic search
of parent or sibling scopes for bare names. Capability is unchanged (any component
can reference any other); only the implicit walking is removed.

RESOLVED (no app-wide fallback inside definitions): a named reference written
inside a composite definition resolves within that definition's scope only;
zero matches is a load-time error, never a fallback to app-wide search. A
composite that needs app-level structure must say so explicitly with
`app.x.y`, keeping the coupling visible. (App-level references in `app.xml`
keep the app-wide uniqueness rule unchanged.)

RESOLVED (ambiguity): an unresolved or ambiguous reference is a **load-time
error**, not a silent best-effort resolution. Bare names that aren't local,
named references whose name is not unique app-wide, and `^name` references with
no matching ancestor all fail loudly at load time.

RESOLVED (`app` reserved): `app` is a reserved root name and may not be used as
a component instance name, so that `{app....}` always unambiguously means "from the
root."

RESOLVED (component definitions are naming scopes): because composite
components are written in the same grammar and may be mounted many times,
identity in the instantiated tree is **path**, and a name is a shorthand that
must be unambiguous *within the scope where the reference is written*.
Concretely:

* Names inside a composite definition must be unique within that definition
  and resolve **within the definition's scope** — so each mounted instance of
  `contact-card` resolves an internal `{phoneField.number}` to *its own*
  `phoneField`, which is what the component author means when writing it.
* Names at app level keep the existing app-wide uniqueness rule.
* Reaching a specific instance's interior from outside uses the full path
  (`app.directory.entry3.phoneField.number`), which is unambiguous by
  construction: each instance sits at a different tree position.
* `^name` still searches upward *across* component boundaries — reaching a
  nameable ancestor is its entire purpose.

Nothing in the earlier reference rules changes; the scope of "unambiguous"
becomes "within the naming scope where the reference is written."

RESOLVED (sibling names are unique): two children of the same parent may not
share a name — identity is path, and same-named siblings would collide at
one path. This is a load-time error. The looser app-scope rule (duplicate
names in *different* subtrees stay legal until an ambiguous reference
targets them) is unchanged.

RESOLVED (resolution is compile-time / load-time binding): references are
resolved **once, at load**, not looked up per read. The loader:

1. Parses `app.xml` and expands every composite mount recursively (each mount
   stamps the composite's definition into the tree as a fresh instance),
   producing the full instantiated component tree, in memory, with every node
   carrying a parent pointer.
2. Walks every reference site; classifies its form (`local`, `.bound`,
   `named`, `^name`, `app.`, function call); runs the matching search strategy
   (current scope / definition scope / upward parent-chain / root); and
   **binds the reference site to the concrete node and field it resolved to**.
3. Fails loudly on anything unresolved or ambiguous — this is where the
   load-time-error guarantees in the earlier RESOLVED items are enforced.

After load, a read is a direct lookup through the stored binding; there is no
per-read search cost. Dynamic insertion of a subtree at runtime (including
collection rows arriving over the Wire — see Collection Binding) is handled by
running the same resolver over the inserted subtree at insertion time: load
time, again, locally. Errors stay at load; per-row runtime work is
instantiation, not resolution.

---

## Field Domain Syntax

Fields may define domains after a colon.

Tentative syntax:

```text
{binding: domain-item, domain-item, domain-item}
```

Domain items may be:

```text
"string literal"
number
true
false
/regex/
table.column
table.value->table.label
function(args)
```

Examples:

```text
{.status: "draft", "published"}
{.active: true, false}
{.email: /.+@.+\..+/}
{.assigned_user_id: users.id->users.name}
{.tag: "urgent", "blocked", tags.name}
```

Tentative widget inference:

| Domain            | Suggested Widget            |
| ----------------- | --------------------------- |
| no domain         | open text field             |
| two values        | toggle, checkbox, or button |
| multiple literals | select/dropdown             |
| regex only        | validated text input        |
| table values      | dynamic select              |
| mixed values      | combo input                 |
| edge-bound domain | multi-select                |

DECISION-POINT: Confirm whether string literals must always be quoted.

DECISION-POINT: Decide whether regex should use `/regex/` syntax.

DECISION-POINT: Decide whether table value display syntax should be `table.value->table.label`.

DECISION-POINT: Decide whether two-value domains should always default to a toggle or whether component/theme settings should choose the widget.

RESOLVED (flattening and storage): every domain item flattens into one combined
option list, including a table-column item whose rows flatten in alongside
literals. Literals store as-is; a `value->label` table item stores its key and
displays its label; a bare `table.column` is both stored and displayed. In a
mixed domain the author is responsible for column compatibility. See the Mixed
Domains subsection for the full contract.

---

## Function Calls

Apskel-NP should remain mostly declarative, but functions are necessary for custom logic.

Tentative function call rules:

* Function calls use `functionName(arg1, arg2)` syntax.
* Function calls may appear in field references and watchers.
* Arguments may be literals, field references, app paths, or table paths.
* No chaining.
* No anonymous functions.
* No inline JavaScript expressions.
* No arbitrary operators in the field syntax.

Allowed:

```text
{count(products)}
{sum(accounts.balance)}
{format_money(.balance)}
```

Not allowed:

```text
{products.filter(x => x.active).map(x => x.name)}
```

DECISION-POINT: Decide whether functions are allowed inside field domains as option sources.

DECISION-POINT: Decide whether functions may be asynchronous.

DECISION-POINT: Decide whether client functions and server functions use separate namespaces.

---

## Component API

RESOLVED (who implements what): composite components are pure XML and have
**no JS contract at all** — the loader expands them like any other markup.
The lifecycle contract exists only for **primitives**, of which there are
single digits in v0.1, all framework-authored. The question "what must every
component author implement?" therefore mostly dissolves: component authors
write XML.

RESOLVED (runtime owns all state): components do **not** hold field state and
do **not** expose `getValue`/`setValue`. The runtime holds every field —
local, bound, and app-global — in one central store, keyed by path. Primitives
merely *display* values pushed to them and *report* user input. Binding,
watchers, Wire sync, validation, testing, and the MCP façade all operate on
that one store through one code path. A primitive is a two-way valve between
the store and the DOM, nothing more.

RESOLVED (primitive contract): the entire surface a primitive implements:

```js
// client.js of a primitive — the whole contract
export function create(ctx, el)          // build DOM inside el; wire DOM events to ctx.input(...)
export function write(ctx, field, value) // runtime pushes state → primitive updates the DOM
export function destroy(ctx)             // teardown (often empty)
```

One callback flows the other way:

```js
ctx.input(field, value)   // the primitive reporting user input to the runtime
```

`ctx.input` is the *only* way a value enters the system from the DOM. The
runtime then updates the central store, runs watchers, and (for bound fields)
enqueues Wire sync — the primitive knows nothing about any of that. There is
no render/update/shouldUpdate cycle because there is no component-held state
to reconcile.

The `ctx` object carries the instance's identity (its path), its resolved
bindings, and framework services (focus/highlight hooks for the MCP façade,
theme access). Its exact field list is an implementation detail of the
runtime, not a public covenant — only `create`/`write`/`destroy` and
`ctx.input` are the contract.

RESOLVED (manifests): composite components need no manifest — **the XML is the
manifest**; declared parameters, fields, watchers, and `^name` expectations
are legible in the file itself. Primitives carry a small `manifest.json`
declaring what the loader must know to validate mount sites:

```json
{
  "type": "text-input",
  "attributes": ["field", "placeholder", "readonly"],
  "input": true
}
```

RESOLVED (parameter bindings are live): when a mount site binds a parameter —
`name="{.name}"` — the expression is resolved **in the mounting context** and
the binding is **kept live**: the child's local field tracks the source. A
change to the parent's `.name` propagates to the child's `{name}`; parameters
are reactive bindings, not one-shot copies at mount time. (One-shot would make
parameters dead values in a framework whose entire premise is reactivity.)
Writes are one-directional — parameter fields are read-tracking; a component
that needs to push a value outward does so via an event/action, not by
assigning to its parameter.

---

## Data Binding and Synchronization Flow

The framework should define what happens when data changes.

Tentative flow for a bound field change:

1. User changes bound field in the client.
2. Runtime updates local client state.
3. Relevant watchers run — synchronously, to cascade completion (see Watcher
   Execution Model).
4. Runtime sends a Wire message to the server over REST — enqueued during the
   cascade, sent after it settles.
5. Server validates the update.
6. Server writes update to PostgreSQL.
7. Server broadcasts a Wire update over SSE.
8. Other clients receive update.
9. Other clients resolve the path and update their local state/UI.

Tentative flow for local field change:

1. User changes local field.
2. Runtime updates local component state.
3. Relevant watchers run.
4. No server update occurs unless a watcher or function explicitly sends one.

RESOLVED (autosave vs explicit save): **autosave drafts, explicit publish.**
Bound fields in a draft data context autosave on change; promoting to a
published state is an explicit action. Save policy is therefore a property of
the data context, not a single global default.

RESOLVED (real-time draft sync): drafts sync at the **field level** as they
autosave. Character-level real-time co-authoring is deferred (see the protocol
section).

RESOLVED (offline model):
* Client keeps a durable local store; the app boots and stays usable offline on
  last-known state.
* Local edits apply optimistically to the client store immediately.
* While online, the server broadcast is the authority.
* Offline edits queue and flush on reconnect, governed by the conflict policy
  below. Reconciliation richer than that policy (CRDT/merge) is deferred to the
  WorkSplicer era.
* Authoritative ordering is the **server's receipt order — never any client
  wall-clock.**

RESOLVED (conflict policy is per data context, not global): conflict strategy is
a declared attribute of the data context — the same place save policy already
lives (autosave-draft / explicit-publish). It is **not** a single global rule.
Closed v0.1 menu:

* `offline-readonly` — **default, safe floor.** Viewable offline; edits need a
  connection. No offline write exists, so no conflict is possible.
* `detect` — offline edits allowed. Each record carries a revision token; a write
  sends the revision it was based on; if the server's current revision differs,
  the write is rejected and the user is prompted (keep mine / take theirs).
  Covers same-author-across-devices.
* `lww` — offline edits allowed; newest by server receipt order wins silently.
  Only for fields where losing a stale write is acceptable.

Access control (*who* may write offline) is a separate axis from conflict
resolution (*what happens* when accepted writes collide). Do not conflate them.

RESOLVED (conflict detection mechanism): one primitive underlies both per-write
checks and resync reconciliation — a per-record revision token (monotonic counter
or server-authoritative stamp) plus a changed-since-read comparison.

* Per write: send base revision → server compares → mismatch prompts the user.
* On resync: pull server changes first; records changed both locally (pending)
  and on the server are the conflict set and are prompted *before* push;
  everything else flushes cleanly.
* This is optimistic concurrency, not CRDT.

RESOLVED (resync order: components before data): on reconnect —

1. apply component/app version updates,
2. pull server data changes,
3. reconcile and flush the local queue.

Components first means queued writes replay against the *current* component
version, not the stale one the client ran while offline — this is what defuses
the migration-vs-backlog collision. A client whose version is behind must update
before flushing.

RESOLVED (echo to originating client): the server broadcast **does** include the
originating client; the `sourceClient` field lets a client recognize and ignore
its own echo if it has already applied the change optimistically.

RESOLVED (minimal core tables, JSONB at the edges):

* Core identity: `users`, `devices`, `user_devices` (a device may host multiple
  users; a user may have multiple devices), plus a credential/token mechanism.
  There is no `sessions` table.
* Relational columns for anything load-bearing — queried, indexed, joined, or
  under referential integrity.
* JSONB only for the sparse/variable tail around that structure (e.g.
  `users.profile`, `devices.state`, `app_state.value`). A JSONB column you end up
  querying *into* is a de-facto schema with none of the relational guarantees —
  that is the line not to cross.
* A server-side `sync_log` is **not** core yet; it lands with the offline queue,
  not before.

RESOLVED (Knowledge Foyer needs almost none of the conflict machinery):

* Articles / editions: single-author → `detect` (covers multi-device
  self-conflict).
* Comments: inserts, not field overwrites → no conflict.
* Comment marks: per-user → each owns their own.
* KF therefore ships on `detect` + `offline-readonly`; hard reconciliation waits
  for WorkSplicer's shared mutable records (task status, assignment).

---

## Wire Message Shape

Wire messages should be structured enough to support server/client
synchronization, AI assistance (via the MCP façade), and testing.

Tentative message shape:

```json
{
  "type": "article.changed",
  "path": "app.articleEditor",
  "table": "articles",
  "id": 42,
  "field": "title",
  "value": "Updated Title",
  "sourceClient": "client-abc"
}
```

Potential standard message types:

```text
apskel.data.get
apskel.data.set
apskel.data.changed
apskel.component.focus
apskel.component.highlight
apskel.component.open
apskel.component.close
apskel.field.set
apskel.field.get
apskel.field.validate
apskel.message.show
```

These framework-level types are the ones the MCP façade exposes as tools; an
app may also define its own application-specific types (e.g. `article.save`).

RESOLVED (message naming): **both.** Framework-level types use the `apskel.`
prefix and are stable; apps define their own application-specific types in their
own namespace.

RESOLVED (`path` requirement): not every message requires a `path`. Messages
that target a component or field carry a `path`; broadcast/notification types may
omit it. The handler does the best it can with what it is given, consistent with
the reflective routing approach.

RESOLVED (auth context): identity comes from a **device-held durable
credential** — the device owns a long-lived credential and mints short-lived
access tokens, so it knows who it is offline and across restarts. Wire messages
rely on this device-authenticated identity rather than carrying auth inline, and
rather than a server-held cookie session.

RESOLVED (device credential mechanics): the browser generates the credential
client-side on first boot — a device id (UUID) plus a random 256-bit secret —
and keeps it durably (localStorage). The server stores only a hash of the
secret in `devices`. Access tokens are **stateless**: the payload
(userId, deviceId, expiry) is HMAC-signed with a server-held key and verified
by recomputation, so there is no token table — the absence of a `sessions`
table holds by construction, not by omission. Tokens are short-lived; the
device re-mints silently with its secret, which is what survives a full
browser restart. Passwords are hashed with scrypt (`node:crypto`; no new
dependency). v0.1 stopgap: when a device hosts multiple users, a silent
re-mint identifies the most recently linked user; account switching on a
shared device is a later design session.

RESOLVED (identity store region): the authenticated identity lives in the
store under the reserved region `app.identity.*` — `userId`, `email`,
`displayName`, `status` (`anonymous` / `authenticated`), `error`. Any
component may read it by absolute reference (`{app.identity.email}`); it is
written only by the framework auth machinery, the same discipline as the
`server` origin. `identity` is therefore reserved as a top-level component
name, alongside the reserved root name `app`.

RESOLVED (token transport): the access token travels as an
`Authorization: Bearer` header on Wire POSTs — envelopes are unchanged from
the unauthenticated Wire, keeping auth orthogonal to data. An app that uses
auth (any `apskel.auth.*` call in its resolved tree) makes `apskel.data.set`
require a valid token; apps without auth are served exactly as before.

RESOLVED (action grammar): a primitive whose manifest declares
`"action": true` (the button) takes `action=` as a brace-less reference
expression, exactly like `field=`, and that expression **must** be a function
call — `action="apskel.auth.loginUser(email, password)"`. Arguments are bare
reference expressions or literals, per the `{fn(args)}` grammar, and bind at
load like every other reference. An unknown function name is a load-time
error naming the site; in this phase the known names are the framework
registry (`apskel.auth.*`) — app-defined `<functions>` arrive with their own
phase.

RESOLVED (conflict declaration surface): the conflict policy is the
`conflict=` attribute on the data-context element itself (the element that
declares `table=`), validated at load against the closed menu —
`offline-readonly` (default), `detect`, `lww`; an unknown value is a
load-time error. For `detect`, v0.1 wires the **mechanism** and not the
prompt: the record carries a `revision` column, every write sends the
`baseRevision` it was based on, the server updates guarded on that revision
and increments it, and a mismatch is a coherent 409 carrying the current
revision — logged, not prompted; keep-mine/take-theirs arrives with the
offline queue. Clients track current revisions as wire bookkeeping (from
initial data and broadcasts), never as a visible field, and a client's own
echo still updates its revision even though the store write is ignored —
otherwise its next write would false-conflict.

RESOLVED (reads through the Wire): `apskel.data.get` is the read
counterpart of `apskel.data.set` — same allowlist derived from the app's
own bindings, returns the value plus the current revision for `detect`
contexts. With identity attached, both data types require a valid token;
private drafts are not readable anonymously. (Phase 7.2 refines the blanket
token requirement into per-table rules — see RESOLVED (permission rules
live on the data graph); a table declared `read="public"` is readable
without a token, and everything else keeps exactly this behavior.)

RESOLVED (save policy attribute deferred past v0.1): save policy remains a
property of the data context per the autosave-vs-explicit resolution, but
the v0.1 slice contains only draft contexts, so no `save=` attribute ships
yet — bound fields autosave, exactly the Wire behavior already in place.
The attribute lands with the explicit-publish workflow immediately after
the slice, rather than shipping unexercised. (Amended, design session 5:
that promise did not come due — publish turned out to be a status
transition plus a next-edition insert, not a deferred save, so `save=`
still has no consumer and stays deferred by this entry's own logic. See
RESOLVED (publish is a status write).)

---

## First Vertical Slice

The first implementation should not attempt to build the whole framework.

RESOLVED (the slice): **draft-and-sync.** Parse `app.xml` → instantiate the
tree with one composite (`text-editor`) over four primitives (`layout`,
`text-input`, `text-area`, `button`) → device-credential register/login →
draft an article, autosave via the Wire → reload and see it back → open the
same draft in a second browser tab and watch a field-level edit sync over SSE.

Acceptance criteria — v0.1 is done when all of these pass:

1. `node run.js knowledge-foyer` parses `app.xml`, expands composites, binds
   every reference at load, and serves the app; a deliberately broken
   reference (bad name, missing `^name` ancestor, ambiguous name) fails at
   load with a message naming the reference site.
2. A new user registers and logs in; identity survives a browser restart
   without a server-held session (device-held credential mints tokens).
3. The logged-in user creates an article, types a title and body; edits
   autosave via Wire messages (watcher cascade settles, then send); killing
   the tab mid-typing loses at most the settle window, not the draft.
4. Reloading the page shows the draft exactly as left (PostgreSQL round-trip
   through binding, not a client cache).
5. The same draft open in a second tab reflects a title edit made in the
   first within one SSE broadcast, and the originating tab does not
   re-apply its own echo (`sourceClient` / origin-marking observably works).
6. Every field and component involved is addressable by path
   (`app.workspace.articleEditor.title`), demonstrated by a trivial test
   script that reads and sets a field through the Wire.

RESOLVED (comments/tags/publish are immediately-after, not in-slice): they add
tables and one workflow transition, not framework semantics. Order after the
slice: publish edition → view published article → comments → tags. Note that
"view published article" is gated on record selection and routing — see
Remaining Semantics Needed for Knowledge Foyer below.

Minimum framework files likely needed:

```text
app.xml
schema.sql
components/login.xml                          (composite)
components/register.xml                       (composite)
components/text-editor.xml                    (composite)
components/primitives/layout/client.js        (+ manifest.json)
components/primitives/text-input/client.js    (+ manifest.json)
components/primitives/text-area/client.js     (+ manifest.json)
components/primitives/button/client.js        (+ manifest.json)
runtime/pathResolver.js
runtime/binder.js
runtime/wireClient.js
server/wireServer.js
```

DECISION-POINT: Confirm the exact first Knowledge Foyer vertical slice. →
RESOLVED above (draft-and-sync, six acceptance criteria).

DECISION-POINT: Decide whether comments/tags are included in the first slice
or added immediately after. → RESOLVED above (immediately after).

---

## Remaining Semantics Needed for Knowledge Foyer

The slice above needs nothing beyond what this doc already resolves. **A
complete Knowledge Foyer does** — five concepts the doc does not yet define.
None undermines anything settled; all are additive, and all five are also
WorkSplicer prerequisites, so they are framework work, not KF-specific work.
Each carries a sketched default; each deserves a real design pass after the
slice runs.

RESOLVED (record selection / single-record context): `record=` takes either
an **integer literal** (a fixed singleton row — legitimate, e.g. a settings
row) or a **brace-less reference expression**, the same grammar as `field=`
and `action=`: `record="app.currentEditionId"`. Any reference form is legal
and binds at load like every other reference; what varies at runtime is the
referenced field's *value*. Selection is ordinary app state — set by a
route, by `apskel.field.set` from a list row's action, or by any watcher.

RESOLVED (selection-change semantics): **paths never change.** The bound
component keeps its instance, its watchers, and its DOM; identity is path,
and the row is context, not identity. When the selection value changes, the
runtime: suspends sends for that context, fetches the new row through
`apskel.data.get`, **applies the fetched values through the server-origin
door** (`applyServerWrite`) — display watchers repaint while the
origin-suppressed wire watcher stays quiet, so nothing echoes back out —
adopts the row's revision, and resumes. (The first ruling here said "seed
silently"; verification proved that wrong: after mount, silence skips the
display watchers too, so the DOM keeps the old row's text and the next
keystroke autosaves it into the new row. Silent seeding is correct only
*before* mount; once mounted, fetched row values are exactly what origin
`server` exists for.) Edges,
decided: a write always targets the row selected *when the keystroke
happened* (captured at enqueue time, not send time); keystrokes landing
between selection-change and fetch-arrival are discarded with a console
warning (queueing them against an unknown revision would be worse); a
null/undefined selection is an **empty context** — fields read undefined,
sends are suppressed, and hiding the component is `visible=`'s job.

RESOLVED (`visible=`): a brace-less reference attribute on any component
instance. The bare form is truthy visibility (`visible="app.taskListOpen"`);
with the domain syntax — its first consumer, no new grammar —
`visible="app.view: editor, article"` means visible while the value is in
the listed set. Hidden is a `display:none` wrapper: instances, state, and
watchers all survive. Creation and destruction remain the collections
mechanism's business, never visibility's.

RESOLVED (routes): routing is **state synchronization with the URL bar**,
not a second navigation system. A `<routes>` section at app level; each
route carries child `<set>` elements — no assignment mini-language, every
assignment its own load-validated element:

```xml
<routes>
    <route path="/">           <set field="app.view" value="landing"/> </route>
    <route path="/editor">     <set field="app.view" value="editor"/>  </route>
    <route path="/article/:id"><set field="app.view" value="article"/>
                               <set field="app.currentArticleId" param="id"/> </route>
</routes>
```

Load-time errors: a `field=` reference that does not resolve, a `param=`
absent from the route's pattern, any route targeting `app.identity.*`.
Two-way sync: URL→state at boot (seeded silently — route state is initial
state) and on back/forward; state→URL by reverse-matching routes **in
declaration order** (the first route whose assignments match current state
wins; params substituted; pushState). The value-change guard is what stops
the loop. An unmatched URL falls back to the first declared route. The
server serves the app shell for any route path, so deep links work.
Dependency named honestly: routing makes URLs *shareable*, not *public* —
anonymous reads await the permissions resolution (`read="public"`), and
routing must not smuggle that in.

RESOLVED (absolute references reach app-scope locals): `{app.x}` validates
against the root's children, the `<app>` element's attributes, **and the
app scope's declared locals** — previously only the first two, a latent gap
that `app.view` / `app.currentArticleId` expose.

RESOLVED (`apskel.field.set`): a framework function whose **first argument
is a write target**, not a read — `action="apskel.field.set(app.selectedTask, .id)"`
assigns the second argument's value to the first's bound field, origin
`user`. This is how a list row selects a record without routing and without
bespoke JS; it may not target `app.identity.*`. (Extended in design
session 5 to multi-assignment pairs — see RESOLVED (`apskel.field.set`
takes pairs).)

RESOLVED (`apskel.nav.go`): the deliberate-navigation counterpart —
`action="apskel.nav.go("/edit/1")"` applies the matched route's assignments
exactly as typing the URL would, then pushes the URL. `field.set` and
`nav.go` are the two directions of the same sync: set state and let the URL
follow, or set the URL and let state follow. Neither is a second navigation
system.

RESOLVED (error taxonomy: load vs. startup): two error classes, one
developer experience. **Load errors** are XML-knowable — grammar, closed
menus, reference resolution, anything decidable from `app.xml` and the
component files alone. **Startup errors** are schema-dependent — FK
introspection, join-table identification, column contracts, anything only
the live database can decide. Both exit 1 naming the site before the
server accepts a connection; neither ever surfaces at runtime. Entries
below cite this taxonomy instead of re-deriving it per case.

RESOLVED (permission rules live on the data graph): the `<data><graph>`
section — designed from the beginning, parsed by nothing until Phase 7.2 —
becomes real, and permission rules ride on its nodes, because ownership *is*
graph traversal:

```xml
<data>
    <graph name="knowledge">
        <users>
            <articles read="public" write="owner">
                <article_editions read="public" write="owner"/>
            </articles>
        </users>
    </graph>
</data>
```

Closed menus, validated at load exactly like `conflict=`: `read` is one of
`public` (no token needed), `users` (any authenticated user), `owner`;
`write` is one of `users`, `owner`, `none`. Defaults for an app that uses
auth: `read="users" write="users"` — precisely the pre-7.2 behavior, so no
existing app changes meaning. Apps without `apskel.auth.*` remain tokenless
end to end (Phase 4 behavior preserved). A table's rule attributes may
appear on **at most one node across all graphs** — a second declaration is a
load-time error even if identical; traversal multiplicity is fine,
permission multiplicity is not.

RESOLVED (owner is a graph walk): `owner` means: walk the declared graph
from the row's table up parent edges to `users`; the terminal user id must
equal the token's identity. The FK **columns are never written in the
XML** — the server introspects them from the live schema at startup
(`article_editions.article_id → articles`, `articles.created_by → users`);
two candidate FKs between adjacent nodes is a startup error naming both
candidates, resolved by a `via="column"` attribute on the child node. A
`users` row's owner is itself. **NULL anywhere in the chain means unowned,
and unowned denies** — the safe floor; a row acquires an owner by being
created by someone (Phase 8's INSERT path) or by explicit SQL until then. A
table carrying an `owner` rule without a graph path to `users` is a
load-time error. One parameterized SQL query per guarded operation. Hop
columns FK-resolve at startup **only for tables whose read or write rule
is `owner`** — a non-owner node's ancestor path may legitimately cross a
join edge (Phase 7.3), and resolving hops nobody walks would reject
configurations the membership entries themselves prescribe.

RESOLVED (enforcement is server-side at every Wire door): `apskel.data.get`
checks the table's read rule and `apskel.data.set` its write rule, before
the allowlist logic that already exists. Missing/invalid token where the
rule requires identity → 401 (unchanged shape); authenticated but rule
unsatisfied → **403 naming the table and rule** (`write on article_editions
requires owner`). The client honors outcomes — a 403 on autosave logs a
warning and does not retry (distinct from the 401 silent-re-mint path) — but
never enforces; the server is the only enforcement point. "Every Wire door"
includes the bundle: `/app.json` is fetched before authentication, so its
`initialData` carries only tables whose read rule is `public` — a
non-public fixed-record context boots empty and fetches through
`apskel.data.get` once a token exists, exactly like a dynamic-record
context. (Pre-7.2 the bundle shipped every fixed-record row tokenlessly —
a leak this entry closes.)

RESOLVED (broadcasts obey read rules): an open SSE firehose would make the
rest theater. `EventSource` cannot set headers, so `/events?token=...`
carries the token; identity is verified at connect and stamped on the
connection. Each broadcast is delivered per-connection by the table's read
rule: `public` → every connection, `users` → identified connections,
`owner` → only the owner's connections — the write handler computes the
owner id once (it already touched the row) and stamps it on the internal
envelope, stripped from the frame before sending. Accepted tradeoff,
recorded: SSE identity is checked at connect, not per-event; a token
expiring mid-stream keeps its connection until reconnect — a 15-minute
exposure ceiling, the same stateless-token philosophy as the REST side.
Revisit only if revocation ever matters.

RESOLVED (framework identity tables are Wire-locked): `users`, `devices`,
`user_devices` get fixed, non-overridable rules on the data Wire:
`read="owner"`, `write="none"` — a user may `apskel.data.get` their own
row; nobody data-writes identity tables (that is what `apskel.auth.*` is
for). An app declaring rules on them is a load-time error. The readable
column set is likewise fixed — `users.email` and `users.display_name`,
nothing else (never `password_hash`; the app's bindings cannot widen it) —
and a `users` row's owner is itself, while `devices`/`user_devices` rows
have no owner walk, so `read="owner"` denies them to everyone by the
unowned-denies floor. Like the absent sessions table, this is
curl-testable.

DECISION-POINT (row-state-conditional read — recorded, not resolved):
KF's true rule is "public may read *published*" — conditional on a row's
state, not its table. That lands in design session 5 as a property of
**named server-defined queries**: the query (`publishedEditions`) is the
permission boundary, keeping conditions in server-side SQL rather than
inventing an XML expression syntax. Until then permissions are per-table
only, and the KF demo's `read="public"` on `article_editions` deliberately
exposes drafts in the interim slice. → **Closed by design session 4**: see
RESOLVED (the query is the permission boundary).

RESOLVED (a set field is a domain-bearing edge reference): `{.tags:
tags.id->tags.name}` — when the data context's table has a declared graph
child named `tags`, the reference binds to that **edge**, and the field is
multi-valued: its store value is an **array of stored keys**. Edge
classification is **by graph declaration, at load**: a field reference
whose name matches a declared graph child of the data context's graph
position is an edge reference, classified at load, period — no
reclassification after load, ever. A collision between a declared graph
child name and an actual column on the context table is a startup error
naming both; the author resolves it by renaming one. "A name that matches
a column stays a column" governs only names with no declared edge — the
trivial case. The domain is mandatory on an edge reference, and on an edge
the **arrow form is mandatory**: the stored value is not the author's
choice — it must be the column the join table's FK references, validated
at startup with a mismatch error naming the site and both columns. The
bare form (`{.tags: tags.name}`) on an edge is a load error — no implicit
key, consistent with no implicit set-ness — and literal items or mixed
domains on an edge reference are likewise load errors: a literal cannot be
a membership row. A bare `{.tags}` with no domain at all is a load error
naming the site. There is no implicit set-ness anywhere. Empty context: a
set field reads `undefined` (not `[]`) when the selection is null, sends
suppressed — the same contract as every other field.

RESOLVED (the graph has two edge kinds; join tables are machinery): an
edge is either an **FK edge** (introspected child→parent FK — ownership-
walkable, 7.2 semantics unchanged) or a **join edge** (a join table with
exactly one FK to each endpoint, introspected at startup; `join="table"`
on the child graph node disambiguates multiple candidates, alongside
`via=`; zero candidates is a startup error). Join tables are introspected
machinery, never graph nodes — declaring one as a node is an error naming
it, raised by startup introspection since only the schema identifies a
join table. The owner walk refuses to cross a join edge: an owner rule on
a table whose only path to `users` crosses one is an error in the same
class as "no graph path to users" — caught at load when a set-field
reference has already marked the edge as a join edge, at startup
otherwise. Join edges confer no ownership. v0.x set fields require a join
edge; a one-to-many FK edge used as a set field is an error (assigning
children is a different, undesigned thing).

RESOLVED (membership writes are whole-set replaces): `apskel.data.setMembers
{table, id, edge, members}` carries the **desired set** — exactly what the
deferred-effect seam coalesces naturally (last value wins). The server
diffs current vs. desired **in one transaction** (DELETE the missing,
INSERT the new, `ON CONFLICT DO NOTHING`) and broadcasts
`apskel.data.membersChanged` with the resulting set. Canonical order:
the server sorts members by stored key in `membersChanged` and in
`getMembers`, and the client sends sorted — so the store's ordered-element
array equality behaves as set equality with exactly one equality rule, and
an echo or refetch of an unchanged set provably does not cascade. Set
fields are **lww at the set level**; `conflict=detect` does not cover
edges — recorded deferral to the offline-queue era, the same file as the
keep-mine/take-theirs prompt, and the raciness is stated plainly: two
owners editing concurrently means the last set wins and can drop the
other's simultaneous add. `apskel.data.getMembers` is the read
counterpart. `setMembers` inherits the 7.1 capture rule: the parent row id
is captured at interaction time, not send time, and membership sends are
suspended in the selection-change fetch window exactly like field sends.

RESOLVED (options are runtime state at the widget's own path): the
domain's table item creates a load-time allowlist entry;
`apskel.data.options {table, value, label}` returns `(value, label)` pairs
ordered by label. The runtime delivers them to the widget instance's own
`options` store path via `applyServerWrite` — ordinary state, no new
region, primitives stay stateless. Fetched at mount and on selection
change; an error or 403 on the options fetch leaves the widget with empty
options and logs a console warning without retry — the autosave-403
pattern. *Liveness* of the option list (a new tag appearing) arrives with
collection broadcasts in Phase 8, not here.

RESOLVED (membership permissions ride the parent row): reading or writing
a set is reading or writing the **parent row**: the parent table's
read/write rules govern, including the owner walk on the parent's id;
`membersChanged` broadcasts scope by the parent's read rule. Rules on a
join table are impossible by grammar — it cannot be a graph node. The
options list is governed solely by the options table's own read rule,
declared on its graph node (for the KF interim: `<tags read="public"
write="none"/>` — tag creation is Phase 8).

RESOLVED (multi-select primitive; array equality in the store): one new
primitive, `multi-select` (checkbox/chips list, structural CSS only), with
two fields: `value` (the array) and `options` — the existing `write(ctx,
field, value)` contract already accommodates multi-field primitives. The
store gains **ordered-element array equality** for its same-value check;
combined with the canonical stored-key order above, equal sets never
cascade. Widget inference: edge-bound domain → multi-select.

RESOLVED (`filter=` is the domain syntax on a column):
`filter=".status: published"` — the third consumer of the `{ref: domain}`
grammar, after field domains and `visible=`. The left side is a column of
the binding's own row context; the right side is literals **or absolute
references** — `filter=".created_by: app.identity.userId"` is "my drafts",
and a reference value makes the filter *dynamic*: its change re-runs the
fetch, the same machinery as a `record=` selection change. Set membership,
String-compared, identical semantics to `visible=`. No bare-truthiness
form (SQL truthiness is a swamp — explicit domains only), one `filter=`
per binding (AND-composition deferred), and `filter=` is legal only on
**table** sources — a query owns its own WHERE. Column existence is a
startup check, per the error taxonomy.

RESOLVED (`order=` and `limit=` closed forms): `order=".created_at desc"`
— one column reference plus optional `asc`/`desc` (default `asc`), one
column in v0.1; `limit="50"` — integer literal only. Both compose onto
table sources and wrap query sources. Columns are startup-checked. This
closes the Collection Binding section's open attribute-set question
verbatim: that is the exact v0.1 set.

RESOLVED (named queries are declared, read-only sources): in `<data>`:

```xml
<query name="publishedEditions" tables="articles, article_editions" read="public"/>
<query name="publishedByTag" params="tag" tables="articles, article_editions, tags, article_tags" read="public"/>
```

The SQL body lives in `queries/<name>.sql` (out of the XML, by the
standing no-arbitrary-expressions rule): one SELECT statement, `$1..$n`
positional parameters matching the declared `params` list. Startup
validates that the file exists, is a single SELECT, and **executes under
`LIMIT 0`** — proving it runs against the live schema and exposes an
**`id` column**. Queries must be row-addressable because a query is
usable anywhere `table=` is: as a collection source or as a record
context. The deliberate cost, stated: an id-less aggregate query (counts,
stats) is not a v0.1 source. Mount syntax reuses the call grammar —
`source="publishedEditions"` bare, `source="publishedByTag(app.currentTag)"`
parameterized — brace-less, bound at load, arguments are literals or
references exactly like `action=` arguments, arity load-checked against
the declared params. Query sources are **read-only by grammar**: an input
binding (`field=`) or a `conflict=` under a query-sourced context is a
load error; `apskel.data.get` works — the server wraps the query
(`SELECT col FROM (<query>) q WHERE q.id = $n`).

RESOLVED (the query is the permission boundary) — closing the
row-state-conditional DECISION-POINT from design session 2: a query
declares its own `read=`, closed menu `public` | `users` — there is no
`owner` query, because a list is not a row. Running the query is governed
by **that rule alone, regardless of the underlying tables' rules**. That
asymmetry is the entire point: the SQL body *is* the row condition the
per-table rules cannot express, and the author's obligation — stated
here, not hidden — is that the query exposes only what its rule warrants
(`publishedEditions` selects WHERE published, or it is a leak the author
wrote). KF endgame, recorded: `article_editions` eventually flips
private, `/article/:id` becomes a query-sourced record context — that
flip lands in Phase 9 (KF completion), not in the collection
implementation phase.

RESOLVED (`apskel.data.select` and collection freshness): one read
envelope — source (table or query), composed filter/order/limit, params —
allowlisted from the app's own resolved bindings like every wire type,
gated by the table's or the query's read rule, returning `id` plus **only
the columns the template binds**, never `*`. Freshness splits by what is
knowable: **table-sourced** collections maintain membership client-side
from ordinary broadcasts — a changed row is re-evaluated against the
filter locally, which the literal/reference filter semantics make
possible by construction (String-compare needs no server round-trip);
**query-sourced** collections re-fetch when a broadcast names a table in
the query's declared `tables=` list, or when a parameter value changes.
`tables=` is mandatory on `<query>` — an author-declared dependency
list, chosen over SQL introspection as less magical; the failure mode is
stated, not discovered: a wrong list means a stale list until the next
fetch trigger.

RESOLVED (collection sources: what stays out of v0.1): no AND/OR filter
composition, no functions in filters or domains (that DECISION-POINT
stays open), no pagination beyond `limit=`, and **no client-supplied SQL,
ever**. Expositions need nothing new from the framework: the
has-tag/lacks-tag rule builder is app UI writing `exposition_tag_rules`
rows that a named server-defined query consumes.

RESOLVED (row creation and deletion — the minimal Wire surface): the
composer RESOLVED entry ("insertion is not a repetition concern") left
the save action's mechanics open; Phase 8 needs them. Two wire types,
symmetric with the rest of the data surface:

* `apskel.data.insert {table, values}` — table and columns allowlisted to
  the app's own collection-bound tables and bound columns; gated by the
  table's **write rule**. Ownership at birth: when the table has a direct
  FK to `users`, the server stamps it from the authenticated identity —
  the client can never claim ownership (a client-supplied value for that
  column is overwritten, not trusted). A `write="owner"` table with no
  direct users FK rejects inserts at startup validation: the row would be
  born unowned and dead by the unowned-denies floor. (Amended, design
  session 5: ownership at birth may also arrive through the owner walk —
  see RESOLVED (ownership at birth may arrive through the walk); the
  startup rejection narrows to tables whose insertable columns could
  never establish ownership.) The server assigns
  the id (identity/serial column), returns the new row, and broadcasts
  `apskel.data.inserted {table, id, values}` scoped by the read rule.
* `apskel.data.delete {table, id}` — write rule plus the owner walk,
  exactly like a field write; broadcasts `apskel.data.deleted` scoped by
  the read rule.

The composer itself is ordinary, per the existing entry: local scratch
fields plus a button whose action is the framework function
`apskel.data.create("messages", "body", draft)` — first argument the
table (string literal), then alternating column-literal / value-reference
pairs, arity and column names load-validated. Its deletion counterpart is
`apskel.data.remove("messages", .id)` — the id argument is an ordinary
reference, read at press time like any action argument. Both clear
nothing and prompt nothing in v0.x; the row appears/disappears through
the same broadcast path as anyone else's insert or delete.

**Phase 9 (Knowledge Foyer completion) — design session 5.** The audit
result first: publish, comments, tags, and the landing page compose from
machinery Phases 7–8 already built. Five entries add the genuinely
missing pieces; the sixth records the KF v1.0 shape those pieces serve,
so the app and this doc cannot drift apart.

RESOLVED (publish is a status write): the explicit-publish workflow needs
no new framework surface. *Publish* is `apskel.field.set` on the
edition's bound `.status` field — an ordinary guarded write through the
existing Wire, subject to the same write rule and owner walk as any
other field. *Start the next edition* is
`apskel.data.create("article_editions", "article_id", .article_id, ...)`
— the Phase 8 composer action, copying forward whatever columns the
action's pairs name. Consequence, stated honestly: the earlier promise
that `save=` "lands with the explicit-publish workflow" does not come
due — publish turned out to be a status transition, not a deferred save,
so `save=` still has no consumer and stays deferred rather than shipping
unexercised. The original entry is amended in place with a pointer here;
the promise stays on record.

RESOLVED (published editions are immutable at the schema): "nobody edits
a published edition, owner included" is a row-state *write* condition —
the write-side twin of the row-state read problem, but with no query to
route it through. The v0.x answer: immutability lives in the app's own
`schema.sql` as a trigger (integrity constraints are the app's SQL,
exactly like its FKs) — a published row rejects UPDATE and DELETE, and
publishing itself is an UPDATE on a still-draft row, so the one-way door
is the trigger's WHEN clause, not framework logic. The framework's whole
contribution is a courtesy already owed: `apskel.data.set` and
`apskel.data.delete` catch database rejections and answer a coherent 400
carrying the database's message, exactly as `apskel.data.insert` already
does — never a 500, never a crash. Row-state-conditional *write rules*
as framework grammar are a recorded DECISION-POINT below, not built;
corrections to published work happen in the next edition, which is the
Knowledge Foyer's editorial model anyway.

DECISION-POINT (row-state-conditional write rules — recorded, not
resolved): whether the graph grammar ever grows a way to say "writable
while draft" directly, or whether schema triggers remain the permanent
answer for row-state write conditions the way named queries are for
row-state reads.

RESOLVED (identity-bound query parameters): a "my drafts" query with a
client-sent user-id parameter is spoofable — any authenticated user
could pass another's id, and the query's own read rule would happily
comply. So: a query may declare the reserved parameter **`@user`** in
its `params=` list; its positional slot is filled server-side from the
verified token's user id, never from the wire — a call site neither
passes it nor can (the call-grammar arity check counts only the
non-`@` params). A query declaring `@user` requires identity regardless
of its `read=` rule — an anonymous call is 401 — and declaring it in an
app that never calls `apskel.auth.*` is a load error, XML-knowable per
the error taxonomy. `@user` is also the only listable form an
`owner`-read table gets: there is no `owner` query rule because a list
is not a row, but a `users`-read query WHERE-clamped to `@user` is
exactly "my rows", unspoofably. No other `@` names exist; any other
`@`-prefixed param is a load error naming the declaration.

RESOLVED (`apskel.field.set` takes pairs): clicking an article on the
landing page must set two fields in one action — `app.view` and
`app.currentEditionId` — and one button has one action. `field.set`
extends from one (target, value) pair to any number:
`apskel.field.set(app.view, "article", app.currentEditionId, .id)`.
Even arity is load-checked; every odd-position argument must be a
write-target reference (a literal there is a load error naming the
site); all assignments apply before one cascade settles, origin `user`.
The state→URL reverse match then makes the URL follow for free —
multi-assignment is precisely how a row click becomes a deep link
without a second navigation system. `app.identity.*` stays off-limits
as a target.

RESOLVED (create actions declare insert targets): Phase 8 allowlisted
`apskel.data.insert` to collection-bound tables — but a pro/con mark is
written yet never *listed* raw (its consumers are aggregate queries), so
`comment_marks` would be insertable nowhere. The principled fix widens
nothing: the insert allowlist derives from the app's own resolved
bindings, and a load-resolved `apskel.data.create` action **is** such a
binding — its string-literal table joins the insert-allowlisted tables
and its string-literal columns join that table's column allowlist, at
load, from the XML alone. Startup validation extends to these tables
exactly as to collection-bound ones: named columns must exist against
the live schema, ownership stamps resolve from the users-FK
introspection, and `write="owner"` with no direct users FK is the same
born-unowned-and-dead startup error. Nothing becomes insertable that the
app's own XML does not name.

RESOLVED (ownership at birth may arrive through the walk) — amending the
session-4 row-creation entry, whose direct-FK-only rule the next-edition
composer broke on contact: `article_editions` is `write="owner"` with no
direct users FK, yet an edition born with `article_id` set IS owned —
through the walk. So, for a `write="owner"` insert into a table with no
direct users FK: the insert must carry the owner walk's first hop column
among its values, and the server walks the REFERENCED parent row's
ownership before inserting — you may only give birth into rows you
already own (403 otherwise; a missing or unowned parent denies, the
unowned-denies floor at birth). The direct-FK stamp remains the rule
when it exists. The startup check refines accordingly: born-unowned-
and-dead now rejects a `write="owner"` insert target only when its
insertable columns could never establish ownership — no direct users FK
to stamp AND the walk's first hop column absent from the table's
insert-allowlisted columns. (The session-4 entry is amended in place
with a pointer here.)

RESOLVED (the KF v1.0 shape): the target the entries above serve.

* Schema: `article_editions` gains `status` (`draft` | `published`,
  default `draft`) and `published_at`; `comments (id, edition_id FK,
  created_by FK users, body, created_at)`; `comment_marks (id,
  comment_id FK, user_id FK users, kind, UNIQUE (comment_id, user_id))`
  — a surrogate id rather than the composite PK, because rows are
  id-addressable by framework contract (insert RETURNING id, broadcasts
  carry id); the UNIQUE constraint is what makes marks insert-once;
  `expositions` and `exposition_tag_rules` per the sketch. The
  immutability trigger on published editions lives here.
* The read flip, cashing the promise in RESOLVED (the query is the
  permission boundary): `article_editions` goes `read="owner"` — drafts
  genuinely private at last — with public reading only through
  `read="public"` queries: `publishedArticles` for the landing list and
  the query-sourced record context behind `/article/:id`. The drafts
  list becomes a `myDrafts` query declaring `@user`. `comments` are
  `read="public" write="owner"`; `comment_marks` `write="owner"` (the
  stamp makes the inserter the owner at birth).
* Comments in the UI are a **flat, filtered collection**
  (`table="comments" filter=".edition_id: app.currentEditionId"`) — the
  Phase 8 dynamic filter, not a nested instantiation; nested
  instantiation stays honestly deferred rather than half-shipping inside
  this phase. Pro/con tallies come from a query-sourced collection whose
  `tables=` names `comment_marks`, so a mark broadcast re-fetches the
  list and the counts move live.
* Marks are **insert-once** in v0.x: the composite primary key makes a
  second mark by the same user a database rejection, answered 400 and
  logged client-side, not prompted. *Changing* a mark needs upsert
  semantics this doc has not designed — recorded here, not smuggled in.
* Expositions, concretely (cashing the session-4 promise that they need
  nothing new): an `/exposition/:id` route; an `expositionArticles`
  query whose SQL does the has-tag/lacks-tag EXISTS work; and a rules
  editor that is an ordinary collection over `exposition_tag_rules`
  with a composer — insertable via the create-action entry above.

**Phase 10.1 (primitive-set completion) — design session 6.** Phase 10's
opening slice: the two primitives the v0.1 set has owed since the set
was declared — `select` and `rich-text` — plus the DECISION-POINTs that
gated them, each resolved in place at its own section (the rich-text
representation under the GUI Compatibility Principle; the MCP façade's
ship-or-defer under the MCP surface section). The offline queue and the
`detect` prompting UI remain design session 7; nothing here touches
them.

RESOLVED (a select is a domain-bearing column reference): `select` is
the single-value counterpart of `multi-select`, and its option list
comes from where every option list comes from — the domain on its field
reference, never a bespoke attribute. Two domain forms, closed:

* **Literal domain** — `field="ruleKind: has, lacks"` on a local, or
  `field=".status: draft, published"` on a bound column: the value list
  is load-knowable, so the options bake into the bundle as static
  (value, label) pairs — no fetch, no allowlist entry, works in
  tokenless and even serverless (Phase 3 static) apps. Literal parsing
  follows the domain grammar everywhere else: bare words are strings;
  quoted strings, numbers, and booleans parse as themselves; the label
  is the value's string form.
* **Table-item domain** — `field=".tag_id: tags.id->tags.name"` on a
  bound column, and equally legal on a local
  (`field="ruleTag: tags.id->tags.name"` — a composer picks a row, a
  create action reads the picked key): the arrow item creates a
  load-time options-allowlist entry, and the option list is runtime
  state at the widget's own `<path>.options` — fetched through
  `apskel.data.options`, delivered via applyServerWrite, refetched on
  login and on the enclosing selection change; RESOLVED (options are
  runtime state at the widget's own path) verbatim, now with two
  consumers. The stored value is the arrow's left column: single,
  scalar, exactly what `apskel.data.set` or a create action already
  carries.

Validation, all load errors naming the site: a `select` whose field
carries no domain (a select with nothing to list is meaningless); a
mixed literal-plus-arrow domain (the widget-inference sketch's "combo
input" — deferred, not half-shipped); more than one arrow item; an
arrow whose two sides name different tables; and a `select` whose field
resolves to a graph **edge** — an edge is multi-valued by declaration
and `multi-select` is its widget; the error says so. Startup checks,
per the error taxonomy: an arrow domain's table and columns must exist
against the live schema — a LIMIT-0 probe naming the site on failure,
exactly like queries. The options *read* door is unchanged: the options
table's own read rule governs, 401/403/empty-plus-warning exactly as
for multi-select. Widget inference stays unimplemented: `type=` remains
explicit everywhere, and the inference table remains a sketch.

RESOLVED (rich-text primitive; mode is load-checked): one primitive,
one field, and a closed `mode=` menu — `edit` (the default): a source
textarea, a write-through valve exactly like `text-area`; `view`: the
rendered content nodes, read-only; `split`: both, the preview
repainting per keystroke through the ordinary store loop (input →
store → write push) — no second data path, and the loop's synchronous
cascade is what makes the preview live. The value is the markup source
string in every mode: the edit surface edits the source itself, so
round-tripping is exact by construction and the same-value guard, echo
suppression, and conflict machinery hold without caveats. (A WYSIWYG
surface regenerating markup from the DOM could not promise that;
toolbars and WYSIWYG are recorded as deferred, not designed.) An
unknown mode is a load error naming the site, and the menu lives in
the primitive's manifest — the loader enforces it; primitives stay
stateless and validate nothing. Mode also settles inputness at load: a
`view` mount is a display, not an input, so it is legal under a
query-sourced record context — that is how the Knowledge Foyer reader
renders a published body — while `edit`/`split` mounts remain inputs
and stay illegal there, per RESOLVED (named queries are declared,
read-only sources).

---

# Future Non-Web GUI Renderers

Apskel-NP is initially a web/PWA framework. However, the design should leave room for future non-web GUI versions of applications.

The long-term possibility is that the same app specification could support multiple renderers:

```text
web/PWA renderer
native desktop GUI renderer
mobile-native renderer
terminal/TUI renderer
```

This should not be built in v0.1, but the design should avoid making it impossible.

---

## Renderer-Neutral Concepts

The following concepts should remain renderer-neutral where possible:

* components
* component types
* component instances
* field bindings
* local state
* app-global state
* data graphs
* watchers
* Wire messages
* path references
* permissions
* validation
* synchronization
* AI-addressable operations

These concepts should not depend directly on the browser DOM.

---

## Renderer-Specific Implementations

Each renderer may implement component types differently.

Example:

```text
layout component
    web renderer: div/flexbox
    desktop renderer: native container/widget
    TUI renderer: terminal panel

text-editor component
    web renderer: contenteditable or textarea
    desktop renderer: native rich text control
    TUI renderer: text buffer/editor
```

This suggests that component types should eventually support renderer-specific implementations.

Possible future component folder structure:

```text
/components
    /layout
        manifest.json
        /web
            client.js
            style.css
        /desktop
            client.js
        /tui
            client.js
```

DECISION-POINT: Decide whether the current component folder structure should anticipate renderer-specific subfolders now, or keep the v0.1 folder structure simpler.

DECISION-POINT: Decide whether the core runtime should be split into renderer-neutral and web-specific layers from the beginning.

---

## GUI Compatibility Principle

Apskel-NP should avoid putting raw HTML assumptions into the semantic app model.

The XML specification may look HTML-like, but its meaning should be:

```text
application structure
component hierarchy
field binding
behavior declaration
```

not:

```text
final DOM structure
```

The web renderer can translate components into DOM elements, but future renderers should be able to translate the same component tree into other interface systems.

RESOLVED (rich text is stored markup, rendered to content nodes, never
HTML) — design session 6, closing the two DECISION-POINTs that stood
here. A rich-text field's stored value is a **plain string of
lightweight markup** — a closed, tight subset of familiar markdown:
paragraphs separated by blank lines; `#`/`##`/`###` headings (a heading
is a block of its own); `- ` unordered and `1. ` ordered list lines;
`> ` quote lines; and inline `**bold**`, `*italic*`, `` `code` ``,
`[text](url)`. The renderer parses that string into **renderer-neutral
content nodes** (a small tree of heading/paragraph/list/quote/text/
bold/italic/code/link/break nodes — `runtime/markup.js`, dependency-
free) and each renderer realizes those nodes natively: the web
primitive via `createElement`/`createTextNode`, a future TUI however it
likes. What this buys, in order of importance:

* **The pipeline below the widget does not know rich text exists.** The
  stored value is a string, so store equality, autosave, revision
  bookkeeping, conflict detection, echo suppression, and every Wire
  message treat a rich-text field exactly as a text field — nothing
  grows a special case.
* **Raw HTML never exists as data.** The parser has no HTML
  pass-through (`<` is an ordinary character), the web realizer never
  touches `innerHTML`, and link hrefs pass a scheme allowlist (http,
  https, mailto, and scheme-less relative paths) — a `javascript:` link
  renders as plain text. Injection is impossible by construction, with
  zero sanitizer dependencies.
* **This principle's own question answers itself**: app XML carries no
  HTML-like content. Structure is components; rich content is field
  *values*; and the content-node tree is a rendering artifact that is
  never stored and never crosses the Wire.

Everything outside the subset is literal text — no extension points, no
raw blocks, no escape hatch. Growing the subset is a design-doc change,
not a parser patch.

---

# Roadmap Applications and Design Pressure Tests

Apskel-NP is intended to support many future applications. The first two planned applications are Knowledge Foyer and WorkSplicer. These applications are not merely examples; they are design pressure tests that help clarify what the framework must support without forcing the framework to become domain-specific.

---

## Knowledge Foyer

Knowledge Foyer is the first planned application.

### Purpose

Knowledge Foyer is a concept-development and article-drafting platform.

Users draft articles through successive editions. Between editions, they receive curated feedback. Once an article is published, registered users may add comments and mark comments as either pro or con.

In this context:

* pro means the comment identifies something the article does well
* con means the comment identifies how the article or concept could be improved

The goal is not merely article publication. The deeper goal is to develop the concepts covered by the articles.

---

### User Roles

## Public Users

Public users may:

* view published articles
* view expositions
* view public comments and feedback
* register for an account

Public users may not:

* write articles
* comment
* mark comments pro/con
* create expositions

## Registered Users

Registered users may:

* draft articles
* maintain a private work area
* publish new article editions
* review feedback
* add comments
* mark comments pro/con
* create expositions

---

### Core Concepts

## Article

An article represents an ongoing conceptual work.

## Article Edition

An edition represents a specific version of an article.

Comments should generally attach to article editions rather than only to articles, because feedback on one edition may no longer apply to a later edition.

## Comment

A comment provides feedback on an article edition.

## Comment Mark

A comment mark records whether a user views a comment as pro or con.

## Tag

Tags identify the concepts and topics an article relates to.

## Exposition

An exposition is a public-facing page based on a tag query.

An exposition may include rules such as:

* has this tag
* does not have this tag
* includes articles related to these concepts
* excludes articles related to those concepts

An exposition has its own page and description.

---

### Likely Data Model

Knowledge Foyer may require tables such as:

```text
users
articles
article_editions
comments
comment_marks
tags
article_tags
expositions
exposition_tag_rules
```

---

### Apskel-NP Features Tested by Knowledge Foyer

Knowledge Foyer tests the early framework features:

* login/register components
* text-editor component
* article draft/edit/publish workflow
* tags and tag-based filtering
* public and private views
* comments
* pro/con comment marking
* exposition pages
* database-bound fields
* simple dynamic lists
* basic REST/SSE synchronization
* AI-assisted editing potential

---

### Mini Design Sketch

```xml
<app title="Knowledge Foyer" version="1.0" copyright="2026 By Matthew Tedder">

    <client style="knowledge.css" functions="knowledge-client.js" orient="vertical">

        <headerBar type="layout" orient="horizontal" space="between">
            Knowledge Foyer
            <loginPanel type="login"/>
            <registerPanel type="register"/>
        </headerBar>

        <workspace type="layout" orient="horizontal">

            <articleList type="layout" table="articles" orient="vertical">
                Search: {search}
                Article: {.title}
            </articleList>

            <articleEditor type="text-editor" table="article_editions" record="app.currentEditionId">
                Title: {.title}
                Body: {.body}
                Tags: {.tags: tags.id->tags.name}
                <publish type="button" action='apskel.field.set(.status, "published")'>Publish</publish>
            </articleEditor>

            <feedbackPanel type="layout" orient="vertical"
                           table="comments" filter=".edition_id: app.currentEditionId">
                <row type="layout" orient="horizontal">
                    {.body}
                    <pro type="button" action='apskel.data.create("comment_marks", "comment_id", .id, "kind", "pro")'>pro</pro>
                    <con type="button" action='apskel.data.create("comment_marks", "comment_id", .id, "kind", "con")'>con</con>
                </row>
            </feedbackPanel>

        </workspace>

        <expositionView type="layout" table="expositions" record="app.currentExpositionId" orient="vertical">
            Title: {.title}
            Description: {.description}
            <articles type="layout" source="expositionArticles(app.currentExpositionId)" orient="vertical">
                {.title}
            </articles>
        </expositionView>

    </client>

    <data source="postgres" schema="knowledge.sql">
        <graph name="knowledge">
            <users>
                <articles>
                    <article_editions read="owner" write="owner"/>
                    <tags read="public" write="none"/>
                </articles>
                <!-- comments and marks are owned by their AUTHOR (the
                     direct users FK the insert stamps) — a comment by
                     its commenter, a mark by its marker — so each hangs
                     off users directly and the owner walk is one hop.
                     Rules ride their exposition's owner, so they nest. -->
                <comments read="public" write="owner"/>
                <comment_marks read="public" write="owner"/>
                <expositions read="public" write="owner">
                    <exposition_tag_rules read="public" write="owner"/>
                </expositions>
            </users>
        </graph>
    </data>

</app>
```

---

## WorkSplicer

WorkSplicer is the second planned application.

### Purpose

WorkSplicer is a work orchestration platform.

It is designed to help users manage tasks, coordinate work, communicate with others, and use specialized task-related assets. Over time, it can become a platform for vertical work systems such as loan origination, case management, review workflows, and other specialized operational processes.

---

### Home View

A user has a home screen that provides:

* useful header
* current time/calendar information
* user status information
* color-coded next-due task bar
* task list
* task content area
* asset list
* selected asset workspace

---

### User Status

The user status area shows current availability or status.

Clicking the status allows the user to:

* change status
* add a note
* add a return time or expiration time

Example:

```text
Out to lunch, back at 1 PM
```

---

### Task Urgency Bar

The task urgency bar is color coded.

Example colors:

```text
red = late
yellow/orange = little time left
yellow = time somewhat short
green = lots of time left
```

Clicking the urgency bar opens a right-side task list.

The task list shows:

* task number
* task label
* due date
* due time if due today
* urgency color

Clicking a task opens it in the main content area and loads its related assets.

---

### Assets

Assets are specialized components for work.

A task has many asset instances. Each asset instance is created from an asset type.

This is the core platform idea of WorkSplicer.

```text
Task
    Asset Instance
        Asset Type
```

Asset types can be expanded over time.

---

### Mandatory Asset Types

Every task should include at least two asset instances.

## Instructions Asset

The instructions asset explains how to complete the task.

It may include:

* task instructions
* ordered steps
* checkboxes
* completion status
* button to mark the task complete

This asset is mandatory for every task.

## Communicator Asset

The communicator asset supports communication with others.

It may support:

* chat
* email
* voice
* video

By default, the communicator shows designated people related to the task, while still allowing access to other users.

This asset is mandatory for every task.

---

### Future Asset Types

Possible future assets include:

* text file editor
* database form
* document viewer
* approval chain
* checklist
* calendar scheduler
* loan origination form
* case review panel
* customer profile
* compliance checklist

Vertical applications can be built by adding specialized asset types.

---

### Likely Data Model

WorkSplicer may require tables such as:

```text
users
user_statuses
tasks
task_assignments
asset_types
asset_instances
asset_instance_data
instructions
instruction_steps
communications
communication_participants
messages
```

---

### Apskel-NP Features Tested by WorkSplicer

WorkSplicer tests later and more advanced framework features:

* dynamic component loading
* asset type registry
* asset instances
* task context propagation
* shared app state
* user presence/status
* urgency calculation
* real-time task updates
* communication components
* component-to-component events
* richer MCP use
* AI-assisted task execution
* vertical application extensibility

---

### Mini Design Sketch

```xml
<app title="WorkSplicer" version="1.0" copyright="2026 By Matthew Tedder">

    <client style="worksplicer.css" functions="worksplicer-client.js" orient="vertical">

        <home type="layout" orient="vertical">

            <topbar type="layout" orient="horizontal" space="between">
                <clock type="date-picker" include="date,time"/>
                <userStatus type="user-status" table="user_statuses"/>
                <taskUrgencyBar type="task-urgency-bar" source="app.user.tasks"/>
            </topbar>

            <mainArea type="layout" orient="horizontal">

                <assetList type="asset-list" task="app.selectedTask"/>

                <assetWorkspace type="dynamic-asset-viewer" asset="app.selectedAsset"/>

                <taskList type="task-list"
                          source="app.user.tasks"
                          visible="{app.taskListOpen}"/>

            </mainArea>

        </home>

    </client>

    <data source="postgres" schema="worksplicer.sql">
        <graph name="work">
            <users>
                <user_statuses/>
                <task_assignments>
                    <tasks>
                        <asset_instances>
                            <asset_types/>
                            <asset_instance_data/>
                        </asset_instances>
                        <instructions>
                            <instruction_steps/>
                        </instructions>
                        <communications>
                            <communication_participants/>
                            <messages/>
                        </communications>
                    </tasks>
                </task_assignments>
            </users>
        </graph>
    </data>

</app>
```

---

## Implications for Apskel-NP

The roadmap applications imply that Apskel-NP must support a small but carefully chosen core.

The core should provide:

* component types
* component instances
* component registry
* data graphs
* path resolution
* field binding
* local state
* app-global state
* watcher declarations
* simple function calls
* REST transport (Wire)
* SSE synchronization (Wire)
* MCP façade for AI access
* authentication hooks
* client synchronization
* extensible client/server functions
* AI-addressable UI operations

The core should not become domain-specific.

Knowledge Foyer should not force publishing concepts into the framework.

WorkSplicer should not force task concepts into the framework.

Instead, both applications should be built from general framework concepts:

```text
components
bindings
data graphs
paths
watchers
functions
Wire messages
synchronized state
```

---

## Future Applications

Apskel-NP should assume that many additional applications may be built later.

Therefore, design decisions should favor:

* reusable primitives
* app-defined component types
* app-defined data graphs
* app-defined Wire message types
* app-defined functions
* simple and stable core semantics
* extensible component registries

The framework should be powerful enough to support future applications without requiring every future feature to be known in advance.

---

# Philosophy

Apskel-NP aims to:

* keep the framework small
* keep applications declarative
* minimize repetitive code
* make application structure visible
* centralize application definition
* make interfaces machine-understandable
* preserve developer readability

The framework should feel more like describing an application than programming one.
