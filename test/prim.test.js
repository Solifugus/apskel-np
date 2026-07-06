// test/prim.test.js — Phase 10.1 harness: primitive-set completion,
// DB-free.
//
//   node test/prim.test.js
//
// Markup: parseMarkup to renderer-neutral content nodes — subset blocks,
// inline nesting, literal HTML, the link scheme allowlist. Loader/
// resolver: the select domain's two closed forms and their load
// failures; rich-text's closed mode menu and load-time inputness.
// Serialization: static options baked, arrow descriptors on nodes, the
// collectSelectOptions allowlist. Wire (fake db): the options allowlist
// is the union of edge and select descriptors. Startup:
// resolveSelectOptions probe against a fake db. Expected outcomes in
// test/fixtures/README.md. Browser behavior (the select element, the
// split preview) is personal verification per the development plan.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import {
  serializeApp,
  collectSelectOptions,
  collectQueryBound,
  findByPath,
} from "../runtime/serialize.js";
import { parseMarkup } from "../runtime/markup.js";
import { attachWire, resolveSelectOptions } from "../server/wireServer.js";

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
console.log("markup — the closed subset parses to renderer-neutral content nodes");

check("empty and null parse to []", eq(parseMarkup(""), []) && eq(parseMarkup(null), []));

check(
  "a plain line is one paragraph of one text node",
  eq(parseMarkup("Hello world"), [
    { type: "paragraph", inlines: [{ type: "text", text: "Hello world" }] },
  ])
);

check(
  "blank lines split paragraphs",
  eq(
    parseMarkup("one\n\ntwo").map((n) => n.type),
    ["paragraph", "paragraph"]
  )
);

check(
  "a single newline inside a block is a break node",
  eq(parseMarkup("one\ntwo"), [
    {
      type: "paragraph",
      inlines: [
        { type: "text", text: "one" },
        { type: "break" },
        { type: "text", text: "two" },
      ],
    },
  ])
);

check(
  "#/### headings carry their level",
  eq(parseMarkup("# Title"), [
    { type: "heading", level: 1, inlines: [{ type: "text", text: "Title" }] },
  ]) &&
    eq(parseMarkup("### Deep"), [
      { type: "heading", level: 3, inlines: [{ type: "text", text: "Deep" }] },
    ])
);

check(
  "#### is outside the subset — literal text",
  eq(parseMarkup("#### four"), [
    { type: "paragraph", inlines: [{ type: "text", text: "#### four" }] },
  ])
);

check(
  "a heading is a block of its own — inside a longer block it stays literal",
  eq(parseMarkup("# H\nmore"), [
    {
      type: "paragraph",
      inlines: [
        { type: "text", text: "# H" },
        { type: "break" },
        { type: "text", text: "more" },
      ],
    },
  ])
);

check(
  "- lines make an unordered list, one item per line",
  eq(parseMarkup("- a\n- b"), [
    {
      type: "list",
      ordered: false,
      items: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
    },
  ])
);

check(
  "1. lines make an ordered list",
  eq(parseMarkup("1. a\n2. b"), [
    {
      type: "list",
      ordered: true,
      items: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
    },
  ])
);

check(
  "> lines join into one quote",
  eq(parseMarkup("> one\n> two"), [
    { type: "quote", inlines: [{ type: "text", text: "one two" }] },
  ])
);

check(
  "bold, italic, and code nest and stay literal respectively",
  eq(parseMarkup("**a *b* c** and `x < y`"), [
    {
      type: "paragraph",
      inlines: [
        {
          type: "bold",
          children: [
            { type: "text", text: "a " },
            { type: "italic", children: [{ type: "text", text: "b" }] },
            { type: "text", text: " c" },
          ],
        },
        { type: "text", text: " and " },
        { type: "code", text: "x < y" },
      ],
    },
  ])
);

check(
  "an http link survives with text and href",
  eq(parseMarkup("[click](https://example.com/x)"), [
    {
      type: "paragraph",
      inlines: [{ type: "link", text: "click", href: "https://example.com/x" }],
    },
  ])
);

check(
  "a javascript: link degrades to plain text — injection dies at the parser",
  eq(parseMarkup("[bad](javascript:x)"), [
    { type: "paragraph", inlines: [{ type: "text", text: "[bad](javascript:x)" }] },
  ])
);

