// test/queue.test.js — Phase 10.2 harness, slice A: the offline queue's
// pure logic, DB-free, storage-agnostic (plain data in, plain data out;
// IndexedDB is the browser adapter's business, not this module's).
//
//   node test/queue.test.js
//
// Encodes design session 7 as executable assertions: coalescing with
// first-baseRevision pinning (Q1), the conflict= queueing gate (Q1),
// delete-does-not-prune (Q1), negative-integer temp ids, the live T→R
// translation mapping, the queue-only rewrite by declared binding (Q2),
// per-lineage partition with transitive temp-id connectivity (Q2), the
// dequeuedThrough watermark (Q4), dead-letter moves (Q2), reconcile
// clean/conflicted (Q2), the app.sync.* conflict derivation and the
// keep-mine / take-theirs queue operations bound to the seen conflict
// (Q3). Expected outcomes are the design doc's Phase 10.2 block.

import { createQueue, deriveConflict } from "../runtime/queue.js";

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Declared bindings, the recognition ground truth for rewrite and
// connectivity — never sniffed from value signs. `comments.score` is
// deliberately absent: a negative integer there must survive rewrite.
const BINDINGS = {
  // table → column → referenced table (FK columns bound by the app)
  fkColumns: {
    comments: { edition_id: "article_editions" },
  },
  // table → edge → target table (declared graph edges)
  edges: {
    article_editions: { tags: "tags" },
  },
};

const set = (table, id, field, value, baseRevision) => {
  const env = { type: "apskel.data.set", path: `p.${field}`, table, id, field, value };
  if (baseRevision !== undefined) env.baseRevision = baseRevision;
  return env;
};
const setMembers = (table, id, edge, members) => ({
  type: "apskel.data.setMembers", path: `p.${edge}`, table, id, edge, members,
});
const insert = (table, values) => ({ type: "apskel.data.insert", table, values });
const del = (table, id) => ({ type: "apskel.data.delete", table, id });

console.log("queue — the conflict= gate and enqueue basics");
{
  const q = createQueue({ bindings: BINDINGS });
  const r = q.enqueue(set("article_editions", 7, "body", "draft one", 3), { conflict: "offline-readonly" });
  check("offline-readonly refuses at enqueue", r.queued === false && r.reason === "offline-readonly", JSON.stringify(r));
  check("a refused edit leaves the queue empty", q.entries().length === 0);

  const a = q.enqueue(set("article_editions", 7, "body", "draft one", 3), { conflict: "detect" });
  check("detect queues", a.queued === true && typeof a.seq === "number");
  const b = q.enqueue(set("article_editions", 7, "title", "T", 3), { conflict: "detect" });
  check("seq is monotonic", b.seq > a.seq, `${a.seq} then ${b.seq}`);
}

console.log("\nqueue — coalescing: set per table:id:field, first baseRevision pinned");
{
  const q = createQueue({ bindings: BINDINGS });
  q.enqueue(set("article_editions", 7, "body", "one", 3), { conflict: "detect" });
  q.enqueue(set("article_editions", 7, "body", "two", 5), { conflict: "detect" });
  q.enqueue(set("article_editions", 7, "body", "three", 9), { conflict: "detect" });
  const entries = q.entries();
  check("ten edits, one entry", entries.length === 1);
  check("last value wins", entries[0].envelope.value === "three");
  check("the FIRST baseRevision is pinned (the revision the user last saw)", entries[0].envelope.baseRevision === 3,
    `got ${entries[0].envelope.baseRevision}`);

  q.enqueue(set("article_editions", 7, "title", "T", 3), { conflict: "detect" });
  check("a different field is a different entry", q.entries().length === 2);
  q.enqueue(set("article_editions", 8, "body", "other row", 1), { conflict: "detect" });
  check("a different row is a different entry", q.entries().length === 3);

  const lww = createQueue({ bindings: BINDINGS });
  lww.enqueue(set("article_editions", 7, "body", "x"), { conflict: "lww" });
  check("an lww entry carries no baseRevision", lww.entries()[0].envelope.baseRevision === undefined);
}

