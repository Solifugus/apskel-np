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

export function attachWireSend({ engine, bound, clientId, send }) {
  const byStorePath = new Map(bound.map((b) => [b.storePath, b]));

  for (const b of bound) {
    engine.watch({
      name: `wire:${b.storePath}`,
      fields: [b.storePath],
      run: (ctx) => {
        if (ctx.origin === "server") return; // never echo a server change back out
        ctx.enqueueEffect(b.storePath, ctx.value);
      },
    });
  }

  engine.onEffect((storePath, value) => {
    const b = byStorePath.get(storePath);
    if (!b) return; // an effect someone else enqueued — not wire traffic
    send({
      type: "apskel.data.set",
      path: b.path,
      table: b.table,
      id: b.record,
      field: b.field,
      value,
      sourceClient: clientId,
    });
  });

  return byStorePath;
}

export function attachWireReceive({ store, bound, clientId }) {
  const byRowField = new Map(bound.map((b) => [`${b.table}:${b.record}:${b.field}`, b]));

  // Returns what happened, for the harness: 'applied' | 'echo' | 'unbound' | 'ignored'
  return function handleEvent(envelope) {
    if (!envelope || envelope.type !== "apskel.data.changed") return "ignored";
    if (envelope.sourceClient && envelope.sourceClient === clientId) return "echo";
    const b = byRowField.get(`${envelope.table}:${envelope.id}:${envelope.field}`);
    if (!b) return "unbound";
    store.applyServerWrite(b.storePath, envelope.value);
    return "applied";
  };
}