check(
  "relative and mailto hrefs pass the allowlist",
  parseMarkup("[a](/article/1)")[0].inlines[0].type === "link" &&
    parseMarkup("[m](mailto:x@y.z)")[0].inlines[0].type === "link"
);

check(
  "HTML has no pass-through — a script tag is literal text",
  eq(parseMarkup("<script>alert(1)</script>"), [
    { type: "paragraph", inlines: [{ type: "text", text: "<script>alert(1)</script>" }] },
  ])
);

// ---------------------------------------------------------------------------
console.log("\nselect-widget — the two domain forms serialize per the RESOLVED entry");

const root = resolveReferences(loadApp(fixture("select-widget")));
const bundle = serializeApp(root);

{
  const kind = findByPath(bundle.tree, "app.panel.kindPick");
  check(
    "literal domain: static options baked, at the widget's own options path, no descriptor",
    kind.optionsPath === "app.panel.kindPick.options" &&
      eq(kind.staticOptions, [
        { value: "has", label: "has" },
        { value: "lacks", label: "lacks" },
      ]) &&
      kind.options === null,
    JSON.stringify({ optionsPath: kind.optionsPath, staticOptions: kind.staticOptions })
  );

  const size = findByPath(bundle.tree, "app.panel.sizePick");
  check(
    "number literals parse as numbers; labels are their string forms",
    eq(size.staticOptions, [
      { value: 1, label: "1" },
      { value: 2, label: "2" },
      { value: 3, label: "3" },
    ]),
    JSON.stringify(size.staticOptions)
  );

  const tag = findByPath(bundle.tree, "app.panel.tagPick");
  check(
    "arrow domain on a local: the options descriptor rides the node, nothing static",
    eq(tag.options, { table: "tags", value: "id", label: "name" }) &&
      tag.staticOptions === null &&
      tag.optionsPath === "app.panel.tagPick.options" &&
      tag.optionsRecordPath === null,
    JSON.stringify({ options: tag.options, staticOptions: tag.staticOptions })
  );

  const status = findByPath(bundle.tree, "app.editorBox.statusPick");
  check(
    "literal domain on a bound column: ordinary bound fieldPath, static options",
    status.fieldPath === "app.editorBox.status" &&
      eq(
        status.staticOptions.map((o) => o.value),
        ["draft", "published"]
      ),
    JSON.stringify({ fieldPath: status.fieldPath, staticOptions: status.staticOptions })
  );

  const viewer = findByPath(bundle.tree, "app.editorBox.viewer");
  const editor = findByPath(bundle.tree, "app.editorBox.editor");
  check(
    "rich-text: explicit view mode kept, absent mode filled with the menu's default",
    viewer.attrs.mode === "view" &&
      editor.attrs.mode === "edit" &&
      viewer.fieldPath === "app.editorBox.body" &&
      viewer.optionsPath === null,
    JSON.stringify({ viewer: viewer.attrs.mode, editor: editor.attrs.mode })
  );

  const selectOptions = collectSelectOptions(root);
  check(
    "collectSelectOptions: exactly the one arrow source, site attached",
    selectOptions.length === 1 &&
      eq(selectOptions[0].options, { table: "tags", value: "id", label: "name" }) &&
      selectOptions[0].site.file.includes("select-widget/app.xml"),
    JSON.stringify(selectOptions)
  );

  check(
    "both new primitives ride primitiveTypes for delivery",
    bundle.primitiveTypes.includes("select") && bundle.primitiveTypes.includes("rich-text"),
    JSON.stringify(bundle.primitiveTypes)
  );
}

// ---------------------------------------------------------------------------
console.log("\nload failures — the select domain's closed forms, the mode menu");

expectLoadFailure("fail-select-nodomain", "a select's field needs a domain", [
  "needs a domain",
  "the domain IS the option list",
  "fail-select-nodomain/app.xml:7",
]);

expectLoadFailure("fail-select-mixed", "mixed literal-plus-arrow domains are deferred", [
  "all literals or ONE table.key->table.label item",
  "fail-select-mixed/app.xml:7",
]);

expectLoadFailure("fail-select-edge", "an edge is multi-valued; multi-select is its widget", [
  "graph edge",
  "multi-select is its widget",
  "fail-select-edge/app.xml:6",
]);

expectLoadFailure("fail-richtext-mode", "the mode menu is closed", [
  "unknown mode 'wysiwyg'",
  "edit, view, split",
  "fail-richtext-mode/app.xml:7",
]);

