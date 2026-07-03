// test/render.test.js — Phase 3 harness: the Node-testable slice.
//
//   node test/render.test.js
//
// Asserts primitive resolution, field= binding paths, content segments,
// serialize/hydrate, and the two new failure fixtures. Browser behavior
// (typing sync, write-through DOM, no cross-talk) is personal verification
// per the development plan.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { serializeApp, hydrateApp, findByPath } from "../runtime/serialize.js";
import { createStore } from "../runtime/store.js";

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

// ---------------------------------------------------------------------------
console.log("uppercase-demo — loads, primitives resolved, field paths bound");

const root = resolveReferences(loadApp(path.join(repoDir, "apps", "uppercase-demo", "app.xml")));
const bundle = serializeApp(root, { title: root.attrs.title });

check(
  "all four primitive types resolved with manifests",
  eq(bundle.primitiveTypes, ["button", "layout", "text-area", "text-input"]),
  JSON.stringify(bundle.primitiveTypes)
);

const json = JSON.parse(JSON.stringify(bundle)); // must be acyclic JSON
const tree = hydrateApp(json.tree);

const sourceInput = findByPath(tree, "app.page.entryRow.sourceInput");
const mirrorInput = findByPath(tree, "app.page.shoutRow.mirrorInput");
const longInput = findByPath(tree, "app.page.longRow.longInput");
check(
  "field= expressions bound to store paths (typed / shout / typed)",
  sourceInput?.fieldPath === "app.typed" &&
    mirrorInput?.fieldPath === "app.shout" &&
    longInput?.fieldPath === "app.typed",
  JSON.stringify({
    source: sourceInput?.fieldPath,
    mirror: mirrorInput?.fieldPath,
    long: longInput?.fieldPath,
  })
);

const noteOne = findByPath(tree, "app.page.padOne.padBox.noteInput");
const noteTwo = findByPath(tree, "app.page.padTwo.padBox.noteInput");
check(
  "echo-pad mounted twice binds distinct per-instance field paths",
  noteOne?.fieldPath === "app.page.padOne.note" && noteTwo?.fieldPath === "app.page.padTwo.note",
  JSON.stringify({ one: noteOne?.fieldPath, two: noteTwo?.fieldPath })
);

const padBox = findByPath(tree, "app.page.padOne.padBox");
check(
  "content segments: order kept, whitespace collapsed, declaration emits none",
  eq(padBox?.content, [
    { kind: "text", text: "Pad note (independent per pad):" },
    { kind: "child", name: "noteInput" },
    { kind: "text", text: "You wrote: " },
    { kind: "ref", raw: "{note}", storePath: "app.page.padOne.note" },
  ]),
  JSON.stringify(padBox?.content)
);

const page = findByPath(tree, "app.page");
const mirrorSeg = page?.content.find((s) => s.kind === "ref");
check(
  "page-level ref segment carries its store path (app.shout)",
  mirrorSeg?.storePath === "app.shout" && mirrorSeg?.raw === "{shout}",
  JSON.stringify(mirrorSeg)
);

const store = createStore();
store.seedDeclaredLocals(tree);
check(
  "hydrated tree seeds declared locals (app.typed, per-pad notes)",
  store.get("app.typed") === "" &&
    store.get("app.shout") === "" &&
    store.get("app.page.padOne.note") === "" &&
    store.get("app.page.padTwo.note") === "",
  JSON.stringify(store.paths())
);

// ---------------------------------------------------------------------------
console.log("\nload failures — unknown type, braced field");

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

expectLoadFailure("fail-unknown-type", "unknown component type fails at load", [
  "unknown component type 'does-not-exist'",
  "<thing>",
  "fail-unknown-type/app.xml:5",
]);

expectLoadFailure("fail-field-braces", "braced field= expression fails at load", [
  "field attribute",
  "without braces",
  "fail-field-braces/app.xml:7",
]);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