console.log("\nqueue — coalescing: setMembers per edge; insert/delete never coalesce");
{
  const q = createQueue({ bindings: BINDINGS });
  q.enqueue(setMembers("article_editions", 7, "tags", [1, 2]), { conflict: "detect" });
  q.enqueue(setMembers("article_editions", 7, "tags", [1, 2, 3]), { conflict: "detect" });
  const e = q.entries();
  check("two set replacements, one entry", e.length === 1);
  check("whole-set replace, last members win", eq(e[0].envelope.members, [1, 2, 3]));
  check("setMembers never carries a baseRevision (lww at set level)", e[0].envelope.baseRevision === undefined);

  const q2 = createQueue({ bindings: BINDINGS });
  q2.enqueue(insert("comments", { body: "a" }), { conflict: "detect", tempId: q2.allocTempId() });
  q2.enqueue(insert("comments", { body: "b" }), { conflict: "detect", tempId: q2.allocTempId() });
  check("two inserts never coalesce", q2.entries().length === 2);
}

console.log("\nqueue — delete does not prune; order is preserved");
{
  const q = createQueue({ bindings: BINDINGS });
  q.enqueue(set("article_editions", 7, "body", "kept", 3), { conflict: "detect" });
  q.enqueue(del("article_editions", 7), { conflict: "detect" });
  const kinds = q.entries().map((e) => e.envelope.type);
  check("a queued delete does NOT prune earlier sets on the row",
    eq(kinds, ["apskel.data.set", "apskel.data.delete"]), kinds.join(","));
}

console.log("\nqueue — temp ids: negative integers from the meta counter");
{
  const q = createQueue({ bindings: BINDINGS });
  const t1 = q.allocTempId();
  const t2 = q.allocTempId();
  check("temp ids are negative integers", t1 === -1 && t2 === -2, `${t1}, ${t2}`);
}

console.log("\nqueue — ackInsert: dequeue, live mapping, queue-only rewrite by declared binding");
{
  const q = createQueue({ bindings: BINDINGS });
  const t = q.allocTempId();
  const tTag = q.allocTempId(); // an offline-born tag, attached immediately — Q2's own example
  const ins = q.enqueue(insert("article_editions", { title: "born offline" }), { conflict: "detect", tempId: t });
  const tagIns = q.enqueue(insert("tags", { name: "fresh" }), { conflict: "detect", tempId: tTag });
  q.enqueue(set("article_editions", t, "body", "typed into the temp row", undefined), { conflict: "detect" });
  q.enqueue(insert("comments", { body: "child", edition_id: t }), { conflict: "detect", tempId: q.allocTempId() });
  q.enqueue(setMembers("article_editions", t, "tags", [tTag, 5]), { conflict: "detect" });
  // A negative value in a column NOT declared as an FK must survive: no sniffing.
  q.enqueue(insert("comments", { body: "scored", score: -1, edition_id: t }), { conflict: "detect", tempId: q.allocTempId() });

  q.ackInsert(ins.seq, 42);
  let after = q.entries();
  check("the acked insert is dequeued", !after.some((e) => e.seq === ins.seq));
  const bodySet = after.find((e) => e.envelope.type === "apskel.data.set");
  check("a later set's id slot is rewritten T→R", bodySet.envelope.id === 42, `id ${bodySet.envelope.id}`);
  const child = after.find((e) => e.envelope.table === "comments" && e.envelope.values?.body === "child");
  check("a child insert's declared FK value is rewritten", child.envelope.values.edition_id === 42);
  const membersEntry = after.find((e) => e.envelope.type === "apskel.data.setMembers");
  check("setMembers id slot is rewritten", membersEntry.envelope.id === 42);
  check("the edition's ack does NOT touch the members array (tags members are tag keys — declared binding, not sign)",
    eq(membersEntry.envelope.members, [tTag, 5]), JSON.stringify(membersEntry.envelope.members));
  const scored = after.find((e) => e.envelope.values?.body === "scored");
  check("a genuinely negative value in a non-FK column is NOT rewritten (no sniffing)",
    scored.envelope.values.score === -1, `score ${scored.envelope.values.score}`);
  check("the live mapping is installed on ack", q.mappings()[t] === 42);

  q.ackInsert(tagIns.seq, 99);
  after = q.entries();
  check("the TAG's ack rewrites the members array (declared edge target)",
    eq(after.find((e) => e.envelope.type === "apskel.data.setMembers").envelope.members, [99, 5]),
    JSON.stringify(after.find((e) => e.envelope.type === "apskel.data.setMembers").envelope.members));

  // Enqueue-time translation: the [T] instance is still on screen; a
  // keystroke captured against T enqueues as R.
  q.enqueue(set("article_editions", t, "body", "typed during the heal window", undefined), { conflict: "detect" });
  const translated = q.entries().find((e) => e.envelope.field === "body");
  check("enqueue translates through the live mapping", translated.envelope.id === 42);

  q.releaseMapping(t);
  check("the mapping dies with the heal", q.mappings()[t] === undefined);
}

