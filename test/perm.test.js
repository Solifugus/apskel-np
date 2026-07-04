// test/perm.test.js — Phase 7.2 harness: permissions, DB-free.
//
//   node test/perm.test.js
//
// Loader: the data graph parses, rules validate against the closed menus,
// and the five failure fixtures fail naming their sites. Wire: rules are
// enforced at every door against a fake db — the graph walk's SQL is
// asserted verbatim; real PostgreSQL and real curl 401/403s are the
// developer's personal verification, per the plan. Expected outcomes in
// test/fixtures/README.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { collectBoundFields, collectPermissions } from "../runtime/serialize.js";
import { createStore } from "../runtime/store.js";
import { WatcherEngine } from "../runtime/watchers.js";
import { attachRecordContexts } from "../runtime/wireClient.js";
import { attachWire, resolvePermissionColumns } from "../server/wireServer.js";
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
console.log("data-graph — the <data> section parses, rules ride the graph nodes");

const root = resolveReferences(loadApp(fixture("data-graph")));
const perms = collectPermissions(root);

check(
  "three rule-bearing tables collected, in graph walk order",
  eq(
    perms,
    [
      {
        table: "articles",
        read: "public",
        write: "owner",
        hops: [{ child: "articles", parent: "users", via: "created_by" }],
      },
      {
        table: "article_editions",
        read: "public",
        write: "owner",
        hops: [
          { child: "article_editions", parent: "articles", via: null },
          { child: "articles", parent: "users", via: "created_by" },
        ],
      },
      { table: "notes", read: "users", write: "users", hops: [] },
    ]
  ),
  JSON.stringify(perms)
);

check(
  "users appears in the graph carrying no rules — anchor only",
  !perms.some((p) => p.table === "users")
);

{
  const kf = resolveReferences(loadApp(path.join(repoDir, "apps", "knowledge-foyer", "app.xml")));
  const kfPerms = collectPermissions(kf);
  check(
    "knowledge-foyer v0.3 declares articles + article_editions public/owner",
    kfPerms.length === 2 &&
      kfPerms.every((p) => p.read === "public" && p.write === "owner") &&
      kfPerms.some((p) => p.table === "article_editions" && p.hops.length === 2),
    JSON.stringify(kfPerms)
  );
}

// ---------------------------------------------------------------------------
console.log("\nload failures — closed menus, one declaration site, locked identity tables");

expectLoadFailure("fail-bad-rule", "unknown read rule fails naming the closed menu", [
  "unknown read rule 'everyone'",
  "public, users, owner",
  "fail-bad-rule/app.xml:13",
]);

expectLoadFailure("fail-write-public", "write=public is not on the write menu", [
  "unknown write rule 'public'",
  "users, owner, none",
  "fail-write-public/app.xml:13",
]);

expectLoadFailure("fail-rule-twice", "a table's rules on two nodes fails naming both sites", [
  "permission rules for 'notes' declared twice",
  "app.xml:13",
  "fail-rule-twice/app.xml:17",
]);

expectLoadFailure("fail-rule-on-identity", "rules on an identity table are not overridable", [
  "identity table <users>",
  "fail-rule-on-identity/app.xml:13",
]);

expectLoadFailure("fail-owner-unrooted", "an owner rule with no users ancestor fails", [
  "no 'users' ancestor",
  "owner is a graph walk",
  "fail-owner-unrooted/app.xml:13",
]);

// ---------------------------------------------------------------------------
// Wire enforcement: the data-graph fixture's own bindings, hand-resolved
// hop columns (startup's introspection is faked further down), a real
// token minter over a fake db.

const bound = collectBoundFields(root);
// What run.js's startup introspection would produce from the live schema:
for (const p of perms) {
  for (const hop of p.hops) {
    hop.column = hop.via ?? { "article_editions->articles": "article_id" }[`${hop.child}->${hop.parent}`];
  }
}

const auth = createAuth({ db: { query: async () => ({ rows: [] }) } });
const tokenFor = (userId) => auth.mintToken(userId, "11111111-2222-3333-4444-555555555555");

