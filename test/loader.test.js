// test/loader.test.js — Phase 1 harness: loader + resolver, pure Node.
//
//   node test/loader.test.js
//
// Asserts the expected outcomes recorded in test/fixtures/README.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

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

function load(fixture) {
  const root = loadApp(path.join(fixturesDir, fixture, "app.xml"));
  return resolveReferences(root);
}

function byPath(root, targetPath) {
  let cur = root;
  for (const seg of targetPath.split(".").slice(1)) {
    cur = cur.children.find((c) => c.name === seg);
    if (!cur) return null;
  }
  return cur;
}

function sites(root, raw) {
  return root.allRefs.filter((s) => s.raw === raw);
}

function expectLoadFailure(fixture, label, substrings) {
  try {
    load(fixture);
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
console.log("double-mount — loads, and each instance binds to its own interior");

const root = load("double-mount");

const phoneOne = byPath(root, "app.directory.entryOne.card.phoneField");
const phoneTwo = byPath(root, "app.directory.entryTwo.card.phoneField");
check("both expanded instances exist in the tree", Boolean(phoneOne && phoneTwo));
check(
  "expansion produced distinct nodes (fresh instance per mount)",
  phoneOne !== phoneTwo && phoneOne?.path !== phoneTwo?.path
);

check(
  "parent pointers chain phoneField -> card -> entryOne -> directory -> app",
  (() => {
    const chain = [];
    for (let n = phoneOne; n; n = n.parent) chain.push(n.name);
    return chain.join(",") === "phoneField,card,entryOne,directory,app";
  })()
);

const phoneRefs = sites(root, "{phoneField.value}");
check("two {phoneField.value} sites exist (one per instance)", phoneRefs.length === 2);
check(
  "each {phoneField.value} site binds to its OWN instance's phoneField",
  phoneRefs.every(
    (s) => s.binding?.targetPath === `${s.scope.path}.card.phoneField` && s.binding.field === "value"
  ),
  phoneRefs.map((s) => `${s.scope.path} -> ${s.binding?.targetPath}`).join("; ")
);
check(
  "the two bindings target distinct paths",
  new Set(phoneRefs.map((s) => s.binding?.targetPath)).size === 2
);

const labelRefs = sites(root, "{label}");
check("two {label} sites exist", labelRefs.length === 2);
check(
  "{label} binds to the mount parameter of its own instance",
  labelRefs.every((s) => s.binding?.kind === "local" && s.binding.targetPath === s.scope.path) &&
    new Set(labelRefs.map((s) => s.binding.target.attrs.label)).size === 2,
  labelRefs.map((s) => `${s.binding?.targetPath}=${s.binding?.target.attrs.label}`).join("; ")
);

const upRefs = sites(root, "{^directory.heading}");
check("two {^directory.heading} sites exist", upRefs.length === 2);
check(
  "{^directory.heading} binds upward to app.directory in both instances",
  upRefs.every((s) => s.binding?.targetPath === "app.directory" && s.binding.field === "heading")
);

const noteDecls = sites(root, '{note = ""}');
check("two {note = \"\"} declaration sites exist", noteDecls.length === 2);
check(
  "{note = \"\"} declares the local on its own instance's scope",
  noteDecls.every(
    (s) =>
      s.binding?.kind === "local" &&
      s.binding.declares === true &&
      s.binding.targetPath === s.scope.path &&
      s.scope.locals.has("note")
  )
);

const noteReads = sites(root, "{note}");
check("two {note} read sites exist", noteReads.length === 2);
check(
  "{note} reads bind to the declared local of their own scope",
  noteReads.every(
    (s) =>
      s.binding?.kind === "local" &&
      !s.binding.declares &&
      s.binding.targetPath === s.scope.path &&
      s.binding.field === "note"
  )
);

const absRefs = sites(root, "{app.title}");
check(
  "{app.title} binds absolutely to the root's title attribute",
  absRefs.length === 1 &&
    absRefs[0].binding?.target === root &&
    absRefs[0].binding.field === "title"
);

check(
  "every reference site carries a stored binding",
  root.allRefs.every((s) => s.binding !== null)
);

// ---------------------------------------------------------------------------
console.log("\nmandatory load failures — each names its reference site");

expectLoadFailure("fail-bare-name", "bare name that is not local fails at load", [
  "bare name 'search'",
  "fail-bare-name/app.xml:6",
  "{search}",
]);

expectLoadFailure("fail-ambiguous", "app-wide ambiguous named reference fails at load", [
  "ambiguous",
  "app.directory.entryOne.card.phoneField",
  "app.directory.entryTwo.card.phoneField",
  "fail-ambiguous/app.xml:8",
  "{phoneField.value}",
]);

expectLoadFailure("fail-no-ancestor", "^name with no matching ancestor fails at load", [
  "no enclosing ancestor named 'workspace'",
  "needs-workspace.xml:4",
  "{^workspace.budget}",
]);

expectLoadFailure("fail-duplicate-local", "declaring the same local twice fails at load", [
  "local field 'search' is already declared",
  "fail-duplicate-local/app.xml:7",
  "app.xml:6",
  '{search = "preset"}',
]);

expectLoadFailure("fail-duplicate-sibling", "same-named siblings fail at load", [
  "duplicate sibling component name 'item'",
  "app.box",
  "fail-duplicate-sibling/app.xml:7",
]);

expectLoadFailure("fail-app-reserved", "component instance named 'app' fails at load", [
  "reserved",
  "fail-app-reserved/app.xml:5",
]);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
