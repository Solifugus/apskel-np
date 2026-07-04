// runtime/boot.js — browser entry (loaded by the index.html shell).
//
// Fetches the server-resolved app bundle, builds the store and watcher
// engine (the same modules Node runs — served unmodified), seeds declared
// locals silently, mounts the tree, and exposes the debug handle:
//
//   window.__apskel = { store, engine, root, byPath }
//
// State inspection goes through this handle — no primitive holds a value.

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
if (bundle.initialData) {
  for (const [storePath, value] of Object.entries(bundle.initialData)) {
    store.seed(storePath, value);
  }
}

const primitives = {};
for (const type of bundle.primitiveTypes) {
  primitives[type] = await import(`/primitives/${type}/client.js`);
}

mountApp(root, {
  store,
  engine,
  document,
  primitives,
  rootEl: document.getElementById("apskel-root"),
});

window.__apskel = { store, engine, root, byPath: (p) => findByPath(root, p) };

if (bundle.wire) {
  const { attachWireSend, attachWireReceive } = await import("/runtime/wireClient.js");
  // Per-tab identity — the seam Phase 5's device credential replaces.
  const clientId = "tab-" + crypto.randomUUID();
  attachWireSend({
    engine,
    bound: bundle.bound,
    clientId,
    send: (envelope) =>
      fetch(bundle.wire.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      })
        .then((r) => {
          if (!r.ok) console.error("[apskel] wire send rejected:", r.status);
        })
        .catch((e) => console.error("[apskel] wire send failed:", e)),
  });
  const handleEvent = attachWireReceive({ store, bound: bundle.bound, clientId });
  const events = new EventSource(bundle.wire.events);
  events.onmessage = (e) => handleEvent(JSON.parse(e.data));
  window.__apskel.clientId = clientId;
}

if (bundle.clientFunctions) {
  const appModule = await import(`/app/${bundle.clientFunctions}`);
  appModule.setup?.(window.__apskel);
}
