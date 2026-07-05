// runtime/watchers.js — Phase 2 watcher engine.
//
// Semantics per the design doc's Watcher Execution Model:
//   * Value-change triggering — the store's guard means same-value writes
//     never reach this engine.
//   * Synchronous, immediate firing — an external set() runs the whole
//     cascade to completion before it returns. No microtask queue.
//   * Cascade deduplication — within one cascade a watcher holds at most one
//     pending entry; changes to several of its watched fields before it runs
//     coalesce into a single firing (the diamond case).
//   * Snapshot values — a watcher body receives (value, oldValue) captured
//     at change time, plus the change's origin (user/server/system).
//   * Cycle detection — a watcher revisited with still-changing values
//     beyond maxFiringsPerWatcher aborts the cascade with an
//     ApskelCascadeError carrying the cascade trace. Never a hang.
//
// The Wire sits after the cascade, never inside it: effects enqueued during
// a cascade (ctx.enqueueEffect / engine.enqueueEffect) are delivered to
// onEffect handlers only after the cascade settles, coalesced per field to
// the last value. A cascade that aborts delivers nothing. This queue is the
// seam Phase 4's Wire send consumes; in Phase 2 it is exercised with
// recording handlers only.

export class ApskelCascadeError extends Error {
  constructor(message, trace) {
    super(message);
    this.name = "ApskelCascadeError";
    this.trace = trace;
  }
}

const DEFAULT_MAX_FIRINGS = 25;

export class WatcherEngine {
  #store;
  #watchers = [];
  #byField = new Map(); // path -> [watcher]
  #effectHandlers = [];
  #maxFirings;
  #cascade = null;
  #fireCounts = new Map(); // watcher name -> lifetime firings (criterion 5's counter)

  constructor(store, { maxFiringsPerWatcher = DEFAULT_MAX_FIRINGS } = {}) {
    this.#store = store;
    this.#maxFirings = maxFiringsPerWatcher;
    store.onChange((change) => this.#onStoreChange(change));
  }

  // skipOrigins: origins that do not schedule this watcher at all (e.g. the
  // wire send watcher skips 'server') — declarative echo suppression, so a
  // suppressed change leaves the fire counter untouched and "did not
  // re-fire" is an observable number, not a claim about a body's early
  // return.
  watch({ name, fields, run, skipOrigins }) {
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error(`watcher '${name}' must watch at least one field`);
    }
    if (typeof run !== "function") {
      throw new Error(`watcher '${name}' has no run function`);
    }
    const watcher = { name: name || `watcher#${this.#watchers.length + 1}`, fields, run, skipOrigins };
    this.#watchers.push(watcher);
    for (const field of fields) {
      const list = this.#byField.get(field) || [];
      list.push(watcher);
      this.#byField.set(field, list);
    }
    return watcher;
  }

  onEffect(handler) {
    this.#effectHandlers.push(handler);
  }

  // Remove watchers by predicate — Phase 8's instance destruction: a
  // destroyed collection instance takes its watchers with it (matched by
  // name, which carries the PK-keyed instance path).
  unwatch(match) {
    this.#watchers = this.#watchers.filter((w) => !match(w));
    for (const [field, list] of this.#byField) {
      const kept = list.filter((w) => !match(w));
      if (kept.length) this.#byField.set(field, kept);
      else this.#byField.delete(field);
    }
  }

  // Lifetime firings per watcher name — the observable form of echo
  // suppression: a server-origin change must leave the wire send watcher's
  // count unchanged. Exposed in the browser via window.__apskel.
  fireCounts() {
    return Object.fromEntries(this.#fireCounts);
  }

  fireCount(name) {
    return this.#fireCounts.get(name) ?? 0;
  }

  // During a cascade: coalesced per field (last value wins), delivered after
  // settle. Outside any cascade there is nothing to wait for — delivered
  // immediately.
  enqueueEffect(path, value) {
    if (this.#cascade) {
      this.#cascade.effects.set(path, value);
    } else {
      this.#deliver(path, value);
    }
  }

  #deliver(path, value) {
    for (const handler of this.#effectHandlers) handler(path, value);
  }

  #onStoreChange(change) {
    if (this.#cascade) {
      // A write from a watcher body mid-cascade: schedule and let the
      // running drain pick it up — same tick, one cascade.
      this.#schedule(change);
      return;
    }
    const cascade = {
      pending: [], // FIFO of {watcher, changes}
      pendingByWatcher: new Map(),
      firingCounts: new Map(),
      trace: [],
      effects: new Map(), // path -> last value (Map preserves first-enqueue order)
    };
    this.#cascade = cascade;
    this.#schedule(change);
    try {
      this.#drain();
    } finally {
      this.#cascade = null;
    }
    // Reached only when the cascade settled cleanly: the deferred queue
    // drains after settle. An aborted cascade delivers nothing.
    for (const [path, value] of cascade.effects) this.#deliver(path, value);
  }

  #schedule(change) {
    const cascade = this.#cascade;
    for (const watcher of this.#byField.get(change.path) || []) {
      if (watcher.skipOrigins?.includes(change.origin)) continue;
      const entry = cascade.pendingByWatcher.get(watcher);
      if (entry) {
        // Cascade deduplication: already pending — coalesce this change
        // into the same upcoming firing.
        entry.changes.push(change);
      } else {
        const fresh = { watcher, changes: [change] };
        cascade.pendingByWatcher.set(watcher, fresh);
        cascade.pending.push(fresh);
      }
    }
  }

  #drain() {
    const cascade = this.#cascade;
    const store = this.#store;
    while (cascade.pending.length > 0) {
      const { watcher, changes } = cascade.pending.shift();
      cascade.pendingByWatcher.delete(watcher);

      const count = (cascade.firingCounts.get(watcher) || 0) + 1;
      cascade.firingCounts.set(watcher, count);
      this.#fireCounts.set(watcher.name, (this.#fireCounts.get(watcher.name) ?? 0) + 1);
      if (count > this.#maxFirings) {
        throw new ApskelCascadeError(
          `watcher '${watcher.name}' fired more than ${this.#maxFirings} times in one ` +
            `cascade with values still changing — cycle detected.\nCascade trace:\n` +
            formatTrace(cascade.trace),
          cascade.trace
        );
      }

      // Snapshot semantics: value/oldValue/origin were captured at change
      // time. With coalesced triggers, the top-level snapshot is the most
      // recent change; all triggers are available on ctx.changes.
      const last = changes[changes.length - 1];
      cascade.trace.push({
        n: cascade.trace.length + 1,
        watcher: watcher.name,
        path: last.path,
        oldValue: last.oldValue,
        value: last.value,
        origin: last.origin,
      });

      const ctx = {
        field: last.path,
        value: last.value,
        oldValue: last.oldValue,
        origin: last.origin,
        changes: [...changes],
        get: (path) => store.get(path),
        set: (path, value, origin = "system") => store.set(path, value, origin),
        enqueueEffect: (path, value) => this.enqueueEffect(path, value),
      };
      watcher.run(ctx);
    }
  }
}

function formatTrace(trace, tailLength = 12) {
  const tail = trace.slice(-tailLength);
  const omitted = trace.length - tail.length;
  const lines = tail.map(
    (t) =>
      `  #${t.n} watcher '${t.watcher}' <- ${t.path}: ` +
      `${fmt(t.oldValue)} -> ${fmt(t.value)} (origin ${t.origin})`
  );
  const head = omitted > 0 ? [`  ... ${omitted} earlier firings omitted`] : [];
  return [...head, ...lines].join("\n");
}

function fmt(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
