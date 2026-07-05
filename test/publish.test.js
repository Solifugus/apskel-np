// test/publish.test.js — Phase 9 harness: the publish era, DB-free.
//
//   node test/publish.test.js
//
// Loader: the five design-session-5 fixtures (field.set pairs, @user).
// Engine: batch — several external writes as one cascade, the state->URL
// sync never sees a half-assigned selection. Serialize: insert targets
// collected from create actions. Startup: create-target validation
// against fakes (the startup-create-* fixtures are the developer's
// terminal verification). Wire: @user filled from the token and never
// from the wire; create-declared inserts; database rejections answered
// 400. Expected outcomes in test/fixtures/README.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { collectInsertTargets } from "../runtime/serialize.js";
import { createStore } from "../runtime/store.js";
import { WatcherEngine } from "../runtime/watchers.js";
import { createRouter } from "../runtime/router.js";
import { attachWire, resolveCollections } from "../server/wireServer.js";
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
console.log("load failures — field.set pairs and @user, each naming its site");

expectLoadFailure("fail-fieldset-odd", "odd arity fails at load", [
  "pairs",
  "got 3 argument(s)",
  "fail-fieldset-odd/app.xml:9",
]);
expectLoadFailure("fail-fieldset-pair-literal", "a later pair's literal target fails at load", [
  "argument 3",
  "write target",
  "fail-fieldset-pair-literal/app.xml:9",
]);
expectLoadFailure("fail-user-param-passed", "a call site supplying @user fails the arity check", [
  "takes 0 call-site parameter(s)",
  "filled server-side from the token",
  "got 1",
]);
expectLoadFailure("fail-user-param-noauth", "@user in a tokenless app fails at load", [
  "never calls apskel.auth.*",
  "no identity to fill it from",
  "fail-user-param-noauth/app.xml:12",
]);
expectLoadFailure("fail-user-param-unknown", "an unknown @-name fails at load", [
  "'@user' is the only reserved parameter",
  "there is no '@owner'",
]);

// ---------------------------------------------------------------------------
console.log("\nengine — batch: several external writes, one cascade");

{
  const store = createStore();
  const engine = new WatcherEngine(store);
  store.seed("app.view", "landing");
  store.seed("app.editionId", "");
  const firings = [];
  engine.watch({
    name: "route-sync",
    fields: ["app.view", "app.editionId"],
    run: (ctx) => firings.push({ view: ctx.get("app.view"), id: ctx.get("app.editionId") }),
  });

  engine.batch(() => {
    store.set("app.view", "article", "user");
    store.set("app.editionId", 7, "user");
  });
  check(
    "batched pair: the watcher fires ONCE with both values current",
    eq(firings, [{ view: "article", id: 7 }]),
    JSON.stringify(firings)
  );

  firings.length = 0;
  store.set("app.view", "editor", "user");
  store.set("app.editionId", 9, "user");
  check(
    "contrast — sequential sets fire twice, the first with a stale partner",
    eq(firings, [{ view: "editor", id: 7 }, { view: "editor", id: 9 }]),
    JSON.stringify(firings)
  );

  // The same-value guard still applies inside a batch.
  firings.length = 0;
  engine.batch(() => {
    store.set("app.view", "editor", "user");
    store.set("app.editionId", 9, "user");
  });
  check("a batch of same-value writes fires nothing", firings.length === 0, JSON.stringify(firings));
}

{
  // The row-click deep link: field.set pairs through the router's reverse
  // match push exactly ONE history entry, the final URL — never the
  // half-assigned intermediate.
  const store = createStore();
  const engine = new WatcherEngine(store);
  store.seed("app.view", "landing");
  store.seed("app.editionId", "");
  const pushes = [];
  const location = { pathname: "/" };
  const history = {
    pushState: (s, t, p) => {
      pushes.push(p);
      location.pathname = p;
    },
    replaceState: (s, t, p) => (location.pathname = p),
  };
  const routes = [
    {
      path: "/",
      segs: [],
      params: [],
      sets: [{ storePath: "app.view", value: "landing" }],
    },
    {
      path: "/article/:id",
      params: ["id"],
      sets: [
        { storePath: "app.view", value: "article" },
        { storePath: "app.editionId", param: "id" },
      ],
    },
  ];
  const router = createRouter({ routes, store, location, history });
  engine.watch({ name: "url-sync", fields: router.targets, run: () => router.syncUrl() });

  engine.batch(() => {
    store.set("app.view", "article", "user");
    store.set("app.editionId", 7, "user");
  });
  check(
    "one pushState, the complete deep link",
    eq(pushes, ["/article/7"]),
    JSON.stringify(pushes)
  );
}

// ---------------------------------------------------------------------------
console.log("\nserialize — create actions declare insert targets");

