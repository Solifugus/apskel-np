// runtime/syncClient.js — Phase 10.2 slice E: the browser side of the
// offline queue. Everything here executes design session 7's entries:
// the durable queue in IndexedDB (four object stores, one database per
// app+identity), the boot overlay through the replay origin, Web Locks
// flush leadership (the lock covers pull → reconcile → flush-clean ONLY,
// then releases), the app.sync.* derivation, and the check-then-act
// resolution verbs bound to the conflict the calling tab saw.
//
// Deliberate v0.1 scope, recorded here as in the plan: offline SETS are
// the end-to-end story (the draft case); offline INSERTS queue and flush
// with idempotency keys but stamp no optimistic client-side instance —
// the row appears at reconnect through the ordinary broadcast path, and
// the queue module's temp-id machinery stays tested-but-unwired until
// optimistic instances land. Offline BOOT (server down before /app.json)
// needs bundle caching (a service worker) and is not wired; the replica
// store is written through so that era can start from real data.

import { createQueue, deriveConflict } from "/runtime/queue.js";

const REGION = "app.sync.conflict";

export async function attachSync({
  store,
  bound,
  bundle,
  postWire,
  remint, // async () => boolean — the boot's silent re-mint, for 401 mid-flush
  credentials, // () => {deviceId, ...}; null in tokenless apps
  revisions, // the shared wire revisions map (table:id → revision)
  log = console,
}) {
  // Offline writes require the identity machinery, per RESOLVED — a
  // tokenless app gets no queue and argless no-op verbs (nothing can
  // ever park, so there is nothing to resolve).
  if (!bundle.auth || !credentials || typeof indexedDB === "undefined") {
    const noop = () => {};
    return { capture: () => false, bootOverlay: noop, resync: noop,
             functions: { "apskel.sync.keepMine": noop, "apskel.sync.takeTheirs": noop } };
  }

  const deviceId = credentials().deviceId;
  const appName = bundle.name ?? bundle.title ?? "app";
  const identity = () => store.get("app.identity.userId") ?? "anon";
  // One database per app+identity: login switches databases, logout
  // likewise, and databases never merge across identities.
  const dbName = () => `apskel:${appName}:${identity()}`;
  const lockName = () => `${dbName()}:flush`;

  const idb = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  let db = null;
  let queue = null;

  async function open() {
    const req = indexedDB.open(dbName(), 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("replica"); // table:id:field → last-acknowledged value
      d.createObjectStore("queue", { keyPath: "seq" });
      d.createObjectStore("meta");
      d.createObjectStore("dead-letter", { keyPath: "seq" });
    };
    db = await idb(req);
    const tx = db.transaction(["queue", "meta", "dead-letter"], "readonly");
    const entries = await idb(tx.objectStore("queue").getAll());
    const dead = await idb(tx.objectStore("dead-letter").getAll());
    const counters = (await idb(tx.objectStore("meta").get("counters"))) ?? {};
    queue = createQueue({
      bindings: bundle.syncBindings ?? {},
      log,
      restore: { entries, dead, nextSeq: counters.nextSeq, tempCounter: counters.tempCounter },
    });
    const metaTx = db.transaction("meta", "readwrite");
    await idb(metaTx.objectStore("meta").put(bundle.version ?? null, "bundleVersion"));
  }
  await open();

  // Persist one queue op's consequences. Whole-entry puts keyed by seq;
  // counters ride meta so seq is never reused across restarts (the
  // idempotency key depends on that).
  async function persist({ put = [], remove = [], deadLetter = [] } = {}) {
    const tx = db.transaction(["queue", "meta", "dead-letter"], "readwrite");
    const q = tx.objectStore("queue");
    for (const e of put) q.put(e);
    for (const seq of remove) q.delete(seq);
    for (const e of deadLetter) {
      q.delete(e.seq);
      tx.objectStore("dead-letter").put(e);
    }
    const s = queue.snapshot();
    tx.objectStore("meta").put({ nextSeq: s.nextSeq, tempCounter: s.tempCounter }, "counters");
    return new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }

  const entryBySeq = (seq) => queue.entries().find((e) => e.seq === seq);

  // The write-through replica: every server-acknowledged value lands
  // here so `theirs` derives from durable last-known server state.
  function persistReplica(key, value) {
    try {
      db.transaction("replica", "readwrite").objectStore("replica").put(value, key);
    } catch (e) {
      log.warn?.(`[apskel] replica write failed (ignored): ${e.message}`);
    }
  }
  const replicaGet = (key) =>
    idb(db.transaction("replica", "readonly").objectStore("replica").get(key));

  // Which store path shows (table, id, field) right now — the receive
  // side's mapping, reused for the boot overlay and take-theirs.
  function storePathFor(table, id, field) {
    for (const b of bound) {
      if (b.table !== table || b.field !== field) continue;
      const current = b.recordPath ? store.get(b.recordPath) : b.record;
      if (String(current) === String(id)) return b.storePath ?? b.path;
    }
    return null;
  }

  const conflictByTable = new Map(bound.map((b) => [b.table, b.conflict]));

  // --- capture: the wire send path failed on the network ------------------

  function capture(envelope) {
    const conflict =
      envelope.type === "apskel.data.insert"
        ? (conflictByTable.get(envelope.table) ?? "offline-readonly")
        : (bound.find((b) => b.table === envelope.table && b.field === envelope.field)?.conflict ??
           conflictByTable.get(envelope.table) ?? "offline-readonly");
    const r = queue.enqueue(envelope, { conflict: conflict ?? "offline-readonly" });
    if (!r.queued) return false;
    persist({ put: [entryBySeq(r.seq)] });
    log.warn?.(`[apskel] offline: queued ${envelope.type} on ${envelope.table} (seq ${r.seq})`);
    return true;
  }

  // --- boot overlay: pending edits repaint through the replay door --------

  function bootOverlay() {
    for (const e of queue.entries()) {
      const env = e.envelope;
      if (env.type !== "apskel.data.set") continue;
      const path = storePathFor(env.table, env.id, env.field);
      if (path) store.applyReplayWrite(path, env.value);
    }
  }

  // --- the app.sync.* derivation ------------------------------------------

  let theirsCache = new Map(); // table:id:field → pulled server value

  function revisionsObj() {
    const o = {};
    for (const [k, v] of revisions) o[k] = v;
    return o;
  }

  function deriveToRegion() {
    const c = deriveConflict(queue, revisionsObj(), Object.fromEntries(theirsCache));
    store.set(`${REGION}.pending`, c?.pending ?? 0, "system");
    store.set(`${REGION}.table`, c?.table ?? "", "system");
    store.set(`${REGION}.id`, c?.id ?? "", "system");
    store.set(`${REGION}.field`, c?.field ?? "", "system");
    store.set(`${REGION}.mine`, c?.mine ?? "", "system");
    store.set(`${REGION}.theirs`, c?.theirs ?? "", "system");
    return c;
  }

  // --- flush ---------------------------------------------------------------

  async function flushEntry(entry) {
    const env = { ...entry.envelope };
    env.sync = { db: dbName(), dequeuedThrough: queue.dequeuedThrough() };
    if (env.type === "apskel.data.insert") env.sync.seq = entry.seq;
    let r;
    try {
      r = await postWire(env);
    } catch {
      return "offline";
    }
    if (r.status === 401 && (await remint?.())) {
      try {
        r = await postWire(env);
      } catch {
        return "offline";
      }
    }
    if (r.status === 409) {
      const body = await r.json().catch(() => null);
      if (typeof body?.currentRevision === "number") {
        revisions.set(`${env.table}:${env.id}`, body.currentRevision);
      }
      return "conflicted"; // late-detected: the lineage re-parks
    }
    if (!r.ok) {
      // Terminal rejection: MOVED to the dead-letter store, never
      // deleted — the payload stays recoverable, the log points at it.
      queue.deadLetter(entry.seq);
      await persist({ deadLetter: [entry] });
      const body = await r.json().catch(() => null);
      log.error?.(
        `[apskel] flush rejected (${r.status}), moved to dead-letter store seq ${entry.seq}:`,
        body?.error ?? "", env
      );
      return "dead";
    }
    const body = await r.json().catch(() => null);
    if (env.type === "apskel.data.insert") {
      queue.ackInsert(entry.seq, body?.id);
      await persist({ remove: [entry.seq], put: queue.entries() }); // rewritten entries re-persist
    } else {
      if (typeof body?.revision === "number") {
        revisions.set(`${env.table}:${env.id}`, body.revision);
      }
      queue.ack(entry.seq);
      await persist({ remove: [entry.seq] });
    }
    return "acked";
  }

  // --- resync: the lock covers pull → reconcile → flush-clean ONLY ---------

  let resyncing = false;
  async function resync() {
    if (resyncing || queue.entries().length === 0) {
      if (queue.entries().length === 0) deriveToRegion();
      return;
    }
    resyncing = true;
    try {
      await navigator.locks.request(lockName(), async () => {
        // Components before data: a changed bundle reloads the page —
        // safe because every step below is idempotent, which depends on
        // the insert idempotency keys.
        try {
          const fresh = await (await fetch("/app.json")).json();
          if ((fresh.version ?? null) !== (bundle.version ?? null)) {
            location.reload();
            return;
          }
        } catch {
          return; // still offline
        }
        // Pull: current value + revision for every detect-set row.
        theirsCache = new Map();
        for (const e of queue.entries()) {
          const env = e.envelope;
          if (env.type !== "apskel.data.set" || env.baseRevision === undefined) continue;
          try {
            const r = await postWire({ type: "apskel.data.get", table: env.table, id: env.id, field: env.field });
            const body = await r.json().catch(() => null);
            if (body?.ok) {
              if (typeof body.revision === "number") revisions.set(`${env.table}:${env.id}`, body.revision);
              theirsCache.set(`${env.table}:${env.id}:${env.field}`, body.value);
              persistReplica(`${env.table}:${env.id}:${env.field}`, body.value);
            }
          } catch {
            return; // offline again; nothing flushed, nothing lost
          }
        }
        // Reconcile: clean lineages flush now, conflicted park for the
        // prompt — resolution flushes them under a FRESH lock.
        const { clean } = queue.reconcile(revisionsObj());
        for (const lineage of clean) {
          for (const entry of lineage) {
            const outcome = await flushEntry(entry);
            if (outcome === "offline") return;
          }
        }
      });
    } finally {
      resyncing = false;
      deriveToRegion(); // conflicts (if any) surface in every tab
    }
  }

  // --- resolution: check-then-act, bound to the conflict the user saw -----

  function seenIdentity() {
    return {
      table: store.get(`${REGION}.table`),
      id: store.get(`${REGION}.id`),
      field: store.get(`${REGION}.field`),
    };
  }

  async function keepMine() {
    const seen = seenIdentity(); // captured at click, from THIS tab's region
    await navigator.locks.request(lockName(), async () => {
      const acted = queue.keepMine(seen, revisions.get(`${seen.table}:${seen.id}`));
      if (!acted) return; // resolved elsewhere or evaporated: no-op
      const entry = queue
        .entries()
        .find((e) => e.envelope.table === seen.table && e.envelope.id === seen.id && e.envelope.field === seen.field);
      if (entry) await persist({ put: [entry] });
    });
    deriveToRegion();
    resync(); // the unparked lineage flushes under a fresh lock
  }

  async function takeTheirs() {
    const seen = seenIdentity();
    await navigator.locks.request(lockName(), async () => {
      const entry = queue
        .entries()
        .find((e) => e.envelope.table === seen.table && e.envelope.id === seen.id && e.envelope.field === seen.field);
      const acted = queue.takeTheirs(seen);
      if (!acted) return;
      // The discarded value is an accepted loss — removed outright, not
      // dead-lettered: a deliberate choice is not an error.
      await persist({ remove: [entry.seq] });
      const path = storePathFor(seen.table, seen.id, seen.field);
      const theirs =
        theirsCache.get(`${seen.table}:${seen.id}:${seen.field}`) ??
        (await replicaGet(`${seen.table}:${seen.id}:${seen.field}`));
      // The replica holds only server-acknowledged values by
      // construction, so the server door is the honest one.
      if (path && theirs !== undefined) store.applyServerWrite(path, theirs);
    });
    deriveToRegion();
    resync();
  }

  return {
    capture,
    bootOverlay,
    resync,
    queue, // exposed for __apskel debugging
    functions: { "apskel.sync.keepMine": keepMine, "apskel.sync.takeTheirs": takeTheirs },
  };
}
