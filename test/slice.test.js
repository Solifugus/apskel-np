// test/slice.test.js — Phase 6 harness: the v0.1 slice, DB-free.
//
//   node test/slice.test.js
//
// A stateful fake db carries the article_editions revision counter; the six
// acceptance criteria themselves are personal verification against
// apps/knowledge-foyer, per the plan. Asserts the outcomes in
// test/fixtures/README.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { collectBoundFields } from "../runtime/serialize.js";
import { createStore } from "../runtime/store.js";
import { WatcherEngine } from "../runtime/watchers.js";
import { attachWireSend, attachWireReceive } from "../runtime/wireClient.js";
import { attachWire } from "../server/wireServer.js";
import { createAuth } from "../server/authServer.js";

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repoDir, "test", "fixtures");

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

function expectLoadFailure(fixture, label, substrings) {
  try {
    resolveReferences(loadApp(path.join(fixturesDir, fixture, "app.xml")));
    check(`${fixture}: ${label}`, false, "loaded without error but must fail");
  } catch (e) {
    if (!(e instanceof ApskelLoadError)) throw e;
    const missing = substrings.filter((s) => !e.message.includes(s));
    check(
      `${fixture}: ${label}`,
      missing.length === 0,
      missing.length ? `message lacks ${JSON.stringify(missing)}; got: ${e.message}` : undefined
    );
    console.log(`      error reads: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log("knowledge-foyer — bindings, criterion 6's path, the conflict menu");

const root = resolveReferences(loadApp(path.join(repoDir, "apps", "knowledge-foyer", "app.xml")));
const bound = collectBoundFields(root);

// Phase 7.1: knowledge-foyer's contexts became dynamic (record=
// "app.currentEditionId"). Phase 9 (KF v1.0): the reader pane went
// query-sourced (collectQueryBound territory, no longer here), the
// publish bar joined with its function-arg bound fields (article_id/
// title/body ride the next-edition create action), and the exposition
// view is a second dynamic record context — the criterion-6 path
// app.workspace.articleEditor.title is unchanged.
const dynamicEntry = (ctx, field) => ({
  storePath: `${ctx}.${field}`,
  path: ctx,
  table: "article_editions",
  record: null,
  field,
  conflict: "detect",
  recordPath: "app.currentEditionId",
});
const expoEntry = (ctx, field) => ({
  storePath: `${ctx}.${field}`,
  path: ctx,
  table: "expositions",
  record: null,
  field,
  conflict: "offline-readonly",
  recordPath: "app.currentExpositionId",
});
check(
  "bound metadata: editor pane, publish bar, exposition view — dynamic records, detect on editions",
  eq(bound, [
    dynamicEntry("app.workspace.articleEditor", "title"),
    dynamicEntry("app.workspace.articleEditor", "body"),
    dynamicEntry("app.workspace.pubBar", "status"),
    dynamicEntry("app.workspace.pubBar", "article_id"),
    dynamicEntry("app.workspace.pubBar", "title"),
    dynamicEntry("app.workspace.pubBar", "body"),
    expoEntry("app.expositionView", "title"),
    expoEntry("app.expositionView", "description"),
  ]),
  JSON.stringify(bound)
);

expectLoadFailure("fail-bad-conflict", "conflict outside the closed menu fails at load", [
  "unknown conflict policy 'merge'",
  "offline-readonly, detect, lww",
]);

// Criterion 1: the three deliberate breaks against the FULL app.
expectLoadFailure("kf-broken-name", "bad name fails naming the site", [
  "named reference 'articleEditorX' does not match any component",
  "kf-broken-name/app.xml:14",
]);
expectLoadFailure("kf-broken-ancestor", "missing ^ancestor fails naming the site", [
  "no enclosing ancestor named 'workspace'",
  "kf-broken-ancestor/app.xml:18",
]);
expectLoadFailure("kf-broken-ambiguous", "ambiguous name fails listing candidates", [
  "named reference 'articleEditor' is ambiguous app-wide",
  "app.workspace.articleEditor",
  "app.scratchpad.articleEditor",
]);

// ---------------------------------------------------------------------------
console.log("\nfire counters — echo suppression as a number, not a claim");

{
  const store = createStore();
  const engine = new WatcherEngine(store);
  const sent = [];
  const revisions = new Map([["article_editions:1", 5]]);
  store.seed("app.currentEditionId", 1); // the dynamic contexts' selected row
  attachWireSend({ engine, bound, clientId: "tab-me", revisions, send: (e) => sent.push(e) });
  engine.watch({
    name: "display",
    fields: ["app.workspace.articleEditor.title"],
    run: () => {},
  });

  const TITLE = "app.workspace.articleEditor.title";
  const WIRE = `wire:${TITLE}`;

  store.set(TITLE, "Hello", "user");
  store.set(TITLE, "Hello w", "user");
  check(
    "two user keystrokes: wire and display watchers fired twice each",
    engine.fireCount(WIRE) === 2 && engine.fireCount("display") === 2,
    JSON.stringify(engine.fireCounts())
  );

  store.applyServerWrite(TITLE, "From elsewhere");
  check(
    "server-origin change: display fired (3), wire send did NOT (still 2)",
    engine.fireCount("display") === 3 && engine.fireCount(WIRE) === 2,
    JSON.stringify(engine.fireCounts())
  );
  check("and nothing was sent for it", sent.length === 2);

  // --- revision bookkeeping on the send/receive paths ---
  check(
    "detect sends carry baseRevision from the bookkeeping (5)",
    sent[0].baseRevision === 5 && sent[1].baseRevision === 5,
    JSON.stringify(sent)
  );

  const handle = attachWireReceive({ store, bound, clientId: "tab-me", revisions });
  const echo = handle({
    type: "apskel.data.changed",
    table: "article_editions",
    id: 1,
    field: "title",
    value: "Hello w",
    revision: 6,
    sourceClient: "tab-me",
  });
  check(
    "own echo: store write ignored, revision adopted (6)",
    echo === "echo" && revisions.get("article_editions:1") === 6
  );
  store.set(TITLE, "Hello world", "user");
  check(
    "next send is based on the echoed revision — no false conflict",
    sent[2].baseRevision === 6,
    JSON.stringify(sent[2])
  );

  const foreign = handle({
    type: "apskel.data.changed",
    table: "article_editions",
    id: 1,
    field: "title",
    value: "Theirs",
    revision: 7,
    sourceClient: "tab-other",
  });
  check(
    "foreign change: applied to the store AND revision adopted (7)",
    foreign === "applied" &&
      store.get(TITLE) === "Theirs" &&
      revisions.get("article_editions:1") === 7
  );
}

// ---------------------------------------------------------------------------
console.log("\nserver — guarded updates, 409 with current revision, data.get");

{
  // Stateful fake: the one article_editions row, with a real revision
  // counter, so the optimistic-concurrency guard is exercised for real.
  const row = { title: "", body: "", revision: 0 };
  const fakeDb = {
    query: async (sql, params = []) => {
      const field = (sql.match(/"(title|body)"/) || [])[1];
      if (sql.startsWith('UPDATE "article_editions"') && sql.includes("revision = revision + 1")) {
        const [value, id, baseRevision] = params;
        if (id !== 1 || baseRevision !== row.revision) return { rowCount: 0, rows: [] };
        row[field] = value;
        row.revision += 1;
        return { rowCount: 1, rows: [{ revision: row.revision }] };
      }
      if (sql.startsWith('SELECT revision FROM "article_editions"')) {
        return params[0] === 1 ? { rowCount: 1, rows: [{ revision: row.revision }] } : { rowCount: 0, rows: [] };
      }
      if (sql.startsWith("SELECT") && sql.includes("AS value")) {
        if (params[0] !== 1) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ value: row[field], revision: row.revision }] };
      }
      throw new Error(`fake db has no answer for: ${sql}`);
    },
  };

  const auth = createAuth({ db: fakeDb });
  const app = express();
  attachWire(app, { db: fakeDb, bound, auth, log: { error: () => {} } });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const token = auth.mintToken(1, "11111111-2222-3333-4444-555555555555");
  const post = (body, withToken = true) =>
    fetch(`${base}/wire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(withToken ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  // Phase 7.2: with identity attached, the default read rule is 'users' —
  // an anonymous SSE connection no longer hears this broadcast, so the
  // listener identifies itself the way a real client now does.
  const sse = await fetch(`${base}/events?token=${encodeURIComponent(token)}`);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function nextSseData() {
    for (let i = 0; i < 50; i++) {
      const line = buffer.split("\n").find((l) => l.startsWith("data: "));
      if (line) {
        buffer = "";
        return JSON.parse(line.slice(6));
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value);
    }
    return null;
  }

  const setEnvelope = (value, baseRevision) => ({
    type: "apskel.data.set",
    table: "article_editions",
    id: 1,
    field: "title",
    value,
    baseRevision,
    sourceClient: "tab-A",
  });

  const ok = await post(setEnvelope("Draft one", 0));
  const okBody = await ok.json();
  check(
    "correct baseRevision: 200, revision incremented to 1",
    ok.status === 200 && okBody.ok === true && okBody.revision === 1 && row.revision === 1,
    JSON.stringify(okBody)
  );
  const broadcastEnv = await nextSseData();
  check(
    "broadcast carries the NEW revision",
    broadcastEnv?.revision === 1 && broadcastEnv?.value === "Draft one",
    JSON.stringify(broadcastEnv)
  );

  const stale = await post(setEnvelope("Stale write", 0));
  const staleBody = await stale.json();
  check(
    "stale baseRevision: 409 with currentRevision, row untouched",
    stale.status === 409 && staleBody.currentRevision === 1 && row.title === "Draft one",
    JSON.stringify(staleBody)
  );

  const missing = await post({ ...setEnvelope("No base", 0), baseRevision: undefined });
  check("missing baseRevision on a detect context: 400", missing.status === 400);

  const get = await post({ type: "apskel.data.get", table: "article_editions", id: 1, field: "title" });
  const getBody = await get.json();
  check(
    "data.get returns value + revision for the detect context",
    get.status === 200 && eq(getBody, { ok: true, value: "Draft one", revision: 1 }),
    JSON.stringify(getBody)
  );

  const getUnbound = await post({ type: "apskel.data.get", table: "pg_shadow", id: 1, field: "passwd" });
  check("data.get outside the allowlist: 400", getUnbound.status === 400);

  const getNoToken = await post(
    { type: "apskel.data.get", table: "article_editions", id: 1, field: "title" },
    false
  );
  check("tokenless data.get with identity attached: 401", getNoToken.status === 401);

  await reader.cancel();
  server.close();
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