console.log("\nqueue — lineages: table:id plus transitive temp-id connectivity");
{
  const q = createQueue({ bindings: BINDINGS });
  q.enqueue(set("article_editions", 7, "body", "real row", 3), { conflict: "detect" });
  const tParent = q.allocTempId();
  q.enqueue(insert("article_editions", { title: "offline-born" }), { conflict: "detect", tempId: tParent });
  q.enqueue(insert("comments", { body: "child of temp", edition_id: tParent }), { conflict: "detect", tempId: q.allocTempId() });
  q.enqueue(set("tags", 2, "name", "unrelated", 1), { conflict: "detect" });

  const lineages = q.lineages();
  check("three lineages", lineages.length === 3, `${lineages.length}`);
  const tempLineage = lineages.find((l) => l.some((e) => e.envelope.type === "apskel.data.insert" && e.envelope.table === "article_editions"));
  check("the child insert referencing the parent's temp id joins the parent's lineage (transitive)",
    tempLineage.length === 2 && tempLineage.some((e) => e.envelope.table === "comments"));
  const flat = lineages.flat().map((e) => e.seq);
  check("within a lineage, seq order is strict",
    lineages.every((l) => l.every((e, i) => i === 0 || l[i - 1].seq < e.seq)), flat.join(","));
}

console.log("\nqueue — reconcile: pinned baseRevision vs pulled revision partitions lineages");
{
  const q = createQueue({ bindings: BINDINGS });
  q.enqueue(set("article_editions", 7, "body", "mine", 3), { conflict: "detect" });
  q.enqueue(set("article_editions", 8, "body", "clean", 5), { conflict: "detect" });
  q.enqueue(set("article_editions", 9, "note", "lww never conflicts"), { conflict: "lww" });
  const tp = q.allocTempId();
  q.enqueue(insert("article_editions", { title: "born offline" }), { conflict: "detect", tempId: tp });

  const revisions = { "article_editions:7": 6, "article_editions:8": 5 };
  const { clean, conflicted } = q.reconcile(revisions);
  check("a moved revision conflicts the lineage",
    conflicted.length === 1 && conflicted[0][0].envelope.id === 7);
  check("a matching revision is clean", clean.some((l) => l[0].envelope.id === 8));
  check("lww entries never conflict", clean.some((l) => l[0].envelope.id === 9));
  check("an insert lineage cannot conflict (offline-born: nothing to mismatch)",
    clean.some((l) => l[0].envelope.type === "apskel.data.insert"));
}

console.log("\nqueue — the app.sync.* derivation: head conflict from queue + replica");
{
  const q = createQueue({ bindings: BINDINGS });
  q.enqueue(set("article_editions", 7, "body", "my body", 3), { conflict: "detect" });
  q.enqueue(set("article_editions", 7, "title", "my title", 3), { conflict: "detect" });
  const revisions = { "article_editions:7": 6 };
  const replica = { "article_editions:7:body": "their body", "article_editions:7:title": "their title" };

  const c = deriveConflict(q, revisions, replica);
  check("pending counts every conflicted field", c.pending === 2, `${c.pending}`);
  check("the head conflict is the earliest by seq", c.field === "body");
  check("mine is the queued value", c.mine === "my body");
  check("theirs is the replica's value", c.theirs === "their body");
  check("table and id name the collision", c.table === "article_editions" && c.id === 7);
  check("no revision leaks into the derivation", !("revision" in c) && !("baseRevision" in c));

  const none = deriveConflict(createQueue({ bindings: BINDINGS }), revisions, replica);
  check("an empty queue derives no conflict", none === null);
}

