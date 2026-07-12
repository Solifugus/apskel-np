// runtime/queue.js — the offline queue's pure logic (design session 7).
// Storage-agnostic: plain data in, plain data out. Durability is the
// browser adapter's job (IndexedDB, four object stores); this module is
// what both that adapter and the DB-free harness drive. No wall-clock
// anywhere — authoritative ordering is the server's receipt order, and
// a stored timestamp is a standing temptation to violate that.

// bindings: the recognition ground truth for temp-id rewrite and
// lineage connectivity — declared FK columns and graph edges, never
// value signs. An app is allowed to store a genuinely negative integer.
//   { fkColumns: { table: { column: referencedTable } },
//     edges:     { table: { edge: targetTable } } }
export function createQueue({ bindings = {}, log, restore } = {}) {
  const fkColumns = bindings.fkColumns ?? {};
  const edges = bindings.edges ?? {};

  // restore: a prior snapshot() — the IndexedDB adapter hydrates the
  // durable queue through this at boot. Counters resume where they
  // stopped: seq is never reused (the idempotency key depends on it)
  // and temp ids never collide across restarts. nextSeq clamps to the
  // restored entries so a stale counter can never re-mint a seq in use.
  let nextSeq = Math.max(
    restore?.nextSeq ?? 1,
    ...(restore?.entries ?? []).map((e) => e.seq + 1),
    ...(restore?.dead ?? []).map((e) => e.seq + 1)
  );
  let tempCounter = restore?.tempCounter ?? 0;
  const entries = [...(restore?.entries ?? [])]; // { seq, envelope, conflict, tempId? } in seq order
  const dead = [...(restore?.dead ?? [])]; // moved, never deleted — dies-loudly is the house rule
  const live = new Map(); // tempId → { realId, table } — the translation mapping

  // --- translation and rewrite share one recognizer ------------------

  function translateEnvelope(env, resolve) {
    // resolve(tempId, table) → realId | undefined. `table` is the table
    // the reference points at, per the declared binding.
    const out = { ...env };
    if (out.id !== undefined) {
      const r = resolve(out.id, out.table);
      if (r !== undefined) out.id = r;
    }
    if (out.values) {
      const declared = fkColumns[out.table] ?? {};
      const values = { ...out.values };
      for (const [col, refTable] of Object.entries(declared)) {
        const r = resolve(values[col], refTable);
        if (r !== undefined) values[col] = r;
      }
      out.values = values;
    }
    if (out.members) {
      const target = edges[out.table]?.[out.edge];
      if (target !== undefined) {
        out.members = out.members.map((m) => resolve(m, target) ?? m);
      }
    }
    return out;
  }

  function liveResolver(value, table) {
    const m = live.get(value);
    return m && m.table === table ? m.realId : undefined;
  }

  // --- the public surface --------------------------------------------

  function allocTempId() {
    tempCounter -= 1;
    return tempCounter;
  }

  function coalesceTarget(env) {
    if (env.type === "apskel.data.set") {
      return entries.find(
        (e) =>
          e.envelope.type === env.type &&
          e.envelope.table === env.table &&
          e.envelope.id === env.id &&
          e.envelope.field === env.field
      );
    }
    if (env.type === "apskel.data.setMembers") {
      return entries.find(
        (e) =>
          e.envelope.type === env.type &&
          e.envelope.table === env.table &&
          e.envelope.id === env.id &&
          e.envelope.edge === env.edge
      );
    }
    return undefined;
  }

  // Would this envelope coalesce into an existing entry? The durable
  // adapter asks before enqueueing: only a NEW entry needs a seq from
  // the shared meta counter — a coalesce keeps the existing one.
  function coalesces(envelope) {
    return coalesceTarget(translateEnvelope(envelope, liveResolver)) !== undefined;
  }

  function enqueue(envelope, { conflict, tempId, seq } = {}) {
    // conflict= is the queueing gate — no new axis. offline-readonly
    // refuses per the autosave-403 pattern: warning, no retry.
    if (conflict === "offline-readonly" || conflict === undefined) {
      log?.warn?.(
        `[apskel] offline edit refused: ${envelope.table} is offline-readonly`
      );
      return { queued: false, reason: "offline-readonly" };
    }

    // A write captured against T during the heal window enqueues as R.
    const env = translateEnvelope(envelope, liveResolver);

    const existing = coalesceTarget(env);
    if (env.type === "apskel.data.set") {
      if (existing) {
        // Last value wins; the FIRST baseRevision stays pinned — the
        // revision the user last actually saw. Re-pinning to the newest
        // would silently convert detect into lww.
        existing.envelope.value = env.value;
        return { queued: true, seq: existing.seq };
      }
      if (conflict !== "detect") delete env.baseRevision;
    } else if (env.type === "apskel.data.setMembers") {
      delete env.baseRevision; // lww at the set level — recorded deferral
      if (existing) {
        existing.envelope.members = env.members;
        return { queued: true, seq: existing.seq };
      }
    }
    // insert and delete never coalesce; a queued delete does not prune
    // earlier sets — anything inconsistent dies loudly as a 400 at flush.

    // seq: preallocated by the durable adapter (atomic against the
    // shared meta counter — tabs share one database, so a tab-local
    // counter would collide). The internal counter serves the DB-free
    // harness and stays monotonic past any provided seq.
    const assigned = seq ?? nextSeq;
    nextSeq = Math.max(nextSeq, assigned + 1);
    const entry = { seq: assigned, envelope: env, conflict };
    if (tempId !== undefined) entry.tempId = tempId;
    entries.push(entry);
    entries.sort((a, b) => a.seq - b.seq); // seq order is the replay order
    return { queued: true, seq: entry.seq };
  }

  function ack(seq) {
    const i = entries.findIndex((e) => e.seq === seq);
    if (i !== -1) entries.splice(i, 1);
  }

  function ackInsert(seq, realId) {
    const i = entries.findIndex((e) => e.seq === seq);
    if (i === -1) return;
    const [ins] = entries.splice(i, 1);
    if (ins.tempId === undefined) return;
    const table = ins.envelope.table;
    // The mapping lives from insert-ack until the [T] instance is
    // destroyed by the heal (releaseMapping) — identical lifetimes.
    live.set(ins.tempId, { realId, table });
    const resolveThis = (value, refTable) =>
      value === ins.tempId && refTable === table ? realId : undefined;
    for (const e of entries) {
      e.envelope = translateEnvelope(e.envelope, resolveThis);
    }
  }

  function releaseMapping(tempId) {
    live.delete(tempId);
  }

  function mappings() {
    const out = {};
    for (const [t, m] of live) out[t] = m.realId;
    return out;
  }

  function deadLetter(seq) {
    const i = entries.findIndex((e) => e.seq === seq);
    if (i === -1) return;
    const [entry] = entries.splice(i, 1);
    dead.push(entry);
  }

  // The lowest still-unacked seq: everything below it is durably
  // dequeued and will never replay — the server prunes receipts under it.
  function dequeuedThrough() {
    return entries.length ? entries[0].seq : nextSeq;
  }

  // --- lineages and reconciliation ------------------------------------

  function rowKeyOf(entry) {
    const env = entry.envelope;
    if (env.type === "apskel.data.insert") {
      return `${env.table}:${entry.tempId ?? `seq${entry.seq}`}`;
    }
    return `${env.table}:${env.id}`;
  }

  // Temp references an entry carries, by declared binding: the id slot,
  // declared FK values, declared edge members. Recognition matches a
  // pending insert's tempId and table — never a value's sign.
  function tempRefsOf(entry) {
    const env = entry.envelope;
    const refs = [];
    const pendingResolver = (value, refTable) => {
      const target = entries.find(
        (e) => e.tempId === value && e.envelope.table === refTable
      );
      if (target) refs.push(`${refTable}:${value}`);
      return undefined; // collecting, not rewriting
    };
    translateEnvelope(env, pendingResolver);
    return refs;
  }

  function lineages() {
    // Union-find over row keys; temp references union lineages.
    const parent = new Map();
    const find = (k) => {
      if (!parent.has(k)) parent.set(k, k);
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r);
      parent.set(k, r);
      return r;
    };
    const union = (a, b) => parent.set(find(a), find(b));

    for (const e of entries) {
      const key = rowKeyOf(e);
      find(key);
      for (const ref of tempRefsOf(e)) union(key, ref);
    }
    const groups = new Map();
    for (const e of entries) {
      const root = find(rowKeyOf(e));
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(e); // entries[] is in seq order already
    }
    return [...groups.values()];
  }

  function entryConflicts(entry, revisions) {
    const env = entry.envelope;
    if (env.type !== "apskel.data.set") return false;
    if (entry.conflict !== "detect") return false; // lww never conflicts
    if (env.baseRevision === undefined) return false; // offline-born: nothing to mismatch
    const current = revisions[`${env.table}:${env.id}`];
    return current !== undefined && current !== env.baseRevision;
  }

  // Parking is a derived property: a lineage is parked while it holds
  // ≥1 conflicted entry. Resolution updates the derivation; nothing
  // bespoke unparks.
  function reconcile(revisions) {
    const clean = [];
    const conflicted = [];
    for (const lineage of lineages()) {
      (lineage.some((e) => entryConflicts(e, revisions)) ? conflicted : clean)
        .push(lineage);
    }
    return { clean, conflicted };
  }

  function conflictedEntries(revisions) {
    return entries.filter((e) => entryConflicts(e, revisions));
  }

  // The flusher's own accepted write moved the row's revision; later
  // queued sets on that row were typed on top of the flushed value
  // (queue order is the session's order), so their pins advance with
  // it — the sequencing an online session would have produced, write
  // by write. A FOREIGN move never advances a pin (that would silently
  // convert detect into lww): only the flusher calls this, with the
  // revision its own ack returned. Returns the advanced entries so the
  // durable adapter can re-persist them (a crash between acks must not
  // resurrect the stale pin).
  function advanceBase({ table, id, afterSeq, revision }) {
    const advanced = [];
    for (const e of entries) {
      const env = e.envelope;
      if (e.seq <= afterSeq) continue;
      if (env.type !== "apskel.data.set") continue;
      if (env.table !== table || String(env.id) !== String(id)) continue;
      if (env.baseRevision === undefined) continue;
      env.baseRevision = revision;
      advanced.push(e);
    }
    return advanced;
  }

  function findSet({ table, id, field }) {
    return entries.find(
      (e) =>
        e.envelope.type === "apskel.data.set" &&
        e.envelope.table === table &&
        e.envelope.id === id &&
        e.envelope.field === field
    );
  }

  // Both verbs are check-then-act, bound to the conflict the user saw —
  // the caller passes the identity captured from its region at click
  // time. Gone already (resolved elsewhere, evaporated) → no-op.
  function keepMine(identity, actRevision) {
    const entry = findSet(identity);
    if (!entry) return false;
    // Act-time pinning, not pull-time: pull-time would ping-pong under
    // per-field sequencing (each flush moves the revision, staling the
    // next adoption on arrival).
    entry.envelope.baseRevision = actRevision;
    return true;
  }

  function takeTheirs(identity) {
    const entry = findSet(identity);
    if (!entry) return false;
    // Removed outright, not dead-lettered: a deliberate choice is not
    // an error, and the discarded value is an accepted loss.
    const i = entries.indexOf(entry);
    entries.splice(i, 1);
    return true;
  }

  // Re-hydrate from the durable store in place. The lock holder calls
  // this on acquisition: tabs share one database, so the durable queue
  // is the truth and this tab's memory is only a cache — a later tab
  // "finds the queue empty and its resync degenerates to a pull" (the
  // flush-leadership RESOLVED entry) exactly because it reloads here.
  // The live temp-id mapping survives: its lifetime is this page's heal
  // window, not the store's.
  function reload(r = {}) {
    entries.length = 0;
    entries.push(...(r.entries ?? []));
    entries.sort((a, b) => a.seq - b.seq);
    dead.length = 0;
    dead.push(...(r.dead ?? []));
    if (r.nextSeq !== undefined) nextSeq = Math.max(nextSeq, r.nextSeq);
    for (const e of [...entries, ...dead]) nextSeq = Math.max(nextSeq, e.seq + 1);
    if (r.tempCounter !== undefined) tempCounter = Math.min(tempCounter, r.tempCounter);
  }

  // Everything the durable adapter must persist to rebuild this queue.
  // The live mapping is deliberately absent: its lifetime is the heal
  // window of one page's [T] instances, which do not survive a reload.
  function snapshot() {
    return {
      nextSeq,
      tempCounter,
      entries: entries.map((e) => ({ ...e, envelope: { ...e.envelope } })),
      dead: dead.map((e) => ({ ...e, envelope: { ...e.envelope } })),
    };
  }

  return {
    snapshot,
    reload,
    allocTempId,
    coalesces,
    enqueue,
    ack,
    ackInsert,
    releaseMapping,
    mappings,
    deadLetter,
    deadLetters: () => [...dead],
    dequeuedThrough,
    entries: () => [...entries],
    lineages,
    reconcile,
    conflictedEntries,
    advanceBase,
    keepMine,
    takeTheirs,
  };
}

// The app.sync.* derivation: a view of the head parked conflict,
// recomputed from queue + replica — never duplicated state. One
// conflict at a time; `pending` keeps the user oriented. Revisions are
// wire bookkeeping and deliberately never appear in the shape.
export function deriveConflict(queue, revisions, replica) {
  const conflicted = queue.conflictedEntries(revisions);
  if (conflicted.length === 0) return null;
  const head = conflicted[0]; // earliest by seq — entries stay ordered
  const { table, id, field, value } = head.envelope;
  return {
    pending: conflicted.length,
    table,
    id,
    field,
    mine: value,
    theirs: replica[`${table}:${id}:${field}`],
  };
}
