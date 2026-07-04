// tools/poke.js — acceptance criterion 6: every field is addressable by
// path, demonstrated by reading and setting a field THROUGH THE WIRE.
//
//   node tools/poke.js app.workspace.articleEditor.title \
//        --email you@example.com --password pw [--set "New Title"] [--url http://localhost:3000]
//
// The script fetches /app.json, finds the bound-field entry whose storePath
// is the given path (the same metadata the browser uses), authenticates as
// a fresh device via apskel.auth.login, then apskel.data.get — and with
// --set, an apskel.data.set carrying the revision the read returned,
// followed by a second read to show the round-trip.

import crypto from "node:crypto";

const args = process.argv.slice(2);
const storePath = args.find((a) => !a.startsWith("--"));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const url = opt("url") ?? "http://localhost:3000";
const email = opt("email");
const password = opt("password");
const setValue = opt("set");

if (!storePath) {
  console.error(
    'usage: node tools/poke.js <storePath> --email <e> --password <pw> [--set "value"] [--url http://localhost:3000]'
  );
  process.exit(2);
}

const bundle = await (await fetch(`${url}/app.json`)).json();
const b = (bundle.bound ?? []).find((x) => x.storePath === storePath);
if (!b) {
  console.error(`no bound field at path '${storePath}'; this app binds:`);
  for (const x of bundle.bound ?? []) console.error(`  ${x.storePath}`);
  process.exit(1);
}
// A dynamic context (record="app.currentEditionId") has no fixed row —
// the script's caller picks one with --id, standing in for the selection.
const rowId = b.record ?? (opt("id") !== undefined ? Number(opt("id")) : undefined);
if (rowId === undefined || rowId === null) {
  console.error(
    `'${storePath}' selects its row at runtime (recordPath ${b.recordPath}) — pass --id <n>`
  );
  process.exit(2);
}
console.log(`${storePath} -> ${b.table} row ${rowId} column ${b.field} (conflict=${b.conflict})`);

let token = null;
const call = async (envelope) => {
  const r = await fetch(`${url}/wire`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(envelope),
  });
  return { status: r.status, body: await r.json() };
};

if (bundle.auth) {
  if (!email || !password) {
    console.error("this app uses identity: --email and --password are required");
    process.exit(2);
  }
  const login = await call({
    type: "apskel.auth.login",
    email,
    password,
    deviceId: crypto.randomUUID(),
    deviceSecret: crypto.randomBytes(32).toString("hex"),
  });
  if (!login.body.ok) {
    console.error(`login failed: ${login.body.error}`);
    process.exit(1);
  }
  token = login.body.token;
  console.log(`authenticated as ${login.body.email} (userId ${login.body.userId})`);
}

const read = await call({ type: "apskel.data.get", table: b.table, id: rowId, field: b.field });
console.log(`read:  ${JSON.stringify(read.body)}`);

if (setValue !== undefined) {
  const envelope = {
    type: "apskel.data.set",
    table: b.table,
    id: rowId,
    field: b.field,
    value: setValue,
    sourceClient: "poke-script",
  };
  if (b.conflict === "detect") envelope.baseRevision = read.body.revision;
  const write = await call(envelope);
  console.log(`set:   ${write.status} ${JSON.stringify(write.body)}`);
  const again = await call({
    type: "apskel.data.get",
    table: b.table,
    id: rowId,
    field: b.field,
  });
  console.log(`read:  ${JSON.stringify(again.body)}`);
}