{
  const root = resolveReferences(loadApp(fixture("startup-create-unowned")));
  const targets = collectInsertTargets(root);
  check(
    "the create action's literal table and columns are collected, site attached",
    targets.length === 1 &&
      targets[0].table === "cu_items" &&
      eq(targets[0].columns, ["body"]) &&
      targets[0].site.file.endsWith("startup-create-unowned/app.xml"),
    JSON.stringify(targets)
  );

  const boardRoot = resolveReferences(loadApp(path.join(repoDir, "apps", "board-demo", "app.xml")));
  const boardTargets = collectInsertTargets(boardRoot);
  check(
    "board-demo's composer collects too (collection-bound and create-declared overlap is fine)",
    boardTargets.length === 1 && boardTargets[0].table === "messages" && eq(boardTargets[0].columns, ["body"]),
    JSON.stringify(boardTargets)
  );
}

// ---------------------------------------------------------------------------
console.log("\nstartup — create-target validation (terminal verification: startup-create-*)");

{
  const introDb = ({ columns = new Set(), userFks = [] }) => ({
    query: async (sql, params = []) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: columns.has(`${params[0]}.${params[1]}`) ? [{}] : [] };
      }
      if (sql.includes("FOREIGN KEY")) return { rows: userFks };
      throw new Error(`no fake for: ${sql}`);
    },
  });
  const target = (table, columns) => ({
    table,
    columns,
    site: { file: "app.xml", line: 9 },
  });

  let badcol = null;
  try {
    await resolveCollections(introDb({ columns: new Set() }), {
      collections: [],
      insertTargets: [target("cb_items", ["bodyy"])],
    });
  } catch (e) {
    badcol = e.message;
  }
  check(
    "a create action naming a missing column is a startup error naming the site",
    badcol !== null && badcol.includes("cb_items.bodyy") && badcol.includes("app.xml:9"),
    badcol
  );

  let deadborn = null;
  try {
    await resolveCollections(introDb({ columns: new Set(["cu_items.body"]) }), {
      collections: [],
      permissions: [{ table: "cu_items", read: "users", write: "owner", hops: [] }],
      insertTargets: [target("cu_items", ["body"])],
    });
  } catch (e) {
    deadborn = e.message;
  }
  check(
    "a write=owner create target with no direct users FK is born unowned and dead",
    deadborn !== null && deadborn.includes("born unowned and dead"),
    deadborn
  );

  const stamps = await resolveCollections(
    introDb({
      columns: new Set(["comment_marks.comment_id", "comment_marks.kind"]),
      userFks: [{ child_table: "comment_marks", col: "user_id", ref_col: "id" }],
    }),
    { collections: [], insertTargets: [target("comment_marks", ["comment_id", "kind"])] }
  );
  check(
    "a create target's ownership stamp resolves from its direct users FK",
    stamps.get("comment_marks") === "user_id"
  );
}

// ---------------------------------------------------------------------------
console.log("\nserver — @user from the token, create-declared inserts, DB rejections as 400s");

