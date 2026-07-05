// test/mv.test.js — Phase 7.3 harness: multi-value fields, DB-free.
//
//   node test/mv.test.js
//
// Loader: edge classification by graph declaration, the four load
// failures naming their sites. Startup: resolveSetFieldEdges against fake
// introspection (the schema-variant fixtures under test/fixtures/startup-*
// are the developer's terminal verification). Wire: whole-set replace in
// one statement, canonical order, parent-row permissions, options.
// Expected outcomes in test/fixtures/README.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { collectSetFields } from "../runtime/serialize.js";
import { createStore } from "../runtime/store.js";
import { WatcherEngine } from "../runtime/watchers.js";
import {
  attachWireSend,
  attachWireReceive,
  attachRecordContexts,
  sortMembers,
} from "../runtime/wireClient.js";
import { attachWire, resolveSetFieldEdges } from "../server/wireServer.js";
import { createAuth } from "../server/authServer.js";

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => path.join(repoDir, "test", "fixtures", name, "app.xml");

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

function expectLoadFailure(name, label, substrings) {
  try {
    resolveReferences(loadApp(fixture(name)));
    check(`${name}: ${label}`, false, "loaded without error but must fail");
  } catch (e) {
    if (!(e instanceof ApskelLoadError)) throw e;
    const missing = substrings.filter((s) => !e.message.includes(s));
    check(
      `${name}: ${label}`,
      missing.length === 0,
      missing.length ? `message lacks ${JSON.stringify(missing)}; got: ${e.message}` : undefined
    );
    console.log(`      error reads: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log("edge-domain — classification by graph declaration, at load");

const root = resolveReferences(loadApp(fixture("edge-domain")));
const setFields = collectSetFields(root);

check(
  "one set field: articles->tags at the context's own store path",
  setFields.length === 1 &&
    setFields[0].storePath === "app.editor.tags" &&
    setFields[0].table === "articles" &&
    setFields[0].edge === "tags" &&
    setFields[0].record === 1 &&
    setFields[0].stored === "id" &&
    setFields[0].label === "name" &&
    eq(setFields[0].options, { table: "tags", value: "id", label: "name" }),
  JSON.stringify(setFields)
);

{
  const kf = resolveReferences(loadApp(path.join(repoDir, "apps", "knowledge-foyer", "app.xml")));
  const kfSets = collectSetFields(kf);
  check(
    "knowledge-foyer v0.4: the tag picker is an edge-bound set field",
    kfSets.length === 1 &&
      kfSets[0].table === "articles" &&
      kfSets[0].edge === "tags" &&
      kfSets[0].storePath === "app.workspace.tagBox.tags",
    JSON.stringify(kfSets)
  );
}

// ---------------------------------------------------------------------------
console.log("\nload failures — domain mandatory, arrow form, no literals, owner walk");

expectLoadFailure("fail-edge-no-domain", "edge reference requires a domain", [
  "edge reference",
  "requires a domain",
  "fail-edge-no-domain/app.xml:6",
]);

expectLoadFailure("fail-edge-bare-form", "arrow form is mandatory on an edge", [
  "arrow form is mandatory",
  "not the author's choice",
  "fail-edge-bare-form/app.xml:6",
]);

expectLoadFailure("fail-edge-literal", "a literal cannot be a membership row", [
  "literal cannot be a membership row",
  "fail-edge-literal/app.xml:6",
]);

expectLoadFailure("fail-owner-past-join", "the owner walk refuses to cross a join edge", [
  "crosses the join edge articles->tags",
  "join edges confer no ownership",
  "fail-owner-past-join/app.xml:15",
  "fail-owner-past-join/app.xml:6",
]);

// ---------------------------------------------------------------------------
console.log("\nstore — ordered-element array equality (set equality via canonical order)");

{
  const store = createStore();
  let fires = 0;
  store.onChange(() => fires++);
  store.set("app.x.tags", [1, 3], "user");
  store.applyServerWrite("app.x.tags", [1, 3]);
  check("re-applying an identical member array does not notify", fires === 1, `fires=${fires}`);
  store.applyServerWrite("app.x.tags", [1, 2]);
  check("a genuinely different set notifies", fires === 2, `fires=${fires}`);
  store.applyServerWrite("app.x.tags", [1, 2, 3]);
  check("a longer set notifies", fires === 3, `fires=${fires}`);
}

// ---------------------------------------------------------------------------
console.log("\nstartup — resolveSetFieldEdges against fake introspection");

function fakeIntroDb({ columns = {}, fks = {}, types = {} } = {}) {
  return {
    query: async (sql, params = []) => {
      if (sql.includes("udt_name")) {
        return { rows: [{ udt_name: types[`${params[0]}.${params[1]}`] ?? "int4" }] };
      }
      if (sql.includes("information_schema.columns")) {
        return { rows: columns[`${params[0]}.${params[1]}`] ? [{ column_name: params[1] }] : [] };
      }
      if (sql.includes("FOREIGN KEY")) {
        return { rows: fks[params[0]] ?? [] };
      }
      throw new Error(`fake introspection has no answer for: ${sql}`);
    },
  };
}

const baseEntry = () => ({
  storePath: "app.editor.tags",
  path: "app.editor",
  table: "articles",
  edge: "tags",
  record: 1,
  stored: "id",
  label: "name",
  join: null,
  options: { table: "tags", value: "id", label: "name" },
  site: { file: "app.xml", line: 6, ref: "{.tags: tags.id->tags.name}" },
});

async function expectStartupError(label, db, entry, substrings, nodes = new Map()) {
  try {
    await resolveSetFieldEdges(db, [entry], nodes);
    check(label, false, "resolved without error but must fail");
  } catch (e) {
    const missing = substrings.filter((s) => !e.message.includes(s));
    check(label, missing.length === 0, missing.length ? `lacks ${JSON.stringify(missing)}; got: ${e.message}` : undefined);
  }
}

{
  const goodFks = {
    articles: [{ child_table: "article_tags", col: "article_id", ref_col: "id" }],
    tags: [{ child_table: "article_tags", col: "tag_id", ref_col: "id" }],
  };
  const s = baseEntry();
  await resolveSetFieldEdges(fakeIntroDb({ fks: goodFks }), [s]);
  check(
    "a single join candidate resolves: table, columns, member type",
    s.joinTable === "article_tags" &&
      s.parentColumn === "article_id" &&
      s.childColumn === "tag_id" &&
      s.memberType === "int4",
    JSON.stringify(s)
  );

  await expectStartupError(
    "declared edge vs actual column collision names both",
    fakeIntroDb({ columns: { "articles.tags": true }, fks: goodFks }),
    baseEntry(),
    ["column 'articles.tags'", "collides with the declared graph edge", "app.xml:6"]
  );

  await expectStartupError(
    "no join table and no FK is a startup error",
    fakeIntroDb(),
    baseEntry(),
    ["no join table between articles and tags"]
  );

  await expectStartupError(
    "a one-to-many FK edge cannot be a set field",
    fakeIntroDb({ fks: { articles: [{ child_table: "tags", col: "article_id", ref_col: "id" }] } }),
    baseEntry(),
    ["one-to-many", "join-table relationship"]
  );

  const twoFks = {
    articles: [
      { child_table: "map_a", col: "article_id", ref_col: "id" },
      { child_table: "map_b", col: "article_id", ref_col: "id" },
    ],
    tags: [
      { child_table: "map_a", col: "tag_id", ref_col: "id" },
      { child_table: "map_b", col: "tag_id", ref_col: "id" },
    ],
  };
  await expectStartupError(
    "two candidates without join= names both",
    fakeIntroDb({ fks: twoFks }),
    baseEntry(),
    ["ambiguous join tables", "map_a", "map_b", "join="]
  );

  const picked = { ...baseEntry(), join: "map_b" };
  await resolveSetFieldEdges(fakeIntroDb({ fks: twoFks }), [picked]);
  check("join= picks among candidates", picked.joinTable === "map_b", JSON.stringify(picked));

  await expectStartupError(
    "join= naming a non-candidate is a startup error",
    fakeIntroDb({ fks: twoFks }),
    { ...baseEntry(), join: "nope" },
    ["join='nope'", "map_a", "map_b"]
  );

  await expectStartupError(
    "stored column must equal the join FK's referenced column",
    fakeIntroDb({
      fks: {
        articles: [{ child_table: "article_tags", col: "article_id", ref_col: "id" }],
        tags: [{ child_table: "article_tags", col: "tag_id", ref_col: "id" }],
      },
    }),
    { ...baseEntry(), stored: "name" },
    ["stores tags.name", "references tags.id", "not the author's choice"]
  );

  await expectStartupError(
    "a join table declared as a graph node is a startup error",
    fakeIntroDb({ fks: goodFks }),
    baseEntry(),
    ["'article_tags' is a declared", "never graph nodes"].map((x) => x.replace("is a declared", "is declared as a graph node")),
    new Map([["article_tags", { file: "app.xml", line: 20 }]])
  );
}

// ---------------------------------------------------------------------------
console.log("\nsend path — a toggle is ONE coalesced whole-set envelope, sorted");

{
  const store = createStore();
  const engine = new WatcherEngine(store);
  const sent = [];
  const sf = [{ ...baseEntry(), joinTable: "article_tags", parentColumn: "article_id", childColumn: "tag_id", memberType: "int4" }];
  attachWireSend({ engine, bound: [], setFields: sf, clientId: "tab-me", send: (e) => sent.push(e) });

  store.set("app.editor.tags", [3, 1], "user");
  check(
    "one toggle -> one setMembers envelope with canonically sorted members",
    sent.length === 1 &&
      eq(sent[0], {
        type: "apskel.data.setMembers",
        path: "app.editor",
        table: "articles",
        id: 1,
        edge: "tags",
        members: [1, 3],
        sourceClient: "tab-me",
      }),
    JSON.stringify(sent)
  );

  sent.length = 0;
  engine.watch({
    name: "burst",
    fields: ["app.kick"],
    run: (ctx) => {
      ctx.set("app.editor.tags", [1]);
      ctx.set("app.editor.tags", [1, 2]);
    },
  });
  store.set("app.kick", 1, "user");
  check(
    "two set writes in one cascade coalesce to ONE envelope, last set wins",
    sent.length === 1 && eq(sent[0].members, [1, 2]),
    JSON.stringify(sent)
  );

  sent.length = 0;
  store.applyServerWrite("app.editor.tags", [9]);
  check("server-origin members change sends NOTHING (echo suppression)", sent.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\nreceive path — membersChanged applied as server origin, echo recognized");

{
  const store = createStore();
  const engine = new WatcherEngine(store);
  const sf = [{ ...baseEntry() }];
  const handle = attachWireReceive({ store, bound: [], setFields: sf, clientId: "tab-me" });

  let displayFires = 0;
  engine.watch({ name: "chips", fields: ["app.editor.tags"], run: () => displayFires++ });

  const applied = handle({
    type: "apskel.data.membersChanged",
    table: "articles",
    id: 1,
    edge: "tags",
    members: [1, 3],
    sourceClient: "tab-other",
  });
  check(
    "foreign membersChanged applies to the store, display repaints",
    applied === "applied" && eq(store.get("app.editor.tags"), [1, 3]) && displayFires === 1
  );

  const echo = handle({
    type: "apskel.data.membersChanged",
    table: "articles",
    id: 1,
    edge: "tags",
    members: [1, 3],
    sourceClient: "tab-me",
  });
  check("own echo ignored", echo === "echo" && displayFires === 1);

  const refetch = handle({
    type: "apskel.data.membersChanged",
    table: "articles",
    id: 1,
    edge: "tags",
    members: [1, 3],
    sourceClient: "tab-other",
  });
  check(
    "a refetch/rebroadcast of an UNCHANGED set does not cascade (canonical order + array equality)",
    refetch === "applied" && displayFires === 1,
    `displayFires=${displayFires}`
  );

  const otherRow = handle({
    type: "apskel.data.membersChanged",
    table: "articles",
    id: 99,
    edge: "tags",
    members: [2],
    sourceClient: "tab-other",
  });
  check("a broadcast for another row is unbound", otherRow === "unbound");
}

// ---------------------------------------------------------------------------
console.log("\nserver — one-statement diff, parent-row permissions, options");

{
  const queries = [];
  const owner = { value: 7 };
  const fakeDb = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes("AS owner")) return { rows: owner.value === null ? [] : [{ owner: owner.value }] };
      if (sql.includes("AS member")) return { rows: [{ member: 1 }, { member: 3 }] };
      if (sql.includes("AS label")) return { rows: [{ value: 2, label: "drafting" }, { value: 3, label: "philosophy" }] };
      return { rowCount: 1, rows: [] };
    },
  };
  const permissions = [
    { table: "articles", read: "public", write: "owner", hops: [{ child: "articles", parent: "users", via: null, column: "created_by" }] },
    { table: "tags", read: "public", write: "none", hops: [] },
  ];
  const sf = [{ ...baseEntry(), joinTable: "article_tags", parentColumn: "article_id", childColumn: "tag_id", memberType: "int4" }];
  const auth = createAuth({ db: { query: async () => ({ rows: [] }) } });
  const tokenFor = (u) => auth.mintToken(u, "11111111-2222-3333-4444-555555555555");

  const app = express();
  attachWire(app, { db: fakeDb, bound: [], setFields: sf, permissions, auth, log: { error: () => {} } });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const post = (body, token) =>
    fetch(`${base}/wire`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  const noToken = await post({ type: "apskel.data.setMembers", table: "articles", id: 1, edge: "tags", members: [1] });
  check("setMembers without a token -> 401 (write=owner on the parent)", noToken.status === 401);

  const nonOwner = await post(
    { type: "apskel.data.setMembers", table: "articles", id: 1, edge: "tags", members: [1] },
    tokenFor(8)
  );
  const nonOwnerBody = await nonOwner.json();
  check(
    "setMembers as a non-owner -> 403 naming the parent's rule",
    nonOwner.status === 403 && nonOwnerBody.error === "write on articles requires owner",
    JSON.stringify(nonOwnerBody)
  );

  queries.length = 0;
  const asOwner = await post(
    { type: "apskel.data.setMembers", table: "articles", id: 1, edge: "tags", members: [3, 1], sourceClient: "curl" },
    tokenFor(7)
  );
  const asOwnerBody = await asOwner.json();
  check(
    "setMembers as the owner -> 200 with the canonical (sorted) set",
    asOwner.status === 200 && eq(asOwnerBody, { ok: true, members: [1, 3] }),
    JSON.stringify(asOwnerBody)
  );
  const diff = queries.find((q) => q.sql.startsWith("WITH del AS"));
  check(
    "the whole-set diff is ONE statement (single implicit transaction): DELETE missing + INSERT new",
    diff !== undefined &&
      diff.sql ===
        'WITH del AS (DELETE FROM "article_tags" WHERE "article_id" = $1 ' +
          'AND NOT ("tag_id" = ANY($2::int4[]))) ' +
          'INSERT INTO "article_tags" ("article_id", "tag_id") ' +
          'SELECT $1, m FROM unnest($2::int4[]) AS m ON CONFLICT DO NOTHING' &&
      eq(diff.params, [1, [1, 3]]),
    JSON.stringify(diff)
  );

  const got = await post({ type: "apskel.data.getMembers", table: "articles", id: 1, edge: "tags" });
  const gotBody = await got.json();
  check(
    "getMembers (read=public, no token) -> the ordered member list",
    got.status === 200 && eq(gotBody, { ok: true, members: [1, 3] }),
    JSON.stringify(gotBody)
  );

  const unknown = await post({ type: "apskel.data.getMembers", table: "articles", id: 1, edge: "nope" }, tokenFor(7));
  check("an undeclared edge -> 400", unknown.status === 400);

  const opts = await post({ type: "apskel.data.options", table: "tags", value: "id", label: "name" });
  const optsBody = await opts.json();
  check(
    "options (tags read=public, no token) -> (value, label) pairs ordered by label",
    opts.status === 200 && eq(optsBody.options, [{ value: 2, label: "drafting" }, { value: 3, label: "philosophy" }]),
    JSON.stringify(optsBody)
  );
  const optQuery = queries.find((q) => q.sql.includes("AS label"));
  check(
    "the options query orders by label",
    optQuery !== undefined && optQuery.sql === 'SELECT "id" AS value, "name" AS label FROM "tags" ORDER BY "name"',
    optQuery?.sql
  );

  const badOpts = await post({ type: "apskel.data.options", table: "tags", value: "id", label: "secret" });
  check("an undeclared options descriptor -> 400 (never reaches SQL)", badOpts.status === 400);

  server.close();
}

// ---------------------------------------------------------------------------
console.log("\nrecord contexts — set members load through getMembers");

{
  const store = createStore();
  const engine = new WatcherEngine(store);
  const calls = [];
  const call = async (env) => {
    calls.push(env);
    if (env.type === "apskel.data.getMembers") return { ok: true, members: [1, 3] };
    return { ok: true, value: "v" };
  };
  const sf = [{ ...baseEntry() }];
  const ctxs = attachRecordContexts({ engine, store, bound: [], setFields: sf, call });
  await ctxs.ready;
  check(
    "a fixed-record set field fetches members at boot and applies via the server door",
    calls.length === 1 &&
      calls[0].type === "apskel.data.getMembers" &&
      eq(store.get("app.editor.tags"), [1, 3]),
    JSON.stringify({ calls, value: store.get("app.editor.tags") })
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
