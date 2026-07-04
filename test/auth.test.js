// test/auth.test.js — Phase 5 harness: identity, DB-free.
//
//   node test/auth.test.js
//
// The database sits behind a narrow injected fake; real registration, the
// browser restart, and the psql schema inspection are the developer's
// personal verification, per the plan. Asserts the outcomes in
// test/fixtures/README.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { serializeApp, hydrateApp, findByPath, collectUsesAuth, collectBoundFields } from "../runtime/serialize.js";
import { createStore } from "../runtime/store.js";
import { evaluateArgs } from "../runtime/binder.js";
import { createFrameworkFunctions } from "../runtime/frameworkFunctions.js";
import {
  createAuth,
  hashPassword,
  verifyPassword,
  hashDeviceSecret,
} from "../server/authServer.js";
import { attachWire } from "../server/wireServer.js";

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
console.log("action grammar — bound at load, failures name the site");

{
  const root = resolveReferences(loadApp(path.join(fixturesDir, "action-call", "app.xml")));
  const tree = hydrateApp(JSON.parse(JSON.stringify(serializeApp(root))).tree);
  const go = findByPath(tree, "app.panel.go");
  check(
    "action-call: button carries the bound call with resolved arg store paths",
    eq(go?.action, {
      name: "apskel.auth.loginUser",
      args: [
        { kind: "ref", storePath: "app.email" },
        { kind: "ref", storePath: "app.password" },
      ],
    }),
    JSON.stringify(go?.action)
  );

  const store = createStore();
  store.seedDeclaredLocals(tree);
  store.set("app.email", "a@b.c", "user");
  store.set("app.password", "hunter2", "user");
  check(
    "evaluateArgs reads refs from the store at press time (literals pass through)",
    eq(evaluateArgs(go.action.args, store), ["a@b.c", "hunter2"]) &&
      eq(evaluateArgs([{ kind: "literal", value: 42 }], store), [42])
  );
}

expectLoadFailure("fail-unknown-function", "unknown function fails at load", [
  "unknown function 'apskel.auth.becomeAdmin'",
  "fail-unknown-function/app.xml:8",
]);
expectLoadFailure("fail-action-not-function", "non-call action fails at load", [
  "action= must be a function call",
  "fail-action-not-function/app.xml:8",
]);
expectLoadFailure("fail-fn-bad-arg", "undeclared bare-name argument fails at load", [
  "bare name 'email'",
  "fail-fn-bad-arg/app.xml:8",
]);
expectLoadFailure("fail-identity-reserved", "top-level 'identity' is reserved", [
  "'identity' is a reserved top-level name",
  "fail-identity-reserved/app.xml:5",
]);

// ---------------------------------------------------------------------------
console.log("\nthe litmus test — login/register are pure XML");

{
  for (const name of ["login", "register"]) {
    const xml = fs.readFileSync(path.join(repoDir, "components", `${name}.xml`), "utf8");
    check(`${name}.xml contains no <functions`, !xml.includes("<functions"));
  }

  const root = resolveReferences(loadApp(path.join(repoDir, "apps", "auth-demo", "app.xml")));
  check("auth-demo loads with login + register mounted", true);
  check("collectUsesAuth: auth-demo calls apskel.auth.*", collectUsesAuth(root) === true);

  const notes = resolveReferences(loadApp(path.join(repoDir, "apps", "notes-demo", "app.xml")));
  check("collectUsesAuth: notes-demo does not (Phase 4 apps stay tokenless)", collectUsesAuth(notes) === false);

  // The reserved region resolves without any component named 'identity'.
  const tree = hydrateApp(JSON.parse(JSON.stringify(serializeApp(root))).tree);
  const who = findByPath(tree, "app.who");
  const identityRefs = who.content.filter((s) => s.kind === "ref").map((s) => s.storePath);
  check(
    "app.identity.* references bind to the reserved region",
    eq(identityRefs, ["app.identity.email", "app.identity.status"]),
    JSON.stringify(identityRefs)
  );

  // Per-mount locals: signin's email and signup's email are distinct paths.
  const signinEmail = findByPath(tree, "app.signin.form.emailInput");
  const signupEmail = findByPath(tree, "app.signup.form.emailInput");
  check(
    "login and register instances keep distinct local field paths",
    signinEmail?.fieldPath === "app.signin.email" && signupEmail?.fieldPath === "app.signup.email",
    JSON.stringify({ signin: signinEmail?.fieldPath, signup: signupEmail?.fieldPath })
  );
}

// ---------------------------------------------------------------------------
console.log("\ncrypto — scrypt passwords, stateless HMAC tokens");