function makeServer({ withAuth, permissions, owner }) {
  const queries = [];
  const fakeDb = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("AS owner")) return { rows: owner.value === null ? [] : [{ owner: owner.value }] };
      if (sql.startsWith("SELECT")) return { rows: [{ value: "stored-value" }] };
      return { rowCount: 1, rows: [] };
    },
  };
  const app = express();
  attachWire(app, {
    db: fakeDb,
    bound,
    log: { error: () => {} },
    auth: withAuth ? auth : null,
    permissions,
  });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const post = (body, token) =>
    fetch(`${base}/wire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  return { server, base, post, queries };
}

// ---------------------------------------------------------------------------
console.log("\nread rules — public needs no token, users needs any token");

{
  const owner = { value: 7 };
  const { server, post, queries } = makeServer({ withAuth: true, permissions: perms, owner });

  const anonPublic = await post({ type: "apskel.data.get", table: "article_editions", id: 1, field: "title" });
  const anonPublicBody = await anonPublic.json();
  check(
    "read=public: apskel.data.get succeeds with no token",
    anonPublic.status === 200 && anonPublicBody.value === "stored-value",
    JSON.stringify(anonPublicBody)
  );

  const anonUsers = await post({ type: "apskel.data.get", table: "notes", id: 1, field: "text" });
  check("read=users: no token -> 401", anonUsers.status === 401);

  const authedUsers = await post(
    { type: "apskel.data.get", table: "notes", id: 1, field: "text" },
    tokenFor(8)
  );
  check("read=users: any valid token -> 200", authedUsers.status === 200);

  const unknownField = await post(
    { type: "apskel.data.get", table: "notes", id: 1, field: "nope" },
    tokenFor(8)
  );
  check("unknown field stays 400 (allowlist unchanged)", unknownField.status === 400);

  queries.length = 0;
  server.close();
}

// ---------------------------------------------------------------------------
console.log("\nwrite=owner — the graph walk decides, one parameterized query");

{
  const owner = { value: 7 };
  const { server, post, queries } = makeServer({ withAuth: true, permissions: perms, owner });
  const envelope = (v) => ({
    type: "apskel.data.set",
    table: "article_editions",
    id: 5,
    field: "title",
    value: v,
    sourceClient: "tab-x",
  });

  const noToken = await post(envelope("a"));
  check("write=owner: no token -> 401", noToken.status === 401);

  queries.length = 0;
  const asOwner = await post(envelope("b"), tokenFor(7));
  check("write=owner: the owner's token -> 200", asOwner.status === 200);
  const ownerQuery = queries.find((q) => q.sql.includes("AS owner"));
  check(
    "the owner walk is ONE parameterized query joining the resolved hops",
    ownerQuery !== undefined &&
      ownerQuery.sql ===
        'SELECT t1."created_by" AS owner FROM "article_editions" t0 ' +
          'JOIN "articles" t1 ON t0."article_id" = t1.id WHERE t0.id = $1' &&
      eq(ownerQuery.params, [5]),
    JSON.stringify(ownerQuery)
  );

  const asOther = await post(envelope("c"), tokenFor(8));
  const asOtherBody = await asOther.json();
  check(
    "write=owner: another user's token -> 403 naming table and rule",
    asOther.status === 403 && asOtherBody.error === "write on article_editions requires owner",
    JSON.stringify(asOtherBody)
  );

  owner.value = null; // created_by NULL somewhere in the chain
  const unowned = await post(envelope("d"), tokenFor(7));
  check("write=owner: unowned row (NULL in the chain) denies EVERYONE", unowned.status === 403);

  server.close();
}

// ---------------------------------------------------------------------------
console.log("\nidentity tables — wire-locked, fixed readable columns");

{
  const owner = { value: 7 };
  const { server, post } = makeServer({ withAuth: true, permissions: perms, owner });

  const setUsers = await post(
    { type: "apskel.data.set", table: "users", id: 7, field: "email", value: "x@y.z" },
    tokenFor(7)
  );
  const setUsersBody = await setUsers.json();
  check(
    "apskel.data.set on users -> 403 (write=none, even for the row's owner)",
    setUsers.status === 403 && setUsersBody.error === "write on users is not allowed over the wire",
    JSON.stringify(setUsersBody)
  );

  const ownRow = await post(
    { type: "apskel.data.get", table: "users", id: 7, field: "email" },
    tokenFor(7)
  );
  check("apskel.data.get users.email, own row -> 200", ownRow.status === 200);

  const otherRow = await post(
    { type: "apskel.data.get", table: "users", id: 8, field: "email" },
    tokenFor(7)
  );
  check("apskel.data.get users.email, someone else's row -> 403", otherRow.status === 403);

  const hash = await post(
    { type: "apskel.data.get", table: "users", id: 7, field: "password_hash" },
    tokenFor(7)
  );
  check("users.password_hash -> 400 (fixed column set, never widened)", hash.status === 400);

  const devices = await post(
    { type: "apskel.data.get", table: "devices", id: 1, field: "id" },
    tokenFor(7)
  );
  check("devices rows have no owner walk -> denied to everyone", devices.status === 403 || devices.status === 400);

  server.close();
}

// ---------------------------------------------------------------------------
console.log("\nno-auth apps — tokenless end to end, exactly Phase 4");

{
  const { server, post } = makeServer({ withAuth: false, permissions: [], owner: { value: null } });
  const write = await post({ type: "apskel.data.set", table: "notes", id: 1, field: "text", value: "v" });
  check("tokenless write accepted when the app has no identity", write.status === 200);
  server.close();
}

// ---------------------------------------------------------------------------
console.log("\nSSE — the connection's identity gates delivery by read rule");

{
  // notes flipped to read=owner for this block: all three read scopes live.
  const ssePerms = [
    ...perms.filter((p) => p.table !== "notes"),
    {
      table: "notes",
      read: "owner",
      write: "owner",
      hops: [{ child: "notes", parent: "users", via: null, column: "owner_id" }],
    },
  ];
  const owner = { value: 7 };
  const { server, base, post } = makeServer({ withAuth: true, permissions: ssePerms, owner });

  async function listen(token) {
    const resp = await fetch(`${base}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
      close: () => reader.cancel(),
      received: async () => {
        // Drain whatever has arrived by now.
        const timer = new Promise((r) => setTimeout(() => r({ done: true }), 300));
        for (;;) {
          const { value, done } = await Promise.race([reader.read(), timer]);
          if (done || !value) break;
          buffer += decoder.decode(value);
        }
        return buffer
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => JSON.parse(l.slice(6)));
      },
    };
  }

  const anon = await listen(null);
  const asOwner = await listen(tokenFor(7));
  const asOther = await listen(tokenFor(8));

  // public read: everyone hears it.
  await post(
    { type: "apskel.data.set", table: "article_editions", id: 5, field: "title", value: "pub", sourceClient: "t" },
    tokenFor(7)
  );
  // owner read: only user 7 hears it.
  await post(
    { type: "apskel.data.set", table: "notes", id: 3, field: "text", value: "secret", sourceClient: "t" },
    tokenFor(7)
  );
  await new Promise((r) => setTimeout(r, 200));

  const anonGot = await anon.received();
  const ownerGot = await asOwner.received();
  const otherGot = await asOther.received();

  check(
    "read=public broadcast reaches anonymous, owner, and other alike",
    anonGot.some((e) => e.value === "pub") &&
      ownerGot.some((e) => e.value === "pub") &&
      otherGot.some((e) => e.value === "pub"),
    JSON.stringify({ anonGot, ownerGot, otherGot })
  );
  check(
    "read=owner broadcast reaches ONLY the owner's connection",
    ownerGot.some((e) => e.value === "secret") &&
      !anonGot.some((e) => e.value === "secret") &&
      !otherGot.some((e) => e.value === "secret"),
    JSON.stringify({ anonGot, otherGot })
  );

  await anon.close();
  await asOwner.close();
  await asOther.close();
  server.close();
}

