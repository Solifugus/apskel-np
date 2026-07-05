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

// Canonical member order is by stored key — the client sends sorted, the
// server responds and broadcasts sorted, and the store's ordered-element
// array equality then behaves as set equality, per RESOLVED (membership
// writes are whole-set replaces).
export const sortMembers = (members) => [...members].sort((a, b) => (a > b) - (a < b));

export function attachWireSend({
  engine,
  bound,
  setFields = [],
  clientId,
  send,
  revisions = new Map(),
  isLoading = () => false,
  log = console,
}) {
  const byStorePath = new Map(bound.map((b) => [b.storePath, b]));
  const setByStorePath = new Map(setFields.map((s) => [s.storePath, s]));

  // Set-field watchers: same seam, same capture rule (row id at
  // interaction time), same loading-window suspension as bound fields.
  for (const s of setFields) {
    engine.watch({
      name: `wire:${s.storePath}`,
      fields: [s.storePath],
      skipOrigins: ["server"],
      run: (ctx) => {
        const id = s.recordPath ? ctx.get(s.recordPath) : s.record;
        if (s.recordPath && emptyId(id)) return; // empty context: sends suppressed
        if (s.recordPath && isLoading(s.path)) {
          log.warn?.(
            `[apskel] membership change on ${s.storePath} discarded: row ${id} still loading`
          );
          return;
        }
        if (!Array.isArray(ctx.value)) return; // undefined = empty context, nothing to send
        ctx.enqueueEffect(s.storePath, { value: sortMembers(ctx.value), id });
      },
    });
  }

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
    const s = setByStorePath.get(storePath);
    if (s) {
      send({
        type: "apskel.data.setMembers",
        path: s.path,
        table: s.table,
        id: effect.id,
        edge: s.edge,
        members: effect.value,
        sourceClient: clientId,
      });
      return;
    }
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

export function attachWireReceive({
  store,
  bound,
  setFields = [],
  clientId,
  revisions = new Map(),
}) {
  const staticByRowField = new Map(
    bound.filter((b) => !b.recordPath).map((b) => [`${b.table}:${b.record}:${b.field}`, b])
  );
  const dynamic = bound.filter((b) => b.recordPath);
  const staticSets = new Map(
    setFields.filter((s) => !s.recordPath).map((s) => [`${s.table}:${s.record}:${s.edge}`, s])
  );
  const dynamicSets = setFields.filter((s) => s.recordPath);

  // Returns what happened, for the harness: 'applied' | 'echo' | 'unbound' | 'ignored'
  return function handleEvent(envelope) {
    if (!envelope) return "ignored";
    if (envelope.type === "apskel.data.membersChanged") {
      const s =
        staticSets.get(`${envelope.table}:${envelope.id}:${envelope.edge}`) ??
        dynamicSets.find(
          (d) =>
            d.table === envelope.table &&
            d.edge === envelope.edge &&
            String(store.get(d.recordPath)) === String(envelope.id)
        );
      if (!s) return "unbound";
      if (envelope.sourceClient && envelope.sourceClient === clientId) return "echo";
      store.applyServerWrite(s.storePath, envelope.members);
      return "applied";
    }
    if (envelope.type !== "apskel.data.changed") return "ignored";
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
//
// Phase 7.2: fixed-record contexts join the same machinery, minus the
// selection watcher (their row never changes). A non-public table ships
// no initialData (the bundle is a Wire door too), so its context boots
// empty, fetches here, and refetchAll() after login fills it. skipInitial
// lists store paths the bundle already seeded — no redundant boot fetch.
export function attachRecordContexts({
  engine,
  store,
  bound,
  setFields = [],
  revisions = new Map(),
  call,
  skipInitial = new Set(),
  log = console,
}) {
  const contexts = new Map(); // context path -> {recordPath|fixedId, fields, gen}
  const addField = (entry, isSet) => {
    if (!entry.recordPath && (entry.record === null || entry.record === undefined)) return;
    const c =
      contexts.get(entry.path) ??
      {
        path: entry.path,
        recordPath: entry.recordPath ?? null,
        fixedId: entry.recordPath ? null : entry.record,
        fields: [],
        gen: 0,
      };
    c.fields.push(isSet ? { ...entry, isSet: true } : entry);
    contexts.set(entry.path, c);
  };
  for (const b of bound) addField(b, false);
  // Set fields load through getMembers in the same context machinery —
  // never through initialData (member arrays are wire state from the
  // first fetch on).
  for (const s of setFields) addField(s, true);
  const loading = new Set();

  async function loadContext(c, { skip } = {}) {
    const gen = ++c.gen;
    const id = c.recordPath ? store.get(c.recordPath) : c.fixedId;
    if (emptyId(id)) {
      for (const b of c.fields) store.applyServerWrite(b.storePath, undefined);
      return;
    }
    const fields = skip ? c.fields.filter((b) => !skip.has(b.storePath)) : c.fields;
    if (fields.length === 0) return;
    loading.add(c.path);
    try {
      for (const b of fields) {
        const resp = b.isSet
          ? await call({ type: "apskel.data.getMembers", table: b.table, id, edge: b.edge })
          : await call({ type: "apskel.data.get", table: b.table, id, field: b.field });
        if (gen !== c.gen) return; // selection moved again — stale fetch
        if (resp?.ok) {
          store.applyServerWrite(b.storePath, b.isSet ? resp.members : resp.value);
          if (resp.revision !== undefined) revisions.set(`${b.table}:${id}`, resp.revision);
        } else {
          store.applyServerWrite(b.storePath, undefined);
          log.warn?.(
            `[apskel] could not load ${b.table} row ${id} ${b.isSet ? b.edge : b.field}:`,
            resp?.error
          );
        }
      }
    } finally {
      if (gen === c.gen) loading.delete(c.path);
    }
  }

  const all = [];
  for (const c of contexts.values()) {
    if (c.recordPath) {
      engine.watch({
        name: `record:${c.path}`,
        fields: [c.recordPath],
        run: () => {
          loadContext(c);
        },
      });
    }
    // Initial fetch (deep links: the route seeded silently); bundle-seeded
    // fields are skipped.
    all.push(loadContext(c, { skip: skipInitial }));
  }

  return {
    isLoading: (contextPath) => loading.has(contextPath),
    refetchAll: () => Promise.all([...contexts.values()].map(loadContext)),
    ready: Promise.all(all),
  };
}
