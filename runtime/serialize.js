// runtime/serialize.js — resolved tree <-> JSON bundle.
//
// The loader/resolver run on the server; the browser receives the already-
// bound tree as JSON. serializeApp() strips everything cyclic (parent and
// scope pointers, site owners) down to what rendering needs: paths, attrs,
// manifests, ordered content segments with a storePath per ref, a fieldPath
// per input primitive, and the declared locals for seeding. hydrateApp()
// restores the shapes store.seedDeclaredLocals expects.
//
// No imports — this module is served to the browser unmodified.

export function serializeApp(root, extra = {}) {
  const primitiveTypes = new Set();
  const tree = nodeToJson(root, primitiveTypes);
  const routes = (root.routes ?? []).map((r) => ({
    path: r.path,
    params: r.params,
    sets: r.sets.map((s) => ({
      storePath: storePathOf(s.site.binding),
      ...(s.value !== undefined ? { value: s.value } : { param: s.param }),
    })),
  }));
  return { tree, primitiveTypes: [...primitiveTypes].sort(), routes, ...extra };
}

// The store path a binding reads/writes. Function-call bindings have no
// single path; they are not renderable in Phase 3.
export function storePathOf(binding) {
  if (!binding || binding.kind === "function") return null;
  return binding.field ? `${binding.targetPath}.${binding.field}` : binding.targetPath;
}

function nodeToJson(node, primitiveTypes) {
  if (node.isPrimitive) primitiveTypes.add(node.type);
  return {
    name: node.name,
    type: node.type,
    path: node.path,
    isRoot: !!node.isRoot,
    isComposite: !!node.isComposite,
    isPrimitive: !!node.isPrimitive,
    attrs: { ...node.attrs },
    manifest: node.manifest ?? null,
    fieldPath: node.fieldSite ? storePathOf(node.fieldSite.binding) : null,
    // An edge-bound input (multi-select) gets its option list at its OWN
    // store path — runtime-owned state, filled via applyServerWrite, per
    // RESOLVED (options are runtime state at the widget's own path).
    optionsPath: node.fieldSite?.binding?.kind === "edge" ? `${node.path}.options` : null,
    action: node.actionSite ? functionToJson(node.actionSite.binding) : null,
    visible: node.visibleSite
      ? {
          storePath: storePathOf(node.visibleSite.binding),
          domain: parseDomain(node.visibleSite.domain),
        }
      : null,
    locals: [...node.locals].map(([name, decl]) => [name, decl.default]),
    content: node.content.map((seg) =>
      seg.kind === "ref"
        ? { kind: "ref", raw: seg.site.raw, storePath: storePathOf(seg.site.binding) }
        : seg.kind === "child"
          ? { kind: "child", name: seg.name }
          : { kind: "text", text: seg.text }
    ),
    children: node.children.map((child) => nodeToJson(child, primitiveTypes)),
  };
}

// A visible= domain ("editor, article" or '"draft", "published"') parsed
// to a plain value list; membership compares String(value). Bare words are
// strings; quotes are stripped. Null for the bare truthy form.
function parseDomain(domain) {
  if (domain === null || domain === undefined) return null;
  return domain
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
}

// A bound function call, flattened for the browser: the name plus each
// argument as either a literal value or a resolved store path — invocation
// needs no runtime lookup, per the bind-at-load rule. (LITERAL defaults are
// JSON-shaped, so JSON.parse is the whole evaluation.)
function functionToJson(binding) {
  return {
    name: binding.name,
    args: binding.args.map((a) =>
      a.kind === "literal"
        ? { kind: "literal", value: JSON.parse(a.value) }
        : { kind: "ref", storePath: storePathOf(a.binding) }
    ),
  };
}

// True when the app's resolved tree calls any apskel.auth.* function —
// the load-time signal that this app uses identity: run.js applies the
// identity schema and the Wire requires tokens on data writes.
export function collectUsesAuth(root) {
  return root.allRefs.some(
    (s) => s.binding?.kind === "function" && s.binding.name.startsWith("apskel.auth.")
  );
}

export function hydrateApp(treeJson) {
  (function walk(node) {
    node.locals = new Map(node.locals.map(([name, def]) => [name, { default: def }]));
    for (const child of node.children) walk(child);
  })(treeJson);
  return treeJson;
}

// Collect wire metadata for every bound field the app declares: the store
// path, the data-context path, table, record (the Phase 4 row-selection
// stopgap attribute), and column. Runs server-side on the resolved tree;
// the result rides in the bundle and doubles as the server's allowlist.
export function collectBoundFields(root) {
  const byStorePath = new Map();
  for (const site of root.allRefs) {
    const binding = site.binding;
    if (!binding || binding.kind !== "bound") continue;
    const storePath = storePathOf(binding);
    if (byStorePath.has(storePath)) continue;
    const target = binding.target;
    const rawRecord = target.attrs.record ?? null;
    // A fixed row is a number; a dynamic selection ships as recordPath —
    // the store path whose VALUE names the row, per RESOLVED (record
    // selection). Static entries keep the Phase 4 shape exactly.
    const entry = {
      storePath,
      path: binding.targetPath,
      table: binding.table,
      record: target.recordSite
        ? null
        : rawRecord !== null && /^\d+$/.test(rawRecord)
          ? Number(rawRecord)
          : rawRecord,
      field: binding.field,
      conflict: target.attrs.conflict ?? "offline-readonly",
    };
    if (target.recordSite) entry.recordPath = storePathOf(target.recordSite.binding);
    byStorePath.set(storePath, entry);
  }
  return [...byStorePath.values()];
}

// The per-table permission rules declared on the data graph, per RESOLVED
// (permission rules live on the data graph). Plain data: the server
// resolves hop columns against the live schema at startup and enforces;
// the bundle may carry it for inspection, the client never enforces.
export function collectPermissions(root) {
  return (root.data?.permissions ?? []).map((p) => ({
    table: p.table,
    read: p.read,
    write: p.write,
    hops: p.hops.map((h) => ({ ...h })),
  }));
}

// Every edge-bound set field the app declares, per RESOLVED (a set field
// is a domain-bearing edge reference): the store path holding the member
// array, the context (with record/recordPath exactly like bound fields),
// the edge and its stored/label columns, and the options descriptor the
// widget's option list is fetched with. Startup introspection fills
// joinTable/parentColumn/childColumn against the live schema.
export function collectSetFields(root) {
  const byStorePath = new Map();
  for (const site of root.allRefs) {
    const binding = site.binding;
    if (!binding || binding.kind !== "edge") continue;
    const storePath = storePathOf(binding);
    if (byStorePath.has(storePath)) continue;
    const target = binding.target;
    const rawRecord = target.attrs.record ?? null;
    const entry = {
      storePath,
      path: binding.targetPath,
      table: binding.table,
      edge: binding.edge,
      record: target.recordSite
        ? null
        : rawRecord !== null && /^\d+$/.test(rawRecord)
          ? Number(rawRecord)
          : rawRecord,
      stored: binding.stored,
      label: binding.label,
      join: binding.join,
      options: { table: binding.edge, value: binding.stored, label: binding.label },
      site: { file: site.file, line: site.line, ref: site.raw },
    };
    if (target.recordSite) entry.recordPath = storePathOf(target.recordSite.binding);
    byStorePath.set(storePath, entry);
  }
  return [...byStorePath.values()];
}

export function findByPath(root, targetPath) {
  if (targetPath === "app") return root;
  let cur = root;
  for (const seg of targetPath.split(".").slice(1)) {
    cur = cur.children.find((c) => c.name === seg);
    if (!cur) return null;
  }
  return cur;
}
