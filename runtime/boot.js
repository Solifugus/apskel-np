// runtime/boot.js — browser entry (loaded by the index.html shell).
//
// Fetches the server-resolved app bundle, builds the store and watcher
// engine (the same modules Node runs — served unmodified), seeds declared
// locals silently, mounts the tree, and exposes the debug handle:
//
//   window.__apskel = { store, engine, root, byPath }
//
// State inspection goes through this handle — no primitive holds a value.
//
// Phase 5: when the app uses auth, the device credential lives in
// localStorage (durable — it is what survives a full browser restart), a
// silent token re-mint runs before mount, framework functions
// (apskel.auth.*) are handed to the binder for button actions, and every
// wire send carries the access token as Authorization: Bearer.

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

// --- identity (before mount, so actions and the first paint see it) --------

let token = null;
let functions = {};
let credentials = null;

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

  functions = createFrameworkFunctions({
    call,
    store,
    credentials,
    onToken: (t) => {
      token = t;
    },
  });

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

// --- mount -------------------------------------------------------------------

const primitives = {};
for (const type of bundle.primitiveTypes) {
  primitives[type] = await import(`/primitives/${type}/client.js`);
}

mountApp(root, {
  store,
  engine,
  document,
  primitives,
  functions,
  rootEl: document.getElementById("apskel-root"),
});

window.__apskel = { store, engine, root, byPath: (p) => findByPath(root, p) };

if (bundle.wire) {
  const { attachWireSend, attachWireReceive } = await import("/runtime/wireClient.js");
  // Per-tab identity for echo recognition (distinct from the device
  // credential, which identifies the user).
  const clientId = "tab-" + crypto.randomUUID();
  attachWireSend({
    engine,
    bound: bundle.bound,
    clientId,
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
        if (!r.ok) console.error("[apskel] wire send rejected:", r.status);
      } catch (e) {
        console.error("[apskel] wire send failed:", e);
      }
    },
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
