// runtime/wireClient.js — Phase 4 client side of the Wire.
//
// The send path consumes the Phase 2 deferred-effect seam exactly as
// designed: a watcher per bound field enqueues the change during the
// cascade (skipping server-origin changes — watcher-level echo
// suppression), and after the cascade settles the coalesced per-field
// values go out as one type-routed envelope each. The Wire sits after the
// cascade, never inside it.
//
// The receive path applies foreign apskel.data.changed events through
// store.applyServerWrite — the only door to origin 'server' — and
// recognizes its own echo by sourceClient, ignoring it (the change was
// already applied optimistically).
//
// Transport is injected (send function, event feed), so this module runs
// identically in the browser (fetch + EventSource glue in boot.js) and in
// the Node harness (recording fakes).
//
// Phase 6: for a conflict="detect" context, every send carries the
// baseRevision it was based on, and every broadcast — including the
// client's own echo — updates the shared revision bookkeeping (a Map keyed
// table:record, never a visible field), per RESOLVED (conflict declaration
// surface). Skipping the echo's revision would false-conflict the very
// next write.

const emptyId = (id) => id === undefined || id === null || id === "";

export function attachWireSend({
  engine,
  bound,
  clientId,
  send,
  revisions = new Map(),
  isLoading = () => false,
  log = console,
}) {
  const byStorePath = new Map(bound.map((b) => [b.storePath, b]));

  for (const b of bound) {
    engine.watch({
      name: `wire:${b.storePath}`,
      fields: [b.storePath],
      // Never echo a server change back out — suppressed at the engine, so
      // the fire counter proves it (criterion 5), rather than an early
      // return hiding inside this body.
      skipOrigins: ["server"],
      run: (ctx) => {
        // The row id is captured at keystroke time, not send time, per
        // RESOLVED (selection-change semantics).
        const id = b.recordPath ? ctx.get(b.recordPath) : b.record;
        if (b.recordPath && emptyId(id)) return; // empty context: sends suppressed
        if (b.recordPath && isLoading(b.path)) {
          log.warn?.(
            `[apskel] keystroke on ${b.storePath} discarded: row ${id} still loading`
          );
          return;
        }
        ctx.enqueueEffect(b.storePath, { value: ctx.value, id });
      },
    });
  }

  engine.onEffect((storePath, effect) => {
    const b = byStorePath.get(storePath);
    if (!b) return; // an effect someone else enqueued — not wire traffic
    const envelope = {
      type: "apskel.data.set",
      path: b.path,
      table: b.table,
      id: effect.id,
      field: b.field,
      value: effect.value,
      sourceClient: clientId,
    };
    if (b.conflict === "detect") {
      envelope.baseRevision = revisions.get(`${b.table}:${effect.id}`) ?? 0;
    }
    send(envelope);
  });

  return byStorePath;
}

export function attachWireReceive({ store, bound, clientId, revisions = new Map() }) {
  const staticByRowField = new Map(
    bound.filter((b) => !b.recordPath).map((b) => [`${b.table}:${b.record}:${b.field}`, b])
  );
  const dynamic = bound.filter((b) => b.recordPath);

  // Returns what happened, for the harness: 'applied' | 'echo' | 'unbound' | 'ignored'
  return function handleEvent(envelope) {
    if (!envelope || envelope.type !== "apskel.data.changed") return "ignored";
    // A dynamic context matches only when the broadcast row IS its current
    // selection; a broadcast for another row of the same table is unbound.
    const b =
      staticByRowField.get(`${envelope.table}:${envelope.id}:${envelope.field}`) ??
      dynamic.find(
        (d) =>
          d.table === envelope.table &&
          d.field === envelope.field &&
          String(store.get(d.recordPath)) === String(envelope.id)
      );
    if (!b) return "unbound";
    // Revision bookkeeping happens for every broadcast on a bound row —
    // the echo's store write is ignored, its revision is not.
    if (envelope.revision !== undefined) {
      revisions.set(`${b.table}:${envelope.id}`, envelope.revision);
    }
    if (envelope.sourceClient && envelope.sourceClient === clientId) return "echo";
    store.applyServerWrite(b.storePath, envelope.value);
    return "applied";
  };
}

// The selection-change machinery, per RESOLVED (selection-change
// semantics): paths never change; when a context's selection value
// changes, sends suspend, each bound field fetches through
// apskel.data.get, and the values apply through the SERVER-ORIGIN door —
// display watchers repaint, the origin-suppressed wire watcher stays
// quiet, nothing echoes back out. (Not store.seed: after mount, a silent
// seed skips the display watchers too, leaving stale text in the DOM for
// the next keystroke to autosave into the wrong row.) The row's revision
// is adopted, sends resume. Stale fetches (selection moved again
// mid-flight) are discarded by generation.
export function attachRecordContexts({
  engine,
  store,
  bound,
  revisions = new Map(),
  call,
  log = console,
}) {
  const contexts = new Map(); // context path -> {recordPath, fields, gen}
  for (const b of bound) {
    if (!b.recordPath) continue;
    const c = contexts.get(b.path) ?? { path: b.path, recordPath: b.recordPath, fields: [], gen: 0 };
    c.fields.push(b);
    contexts.set(b.path, c);
  }
  const loading = new Set();

  async function loadContext(c) {
    const gen = ++c.gen;
    const id = store.get(c.recordPath);
    if (emptyId(id)) {
      for (const b of c.fields) store.applyServerWrite(b.storePath, undefined);
      return;
    }
    loading.add(c.path);
    try {
      for (const b of c.fields) {
        const resp = await call({ type: "apskel.data.get", table: b.table, id, field: b.field });
        if (gen !== c.gen) return; // selection moved again — stale fetch
        if (resp?.ok) {
          store.applyServerWrite(b.storePath, resp.value);
          if (resp.revision !== undefined) revisions.set(`${b.table}:${id}`, resp.revision);
        } else {
          store.applyServerWrite(b.storePath, undefined);
          log.warn?.(`[apskel] could not load ${b.table} row ${id} ${b.field}:`, resp?.error);
        }
      }
    } finally {
      if (gen === c.gen) loading.delete(c.path);
    }
  }

  const all = [];
  for (const c of contexts.values()) {
    engine.watch({
      name: `record:${c.path}`,
      fields: [c.recordPath],
      run: () => {
        loadContext(c);
      },
    });
    all.push(loadContext(c)); // initial fetch (deep links: the route seeded silently)
  }

  return {
    isLoading: (contextPath) => loading.has(contextPath),
    refetchAll: () => Promise.all([...contexts.values()].map(loadContext)),
    ready: Promise.all(all),
  };
}