{
  const stored = hashPassword("correct horse");
  check("password round-trip verifies", verifyPassword("correct horse", stored));
  check("wrong password fails", !verifyPassword("wrong horse", stored));
  check("same password, different salt, different hash", hashPassword("correct horse") !== stored);
  check("device secret stored only as hash", hashDeviceSecret("s3cret") !== "s3cret");

  let clock = 1_000_000;
  const auth = createAuth({ db: null, tokenTtlMs: 1000, now: () => clock });
  const token = auth.mintToken(7, "dev-1");
  check("token verifies to its claims", eq(auth.verifyToken(token), { userId: 7, deviceId: "dev-1" }));
  clock += 1001;
  check("expired token verifies to null", auth.verifyToken(token) === null);
  clock -= 1001;
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ u: 999, d: "dev-1", exp: clock + 1000 })).toString("base64url");
  check("tampered payload verifies to null", auth.verifyToken(`${forged}.${sig}`) === null);
  check("tampered signature verifies to null", auth.verifyToken(`${payload}.AAAA${sig.slice(4)}`) === null);
  check("garbage verifies to null", auth.verifyToken("not-a-token") === null && auth.verifyToken(null) === null);
  const other = createAuth({ db: null, now: () => clock });
  check("a token from another server's key verifies to null", other.verifyToken(token) === null);
}

// ---------------------------------------------------------------------------
console.log("\nserver dispatch — register, login, token, guarded data writes");

