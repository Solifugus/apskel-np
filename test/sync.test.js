// test/sync.test.js — Phase 10.2 harness, slice C: the server side of the
// offline queue — sync_receipts idempotency, the idempotent delete, the
// dequeuedThrough watermark prune. DB-free (fake db records SQL and plays
// a receipts store); the real-PostgreSQL pass is personal verification
// per the development plan.
//
//   node test/sync.test.js
//
// Encodes the Q4 entries: a receipt row per flushed insert, committed in
// the insert's OWN statement (one CTE — the setMembers discipline: the
// shared connection means multi-statement transactions could interleave);
// a replayed key answers the ORIGINAL assigned id with no second insert
// and nothing to broadcast; delete answers success on an already-missing
// row (insert is the only non-idempotent verb) while a present-but-
// unowned row still 403s (unowned = locked); the prune deletes receipts
// below the client's watermark, device_id always from the TOKEN, never
// the envelope; a tokenless app ignores sync entirely (sync.sql is only
// applied when identity is).

import express from "express";
import { attachWire } from "../server/wireServer.js";
import { createAuth } from "../server/authServer.js";

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

const DEVICE = "11111111-2222-3333-4444-555555555555";
const DB_NAME = "apskel:kf:7";

// A fake db that actually plays the receipts store, so replay is
// testable end-to-end: the claim SELECT hits it, the CTE writes it, the
// PK backstop throws on a duplicate exactly as PostgreSQL would.
function makeFakeDb() {
  const receipts = new Map(); // "db#device#seq" → assigned_id
  const queries = [];
  let nextId = 42;
  const db = {
    receipts,
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT assigned_id FROM sync_receipts")) {
        const key = params.join("#");
        return receipts.has(key)
          ? { rows: [{ assigned_id: receipts.get(key) }] }
          : { rows: [] };
      }
      if (sql.startsWith("WITH ins AS (INSERT INTO")) {
        // The atomic pair: params tail is db, device_id, seq, table_name.
        const n = params.length;
        const key = `${params[n - 4]}#${params[n - 3]}#${params[n - 2]}`;
        if (receipts.has(key)) {
          throw new Error('duplicate key value violates unique constraint "sync_receipts_pkey"');
        }
        const id = nextId++;
        receipts.set(key, id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM sync_receipts")) {
        return { rowCount: 3, rows: [] };
      }
      if (sql.includes("AS owner")) {
        const id = params[0];
        if (id === 5) return { rows: [{ owner: 7 }] };
        if (id === 555) return { rows: [{ owner: null }] }; // present, unowned
        return { rows: [] }; // missing
      }
      if (sql.startsWith("SELECT 1 FROM")) {
        return params[0] === 555 ? { rows: [{ "?column?": 1 }] } : { rows: [] };
      }
      if (sql.startsWith("DELETE FROM")) {
        return params[0] === 999 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("INSERT INTO")) {
        return { rows: [{ id: nextId++ }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE")) {
        return { rowCount: 1, rows: [{ revision: 2 }] };
      }
      return { rows: [] };
    },
  };
  return db;
}

function makeServer({ withAuth = true } = {}) {
  const db = makeFakeDb();
  const auth = withAuth ? createAuth({ db: { query: async () => ({ rows: [] }) } }) : null;
  const app = express();
  attachWire(app, {
    db,
    bound: [
      { path: "app.doc.title", table: "articles", record: 5, field: "title", conflict: null },
    ],
    auth,
    permissions: withAuth
      ? [{ table: "articles", read: "users", write: "owner", hops: [{ child: "articles", parent: "users", via: null, column: "created_by" }] }]
      : [],
    collections: [
      { path: "app.list", table: "articles", query: null, filter: null, order: null, limit: null, columns: ["title"] },
      { path: "app.board", table: "messages", query: null, filter: null, order: null, limit: null, columns: ["body"] },
    ],
    insertStamps: new Map([["articles", "created_by"], ["messages", null]]),
    log: { error: () => {}, warn: () => {} },
  });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const post = (body, token) =>
    fetch(`${base}/wire`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const token = withAuth ? auth.mintToken(7, DEVICE) : null;
  return { db, server, post, token };
}

console.log("sync — the receipt path: one atomic statement, replay answers the original");
{
  const { db, server, post, token } = makeServer();

  db.queries.length = 0;
  const first = await post(
    { type: "apskel.data.insert", table: "articles", values: { title: "born offline" }, sync: { db: DB_NAME, seq: 12 } },
    token
  );
  const firstBody = await first.json();
  check("a fresh key inserts and answers the assigned id", first.status === 200 && firstBody.id === 42);
  const claim = db.queries.find((q) => q.sql.startsWith("SELECT assigned_id FROM sync_receipts"));
  check("the claim checks (db, device_id, seq) with device_id from the TOKEN",
    claim && eq(claim.params, [DB_NAME, DEVICE, 12]), JSON.stringify(claim?.params));
  const cte = db.queries.find((q) => q.sql.startsWith("WITH ins AS (INSERT INTO"));
  check("the data insert and the receipt commit in ONE statement (the setMembers discipline)",
    cte && cte.sql.includes('INSERT INTO "articles"') && cte.sql.includes("INSERT INTO sync_receipts"),
    cte?.sql);
  check("ownership is still stamped from the token inside the receipted insert",
    cte && cte.params.includes(7), JSON.stringify(cte?.params));
  check("the receipt records the table name for integrity",
    cte && cte.params.includes("articles"));

  db.queries.length = 0;
  const replay = await post(
    { type: "apskel.data.insert", table: "articles", values: { title: "born offline" }, sync: { db: DB_NAME, seq: 12 } },
    token
  );
  const replayBody = await replay.json();
  check("a replayed key answers 200 with the ORIGINAL assigned id", replay.status === 200 && replayBody.id === 42);
  check("the replay is marked so the client can heal its temp id", replayBody.replayed === true);
  check("the replay runs NO second data insert (and therefore broadcasts nothing)",
    !db.queries.some((q) => q.sql.includes("WITH ins AS")), JSON.stringify(db.queries.map((q) => q.sql)));

  const next = await post(
    { type: "apskel.data.insert", table: "articles", values: { title: "another" }, sync: { db: DB_NAME, seq: 13 } },
    token
  );
  const nextBody = await next.json();
  check("a different seq is a different insert", next.status === 200 && nextBody.id === 43);

  const bare = await post(
    { type: "apskel.data.insert", table: "articles", values: { title: "online, no queue" } },
    token
  );
  check("an insert without sync stays the plain non-receipted path", bare.status === 200 &&
    !db.queries.filter((q) => q.params.includes("online, no queue")).some((q) => q.sql.includes("sync_receipts")));

  server.close();
}

console.log("\nsync — a tokenless app ignores sync entirely");
{
  const { db, server, post } = makeServer({ withAuth: false });
  const r = await post({ type: "apskel.data.insert", table: "messages", values: { body: "hi" }, sync: { db: DB_NAME, seq: 1 } });
  check("the insert succeeds", r.status === 200);
  check("no receipts SQL is ever issued without identity (sync.sql is not even applied there)",
    !db.queries.some((q) => q.sql.includes("sync_receipts")), JSON.stringify(db.queries.map((q) => q.sql)));
  server.close();
}

console.log("\nsync — delete is idempotent: missing answers success, unowned still locks");
{
  const { db, server, post, token } = makeServer();

  const missing = await post({ type: "apskel.data.delete", table: "messages", id: 999 }, token);
  check("deleting an already-missing row answers success, not 404 (the crash-retry path)",
    missing.status === 200 && (await missing.json()).ok === true);

  const missingOwned = await post({ type: "apskel.data.delete", table: "articles", id: 999 }, token);
  check("a missing row on an owner-ruled table also answers success — nothing left to protect",
    missingOwned.status === 200, `status ${missingOwned.status}`);

  const unowned = await post({ type: "apskel.data.delete", table: "articles", id: 555 }, token);
  check("a PRESENT but unowned row still 403s (unowned = locked, unchanged)",
    unowned.status === 403, `status ${unowned.status}`);

  const owned = await post({ type: "apskel.data.delete", table: "articles", id: 5 }, token);
  check("the owner's delete still deletes", owned.status === 200);

  server.close();
}

console.log("\nsync — the dequeuedThrough watermark prunes receipts below it");
{
  const { db, server, post, token } = makeServer();

  db.queries.length = 0;
  await post(
    { type: "apskel.data.insert", table: "articles", values: { title: "x" }, sync: { db: DB_NAME, seq: 20, dequeuedThrough: 9 } },
    token
  );
  let prune = db.queries.find((q) => q.sql.startsWith("DELETE FROM sync_receipts"));
  check("an insert carrying the watermark prunes below it",
    prune && eq(prune.params, [DB_NAME, DEVICE, 9]), JSON.stringify(prune?.params));

  db.queries.length = 0;
  await post(
    { type: "apskel.data.set", table: "articles", id: 5, field: "title", value: "t", sync: { db: DB_NAME, dequeuedThrough: 15 } },
    token
  );
  prune = db.queries.find((q) => q.sql.startsWith("DELETE FROM sync_receipts"));
  check("a set carrying the watermark prunes too (any flush traffic carries it)",
    prune && eq(prune.params, [DB_NAME, DEVICE, 15]), JSON.stringify(prune?.params));

  db.queries.length = 0;
  await post({ type: "apskel.data.delete", table: "articles", id: 5, sync: { db: DB_NAME, dequeuedThrough: 21 } }, token);
  prune = db.queries.find((q) => q.sql.startsWith("DELETE FROM sync_receipts"));
  check("a delete carrying the watermark prunes too",
    prune && eq(prune.params, [DB_NAME, DEVICE, 21]), JSON.stringify(prune?.params));

  db.queries.length = 0;
  await post({ type: "apskel.data.set", table: "articles", id: 5, field: "title", value: "anon", sync: { db: DB_NAME, dequeuedThrough: 30 } });
  check("no token, no prune — device_id comes from identity or not at all",
    !db.queries.some((q) => q.sql.startsWith("DELETE FROM sync_receipts")));

  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
