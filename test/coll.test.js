// test/coll.test.js — Phase 8 harness: collection sources and binding,
// DB-free.
//
//   node test/coll.test.js
//
// Loader: the nine collection-source fixtures. Startup: resolveQueries /
// resolveCollections against fakes (the startup-query-* fixtures are the
// developer's terminal verification). Wire: data.select composition and
// gating, insert/delete with ownership stamping. Sync: membership
// maintained from broadcasts through fake controllers. Browser
// instantiation itself is personal verification against board-demo.
// Expected outcomes in test/fixtures/README.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import {
  collectBoundFields,
  collectCollections,
  collectQueries,
  collectQueryBound,
} from "../runtime/serialize.js";
import { createStore } from "../runtime/store.js";
import { WatcherEngine } from "../runtime/watchers.js";
import { attachCollectionSync } from "../runtime/wireClient.js";
import { remapInstance } from "../runtime/binder.js";
import {
  attachWire,
  resolveQueries,
  resolveCollections,
} from "../server/wireServer.js";
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
console.log("collection-source — all four source forms load and collect");

const root = resolveReferences(loadApp(fixture("collection-source")));
const collections = collectCollections(root);
const queries = collectQueries(root);
const queryBound = collectQueryBound(root);

check(
  "three collections collected (the reader is a record context, not a collection)",
  eq(
    collections.map((c) => c.path),
    ["app.published", "app.mine", "app.byTag"]
  ),
  JSON.stringify(collections.map((c) => c.path))
);

const published = collections.find((c) => c.path === "app.published");
check(
  "query source, bare form: order and limit wrap the query; bound columns only",
  published.query?.name === "publishedEditions" &&
    eq(published.query.args, []) &&
    eq(published.order, { column: "created_at", dir: "desc" }) &&
    published.limit === 10 &&
    eq(published.columns, ["title"]),
  JSON.stringify(published)
);

const mine = collections.find((c) => c.path === "app.mine");
check(
  "table source with a dynamic reference filter",
  mine.table === "articles" &&
    mine.filter.column === "created_by" &&
    eq(mine.filter.items, [{ kind: "ref", storePath: "app.identity.userId" }]) &&
    eq(mine.order, { column: "id", dir: "asc" }),
  JSON.stringify(mine)
);

const byTag = collections.find((c) => c.path === "app.byTag");
check(
  "parameterized call mount: the argument is a resolved reference",
  byTag.query?.name === "publishedByTag" &&
    eq(byTag.query.args, [{ kind: "ref", storePath: "app.currentTag" }]),
  JSON.stringify(byTag)
);

check(
  "two queries declared with tables= and read rules",
  queries.length === 2 &&
    queries.every((q) => q.read === "public") &&
    eq(queries.find((q) => q.name === "publishedByTag").params, ["tag"]),
  JSON.stringify(queries)
);

check(
  "the query-sourced record context collects into queryBound, not bound",
  queryBound.length === 1 &&
    queryBound[0].storePath === "app.reader.title" &&
    queryBound[0].query === "publishedEditions" &&
    queryBound[0].recordPath === "app.currentEditionId" &&
    collectBoundFields(root).length === 0,
  JSON.stringify({ queryBound, bound: collectBoundFields(root) })
);

{
  const board = resolveReferences(loadApp(path.join(repoDir, "apps", "board-demo", "app.xml")));
  const bc = collectCollections(board);
  check(
    "board-demo: one collection, newest-first, template binds body and id",
    bc.length === 1 &&
      bc[0].table === "messages" &&
      eq(bc[0].order, { column: "id", dir: "desc" }) &&
      bc[0].limit === 20 &&
      eq(bc[0].columns, ["body", "id"]),
    JSON.stringify(bc)
  );
}

// ---------------------------------------------------------------------------
console.log("\nload failures — the eight named errors");

expectLoadFailure("fail-filter-on-query", "filter= on a query source", [
  "a query owns its own WHERE",
  "fail-filter-on-query/app.xml:5",
]);
expectLoadFailure("fail-filter-bare", "no bare-truthiness filters", [
  "no bare-truthiness form",
  "fail-filter-bare/app.xml:5",
]);
expectLoadFailure("fail-query-input", "query sources are read-only", [
  "query sources are read-only",
  "fail-query-input/app.xml:6",
]);
expectLoadFailure("fail-conflict-on-query", "conflict= on a query source", [
  "query sources are read-only by grammar",
  "fail-conflict-on-query/app.xml:5",
]);
expectLoadFailure("fail-query-unknown", "unknown query named with candidates", [
  "unknown query 'nosuch'",
  "publishedEditions",
]);
expectLoadFailure("fail-query-arity", "call arity checked against declared params", [
  "takes 0 call-site parameter(s)",
  "got 2",
]);
expectLoadFailure("fail-query-read-owner", "no owner queries", [
  "a list is not a row",
  "fail-query-read-owner/app.xml:12",
]);
expectLoadFailure("fail-query-no-tables", "tables= is mandatory", [
  "needs tables=",
  "fail-query-no-tables/app.xml:12",
]);