// ---------------------------------------------------------------------------
console.log("\nknowledge-foyer — the rule composer's selects, the reader's view mount");

{
  const kf = resolveReferences(loadApp(path.join(repoDir, "apps", "knowledge-foyer", "app.xml")));
  const kfBundle = serializeApp(kf);

  const kfSelects = collectSelectOptions(kf);
  check(
    "the rule composer's tag picker declares the tags.id->tags.name source",
    kfSelects.length === 1 && eq(kfSelects[0].options, { table: "tags", value: "id", label: "name" }),
    JSON.stringify(kfSelects)
  );

  const ruleKind = findByPath(kfBundle.tree, "app.ruleBar.ruleKindInput");
  check(
    "the rule kind is a static two-option select (was: 'type has or lacks')",
    eq(
      ruleKind.staticOptions.map((o) => o.value),
      ["has", "lacks"]
    ),
    JSON.stringify(ruleKind.staticOptions)
  );

  const bodyView = findByPath(kfBundle.tree, "app.reader.bodyView");
  check(
    "the reader's body is a view-mode rich-text under the query-sourced context",
    bodyView.attrs.mode === "view" && bodyView.fieldPath === "app.reader.body",
    JSON.stringify({ mode: bodyView.attrs.mode, fieldPath: bodyView.fieldPath })
  );

  const queryBound = collectQueryBound(kf);
  check(
    "the view mount's column still rides collectQueryBound (the record-context fetch)",
    queryBound.some((b) => b.storePath === "app.reader.body" && b.query === "publishedEdition"),
    JSON.stringify(queryBound.map((b) => b.storePath))
  );
}

// ---------------------------------------------------------------------------
console.log("\nwire (fake db) — the options allowlist is the union, nothing wider");

{
  const queries = [];
  const fakeDb = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes("AS label"))
        return { rows: [{ value: 2, label: "drafting" }, { value: 3, label: "philosophy" }] };
      return { rowCount: 1, rows: [] };
    },
  };
  const app = express();
  attachWire(app, {
    db: fakeDb,
    bound: [],
    selectOptions: [
      {
        options: { table: "tags", value: "id", label: "name" },
        site: { file: "app.xml", line: 1, ref: "{ruleTag: tags.id->tags.name}" },
      },
    ],
    log: { error: () => {} },
  });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const post = (body) =>
    fetch(`${base}/wire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const good = await post({ type: "apskel.data.options", table: "tags", value: "id", label: "name" });
  const goodBody = await good.json();
  check(
    "a select-declared descriptor is allowlisted: (value, label) ordered by label",
    good.status === 200 &&
      eq(goodBody.options, [
        { value: 2, label: "drafting" },
        { value: 3, label: "philosophy" },
      ]),
    JSON.stringify(goodBody)
  );

  const bad = await post({ type: "apskel.data.options", table: "tags", value: "id", label: "secret" });
  check("an undeclared column pair -> 400 (never reaches SQL)", bad.status === 400);

  server.close();
}

// ---------------------------------------------------------------------------
console.log("\nstartup — the LIMIT-0 probe names the site");

{
  const good = {
    query: async () => ({ rows: [] }),
  };
  let threw = null;
  try {
    await resolveSelectOptions(good, [
      {
        options: { table: "tags", value: "id", label: "name" },
        site: { file: "app.xml", line: 9, ref: "{ruleTag: tags.id->tags.name}" },
      },
    ]);
  } catch (e) {
    threw = e;
  }
  check("a probe that runs passes silently", threw === null, threw?.message);

  const bad = {
    query: async () => {
      throw new Error('column "namee" does not exist');
    },
  };
  try {
    await resolveSelectOptions(bad, [
      {
        options: { table: "sb_tags", value: "id", label: "namee" },
        site: { file: "fix/app.xml", line: 9, ref: "{pickedTag: sb_tags.id->sb_tags.namee}" },
      },
    ]);
    check("a failing probe throws", false, "did not throw");
  } catch (e) {
    check(
      "the startup error names the source, the site, and the database's complaint",
      e.message.includes("sb_tags.id->sb_tags.namee") &&
        e.message.includes("fix/app.xml:9") &&
        e.message.includes('column "namee" does not exist'),
      e.message
    );
    console.log(`      error reads: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
