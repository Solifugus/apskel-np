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

const revisionKey = (b) => `${b.table}:${b.record}`;

export function attachWireSend({ engine, bound, clientId, send, revisions = new Map() }) {
  const byStorePath = new Map(bound.map((b) => [b.storePath, b]));

  for (const b of bound) {
    engine.watch({
      name: `wire:${b.storePath}`,
      fields: [b.storePath],
      // Never echo a server change back out — suppressed at the engine, so
      // the fire counter proves it (criterion 5), rather than an early
      // return hiding inside this body.
      skipOrigins: ["server"],
      run: (ctx) => ctx.enqueueEffect(b.storePath, ctx.value),
    });
  }

  engine.onEffect((storePath, value) => {
    const b = byStorePath.get(storePath);
    if (!b) return; // an effect someone else enqueued — not wire traffic
    const envelope = {
      type: "apskel.data.set",
      path: b.path,
      table: b.table,
      id: b.record,
      field: b.field,
      value,
      sourceClient: clientId,
    };
    if (b.conflict === "detect") {
      envelope.baseRevision = revisions.get(revisionKey(b)) ?? 0;
    }
    send(envelope);
  });

  return byStorePath;
}

export function attachWireReceive({ store, bound, clientId, revisions = new Map() }) {
  const byRowField = new Map(bound.map((b) => [`${b.table}:${b.record}:${b.field}`, b]));

  // Returns what happened, for the harness: 'applied' | 'echo' | 'unbound' | 'ignored'
  return function handleEvent(envelope) {
    if (!envelope || envelope.type !== "apskel.data.changed") return "ignored";
    const b = byRowField.get(`${envelope.table}:${envelope.id}:${envelope.field}`);
    if (!b) return "unbound";
    // Revision bookkeeping happens for every broadcast on a bound row —
    // the echo's store write is ignored, its revision is not.
    if (envelope.revision !== undefined) {
      revisions.set(revisionKey(b), envelope.revision);
    }
    if (envelope.sourceClient && envelope.sourceClient === clientId) return "echo";
    store.applyServerWrite(b.storePath, envelope.value);
    return "applied";
  };
}