// ---------------------------------------------------------------------------
console.log("\nstartup column resolution — FKs from the live schema, never the XML");

{
  const fkDb = (rowsByPair) => ({
    query: async (sql, params) => ({
      rows: (rowsByPair[`${params[0]}->${params[1]}`] ?? []).map((c) => ({ column_name: c })),
    }),
  });

  const single = [{ table: "articles", read: "public", write: "owner", hops: [{ child: "articles", parent: "users", via: null }] }];
  await resolvePermissionColumns(fkDb({ "articles->users": ["created_by"] }), single);
  check("a single FK candidate resolves without via=", single[0].hops[0].column === "created_by");

  const viaPick = [{ table: "articles", read: "public", write: "owner", hops: [{ child: "articles", parent: "users", via: "created_by" }] }];
  await resolvePermissionColumns(fkDb({ "articles->users": ["created_by", "updated_by"] }), viaPick);
  check("via= picks among ambiguous candidates", viaPick[0].hops[0].column === "created_by");

  let ambiguous = null;
  try {
    await resolvePermissionColumns(
      fkDb({ "articles->users": ["created_by", "updated_by"] }),
      [{ table: "articles", read: "public", write: "owner", hops: [{ child: "articles", parent: "users", via: null }] }]
    );
  } catch (e) {
    ambiguous = e.message;
  }
  check(
    "two candidates without via= is a startup error naming both",
    ambiguous !== null && ambiguous.includes("created_by") && ambiguous.includes("updated_by") && ambiguous.includes("via="),
    ambiguous
  );

  let missing = null;
  try {
    await resolvePermissionColumns(fkDb({}), [
      { table: "articles", read: "public", write: "owner", hops: [{ child: "articles", parent: "users", via: null }] },
    ]);
  } catch (e) {
    missing = e.message;
  }
  check("no FK edge at all is a startup error", missing !== null && missing.includes("no foreign key"), missing);

  let badVia = null;
  try {
    await resolvePermissionColumns(fkDb({ "articles->users": ["created_by"] }), [
      { table: "articles", read: "public", write: "owner", hops: [{ child: "articles", parent: "users", via: "nope" }] },
    ]);
  } catch (e) {
    badVia = e.message;
  }
  check("via= naming a non-FK column is a startup error", badVia !== null && badVia.includes("'nope'"), badVia);
}