console.log("\nqueue — keep-mine / take-theirs: check-then-act, bound to the seen conflict");
{
  const q = createQueue({ bindings: BINDINGS });
  q.enqueue(set("article_editions", 7, "body", "my body", 3), { conflict: "detect" });
  q.enqueue(set("article_editions", 7, "title", "my title", 3), { conflict: "detect" });
  const revisions = { "article_editions:7": 6 };
  const replica = { "article_editions:7:body": "their body", "article_editions:7:title": "their title" };

  // keep-mine pins the ACT-TIME revision (the map is current via echo),
  // not the pull-time one — the ping-pong correction.
  const acted = q.keepMine({ table: "article_editions", id: 7, field: "body" }, 6);
  check("keep-mine acts on the named conflict", acted === true);
  const body = q.entries().find((e) => e.envelope.field === "body");
  check("keep-mine keeps the entry queued (it flushes fresh-lock)", body !== undefined);
  check("keep-mine re-pins the baseRevision to the act-time value", body.envelope.baseRevision === 6);
  const afterKeep = q.reconcile(revisions);
  check("parking is derived: the lineage stays parked while title still conflicts",
    afterKeep.conflicted.length === 1);
  check("the derivation moves to the next conflict",
    deriveConflict(q, revisions, replica).field === "title" &&
    deriveConflict(q, revisions, replica).pending === 1);

  const took = q.takeTheirs({ table: "article_editions", id: 7, field: "title" });
  check("take-theirs removes the entry outright", took === true &&
    !q.entries().some((e) => e.envelope.field === "title"));
  const afterBoth = q.reconcile(revisions);
  check("with every conflict resolved the lineage unparks (nothing bespoke)",
    afterBoth.conflicted.length === 0 && afterBoth.clean.length === 1);
  check("no conflict remains to derive", deriveConflict(q, revisions, replica) === null);
  check("take-theirs does not dead-letter (a choice, not an error)", q.deadLetters().length === 0);
  const again = q.takeTheirs({ table: "article_editions", id: 7, field: "title" });
  check("resolve twice, act once: the second resolution no-ops", again === false);
  const gone = q.takeTheirs({ table: "article_editions", id: 99, field: "body" });
  check("a resolution against a conflict that never existed no-ops", gone === false);
}

console.log("\nqueue — ack, watermark, dead-letter");
{
  const q = createQueue({ bindings: BINDINGS });
  const a = q.enqueue(set("article_editions", 7, "body", "x", 3), { conflict: "detect" });
  const b = q.enqueue(set("article_editions", 8, "body", "y", 3), { conflict: "detect" });
  const c = q.enqueue(set("article_editions", 9, "body", "z", 3), { conflict: "detect" });

  check("before any ack, the watermark sits at the first pending seq", q.dequeuedThrough() === a.seq);
  q.ack(a.seq);
  check("ack dequeues", q.entries().length === 2);
  check("the watermark advances past the acked entry", q.dequeuedThrough() === b.seq);
  q.ack(c.seq);
  check("the watermark is the LOWEST still-unacked seq, not the highest acked",
    q.dequeuedThrough() === b.seq, `got ${q.dequeuedThrough()}`);

  q.deadLetter(b.seq);
  check("dead-letter moves the entry out of the queue", q.entries().length === 0);
  const dead = q.deadLetters();
  check("the dead-lettered payload is recoverable, not deleted",
    dead.length === 1 && dead[0].envelope.value === "y");
  check("with the queue drained, the watermark passes everything", q.dequeuedThrough() > c.seq);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
