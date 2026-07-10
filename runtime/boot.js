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
    queryBound: bundle.queryBound ?? [],
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
          // Revision mismatch (conflict=detect): detect graduates from
          // log-only to the prompt (Phase 10.2) — the rejected write is
          // captured into the queue with its stale baseRevision, so the
          // resync pull derives it into app.sync.* and the prompt shows.
          const body = await r.json().catch(() => null);
          if (typeof body?.currentRevision === "number") {
            revisions.set(`${envelope.table}:${envelope.id}`, body.currentRevision);
          }
          console.warn("[apskel] write conflicted (revision mismatch):", envelope, body);
          if (sync.capture(envelope)) sync.resync();
          return;
        }
        if (!r.ok) {
          // e.g. a schema trigger's rejection (published editions are
          // immutable) arrives as a 400 carrying the database's message.
          const body = await r.json().catch(() => null);
          console.error("[apskel] wire send rejected:", r.status, body?.error ?? "");
        }
      } catch (e) {
        // Network failure: we are offline. The write queues durably and
        // flushes on reconnect — or is refused per the context's policy.
        if (!sync.capture(envelope)) {
          console.error("[apskel] wire send failed (not queued):", e);
        }
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
    const envelope = { type: "apskel.data.insert", table, values, sourceClient: clientId };
    try {
      const resp = await call(envelope);
      if (!resp?.ok) console.warn("[apskel] insert rejected:", resp?.error);
    } catch {
      // Offline: the insert queues (no optimistic instance in v0.1 — the
      // row appears at reconnect through the broadcast path) and flushes
      // with its idempotency key.
      if (!sync.capture(envelope)) {
        console.warn("[apskel] offline insert refused: no queueable context on", table);
      }
    }
  };
  functions["apskel.data.remove"] = async (table, id) => {
    const resp = await call({ type: "apskel.data.delete", table, id, sourceClient: clientId });
    if (!resp?.ok) console.warn("[apskel] delete rejected:", resp?.error);
  };

  // Option lists for fetched widgets — edge-bound multi-selects and
  // arrow-domain selects: fetched at mount into the widget's OWN options
  // path via the server-origin door, refetched on login (a token can
  // unlock a users-read options table) and on selection change for
  // dynamic contexts. Failure = empty options + warning, no retry — per
  // RESOLVED (options are runtime state at the widget's own path).
  // (Static options — a select's literal domain — ride the bundle and
  // are seeded by the binder; they never appear here.)
  {
    const setByStore = new Map((bundle.setFields ?? []).map((s) => [s.storePath, s]));
    const optionWidgets = [];
    (function walk(n) {
      if (n.optionsPath && n.options) {
        // A select's arrow domain: the descriptor rides the node.
        optionWidgets.push({
          descriptor: n.options,
          optionsPath: n.optionsPath,
          recordPath: n.optionsRecordPath ?? null,
          label: n.fieldPath ?? n.path,
        });
      } else if (n.optionsPath && setByStore.has(n.fieldPath)) {
        const s = setByStore.get(n.fieldPath);
        optionWidgets.push({
          descriptor: s.options,
          optionsPath: n.optionsPath,
          recordPath: s.recordPath ?? null,
          label: s.storePath,
        });
      }
      for (const child of n.children) walk(child);
    })(root);
    const fetchOne = async ({ descriptor, optionsPath, label }) => {
      try {
        const resp = await call({ type: "apskel.data.options", ...descriptor });
        if (resp?.ok) {
          store.applyServerWrite(optionsPath, resp.options);
        } else {
          store.applyServerWrite(optionsPath, []);
          console.warn(`[apskel] options for ${label} unavailable:`, resp?.error);
        }
      } catch (e) {
        store.applyServerWrite(optionsPath, []);
        console.warn(`[apskel] options fetch for ${label} failed:`, e);
      }
    };
    refetchOptions = () => optionWidgets.forEach(fetchOne);
    for (const w of optionWidgets) {
      fetchOne(w);
      if (w.recordPath) {
        engine.watch({
          name: `options-refetch:${w.optionsPath}`,
          fields: [w.recordPath],
          run: () => fetchOne(w),
        });
      }
    }
  }
  // --- the offline queue (Phase 10.2, design session 7) --------------------
  // Durable queue + boot overlay + Web Locks flush leadership + the
  // app.sync.* derivation and its two resolution verbs. Tokenless apps
  // get the no-op surface: offline-readonly for writes.
  const { attachSync } = await import("/runtime/syncClient.js");
  const sync = await attachSync({
    store,
    bound: bundle.bound,
    bundle,
    postWire,
    remint: async () => {
      if (!credentials) return false;
      const minted = await call({ type: "apskel.auth.token", ...credentials() });
      if (minted?.ok) token = minted.token;
      return !!minted?.ok;
    },
    credentials,
    revisions,
  });
  Object.assign(functions, sync.functions);
  // Boot ordering per RESOLVED (the replay origin): the queue overlay
  // repaints pending edits through the replay door AFTER binding and
  // initial state, BEFORE the connection — the wire watchers stay quiet.
  sync.bootOverlay();
  window.addEventListener("online", () => sync.resync());

  // EventSource cannot set headers: the token rides the query string, and
  // the connection's identity is fixed at connect — so a token change
  // (login) reconnects, per RESOLVED (broadcasts obey read rules).
  let events = null;
  reconnectEvents = () => {
    events?.close();
    const url = bundle.wire.events + (token ? `?token=${encodeURIComponent(token)}` : "");
    events = new EventSource(url);
    // A (re)opened feed is the reconnect signal: resync — pull, reconcile,
    // flush clean lineages under the flush lock, surface any conflicts.
    events.onopen = () => sync.resync();
    events.onmessage = (e) => {
      const envelope = JSON.parse(e.data);
      handleEvent(envelope);
      collectionSync?.handleEvent(envelope);
    };
  };
  reconnectEvents();
  window.__apskel.clientId = clientId;
  window.__apskel.sync = sync;
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