// ---------------------------------------------------------------------------
console.log("\nfixed-record contexts — non-public tables boot empty and fetch post-login");

{
  const store = createStore();
  const engine = new WatcherEngine(store);
  const calls = [];
  const call = async (env) => {
    calls.push(env);
    return { ok: true, value: `db:${env.field}` };
  };
  const staticBound = [
    { storePath: "app.journal.entry", path: "app.journal", table: "journal", record: 1, field: "entry", conflict: "offline-readonly" },
    { storePath: "app.pub.title", path: "app.pub", table: "pages", record: 2, field: "title", conflict: "offline-readonly" },
  ];

  // app.pub.title was bundle-seeded (public table); app.journal.entry was not.
  const ctxs = attachRecordContexts({
    engine,
    store,
    bound: staticBound,
    call,
    skipInitial: new Set(["app.pub.title"]),
  });
  await ctxs.ready;

  check(
    "boot fetches ONLY the non-seeded fixed-record field",
    eq(calls.map((c) => `${c.table}.${c.field}`), ["journal.entry"]),
    JSON.stringify(calls)
  );
  check(
    "the fetched value applied through the server-origin door",
    store.get("app.journal.entry") === "db:entry"
  );

  calls.length = 0;
  await ctxs.refetchAll();
  check(
    "refetchAll (login) refetches every fixed-record field",
    calls.length === 2 && calls.some((c) => c.table === "pages"),
    JSON.stringify(calls)
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
