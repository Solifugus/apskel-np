// test/wire.test.js — Phase 4 harness: the Wire, DB-free.
//
//   node test/wire.test.js
//
// The database sits behind a narrow injected fake that records queries;
// real PostgreSQL round-trips are the developer's personal verification in
// psql, per the plan. Asserts the outcomes in test/fixtures/README.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadApp } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { collectBoundFields } from "../runtime/serialize.js";
import { createStore } from "../runtime/store.js";
import { WatcherEngine } from "../runtime/watchers.js";
import { attachWireSend, attachWireReceive } from "../runtime/wireClient.js";
import { attachWire } from "../server/wireServer.js";

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

// ---------------------------------------------------------------------------
console.log("notes-demo — bound-field wire metadata");

const root = resolveReferences(loadApp(path.join(repoDir, "apps", "notes-demo", "app.xml")));
const bound = collectBoundFields(root);

check(
  "bound fields collect: title and body of notes row 1 at app.editor.*",
  eq(bound, [
    { storePath: "app.editor.title", path: "app.editor", table: "notes", record: 1, field: "title" },
    { storePath: "app.editor.body", path: "app.editor", table: "notes", record: 1, field: "body" },
  ]),
  JSON.stringify(bound)
);

// ---------------------------------------------------------------------------
console.log("\nsend path — the Phase 2 seam becomes the Wire send");

{
  const store = createStore();
  const engine = new WatcherEngine(store);
  const sent = [];
  attachWireSend({ engine, bound, clientId: "tab-me", send: (env) => sent.push(env) });

  store.set("app.editor.title", "hello", "user");
  check(
    "one keystroke -> one apskel.data.set envelope after settle",
    sent.length === 1 &&
      eq(sent[0], {
        type: "apskel.data.set",
        path: "app.editor",
        table: "notes",
        id: 1,
        field: "title",
        value: "hello",
        sourceClient: "tab-me",
      }),
    JSON.stringify(sent)
  );

  // Two writes to the same bound field within ONE cascade coalesce to one
  // envelope with the last value.
  sent.length = 0;
  engine.watch({
    name: "burst",
    fields: ["app.kick"],
    run: (ctx) => {
      ctx.set("app.editor.title", "a");
      ctx.set("app.editor.title", "ab");
    },
  });
  store.set("app.kick", 1, "user");
  check(
    "two same-field writes in one cascade -> ONE envelope, last value wins",
    sent.length === 1 && sent[0].value === "ab",
    JSON.stringify(sent)
  );

  sent.length = 0;
  store.applyServerWrite("app.editor.title", "from-server");
  check("server-origin change sends NOTHING (echo suppression)", sent.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\nreceive path — echo recognized, foreign changes applied as 'server'");

{
  const store = createStore();
  new WatcherEngine(store);
  const handle = attachWireReceive({ store, bound, clientId: "tab-me" });

  const echo = handle({
    type: "apskel.data.changed",
    table: "notes",
    id: 1,
    field: "title",
    value: "stale",
    sourceClient: "tab-me",
  });
  check(
    "own echo ignored, store untouched",
    echo === "echo" && store.get("app.editor.title") === undefined
  );

  const applied = handle({
    type: "apskel.data.changed",
    table: "notes",
    id: 1,
    field: "title",
    value: "from tab B",
    sourceClient: "tab-other",
  });
  check(
    "foreign change applied via applyServerWrite",
    applied === "applied" && store.get("app.editor.title") === "from tab B"
  );

  const unbound = handle({
    type: "apskel.data.changed",
    table: "mystery",
    id: 9,
    field: "x",
    value: 1,
    sourceClient: "tab-other",
  });
  check("unbound table/field ignored without error", unbound === "unbound");
}

// ---------------------------------------------------------------------------
console.log("\nserver dispatch — allowlist, broadcast with sourceClient, survival");

{
  const queries = [];
  const fakeDb = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
  const app = express();
  attachWire(app, { db: fakeDb, bound, log: { error: () => {} } });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;

  // SSE subscriber first, so the broadcast has somewhere to land.
  const sseResponse = await fetch(`${base}/events`);
  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  async function nextSseData(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const dataLine = sseBuffer.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        sseBuffer = "";
        return JSON.parse(dataLine.slice(6));
      }
      const { value, done } = await reader.read();
      if (done) return null;
      sseBuffer += decoder.decode(value);
    }
    return null;
  }

  const post = (body, raw = false) =>
    fetch(`${base}/wire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? body : JSON.stringify(body),
    });

  const ok = await post({
    type: "apskel.data.set",
    table: "notes",
    id: 1,
    field: "title",
    value: "persisted",
    sourceClient: "tab-A",
  });
  const okBody = await ok.json();
  check("valid apskel.data.set accepted", ok.status === 200 && okBody.ok === true);
  check(
    "UPDATE hit the (fake) database with parameterized values",
    queries.length === 1 &&
      queries[0].sql === 'UPDATE "notes" SET "title" = $1 WHERE id = $2' &&
      eq(queries[0].params, ["persisted", 1]),
    JSON.stringify(queries)
  );

  const broadcastEnv = await nextSseData();
  check(
    "accepted write broadcast over SSE with sourceClient (originator included)",
    eq(broadcastEnv, {
      type: "apskel.data.changed",
      path: "app.editor",
      table: "notes",
      id: 1,
      field: "title",
      value: "persisted",
      sourceClient: "tab-A",
    }),
    JSON.stringify(broadcastEnv)
  );

  const malformed = await post("{this is not json", true);
  const malformedBody = await malformed.json();
  check(
    "malformed JSON -> 400 with coherent body",
    malformed.status === 400 && malformedBody.ok === false,
    JSON.stringify(malformedBody)
  );

  const unknown = await post({ type: "no.such.type" });
  check("unknown wire type -> 400", unknown.status === 400);

  queries.length = 0;
  const forbidden = await post({
    type: "apskel.data.set",
    table: "pg_shadow",
    id: 1,
    field: "passwd",
    value: "x",
  });
  check(
    "table/field outside the app's bindings -> 400, DB untouched",
    forbidden.status === 400 && queries.length === 0
  );

  const survives = await post({
    type: "apskel.data.set",
    table: "notes",
    id: 1,
    field: "body",
    value: "still alive",
    sourceClient: "tab-A",
  });
  check("server still answers after the abuse", survives.status === 200);

  await reader.cancel();
  server.close();
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