{
  const queriesResolved = [
    {
      name: "myDrafts",
      params: ["@user"],
      tables: ["drafts"],
      read: "users",
      sql: "SELECT d.id, d.title FROM drafts d WHERE d.created_by = $1",
      fields: ["id", "title"],
    },
    {
      name: "publicMine",
      params: ["tag", "@user"],
      tables: ["things"],
      read: "public",
      sql: "SELECT t.id, t.title FROM things t WHERE t.tag = $1 AND t.created_by = $2",
      fields: ["id", "title"],
    },
  ];
  const colls = [
    {
      path: "app.drafts",
      table: null,
      query: { name: "myDrafts", args: [] },
      filter: null,
      order: null,
      limit: null,
      columns: ["title"],
    },
    {
      path: "app.tagged",
      table: null,
      query: { name: "publicMine", args: [{ kind: "ref", storePath: "app.tag" }] },
      filter: null,
      order: null,
      limit: null,
      columns: ["title"],
    },
  ];
  const insertTargets = [{ table: "comment_marks", columns: ["comment_id", "kind"], site: { file: "app.xml", line: 5 } }];
  const rejectTables = new Set();
  const dbQueries = [];
  const fakeDb = {
    query: async (sql, params = []) => {
      dbQueries.push({ sql, params });
      for (const t of rejectTables) {
        if (sql.includes(`"${t}"`)) throw new Error(`published editions are immutable (trigger says no)`);
      }
      if (sql.includes("AS owner")) return { rows: [{ owner: 7 }] };
      if (sql.startsWith("INSERT")) return { rowCount: 1, rows: [{ id: 42 }] };
      if (sql.startsWith("DELETE")) return { rowCount: 1, rows: [] };
      if (sql.startsWith("UPDATE")) return { rowCount: 1, rows: [{ revision: 2 }] };
      return { rows: [{ id: 1, title: "A" }] };
    },
  };
  const auth = createAuth({ db: { query: async () => ({ rows: [] }) } });
  const tokenFor = (u) => auth.mintToken(u, "11111111-2222-3333-4444-555555555555");
  const app = express();
  attachWire(app, {
    db: fakeDb,
    bound: [{ table: "article_editions", field: "title", path: "app.editor", storePath: "app.editor.title", record: 1, conflict: "offline-readonly" }],
    auth,
    permissions: [{ table: "article_editions", read: "users", write: "users", hops: [] }],
    collections: colls,
    queries: queriesResolved,
    queryBound: [{ storePath: "app.reader.title", path: "app.reader", query: "myDrafts", args: [], record: null, recordPath: "app.currentId", field: "title" }],
    insertStamps: new Map([["comment_marks", "user_id"]]),
    insertTargets,
    log: { error: () => {} },
  });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const post = (body, token) =>
    fetch(`${base}/wire`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  const anon = await post({ type: "apskel.data.select", path: "app.drafts", params: [] });
  check("select on a @user query without a token -> 401", anon.status === 401);

  const anonPublic = await post({ type: "apskel.data.select", path: "app.tagged", params: ["news"] });
  check(
    "@user requires identity even on a read=public query -> 401",
    anonPublic.status === 401
  );

  dbQueries.length = 0;
  const mine = await post({ type: "apskel.data.select", path: "app.drafts", params: [] }, tokenFor(7));
  check(
    "@user fills from the token: the SQL parameter is the verified user id, the wire sent none",
    mine.status === 200 && eq(dbQueries[0].params, [7]),
    JSON.stringify(dbQueries[0])
  );

  dbQueries.length = 0;
  const tagged = await post(
    { type: "apskel.data.select", path: "app.tagged", params: ["news"] },
    tokenFor(7)
  );
  check(
    "mixed params: wire values fill the non-@ slots in declared order, @user its own",
    tagged.status === 200 && eq(dbQueries[0].params, ["news", 7]),
    JSON.stringify(dbQueries[0])
  );

  const forged = await post(
    { type: "apskel.data.select", path: "app.drafts", params: [999] },
    tokenFor(7)
  );
  check(
    "a wire value aimed at the @user slot is an arity error, not a fill -> 400",
    forged.status === 400
  );

  dbQueries.length = 0;
  const got = await post(
    { type: "apskel.data.get", query: "myDrafts", field: "title", id: 3, params: [] },
    tokenFor(7)
  );
  check(
    "the query-wrap get fills @user the same way",
    got.status === 200 && eq(dbQueries[0].params, [7, 3]),
    JSON.stringify(dbQueries[0])
  );

  dbQueries.length = 0;
  const mark = await post(
    { type: "apskel.data.insert", table: "comment_marks", values: { comment_id: 3, kind: "pro", user_id: 999 } },
    tokenFor(7)
  );
  const markBody = await mark.json();
  const markQuery = dbQueries.find((q) => q.sql.startsWith("INSERT"));
  check(
    "a create-declared table is insertable; the stamp comes from the token, the claim stripped",
    mark.status === 200 &&
      markBody.id === 42 &&
      markQuery.sql === 'INSERT INTO "comment_marks" ("comment_id", "kind", "user_id") VALUES ($1, $2, $3) RETURNING id' &&
      eq(markQuery.params, [3, "pro", 7]),
    JSON.stringify(markQuery)
  );

  const markDel = await post({ type: "apskel.data.delete", table: "comment_marks", id: 42 }, tokenFor(7));
  check(
    "create actions declare INSERT targets, nothing wider: delete on one -> 400",
    markDel.status === 400
  );

  rejectTables.add("comment_marks");
  const dup = await post(
    { type: "apskel.data.insert", table: "comment_marks", values: { comment_id: 3, kind: "pro" } },
    tokenFor(7)
  );
  const dupBody = await dup.json();
  check(
    "a second mark (PK rejection) answers 400 carrying the database's message",
    dup.status === 400 && dupBody.error.includes("insert rejected"),
    JSON.stringify(dupBody)
  );

  rejectTables.add("article_editions");
  const immut = await post(
    { type: "apskel.data.set", table: "article_editions", id: 1, field: "title", value: "sneaky" },
    tokenFor(7)
  );
  const immutBody = await immut.json();
  check(
    "a trigger rejection on data.set is a 400 carrying the trigger's message — never a 500",
    immut.status === 400 && immutBody.error.includes("immutable"),
    JSON.stringify(immutBody)
  );

  server.close();
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
