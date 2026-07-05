// tools/run.js — Phase 4 app runner: PostgreSQL + the Wire.
//
//   node tools/run.js <appDir> [--port 3000]
//
// Loads and resolves the app, connects to PostgreSQL, applies the app's
// schema.sql, and serves the app with the Wire attached: POST /wire for
// type-routed envelopes, GET /events for the SSE broadcast channel.
// /app.json refreshes initialData from the database per request, so a
// reload shows the draft exactly as left — a real round-trip, not a cache.
//
// Connection: PGHOST/PGPORT/PGDATABASE/PGUSER env vars override the
// defaults (127.0.0.1:5432, apskel_development, apskel); the password comes from
// ~/.pgpass (standard libpq format).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import {
  serializeApp,
  collectBoundFields,
  collectUsesAuth,
  collectPermissions,
  collectSetFields,
  collectQueries,
  collectCollections,
  collectQueryBound,
  collectInsertTargets,
} from "../runtime/serialize.js";
import { createAppServer, attachShellFallback } from "../server/appServer.js";
import {
  attachWire,
  resolvePermissionColumns,
  resolveSetFieldEdges,
  resolveQueries,
  resolveCollections,
} from "../server/wireServer.js";
import { createAuth } from "../server/authServer.js";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const appDirArg = args.find((a) => !a.startsWith("--"));
const portArg = args.indexOf("--port");
const port = portArg !== -1 ? Number(args[portArg + 1]) : 3000;

if (!appDirArg) {
  console.error("usage: node tools/run.js <appDir> [--port 3000]");
  process.exit(2);
}
const appDir = path.resolve(appDirArg);

// --- load and resolve ------------------------------------------------------

let root;
let baseBundle;
let bound;
let usesAuth;
let permissions;
let setFields;
let collections;
let queryBound;
let serverQueries;
let insertTargets;
try {
  root = resolveReferences(loadApp(path.join(appDir, "app.xml")));
  bound = collectBoundFields(root);
  usesAuth = collectUsesAuth(root);
  permissions = collectPermissions(root);
  setFields = collectSetFields(root);
  collections = collectCollections(root);
  queryBound = collectQueryBound(root);
  insertTargets = collectInsertTargets(root);
  // Two copies on purpose: startup resolution adds .sql to the server's
  // copy, and SQL bodies never ride the bundle to the browser.
  serverQueries = collectQueries(root);
  baseBundle = serializeApp(root, {
    title: root.attrs.title ?? "Apskel App",
    style: root.clientAttrs.style ?? null,
    clientFunctions: root.clientAttrs.functions ?? null,
    bound,
    permissions,
    setFields,
    collections,
    queries: collectQueries(root),
    queryBound,
    wire: { endpoint: "/wire", events: "/events" },
    auth: usesAuth,
  });
} catch (e) {
  if (e instanceof ApskelLoadError) {
    console.error(`LOAD ERROR: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

// --- database --------------------------------------------------------------

const dbConfig = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? "apskel_development",
  user: process.env.PGUSER ?? "apskel",
};
dbConfig.password = process.env.PGPASSWORD ?? readPgPass(dbConfig);
if (dbConfig.password === undefined) {
  console.error(
    `DB ERROR: no password for ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/` +
      `${dbConfig.database} — set PGPASSWORD or add a ~/.pgpass line:\n` +
      `  ${dbConfig.host}:${dbConfig.port}:${dbConfig.database}:${dbConfig.user}:<password>`
  );
  process.exit(1);
}

const db = new pg.Client(dbConfig);
try {
  await db.connect();
} catch (e) {
  console.error(
    `DB ERROR: cannot connect to postgres at ${dbConfig.host}:${dbConfig.port}/` +
      `${dbConfig.database} as ${dbConfig.user}: ${e.message}`
  );
  process.exit(1);
}

// An app that calls apskel.auth.* gets the identity core: the framework
// tables (users, devices, user_devices — deliberately no sessions table)
// and token-guarded data writes. Framework schema first, so the app's own
// schema may reference users.
let auth = null;
if (usesAuth) {
  const identitySql = fileURLToPath(new URL("../server/identity.sql", import.meta.url));
  await db.query(fs.readFileSync(identitySql, "utf8"));
  console.log(`applied ${identitySql}`);
  auth = createAuth({ db });
}

const schemaFile = path.join(appDir, "schema.sql");
if (fs.existsSync(schemaFile)) {
  await db.query(fs.readFileSync(schemaFile, "utf8"));
  console.log(`applied ${schemaFile}`);
}

// The owner-walk FK columns and the set-field join edges come from the
// live schema, never the XML — collisions and ambiguities are startup
// errors naming the site, per RESOLVED (error taxonomy: load vs. startup).
let insertStamps;
try {
  await resolvePermissionColumns(db, permissions);
  await resolveSetFieldEdges(db, setFields, root.data.nodes);
  await resolveQueries(db, serverQueries, { appDir, collections, queryBound });
  insertStamps = await resolveCollections(db, { collections, permissions, insertTargets });
} catch (e) {
  console.error(`STARTUP ERROR: ${e.message}`);
  process.exit(1);
}

// --- serve -----------------------------------------------------------------

// /app.json is fetched before authentication, so initialData is a Wire
// door too: with identity attached, only read="public" tables ship rows —
// everything else boots empty and fetches through apskel.data.get once a
// token exists, per RESOLVED (enforcement is server-side at every Wire
// door).
const publicRead = new Set(
  permissions.filter((p) => p.read === "public").map((p) => p.table)
);

async function fetchInitialData() {
  const initialData = {};
  const revisions = {};
  for (const b of bound) {
    if (b.record === null || b.record === undefined) continue; // no row chosen (Phase 7 territory)
    if (usesAuth && !publicRead.has(b.table)) continue; // non-public: fetched post-login
    const columns = b.conflict === "detect" ? `"${b.field}" AS value, revision` : `"${b.field}" AS value`;
    const result = await db.query(`SELECT ${columns} FROM "${b.table}" WHERE id = $1`, [b.record]);
    if (result.rows.length > 0) {
      initialData[b.storePath] = result.rows[0].value;
      if (b.conflict === "detect") revisions[`${b.table}:${b.record}`] = result.rows[0].revision;
    }
  }
  return { initialData, revisions };
}

const app = createAppServer({
  appDir,
  bundleProvider: async () => ({ ...baseBundle, ...(await fetchInitialData()) }),
});
attachWire(app, {
  db,
  bound,
  auth,
  permissions,
  setFields,
  collections,
  queries: serverQueries,
  queryBound,
  insertStamps,
  insertTargets,
});
attachShellFallback(app); // deep links: /edit/2 serves the shell — last, so /wire and /events win

app.listen(port, () => {
  console.log(`Apskel running ${appDir} with the Wire`);
  console.log(`  http://localhost:${port}/`);
  console.log(`  db: ${dbConfig.database} as ${dbConfig.user}@${dbConfig.host}`);
  if (auth) console.log(`  identity: device-credential auth on (data writes need a token)`);
});

// --- ~/.pgpass (standard libpq format: host:port:database:user:password) ---

function readPgPass({ host, port, database, user }) {
  const file = process.env.PGPASSFILE ?? path.join(os.homedir(), ".pgpass");
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [h, p, d, u, ...rest] = line.split(":");
    const match = (pattern, value) => pattern === "*" || pattern === String(value);
    if (match(h, host) && match(p, port) && match(d, database) && match(u, user)) {
      return rest.join(":");
    }
  }
  return undefined;
}