// ---------------------------------------------------------------------------
console.log("\nremapInstance — PK-keyed instance stamping, external paths preserved");

{
  const template = {
    path: "app.board",
    fieldPath: null,
    visible: { storePath: "app.view", domain: ["board"] },
    content: [{ kind: "ref", storePath: "app.board.body" }],
    children: [
      {
        path: "app.board.row",
        action: { name: "apskel.data.remove", args: [{ kind: "ref", storePath: "app.board.id" }] },
        locals: new Map([["expanded", { default: "false" }]]),
        children: [],
        content: [],
      },
    ],
  };
  const inst = remapInstance(template, "app.board", 7);
  check(
    "paths under the collection gain the PK key; external paths survive",
    inst.path === "app.board[7]" &&
      inst.content[0].storePath === "app.board[7].body" &&
      inst.children[0].path === "app.board[7].row" &&
      inst.children[0].action.args[0].storePath === "app.board[7].id" &&
      inst.visible.storePath === "app.view" &&
      inst.children[0].locals.get("expanded").default === "false",
    JSON.stringify({ path: inst.path, visible: inst.visible.storePath })
  );
  check("the original template is untouched (clone, not mutation)", template.path === "app.board");
}

// ---------------------------------------------------------------------------
console.log("\nstartup — query and collection resolution against fakes");

{
  // Real fixture files, fake probe: the id-less query's LIMIT-0 result.
  const probeDb = (fields) => ({
    query: async () => ({ rows: [], fields: fields.map((name) => ({ name })) }),
  });
  let noid = null;
  try {
    await resolveQueries(probeDb(["name"]), [{ name: "qn_list", params: [], tables: ["qn_items"], read: "public" }], {
      appDir: path.join(repoDir, "test", "fixtures", "startup-query-noid"),
    });
  } catch (e) {
    noid = e.message;
  }
  check("an id-less query fails the LIMIT-0 check", noid !== null && noid.includes("no 'id' column"), noid);

  let notselect = null;
  try {
    await resolveQueries(probeDb(["id"]), [{ name: "qu_list", params: [], tables: ["qu_items"], read: "public" }], {
      appDir: path.join(repoDir, "test", "fixtures", "startup-query-notselect"),
    });
  } catch (e) {
    notselect = e.message;
  }
  check(
    "a non-SELECT body is rejected",
    notselect !== null && notselect.includes("single SELECT"),
    notselect
  );

  let missing = null;
  try {
    await resolveQueries(probeDb(["id"]), [{ name: "qm_list", params: [], tables: ["qm_items"], read: "public" }], {
      appDir: path.join(repoDir, "test", "fixtures", "startup-query-missing"),
    });
  } catch (e) {
    missing = e.message;
  }
  check("a missing SQL body names the expected path", missing !== null && missing.includes("qm_list.sql"), missing);

  const introDb = ({ columns = new Set(), userFks = [] }) => ({
    query: async (sql, params = []) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: columns.has(`${params[0]}.${params[1]}`) ? [{}] : [] };
      }
      if (sql.includes("FOREIGN KEY")) return { rows: userFks };
      throw new Error(`no fake for: ${sql}`);
    },
  });

  let badcol = null;
  try {
    await resolveCollections(introDb({ columns: new Set() }), {
      collections: [{ path: "app.mine", table: "articles", filter: { column: "nope", items: [] }, order: null, columns: [] }],
    });
  } catch (e) {
    badcol = e.message;
  }
  check("a filter column that does not exist is a startup error", badcol !== null && badcol.includes("articles.nope"), badcol);

  const stamps = await resolveCollections(
    introDb({
      columns: new Set(["articles.created_by", "articles.id"]),
      userFks: [{ child_table: "articles", col: "created_by", ref_col: "id" }],
    }),
    { collections: [{ path: "app.mine", table: "articles", filter: { column: "created_by", items: [] }, order: null, columns: [] }] }
  );
  check("the insert ownership stamp resolves to the direct users FK", stamps.get("articles") === "created_by");

  let deadborn = null;
  try {
    await resolveCollections(introDb({ columns: new Set(), userFks: [] }), {
      collections: [{ path: "app.list", table: "widgets", filter: null, order: null, columns: [] }],
      permissions: [{ table: "widgets", read: "users", write: "owner", hops: [] }],
    });
  } catch (e) {
    deadborn = e.message;
  }
  check(
    "write=owner with no users FK rejects inserts at startup (born unowned and dead)",
    deadborn !== null && deadborn.includes("born unowned and dead"),
    deadborn
  );
}

