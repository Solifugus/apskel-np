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
  return { tree, primitiveTypes: [...primitiveTypes].sort(), ...extra };
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

export function hydrateApp(treeJson) {
  (function walk(node) {
    node.locals = new Map(node.locals.map(([name, def]) => [name, { default: def }]));
    for (const child of node.children) walk(child);
  })(treeJson);
  return treeJson;
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
