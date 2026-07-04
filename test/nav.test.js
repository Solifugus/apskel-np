// test/nav.test.js — Phase 7.1 harness: record selection, views, routing.
//
//   node test/nav.test.js
//
// DB-free: fetches go through a controllable fake call; the router gets a
// fake location/history. Browser behavior (views switching, URL bar,
// back/forward) is personal verification against knowledge-foyer v0.2.
// Asserts the outcomes in test/fixtures/README.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { serializeApp, hydrateApp, findByPath, collectBoundFields } from "../runtime/serialize.js";
import { createStore } from "../runtime/store.js";
import { WatcherEngine } from "../runtime/watchers.js";
import { attachWireSend, attachWireReceive, attachRecordContexts } from "../runtime/wireClient.js";
import { createRouter } from "../runtime/router.js";
import { isVisible } from "../runtime/binder.js";

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

const tick = () => new Promise((r) => setTimeout(r, 0));

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
console.log("grammar — record refs, visible domains, app-scope locals");

{
  const root = resolveReferences(loadApp(path.join(fixturesDir, "record-ref", "app.xml")));
  const bound = collectBoundFields(root);
  check(
    "record-ref: dynamic context ships recordPath, fixed context stays Phase 4 shape",
    eq(bound, [
      {
        storePath: "app.editor.title",
        path: "app.editor",
        table: "article_editions",
        record: null,
        field: "title",
        conflict: "detect",
        recordPath: "app.currentEditionId",
      },
      {
        storePath: "app.fixed.title",
        path: "app.fixed",
        table: "notes",
        record: 1,
        field: "title",
        conflict: "offline-readonly",
      },
    ]),
    JSON.stringify(bound)
  );
}

{
  const root = resolveReferences(loadApp(path.join(fixturesDir, "visible-domain", "app.xml")));
  const tree = hydrateApp(JSON.parse(JSON.stringify(serializeApp(root))).tree);
  const landing = findByPath(tree, "app.landing");
  const editor = findByPath(tree, "app.editor");
  const panel = findByPath(tree, "app.panel");
  check(
    "visible-domain: single-value, set, and bare truthy forms serialize",
    eq(landing?.visible, { storePath: "app.view", domain: ["landing"] }) &&
      eq(editor?.visible, { storePath: "app.view", domain: ["editor", "article"] }) &&
      eq(panel?.visible, { storePath: "app.panelOpen", domain: null }),
    JSON.stringify({ landing: landing?.visible, editor: editor?.visible, panel: panel?.visible })
  );
  check(
    "isVisible: membership by String comparison, bare is truthy",
    isVisible(editor.visible, "editor") &&
      isVisible(editor.visible, "article") &&
      !isVisible(editor.visible, "landing") &&
      !isVisible(panel.visible, "") &&
      isVisible(panel.visible, "yes")
  );
}

{
  const root = resolveReferences(loadApp(path.join(fixturesDir, "app-local-absolute", "app.xml")));
  const inner = findByPath(root, "app.outer.inner");
  const ref = inner.content.find((s) => s.kind === "ref");
  check(
    "app-local-absolute: {app.view} resolves to the app-scope declared local",
    ref?.site?.binding?.targetPath === "app" && ref?.site?.binding?.field === "view"
  );
}

expectLoadFailure("fail-record-braces", "braced record= fails at load", [
  "record attribute",
  "without braces",
]);
expectLoadFailure("fail-route-field", "unresolved route field fails at load", [
  "app-scope declared local named 'nosuch'",
  "fail-route-field/app.xml:15",
]);
expectLoadFailure("fail-route-param", "param missing from pattern fails at load", [
  "':id'",
  "'/editor' does not declare it",
]);
expectLoadFailure("fail-route-identity", "route targeting identity fails at load", [
  "reserved identity region",
]);
expectLoadFailure("fail-fieldset-literal", "field.set with literal target fails at load", [
  "apskel.field.set",
  "write target",
]);

// ---------------------------------------------------------------------------
console.log("\nrouter — URL <-> state, both directions, declaration order");

{
  const kf = resolveReferences(loadApp(path.join(repoDir, "apps", "knowledge-foyer", "app.xml")));
  const bundle = serializeApp(kf);
  check(
    "knowledge-foyer routes serialize with bound store paths",
    bundle.routes.length === 3 &&
      eq(bundle.routes[1], {
        path: "/edit/:id",
        params: ["id"],
        sets: [
          { storePath: "app.view", value: "editor" },
          { storePath: "app.currentEditionId", param: "id" },
        ],
      }),
    JSON.stringify(bundle.routes)
  );

  const store = createStore();
  const engine = new WatcherEngine(store);
  store.seed("app.view", "landing");
  store.seed("app.currentEditionId", "");
  const location = { pathname: "/edit/2" };
  const pushes = [];
  const history = {
    pushState: (s, t, p) => (pushes.push(["push", p]), (location.pathname = p)),
    replaceState: (s, t, p) => (pushes.push(["replace", p]), (location.pathname = p)),
  };
  const router = createRouter({ routes: bundle.routes, store, location, history });

  let viewFirings = 0;
  engine.watch({ name: "spy", fields: ["app.view"], run: () => (viewFirings += 1) });

  router.apply(location.pathname, { silent: true });
  check(
    "boot: /edit/2 seeds silently — view=editor, id=2 as a NUMBER, no watcher fired",
    store.get("app.view") === "editor" && store.get("app.currentEditionId") === 2 && viewFirings === 0
  );

  // State -> URL: the outward watcher, as boot wires it.
  engine.watch({ name: "router:sync-url", fields: router.targets, run: () => router.syncUrl() });

  store.set("app.view", "article", "user"); // "Read it" via field.set
  check(
    "state change reverse-matches in declaration order -> pushState /article/2",
    eq(pushes.at(-1), ["push", "/article/2"]) && location.pathname === "/article/2",
    JSON.stringify(pushes)
  );

  store.set("app.view", "landing", "user"); // back to landing: '/' wins despite id=2
  check(
    "landing + leftover id: first route wins -> '/'",
    eq(pushes.at(-1), ["push", "/"]),
    JSON.stringify(pushes.at(-1))
  );

  router.navigate("/edit/1"); // nav.go
  check(
    "navigate applies the route non-silently and pushes",
    store.get("app.view") === "editor" &&
      store.get("app.currentEditionId") === 1 &&
      location.pathname === "/edit/1" &&
      viewFirings > 0
  );

  location.pathname = "/no/such/page";
  pushes.length = 0;
  router.apply(location.pathname);
  check(
    "unmatched URL falls back to the first route and corrects via replaceState",
    store.get("app.view") === "landing" && eq(pushes[0], ["replace", "/"])
  );
}

