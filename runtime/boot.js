// runtime/boot.js — browser entry (loaded by the index.html shell).
//
// Fetches the server-resolved app bundle, builds the store and watcher
// engine (the same modules Node runs — served unmodified), seeds declared
// locals silently, mounts the tree, and exposes the debug handle:
//
//   window.__apskel = { store, engine, root, byPath, fireCounts, ... }
//
// State inspection goes through this handle — no primitive holds a value.
//
// Phase 5: device credential in localStorage, silent token re-mint before
// mount, framework functions for button actions, Bearer token on sends.
// Phase 7.1: the router applies the initial URL silently before mount
// (route state is initial state), record contexts fetch their selected
// rows, and nav.go/field.set drive the two directions of URL<->state sync.

import { createStore } from "/runtime/store.js";
import { WatcherEngine } from "/runtime/watchers.js";
import { hydrateApp, findByPath } from "/runtime/serialize.js";
import { mountApp } from "/runtime/binder.js";

const bundle = await (await fetch("/app.json")).json();
const root = hydrateApp(bundle.tree);

const store = createStore();
const engine = new WatcherEngine(store);
store.seedDeclaredLocals(root); // silent, before any watcher runs

// Bound-field values fetched from the database at page load: initial
// state, not changes — seeded silently, same rationale as declared locals.
// (Dynamic-record contexts are absent here; they fetch once the router
// has seeded the selection.)
if (bundle.initialData) {
  for (const [storePath, value] of Object.entries(bundle.initialData)) {
    store.seed(storePath, value);
  }
}

// --- router (before mount: the initial URL is initial state) ---------------

let router = null;
if (bundle.routes?.length) {
  const { createRouter } = await import("/runtime/router.js");
  router = createRouter({ routes: bundle.routes, store, location, history });
  router.apply(location.pathname, { silent: true });
}

// --- identity (before mount, so actions and the first paint see it) --------

let token = null;
let functions = {};
let credentials = null;
let recordContexts = null; // assigned below; onToken refetches through it
let collectionSync = null; // assigned below; onToken can unlock lists
let reconnectEvents = () => {}; // assigned below; onToken re-identifies the SSE feed
let refetchOptions = () => {}; // assigned below; onToken can unlock option lists

const postWire = (envelope) =>
  fetch(bundle.wire?.endpoint ?? "/wire", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(envelope),
  });

const call = async (envelope) => (await postWire(envelope)).json();

if (bundle.auth) {
  const { createFrameworkFunctions, applyIdentity } = await import(
    "/runtime/frameworkFunctions.js"
  );

  credentials = () => {
    let cred = JSON.parse(localStorage.getItem("apskel.device") ?? "null");
    if (!cred) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      cred = {
        deviceId: crypto.randomUUID(),
        deviceSecret: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""),
      };
      localStorage.setItem("apskel.device", JSON.stringify(cred));
    }
    return cred;
  };

  const onToken = (t) => {
    token = t;
    // A fresh login can unlock rows the anonymous boot could not read —
    // and the SSE connection's identity is stamped at connect, so it must
    // reconnect to start receiving users/owner-scoped broadcasts.
    recordContexts?.refetchAll();
    collectionSync?.refetchAll();
    reconnectEvents();
    refetchOptions();
  };

  functions = createFrameworkFunctions({ call, store, credentials, onToken });

  // Anonymous until proven otherwise — seeded silently (initial state).
  store.seed("app.identity.status", "anonymous");
  store.seed("app.identity.error", "");

  // Silent re-mint: if this device is already linked to a user, the durable
  // credential identifies us without a password. Failure stays quiet.
  try {
    const minted = await call({ type: "apskel.auth.token", ...credentials() });
    if (minted?.ok) applyIdentity(store, minted, (t) => (token = t));
  } catch {
    /* offline or no server auth — stay anonymous */
  }
}

if (router) {
  functions["apskel.nav.go"] = (path) => router.navigate(path);
}

// --- mount -------------------------------------------------------------------

const primitives = {};
for (const type of bundle.primitiveTypes) {
  primitives[type] = await import(`/primitives/${type}/client.js`);
}

const { collections: collectionControllers } = mountApp(root, {
  store,
  engine,
  document,
  primitives,
  functions,
  rootEl: document.getElementById("apskel-root"),
});

window.__apskel = {
  store,
  engine,
  root,
  byPath: (p) => findByPath(root, p),
  // Criterion 5's counter: __apskel.fireCounts() — an echoed change (or a
  // record switch's silent re-seed) must leave wire:* counts unchanged.
  fireCounts: () => engine.fireCounts(),
  router,
};

