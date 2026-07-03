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

if (bundle.clientFunctions) {
  const appModule = await import(`/app/${bundle.clientFunctions}`);
  appModule.setup?.(window.__apskel);
}
