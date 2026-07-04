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
// defaults (127.0.0.1:5432, apskel_dev, apskel); the password comes from
// ~/.pgpass (standard libpq format).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { serializeApp, collectBoundFields } from "../runtime/serialize.js";
import { createAppServer } from "../server/appServer.js";
import { attachWire } from "../server/wireServer.js";

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
try {
  root = resolveReferences(loadApp(path.join(appDir, "app.xml")));
  bound = collectBoundFields(root);
  baseBundle = serializeApp(root, {
    title: root.attrs.title ?? "Apskel App",
    style: root.clientAttrs.style ?? null,
    clientFunctions: root.clientAttrs.functions ?? null,
    bound,
    wire: { endpoint: "/wire", events: "/events" },
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
  database: process.env.PGDATABASE ?? "apskel_dev",
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

const schemaFile = path.join(appDir, "schema.sql");
if (fs.existsSync(schemaFile)) {
  await db.query(fs.readFileSync(schemaFile, "utf8"));
  console.log(`applied ${schemaFile}`);
}

// --- serve -----------------------------------------------------------------

async function fetchInitialData() {
  const initialData = {};
  for (const b of bound) {
    if (b.record === null || b.record === undefined) continue; // no row chosen (Phase 7 territory)
    const result = await db.query(
      `SELECT "${b.field}" AS value FROM "${b.table}" WHERE id = $1`,
      [b.record]
    );
    if (result.rows.length > 0) initialData[b.storePath] = result.rows[0].value;
  }
  return initialData;
}

const app = createAppServer({
  appDir,
  bundleProvider: async () => ({ ...baseBundle, initialData: await fetchInitialData() }),
});
attachWire(app, { db, bound });

app.listen(port, () => {
  console.log(`Apskel running ${appDir} with the Wire`);
  console.log(`  http://localhost:${port}/`);
  console.log(`  db: ${dbConfig.database} as ${dbConfig.user}@${dbConfig.host}`);
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
