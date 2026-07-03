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

Collection bindings should admit declarative `order=`, and probably `filter=`
and `limit=`, attributes (a forum wants newest-first and pagination; better as
declared attributes than as function-call escape hatches).

DECISION-POINT: fix the exact v0.1 attribute set and syntax for `order=` /
`filter=` / `limit=` on collection bindings.

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

| Domain          | Widget               |
| --------------- | -------------------- |
| none            | text input           |
| two values      | toggle               |
| multiple values | dropdown/select      |
| regex           | validated text input |
| table values    | dynamic select       |
| mixed           | combo input          |

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

DECISION-POINT: Decide whether the MCP façade ships in v0.1 or is deferred. If
deferred, the only firm rule for v0.1 is: do not name the internal Wire "MCP,"
so the MCP namespace stays free for the façade later.

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

DECISION-POINT (record selection / single-record context): the doc binds
`articleEditor` to `table="article_editions"` but never says **which row**.
A component bound to a single record needs its row chosen somehow. Sketched
default: a `record=` attribute whose value is a reference to a key —
`record="{app.currentEditionId}"` — with selection itself being ordinary
app-global state that a list row's action sets. (The WorkSplicer sketch
already leans on this shape with `app.selectedTask`.) Changing the selection
re-instantiates the component's data context via the same dynamic-insertion
path as everything else.

DECISION-POINT (views, navigation, and routing): the doc has no concept of
pages. KF needs a landing view, an editor view, article pages, and exposition
pages — and the last two need **shareable public URLs**, which matters
enormously for a publishing platform. Sketched default: `visible=` bindings
handle intra-app view switching (already sketched in WorkSplicer:
`visible="{app.taskListOpen}"`); a small `<routes>` declaration maps URL
patterns to app-state assignments (`/article/:id` → sets
`app.currentArticleId`, shows the article view) so routing is *state
synchronization with the URL bar*, not a second navigation system.

DECISION-POINT (permissions/authorization): "permissions/auth context" is
listed as something components can access, and the offline section explicitly
separates access control from conflict policy — but the access-control axis
itself is undefined. KF needs: public may read published, only the author may
write their article, only registered users may comment. Enforcement must be
**server-side on Wire writes** (the client honors it; the server enforces
it). Sketched default: declarative per-table/per-context rules in the `<data>`
section (`read="public"`, `write="owner"`), with `owner` derived from the
graph edge to `users` and the device-authenticated identity.

DECISION-POINT (multi-value fields / many-to-many): an article's tag *set* is
a join-table relationship, but the field/domain system is single-value. The
sketch `{.tags: tags.name}` implies a multi-select whose writes are inserts
and deletes on `article_tags`. Sketched default: a domain-bearing field whose
bound target is a declared graph edge (rather than a column) is multi-valued;
the widget is a multi-select/chips input; the runtime translates set
membership changes into join-table inserts/deletes over the Wire.

DECISION-POINT (collection sources beyond a table and filtering): the landing
page needs "all *published* articles" (a filtered table, making `filter=`
load-bearing rather than deferrable), and expositions need rule-based queries
(has tag / lacks tag) that exceed any inline filter syntax. Sketched default:
`filter=` handles simple declarative predicates; anything richer is a **named
server-defined query** declared in `<data>` and usable as a collection source
(`source="publishedByTag"` with parameters) — keeping complex SQL on the
server and out of the XML, consistent with the no-arbitrary-expressions rule.

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

DECISION-POINT: Decide how much HTML-like content should be allowed inside app XML if long-term GUI portability matters.

DECISION-POINT: Decide whether rich text/static markup should be represented as raw HTML, markdown, or renderer-neutral content nodes.

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

            <articleEditor type="text-editor" table="article_editions">
                Title: {.title}
                Body: {.body}
                Status: {.status: "draft", "published"}
                Tags: {.tags: tags.name}
            </articleEditor>

            <feedbackPanel type="layout" table="comments" orient="vertical">
                Comment: {.body}
                Kind: {.kind: "pro", "con"}
            </feedbackPanel>

        </workspace>

        <expositionView type="layout" table="expositions" orient="vertical">
            Title: {.title}
            Description: {.description}
            Articles: {articlesForExposition(.id)}
        </expositionView>

    </client>

    <data source="postgres" schema="knowledge.sql">
        <graph name="knowledge">
            <users>
                <articles>
                    <article_editions>
                        <comments>
                            <comment_marks/>
                        </comments>
                    </article_editions>
                    <article_tags>
                        <tags/>
                    </article_tags>
                </articles>
                <expositions>
                    <exposition_tag_rules/>
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
