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
// does not echo it back).
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

export const ORIGINS = ["user", "server", "system"];

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
      if (!ORIGINS.includes(origin)) {
        throw new ApskelStoreError(
          `unknown origin '${origin}' on set of '${path}' (expected ${ORIGINS.join("/")})`
        );
      }
      const oldValue = values.get(path);
      if (values.has(path) && Object.is(oldValue, value)) return false;
      values.set(path, value);
      const change = { path, value, oldValue, origin };
      for (const listener of listeners) listener(change);
      return true;
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
  return store;
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