// ---------------------------------------------------------------------------
console.log("\nserver — select composition, insert stamping, delete guard");

{
  const queriesResolved = [
    { name: "publishedEditions", params: [], tables: ["articles", "article_editions"], read: "public", sql: "SELECT e.id, e.title, e.created_at FROM article_editions e", fields: ["id", "title", "created_at"] },
  ];
  const colls = [
    { path: "app.published", table: null, query: { name: "publishedEditions", args: [] }, filter: null, order: { column: "created_at", dir: "desc" }, limit: 10, columns: ["title"] },
    { path: "app.mine", table: "articles", query: null, filter: { column: "created_by", items: [{ kind: "ref", storePath: "app.identity.userId" }] }, order: { column: "id", dir: "asc" }, limit: null, columns: ["id", "title"] },
    { path: "app.board", table: "messages", query: null, filter: null, order: { column: "id", dir: "desc" }, limit: 20, columns: ["body", "id"] },
  ];
  const queries = [];
  const fakeDb = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes("AS owner")) return { rows: [{ owner: 7 }] };
      if (sql.startsWith("INSERT")) return { rowCount: 1, rows: [{ id: 42 }] };
      if (sql.startsWith("DELETE")) return { rowCount: 1, rows: [] };
      return { rows: [{ id: 1, title: "A" }, { id: 2, title: "B" }] };
    },
  };
  const auth = createAuth({ db: { query: async () => ({ rows: [] }) } });
  const tokenFor = (u) => auth.mintToken(u, "11111111-2222-3333-4444-555555555555");
  const permissions = [
    { table: "articles", read: "users", write: "owner", hops: [{ child: "articles", parent: "users", via: null, column: "created_by" }] },
  ];
  const app = express();
  attachWire(app, {
    db: fakeDb,
    bound: [],
    auth,
    permissions,
    collections: colls,
    queries: queriesResolved,
    insertStamps: new Map([["articles", "created_by"], ["messages", null]]),
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

  queries.length = 0;
  const pub = await post({ type: "apskel.data.select", path: "app.published", params: [] });
  const pubBody = await pub.json();
  check(
    "query-sourced select: public, anonymous, order/limit wrap the query",
    pub.status === 200 &&
      pubBody.rows.length === 2 &&
      queries[0].sql ===
        'SELECT "id", "title" FROM (SELECT e.id, e.title, e.created_at FROM article_editions e) q ' +
          'ORDER BY "created_at" DESC LIMIT 10',
    JSON.stringify(queries[0])
  );

  const mineAnon = await post({ type: "apskel.data.select", path: "app.mine", filterValues: [7] });
  check("table select on a read=users table: anonymous -> 401", mineAnon.status === 401);

  queries.length = 0;
  const mine = await post(
    { type: "apskel.data.select", path: "app.mine", filterValues: [7] },
    tokenFor(7)
  );
  check(
    "table select composes the filter as a parameterized ANY",
    mine.status === 200 &&
      queries[0].sql === 'SELECT "id", "title" FROM "articles" WHERE "created_by" = ANY($1) ORDER BY "id" ASC' &&
      eq(queries[0].params, [[7]]),
    JSON.stringify(queries[0])
  );

  const unknown = await post({ type: "apskel.data.select", path: "app.nope" });
  check("an undeclared collection path -> 400", unknown.status === 400);

  queries.length = 0;
  const ins = await post(
    { type: "apskel.data.insert", table: "articles", values: { title: "mine", created_by: 999 }, sourceClient: "t" },
    tokenFor(7)
  );
  const insBody = await ins.json();
  const insQuery = queries.find((q) => q.sql.startsWith("INSERT"));
  check(
    "insert stamps ownership from the token — the client's claimed value is overwritten",
    ins.status === 200 &&
      insBody.id === 42 &&
      insQuery.sql === 'INSERT INTO "articles" ("title", "created_by") VALUES ($1, $2) RETURNING id' &&
      eq(insQuery.params, ["mine", 7]),
    JSON.stringify({ insBody, insQuery })
  );

  const insBad = await post(
    { type: "apskel.data.insert", table: "articles", values: { secret: "x" } },
    tokenFor(7)
  );
  check("an unbound column on insert -> 400", insBad.status === 400);

  const insNoTable = await post({ type: "apskel.data.insert", table: "pg_shadow", values: {} }, tokenFor(7));
  check("a non-collection table on insert -> 400", insNoTable.status === 400);

  const delAnon = await post({ type: "apskel.data.delete", table: "articles", id: 5 });
  check("delete without a token -> 401", delAnon.status === 401);

  const delOther = await post({ type: "apskel.data.delete", table: "articles", id: 5 }, tokenFor(8));
  check("delete as a non-owner -> 403 (the owner walk guards deletes)", delOther.status === 403);

  const delOwn = await post({ type: "apskel.data.delete", table: "articles", id: 5 }, tokenFor(7));
  check("delete as the owner -> 200", delOwn.status === 200);

  server.close();
}

// ---------------------------------------------------------------------------
console.log("\nsync — membership maintained from broadcasts through the controllers");

{
  const store = createStore();
  const engine = new WatcherEngine(store);
  const actions = [];
  const makeCtrl = () => ({
    has: () => false,
    instantiate: (id, values, before = null) => actions.push(["instantiate", id, values, before]),
    destroy: (id) => actions.push(["destroy", id]),
    clear: () => actions.push(["clear"]),
  });
  const controllers = new Map([
    ["app.board", makeCtrl()],
    ["app.pubs", makeCtrl()],
  ]);
  const colls = [
    { path: "app.board", table: "messages", query: null, filter: { column: "status", items: [{ kind: "literal", value: "open" }] }, order: { column: "id", dir: "desc" }, limit: null, columns: ["body", "status", "id"] },
    { path: "app.pubs", table: null, query: { name: "publishedEditions", args: [] }, filter: null, order: null, limit: null, columns: ["title"] },
  ];
  const clientQueries = [
    { name: "publishedEditions", params: [], tables: ["articles", "article_editions"], read: "public" },
  ];
  let selects = 0;
  const call = async (env) => {
    selects++;
    if (env.path === "app.board")
      return { ok: true, rows: [{ id: 9, body: "hi", status: "open" }, { id: 5, body: "old", status: "open" }] };
    return { ok: true, rows: [{ id: 1, title: "T" }] };
  };

  const sync = attachCollectionSync({
    engine,
    store,
    collections: colls,
    queries: clientQueries,
    controllers,
    call,
  });
  await sync.ready;

  check(
    "initial select instantiates rows in server order",
    eq(
      actions.filter((a) => a[0] !== "clear").map((a) => [a[0], a[1]]),
      [["instantiate", 9], ["instantiate", 5], ["instantiate", 1]]
    ),
    JSON.stringify(actions)
  );

  actions.length = 0;
  sync.handleEvent({ type: "apskel.data.inserted", table: "messages", id: 12, values: { body: "new", status: "open" } });
  check(
    "an inserted broadcast matching the filter instantiates at its ordered position (before id 9)",
    eq(actions, [["instantiate", 12, { id: 12, body: "new", status: "open" }, "9"]]),
    JSON.stringify(actions)
  );

  actions.length = 0;
  sync.handleEvent({ type: "apskel.data.inserted", table: "messages", id: 13, values: { body: "x", status: "closed" } });
  check("an inserted broadcast failing the filter does nothing", actions.length === 0);

  sync.handleEvent({ type: "apskel.data.deleted", table: "messages", id: 5 });
  check("a deleted broadcast destroys the instance", eq(actions, [["destroy", 5]]), JSON.stringify(actions));

  actions.length = 0;
  sync.handleEvent({ type: "apskel.data.changed", table: "messages", id: 9, field: "status", value: "closed" });
  check(
    "a changed row that now fails the filter leaves the list",
    eq(actions, [["destroy", 9]]),
    JSON.stringify(actions)
  );

  actions.length = 0;
  sync.handleEvent({ type: "apskel.data.changed", table: "messages", id: 12, field: "body", value: "edited" });
  check(
    "a changed field on a member row applies through the server door at the instance path",
    actions.length === 0 && store.get("app.board[12].body") === "edited"
  );

  const before = selects;
  sync.handleEvent({ type: "apskel.data.changed", table: "messages", id: 77, field: "status", value: "open" });
  await new Promise((r) => setTimeout(r, 10));
  check("a membership GAIN re-fetches (one field is not a whole row)", selects === before + 1);

  const beforeQ = selects;
  sync.handleEvent({ type: "apskel.data.changed", table: "article_editions", id: 3, field: "title", value: "t" });
  await new Promise((r) => setTimeout(r, 10));
  check("a broadcast naming a query's tables= re-fetches the query collection", selects === beforeQ + 1);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