{
  // A narrow fake: users/devices/user_devices as Maps, queries recognized
  // by their leading SQL words. Records every data UPDATE.
  const state = { users: new Map(), devices: new Map(), links: [], nextUserId: 1, updates: [] };
  const fakeDb = {
    query: async (sql, params = []) => {
      if (sql.startsWith("INSERT INTO users")) {
        const [email, displayName, passwordHash] = params;
        if ([...state.users.values()].some((u) => u.email === email)) {
          const e = new Error("duplicate key value violates unique constraint");
          e.code = "23505";
          throw e;
        }
        const id = state.nextUserId++;
        state.users.set(id, { id, email, display_name: displayName, password_hash: passwordHash });
        return { rowCount: 1, rows: [{ id }] };
      }
      if (sql.startsWith("SELECT id, email, display_name, password_hash FROM users")) {
        const user = [...state.users.values()].find((u) => u.email === params[0]);
        return { rowCount: user ? 1 : 0, rows: user ? [user] : [] };
      }
      if (sql.startsWith("SELECT credential_hash FROM devices")) {
        const d = state.devices.get(params[0]);
        return { rowCount: d ? 1 : 0, rows: d ? [d] : [] };
      }
      if (sql.startsWith("INSERT INTO devices")) {
        state.devices.set(params[0], { credential_hash: params[1] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE devices")) return { rowCount: 1, rows: [] };
      if (sql.startsWith("INSERT INTO user_devices")) {
        state.links = state.links.filter(
          (l) => !(l.user_id === params[0] && l.device_id === params[1])
        );
        state.links.push({ user_id: params[0], device_id: params[1], at: state.links.length });
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("SELECT u.id, u.email, u.display_name FROM user_devices")) {
        const link = [...state.links].reverse().find((l) => l.device_id === params[0]);
        const user = link && state.users.get(link.user_id);
        return { rowCount: user ? 1 : 0, rows: user ? [user] : [] };
      }
      if (sql.startsWith("UPDATE ")) {
        state.updates.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`fake db has no answer for: ${sql}`);
    },
  };

  const root = resolveReferences(loadApp(path.join(repoDir, "apps", "auth-demo", "app.xml")));
  const bound = collectBoundFields(root);
  const auth = createAuth({ db: fakeDb });
  const app = express();
  attachWire(app, { db: fakeDb, bound, auth, log: { error: () => {} } });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const post = (body, headers = {}) =>
    fetch(`${base}/wire`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const DEVICE = { deviceId: "11111111-2222-3333-4444-555555555555", deviceSecret: "aa".repeat(32) };

  const reg = await post({
    type: "apskel.auth.register",
    email: "Ada@Example.com",
    password: "difference engine",
    displayName: "Ada",
    ...DEVICE,
  });
  const regBody = await reg.json();
  check(
    "register: 200 with userId/email/displayName/token, email normalized",
    reg.status === 200 &&
      regBody.ok === true &&
      regBody.userId === 1 &&
      regBody.email === "ada@example.com" &&
      regBody.displayName === "Ada" &&
      typeof regBody.token === "string",
    JSON.stringify(regBody)
  );
  check(
    "register stored scrypt hash and device hash, never the secrets",
    state.users.get(1).password_hash.startsWith("scrypt:") &&
      !JSON.stringify([...state.devices]).includes(DEVICE.deviceSecret) &&
      state.devices.get(DEVICE.deviceId).credential_hash === hashDeviceSecret(DEVICE.deviceSecret)
  );

  const dup = await post({
    type: "apskel.auth.register",
    email: "ada@example.com",
    password: "x",
    ...DEVICE,
  });
  check("duplicate email -> 409 coherent body", dup.status === 409 && (await dup.json()).ok === false);

  const badLogin = await post({
    type: "apskel.auth.login",
    email: "ada@example.com",
    password: "wrong",
    ...DEVICE,
  });
  const noUser = await post({
    type: "apskel.auth.login",
    email: "nobody@example.com",
    password: "wrong",
    ...DEVICE,
  });
  check(
    "wrong password and unknown email: both 401 with the SAME body (no enumeration)",
    badLogin.status === 401 &&
      noUser.status === 401 &&
      eq(await badLogin.json(), await noUser.json())
  );

  const login = await post({
    type: "apskel.auth.login",
    email: "ada@example.com",
    password: "difference engine",
    ...DEVICE,
  });
  const loginBody = await login.json();
  check("login: correct password -> ok + token", login.status === 200 && loginBody.ok && !!loginBody.token);

  const badDevice = await post({
    type: "apskel.auth.login",
    email: "ada@example.com",
    password: "difference engine",
    deviceId: DEVICE.deviceId,
    deviceSecret: "bb".repeat(32),
  });
  check("right password, wrong device secret -> 401", badDevice.status === 401);

  const mint = await post({ type: "apskel.auth.token", ...DEVICE });
  const mintBody = await mint.json();
  check(
    "token re-mint from device credential alone (the browser-restart path)",
    mint.status === 200 && mintBody.ok && mintBody.userId === 1 && typeof mintBody.token === "string"
  );
  const mintBad = await post({
    type: "apskel.auth.token",
    deviceId: DEVICE.deviceId,
    deviceSecret: "bb".repeat(32),
  });
  check("re-mint with wrong secret -> 401", mintBad.status === 401);

  // Guarded data writes.
  const dataSet = { type: "apskel.data.set", table: "journal", id: 1, field: "entry", value: "hi" };
  const noToken = await post(dataSet);
  check("data.set without token -> 401, DB untouched", noToken.status === 401 && state.updates.length === 0);
  const forged = await post(dataSet, { Authorization: "Bearer aaaa.bbbb" });
  check("data.set with forged token -> 401", forged.status === 401 && state.updates.length === 0);
  const good = await post(dataSet, { Authorization: `Bearer ${mintBody.token}` });
  check(
    "data.set with valid token -> 200, parameterized UPDATE",
    good.status === 200 &&
      state.updates.length === 1 &&
      state.updates[0].sql === 'UPDATE "journal" SET "entry" = $1 WHERE id = $2',
    JSON.stringify(state.updates)
  );

  server.close();

  // Phase 4 regression: without auth attached, data.set stays tokenless.
  const plain = express();
  const state2 = [];
  attachWire(plain, {
    db: { query: async (sql, params) => (state2.push({ sql, params }), { rowCount: 1, rows: [] }) },
    bound,
    log: { error: () => {} },
  });
  const plainServer = plain.listen(0);
  const plainResp = await fetch(`http://localhost:${plainServer.address().port}/wire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dataSet),
  });
  check("without auth attached, tokenless data.set still works (Phase 4 pinned)", plainResp.status === 200);
  plainServer.close();
}

// ---------------------------------------------------------------------------
console.log("\nclient functions — loginUser writes app.identity.*, one door");

{
  const store = createStore();
  const calls = [];
  let heldToken = null;
  let respond = () => ({ ok: true, userId: 3, email: "ada@example.com", displayName: "Ada", token: "tok-1" });
  const fns = createFrameworkFunctions({
    call: async (envelope) => (calls.push(envelope), respond(envelope)),
    store,
    credentials: () => ({ deviceId: "d-1", deviceSecret: "s-1" }),
    onToken: (t) => (heldToken = t),
  });

  await fns["apskel.auth.loginUser"]("ada@example.com", "pw");
  check(
    "loginUser sends the login envelope with the device credential attached",
    eq(calls[0], {
      type: "apskel.auth.login",
      email: "ada@example.com",
      password: "pw",
      deviceId: "d-1",
      deviceSecret: "s-1",
    }),
    JSON.stringify(calls[0])
  );
  check(
    "success writes the identity region and hands over the token",
    store.get("app.identity.userId") === 3 &&
      store.get("app.identity.email") === "ada@example.com" &&
      store.get("app.identity.status") === "authenticated" &&
      store.get("app.identity.error") === "" &&
      heldToken === "tok-1"
  );

  respond = () => ({ ok: false, error: "invalid email or password" });
  await fns["apskel.auth.loginUser"]("ada@example.com", "wrong");
  check(
    "failure surfaces in app.identity.error, status back to anonymous",
    store.get("app.identity.error") === "invalid email or password" &&
      store.get("app.identity.status") === "anonymous"
  );

  await fns["apskel.auth.registerUser"]("new@example.com", "pw2", "Newbie");
  check(
    "registerUser sends the register envelope",
    calls[2].type === "apskel.auth.register" && calls[2].displayName === "Newbie"
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
