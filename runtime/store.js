// runtime/store.js — Phase 2 central store.
//
// One store keyed by path; local, bound, and app-global fields all live
// here. Components never hold state — the runtime owns every field, and
// binding, watchers, Wire sync, validation, and the MCP façade all operate
// on this one store through one code path.
//
// set() carries an origin — 'user' / 'server' / 'system' — into every change
// notification; this is the hook Phase 6's echo suppression uses (a watcher
// whose job is to sync outward recognizes a server-originated change and
// does not echo it back). Per RESOLVED (origins), 'server' is reserved to
// the Wire receive path: it enters only through applyServerWrite, and set()
// rejects it — echo suppression trusts this origin, so app code must not be
// able to forge it.
//
// The value-change guard lives here: writing a field its current value does
// not notify anyone. Per the design doc this is also the base cycle-breaker
// — a self-stabilizing cascade terminates when values stop changing.

export class ApskelStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApskelStoreError";
  }
}

// Four origins, each minted by exactly one gatekeeper, per the amended
// RESOLVED (origins): 'user' by ctx.input, 'server' by the Wire receive
// path (applyServerWrite), 'replay' by the boot overlay
// (applyReplayWrite), 'system' by everything else. 'replay' exists
// because queued-but-unacknowledged values must repaint at boot without
// re-enqueueing — and smuggling them through 'server' would make the
// origin taxonomy a lie at the exact moment (conflict resolution) it
// must be trustworthy.
export const ORIGINS = ["user", "server", "system", "replay"];

export function createStore() {
  const values = new Map();
  const listeners = [];

  const store = {
    get(path) {
      return values.get(path);
    },

    has(path) {
      return values.has(path);
    },

    // Returns true if the value changed (and listeners were notified),
    // false if the write was absorbed by the value-change guard.
    set(path, value, origin = "system") {
      if (origin === "server") {
        throw new ApskelStoreError(
          `origin 'server' on set of '${path}' is reserved to the Wire receive path ` +
            `(use applyServerWrite); echo suppression trusts this origin and it must ` +
            `not be forgeable by app code`
        );
      }
      if (origin === "replay") {
        throw new ApskelStoreError(
          `origin 'replay' on set of '${path}' is reserved to the boot overlay ` +
            `(use applyReplayWrite); the wire watchers trust this origin the same ` +
            `way they trust 'server', and it must not be forgeable by app code`
        );
      }
      if (!ORIGINS.includes(origin)) {
        throw new ApskelStoreError(
          `unknown origin '${origin}' on set of '${path}' (expected ${ORIGINS.join("/")})`
        );
      }
      return write(path, value, origin);
    },

    // The Wire receive path's door: the only writer that produces
    // origin-'server' changes.
    applyServerWrite(path, value) {
      return write(path, value, "server");
    },

    // The boot overlay's door: queued-but-unacknowledged values repaint
    // through here — suppressed by the wire watchers exactly as 'server'
    // is, distinguishable from it, minted only by boot.
    applyReplayWrite(path, value) {
      return write(path, value, "replay");
    },

    // Silent write: no listeners, no cascade. Used for initialization that
    // must complete before any watcher runs.
    seed(path, value) {
      values.set(path, value);
    },

    // Initialize every declared local ({name = default}) in a resolved tree
    // from the unevaluated literal default Phase 1 recorded. Silent by
    // design: seeding happens before any watcher runs.
    seedDeclaredLocals(root) {
      (function walk(node) {
        for (const [name, decl] of node.locals) {
          store.seed(`${node.path}.${name}`, evalLiteral(decl.default, name, node));
        }
        for (const child of node.children) walk(child);
      })(root);
    },

    onChange(listener) {
      listeners.push(listener);
    },

    paths() {
      return [...values.keys()];
    },
  };

  function write(path, value, origin) {
    const oldValue = values.get(path);
    if (values.has(path) && sameValue(oldValue, value)) return false;
    values.set(path, value);
    const change = { path, value, oldValue, origin };
    for (const listener of listeners) listener(change);
    return true;
  }

  return store;
}

// The value-change guard's equality: Object.is for scalars, ordered-
// element comparison for arrays (Phase 7.3) — set fields carry member
// arrays in canonical stored-key order, so this behaves as set equality
// with exactly one equality rule, and an echo or refetch of an unchanged
// set does not cascade.
function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  return false;
}

// Declaration defaults are restricted to literals by the resolver (quoted
// string, number, true/false) — all valid JSON, so evaluation is JSON.parse.
function evalLiteral(text, name, node) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ApskelStoreError(
      `cannot evaluate default '${text}' of declared local '${name}' at '${node.path}'`
    );
  }
}