if (bundle.wire) {
  const { attachWireSend, attachWireReceive, attachRecordContexts, attachCollectionSync } =
    await import("/runtime/wireClient.js");
  // Per-tab identity for echo recognition (distinct from the device
  // credential, which identifies the user).
  const clientId = "tab-" + crypto.randomUUID();
  // Revision bookkeeping for conflict=detect contexts — wire state, never
  // a visible field. Seeded from the bundle, updated by every broadcast.
  const revisions = new Map(Object.entries(bundle.revisions ?? {}));
  window.__apskel.revisions = revisions;

  // Record contexts: fetch the selected row now (deep links — the router
  // already seeded the selection; fixed-record contexts of non-public
  // tables ship no initialData and fetch here too), refetch on selection
  // changes and on login. Bundle-seeded fields skip the boot fetch.
  recordContexts = attachRecordContexts({
    engine,
    store,
    bound: bundle.bound,
    setFields: bundle.setFields ?? [],
    revisions,
    call,
    skipInitial: new Set(Object.keys(bundle.initialData ?? {})),
  });

  attachWireSend({
    engine,
    bound: bundle.bound,
    setFields: bundle.setFields ?? [],
    clientId,
    revisions,
    isLoading: recordContexts.isLoading,
    send: async (envelope) => {
      try {
        let r = await postWire(envelope);
        if (r.status === 401 && bundle.auth && credentials) {
          // Token expired mid-session: re-mint once with the device
          // credential and retry the same envelope.
          const minted = await call({ type: "apskel.auth.token", ...credentials() });
          if (minted?.ok) {
            token = minted.token;
            r = await postWire(envelope);
          }
        }
        if (r.status === 403) {
          // Forbidden by a permission rule: the server enforces, the
          // client honors — a warning, never a retry (unlike 401's
          // silent re-mint above).
          const body = await r.json().catch(() => null);
          console.warn("[apskel] write forbidden:", body?.error ?? r.status, envelope);
          return;
        }
        if (r.status === 409) {
          // Revision mismatch (conflict=detect): v0.1 logs, no prompt.
          // Adopt the server's revision so the next write recovers.
          const body = await r.json().catch(() => null);
          if (typeof body?.currentRevision === "number") {
            revisions.set(`${envelope.table}:${envelope.id}`, body.currentRevision);
          }
          console.warn("[apskel] write conflicted (revision mismatch):", envelope, body);
          return;
        }
        if (!r.ok) console.error("[apskel] wire send rejected:", r.status);
      } catch (e) {
        console.error("[apskel] wire send failed:", e);
      }
    },
  });
  const handleEvent = attachWireReceive({
    store,
    bound: bundle.bound,
    setFields: bundle.setFields ?? [],
    clientId,
    revisions,
  });

  // Collections: initial select per collection, instances driven through
  // the binder's controllers, membership maintained from broadcasts.
  collectionSync = attachCollectionSync({
    engine,
    store,
    collections: bundle.collections ?? [],
    queries: bundle.queries ?? [],
    controllers: collectionControllers,
    call,
  });

  // The composer's framework functions, per RESOLVED (row creation and
  // deletion): create posts the whole values object, remove deletes by
  // id; the row appears/disappears through the broadcast path like
  // anyone else's.
  functions["apskel.data.create"] = async (table, ...pairs) => {
    const values = {};
    for (let i = 0; i + 1 < pairs.length; i += 2) values[pairs[i]] = pairs[i + 1];
    const resp = await call({ type: "apskel.data.insert", table, values, sourceClient: clientId });
    if (!resp?.ok) console.warn("[apskel] insert rejected:", resp?.error);
  };
  functions["apskel.data.remove"] = async (table, id) => {
    const resp = await call({ type: "apskel.data.delete", table, id, sourceClient: clientId });
    if (!resp?.ok) console.warn("[apskel] delete rejected:", resp?.error);
  };

  // Option lists for edge-bound widgets: fetched at mount into the
  // widget's OWN options path via the server-origin door, refetched on
  // login (a token can unlock a users-read options table) and on
  // selection change for dynamic contexts. Failure = empty options +
  // warning, no retry — per RESOLVED (options are runtime state at the
  // widget's own path).
  {
    const setByStore = new Map((bundle.setFields ?? []).map((s) => [s.storePath, s]));
    const optionWidgets = [];
    (function walk(n) {
      if (n.optionsPath && setByStore.has(n.fieldPath)) {
        optionWidgets.push({ s: setByStore.get(n.fieldPath), optionsPath: n.optionsPath });
      }
      for (const child of n.children) walk(child);
    })(root);
    const fetchOne = async ({ s, optionsPath }) => {
      try {
        const resp = await call({ type: "apskel.data.options", ...s.options });
        if (resp?.ok) {
          store.applyServerWrite(optionsPath, resp.options);
        } else {
          store.applyServerWrite(optionsPath, []);
          console.warn(`[apskel] options for ${s.storePath} unavailable:`, resp?.error);
        }
      } catch (e) {
        store.applyServerWrite(optionsPath, []);
        console.warn(`[apskel] options fetch for ${s.storePath} failed:`, e);
      }
    };
    refetchOptions = () => optionWidgets.forEach(fetchOne);
    for (const w of optionWidgets) {
      fetchOne(w);
      if (w.s.recordPath) {
        engine.watch({
          name: `options-refetch:${w.optionsPath}`,
          fields: [w.s.recordPath],
          run: () => fetchOne(w),
        });
      }
    }
  }
  // EventSource cannot set headers: the token rides the query string, and
  // the connection's identity is fixed at connect — so a token change
  // (login) reconnects, per RESOLVED (broadcasts obey read rules).
  let events = null;
  reconnectEvents = () => {
    events?.close();
    const url = bundle.wire.events + (token ? `?token=${encodeURIComponent(token)}` : "");
    events = new EventSource(url);
    events.onmessage = (e) => {
      const envelope = JSON.parse(e.data);
      handleEvent(envelope);
      collectionSync?.handleEvent(envelope);
    };
  };
  reconnectEvents();
  window.__apskel.clientId = clientId;
}

// --- URL <-> state sync (after mount; seeds never fire watchers) -----------

if (router) {
  engine.watch({
    name: "router:sync-url",
    fields: router.targets,
    run: () => router.syncUrl(),
  });
  window.addEventListener("popstate", () => router.apply(location.pathname));
}

if (bundle.clientFunctions) {
  const appModule = await import(`/app/${bundle.clientFunctions}`);
  appModule.setup?.(window.__apskel);
}