// ---------------------------------------------------------------------------
console.log("\nselection machinery — silent re-seed, keystroke rules, receive");

{
  const kf = resolveReferences(loadApp(path.join(repoDir, "apps", "knowledge-foyer", "app.xml")));
  const bound = collectBoundFields(kf);
  const store = createStore();
  const engine = new WatcherEngine(store);
  const revisions = new Map();
  store.seed("app.currentEditionId", "");

  const rows = {
    1: { title: "One", body: "first", revision: 3 },
    2: { title: "Two", body: "second", revision: 7 },
  };
  let holdId = null; // when set, fetches for that row wait until release()
  let release = null;
  const held = [];
  const call = (env) => {
    const respond = () => ({ ok: true, value: rows[env.id][env.field], revision: rows[env.id].revision });
    if (env.id === holdId) {
      return new Promise((resolve) => held.push(() => resolve(respond())));
    }
    return Promise.resolve(respond());
  };
  release = () => {
    held.splice(0).forEach((r) => r());
  };

  const warnings = [];
  const contexts = attachRecordContexts({
    engine,
    store,
    bound,
    revisions,
    call,
    log: { warn: (...a) => warnings.push(a.join(" ")) },
  });
  const sent = [];
  attachWireSend({
    engine,
    bound,
    clientId: "tab-me",
    revisions,
    isLoading: contexts.isLoading,
    send: (e) => sent.push(e),
    log: { warn: (...a) => warnings.push(a.join(" ")) },
  });
  await contexts.ready;

  const TITLE = "app.workspace.articleEditor.title";
  const WIRE = `wire:${TITLE}`;
  let repaints = 0;
  engine.watch({ name: "display", fields: [TITLE], run: () => (repaints += 1) });

  check("empty selection: fields undefined, nothing fetched", store.get(TITLE) === undefined);
  store.set(TITLE, "typed into nothing", "user");
  check("keystroke on an empty context is suppressed", sent.length === 0);

  store.set("app.currentEditionId", 1, "system");
  await tick();
  await tick();
  const repaintsBefore = repaints;
  check(
    "selection 1: values applied via SERVER origin — display repainted, wire watcher unmoved, revision adopted",
    store.get(TITLE) === "One" &&
      revisions.get("article_editions:1") === 3 &&
      engine.fireCount(WIRE) === 1 && // only the earlier suppressed keystroke
      repaintsBefore >= 2, // the keystroke AND the fetch both repainted (the bug was the fetch not repainting)
    JSON.stringify({ title: store.get(TITLE), repaints, counts: engine.fireCounts() })
  );

  store.set(TITLE, "One edited", "user");
  check(
    "keystroke sends with the row id captured at keystroke time and its revision",
    sent.length === 1 && sent[0].id === 1 && sent[0].baseRevision === 3,
    JSON.stringify(sent)
  );

  holdId = 2;
  store.set("app.currentEditionId", 2, "system");
  check("loading window: context reports loading", contexts.isLoading("app.workspace.articleEditor"));
  store.set(TITLE, "typed during load", "user");
  check(
    "keystroke during the loading window is discarded with a warning",
    sent.length === 1 && warnings.some((w) => w.includes("discarded")),
    JSON.stringify({ sent: sent.length, warnings })
  );
  holdId = null;
  release();
  await tick();
  check(
    "fetch lands: row 2 seeded, revision adopted, loading over",
    store.get(TITLE) === "Two" &&
      revisions.get("article_editions:2") === 7 &&
      !contexts.isLoading("app.workspace.articleEditor")
  );

  const handle = attachWireReceive({ store, bound, clientId: "tab-me", revisions });
  const current = handle({
    type: "apskel.data.changed",
    table: "article_editions",
    id: 2,
    field: "title",
    value: "Two from tab B",
    revision: 8,
    sourceClient: "tab-other",
  });
  const other = handle({
    type: "apskel.data.changed",
    table: "article_editions",
    id: 1,
    field: "title",
    value: "One from tab B",
    revision: 9,
    sourceClient: "tab-other",
  });
  check(
    "receive: broadcast for the SELECTED row applies; another row is unbound",
    current === "applied" &&
      store.get(TITLE) === "Two from tab B" &&
      other === "unbound" &&
      revisions.get("article_editions:2") === 8,
    JSON.stringify({ current, other, title: store.get(TITLE) })
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
