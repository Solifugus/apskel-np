// runtime/pathResolver.js — Phase 1 reference resolver.
//
// Classifies every reference site collected by the loader (local / .bound /
// named / ^name / app. / function call), runs the matching search strategy,
// and binds each site to its concrete target, storing the binding on the
// site. Resolution happens once, at load; after this pass a read is a direct
// lookup through the stored binding.
//
// Search strategies, per the design doc's RESOLVED entries:
//   local     {field}        the enclosing naming scope's mount parameters
//                            (or the <app> element's attributes at app
//                            scope), plus locals declared by a defaulted
//                            reference {name = default} in that scope. No
//                            outward search, ever; locals are never created
//                            implicitly by a bare read.
//   bound     {.field}       nearest enclosing instance declaring table=,
//                            including the owner itself.
//   named     {name.field}   written inside a composite definition: that
//                            definition's scope only. Written at app scope:
//                            the whole tree, and the name must be
//                            unambiguous app-wide.
//   upward    {^name.field}  strict ancestors of the site, nearest match
//                            wins; matching is by name, never by position.
//   absolute  {app.x.y}      from the root: segments are consumed as child
//                            instance names; the remainder is the field path.
//   function  {fn(a, b)}     classified, its reference arguments resolved,
//                            and (since Phase 5) the name validated against
//                            the framework function registry — unknown
//                            functions are load-time errors.
//
// Field existence on components is NOT validated in Phase 1 — primitives
// have no manifests yet. Component targets always are.
//
// Phase 5: app.identity.* is a reserved framework store region, per
// RESOLVED (identity store region) — an absolute reference into it binds
// without any component named 'identity' existing. A site marked
// requireFunction (the button's action=) must resolve to a function call.

import { ApskelLoadError } from "./loader.js";
import { FRAMEWORK_FUNCTION_NAMES } from "./frameworkFunctions.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function resolveReferences(root) {
  // Declaration pass first: register every {name = default} in its scope so
  // a bare read never depends on document order relative to the declaration.
  for (const site of root.allRefs) {
    registerDeclaration(site);
  }
  // Edges marked as join edges by set-field references, filled during
  // resolution and checked by the owner-walk pass below. Key: "parent->child".
  root.edgeRefs = new Map(); // key -> the first marking site
  for (const site of root.allRefs) {
    resolveSite(site, root);
  }
  // The owner walk refuses to cross a join edge, per RESOLVED (the graph
  // has two edge kinds). A set-field reference marks its edge as a join
  // edge in the XML itself, so this case is load-knowable; without such a
  // reference the same mistake surfaces at startup (no child->parent FK).
  for (const p of root.data?.permissions ?? []) {
    if (p.read !== "owner" && p.write !== "owner") continue;
    for (const hop of p.hops) {
      const marker = root.edgeRefs.get(`${hop.parent}->${hop.child}`);
      if (marker) {
        throw new ApskelLoadError(
          `<${p.table}> declares an 'owner' rule but its path to 'users' crosses the ` +
            `join edge ${hop.parent}->${hop.child} (marked as a join edge by the set ` +
            `field at ${marker.file}:${marker.line}) — the owner walk refuses to cross ` +
            `a join edge; join edges confer no ownership`,
          { file: p.file, line: p.line }
        );
      }
    }
  }
  // Nested collections follow graph edges, per RESOLVED (nested
  // collections follow graph edges): an inner collection binding must be
  // a declared graph child of the enclosing context's table. A
  // query-sourced enclosing context has no graph position, so any inner
  // collection under one is an error.
  (function walkNested(node, enclosing) {
    let next = enclosing;
    if (node.attrs?.table !== undefined || node.attrs?.source !== undefined) {
      if (node.isCollection && enclosing) {
        const at = { file: node.file, line: node.line };
        if (enclosing.query) {
          throw new ApskelLoadError(
            `collection <${node.name}> nested under the query-sourced context ` +
              `'${enclosing.path}' — a query has no graph position, so nothing nests ` +
              `under it, per RESOLVED (nested collections follow graph edges)`,
            at
          );
        }
        if (
          node.attrs.source !== undefined ||
          !root.data?.children?.get(enclosing.table)?.has(node.attrs.table)
        ) {
          throw new ApskelLoadError(
            `collection <${node.name}> nested under the '${enclosing.table}' context ` +
              `'${enclosing.path}' does not correspond to a declared graph edge from ` +
              `'${enclosing.table}', per RESOLVED (nested collections follow graph edges)`,
            at
          );
        }
      }
      next = { table: node.attrs.table ?? null, query: node.attrs.source ?? null, path: node.path };
    }
    for (const child of node.children ?? []) walkNested(child, next);
  })(root, null);

  // '@user' needs an identity to be filled from, per RESOLVED
  // (identity-bound query parameters). Whether the app uses identity is
  // XML-knowable (it calls apskel.auth.* or it doesn't), so this is a
  // load error, not a startup one.
  const queries = [...(root.data?.queries?.values() ?? [])];
  if (queries.some((q) => q.params.includes("@user"))) {
    const usesAuth = root.allRefs.some(
      (s) => s.binding?.kind === "function" && s.binding.name.startsWith("apskel.auth.")
    );
    if (!usesAuth) {
      const q = queries.find((p) => p.params.includes("@user"));
      throw new ApskelLoadError(
        `<query name="${q.name}"> declares '@user' but this app never calls ` +
          `apskel.auth.* — there is no identity to fill it from`,
        { file: q.file, line: q.line }
      );
    }
  }

  // detect's two load obligations (Phase 10.2, design session 7).
  const conflictNodes = [];
  (function collectConflicts(node) {
    if (node.attrs?.conflict === "detect" || node.attrs?.conflict === "lww") {
      conflictNodes.push(node);
    }
    for (const child of node.children ?? []) collectConflicts(child);
  })(root);
  if (conflictNodes.length > 0) {
    const usesAuth = root.allRefs.some(
      (s) => s.binding?.kind === "function" && s.binding.name.startsWith("apskel.auth.")
    );
    // Offline writes require the identity machinery, per RESOLVED
    // (offline writes require the identity machinery): a tokenless app
    // has no device row, no per-device seq namespace, and no place to
    // anchor insert receipts — so detect/lww on a context whose table is
    // an insert target cannot queue and is refused at load.
    if (!usesAuth) {
      const insertTargets = new Set();
      (function collectCollections(node) {
        if (node.isCollection && node.attrs?.table !== undefined) {
          insertTargets.add(node.attrs.table);
        }
        for (const child of node.children ?? []) collectCollections(child);
      })(root);
      for (const s of root.allRefs) {
        if (s.binding?.kind === "function" && s.binding.name === "apskel.data.create") {
          insertTargets.add(JSON.parse(s.binding.args[0].value));
        }
      }
      const offending = conflictNodes.find((n) => insertTargets.has(n.attrs.table));
      if (offending) {
        throw new ApskelLoadError(
          `conflict="${offending.attrs.conflict}" on <${offending.name}> but its table ` +
            `'${offending.attrs.table}' is an insert target and this app never calls ` +
            `apskel.auth.* — offline writes require the identity machinery (there is ` +
            `no device to anchor insert receipts to); a tokenless app is ` +
            `offline-readonly for writes`,
          { file: offending.file, line: offending.line }
        );
      }
    }
    // The not-mounted floor, per RESOLVED (the conflict prompt is a
    // framework composite over a reserved region): detect anywhere
    // requires a reference site reading app.sync.* AND a call site for a
    // resolution function — an app that shows the conflict but wires no
    // verb is the silent-parking machine this error exists to prevent.
    const detectNode = conflictNodes.find((n) => n.attrs.conflict === "detect");
    if (detectNode) {
      const readsRegion = root.allRefs.some(
        (s) => s.binding?.kind === "absolute" && (s.binding.field ?? "").startsWith("sync.")
      );
      const hasVerb = root.allRefs.some(
        (s) => s.binding?.kind === "function" && s.binding.name.startsWith("apskel.sync.")
      );
      const at = { file: detectNode.file, line: detectNode.line };
      if (!readsRegion) {
        throw new ApskelLoadError(
          `conflict="detect" on <${detectNode.name}> but nothing in this app reads ` +
            `the app.sync.* region — a conflict would park forever with no prompt; ` +
            `mount the shipped conflict-prompt composite (or your own over the same ` +
            `region and apskel.sync.* functions)`,
          at
        );
      }
      if (!hasVerb) {
        throw new ApskelLoadError(
          `conflict="detect" on <${detectNode.name}> and the app reads app.sync.*, ` +
            `but no action calls a resolution function — a conflict would park ` +
            `forever with no door out; wire apskel.sync.keepMine() or ` +
            `apskel.sync.takeTheirs() (the shipped conflict-prompt composite carries both)`,
          at
        );
      }
    }
  }

  return root;
}

const DECLARATION = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/s;

function registerDeclaration(site) {
  const inner = site.raw.slice(1, -1).trim();
  const m = inner.match(DECLARATION);
  if (!m) return;
  const [, name, defaultText] = m;
  if (!LITERAL.test(defaultText)) {
    fail(site, `local declaration '${name}' has a non-literal default '${defaultText}'`);
  }
  const scope = site.scope;
  if (name in scope.attrs) {
    fail(
      site,
      `local field '${name}' is already bound as a mount parameter of scope '${scope.path}'`
    );
  }
  const prior = scope.locals.get(name);
  if (prior) {
    fail(
      site,
      `local field '${name}' is already declared in scope '${scope.path}' ` +
        `(first declared at ${prior.site.file}:${prior.site.line})`
    );
  }
  scope.locals.set(name, { site, default: defaultText });
  site.isDeclaration = true;
}

function fail(site, message) {
  throw new ApskelLoadError(message, { file: site.file, line: site.line, ref: site.raw });
}

function resolveSite(site, root) {
  const inner = site.raw.slice(1, -1).trim();
  const { expr, domain } = splitDomain(inner);
  site.domain = domain;
  if (site.isSource) {
    site.form = "source";
    site.binding = resolveSource(site, inner, root);
    return;
  }
  site.form = classify(expr);
  switch (site.form) {
    case "local":
      site.binding = resolveLocal(site, expr);
      break;
    case "bound":
      site.binding = resolveBound(site, expr, root);
      break;
    case "named":
      site.binding = resolveNamed(site, expr, root);
      break;
    case "upward":
      site.binding = resolveUpward(site, expr);
      break;
    case "absolute":
      site.binding = resolveAbsolute(site, expr, root);
      break;
    case "function":
      site.binding = resolveFunction(site, expr, root);
      break;
  }
  if (site.requireFunction && site.form !== "function") {
    fail(
      site,
      `action= must be a function call — ` +
        `action="apskel.auth.loginUser(email, password)" — got '${expr}'`
    );
  }
  // Route targets (and any other flagged writer) may not claim the
  // identity region — it is written only by the auth machinery. The
  // sync region is its parallel: written only by the sync machinery.
  if (site.forbidIdentity && site.binding) {
    const p = site.binding.field
      ? `${site.binding.targetPath}.${site.binding.field}`
      : site.binding.targetPath;
    if (p === "app.identity" || p.startsWith("app.identity.")) {
      fail(site, `may not target the reserved identity region '${p}'`);
    }
    if (p === "app.sync" || p.startsWith("app.sync.")) {
      fail(site, `may not target the reserved sync region '${p}'`);
    }
  }
  // A select's option list IS its field's domain, per RESOLVED (a
  // select is a domain-bearing column reference).
  if (site.optionsFromDomain) resolveSelectDomain(site);
}

// The select domain's two closed forms: all literals (static options,
// baked into the bundle) or exactly one table.key->table.label item (an
// apskel.data.options source). An edge is multi-valued by declaration
// and belongs to multi-select; mixed and multi-arrow domains are the
// deferred "combo input", not half-shipped here.
const SELECT_ARROW = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)->([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;
const SELECT_BARE_WORD = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function resolveSelectDomain(site) {
  if (site.binding?.kind === "edge") {
    fail(
      site,
      `a select's field resolves to the graph edge '${site.binding.table}->` +
        `${site.binding.edge}' — an edge is multi-valued by declaration, and ` +
        `multi-select is its widget`
    );
  }
  if (site.domain === null || site.domain === undefined || site.domain === "") {
    fail(
      site,
      `a select's field needs a domain — the domain IS the option list ` +
        `(field="name: a, b" or field="name: table.key->table.label")`
    );
  }
  const items = splitArgs(site.domain);
  if (items.some((i) => SELECT_ARROW.test(i))) {
    if (items.length > 1) {
      fail(
        site,
        `a select's domain is either all literals or ONE table.key->table.label ` +
          `item — mixed and multi-arrow domains are deferred, per RESOLVED (a ` +
          `select is a domain-bearing column reference)`
      );
    }
    const [, table, value, labelTable, label] = items[0].match(SELECT_ARROW);
    if (table !== labelTable) {
      fail(site, `the arrow's two sides must name the same table — got '${items[0]}'`);
    }
    site.optionsSource = { table, value, label };
    return;
  }
  site.staticOptions = items.map((item) => {
    if (LITERAL.test(item)) {
      const parsed = JSON.parse(item);
      return { value: parsed, label: String(parsed) };
    }
    if (SELECT_BARE_WORD.test(item)) return { value: item, label: item };
    fail(
      site,
      `select domain item '${item}' — items are literals or one ` +
        `table.key->table.label item`
    );
  });
}

// A domain follows the first ':' outside quotes: {.status: "draft", "published"}
function splitDomain(inner) {
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      return { expr: inner.slice(0, i).trim(), domain: inner.slice(i + 1).trim() };
    }
  }
  return { expr: inner, domain: null };
}

function classify(expr) {
  if (expr.startsWith("^")) return "upward";
  if (expr.startsWith(".")) return "bound";
  if (DECLARATION.test(expr)) return "local";
  if (/^[A-Za-z_][A-Za-z0-9_.]*\(/.test(expr)) return "function";
  if (expr === "app" || expr.startsWith("app.")) return "absolute";
  if (expr.includes(".")) return "named";
  return "local";
}

// --- local: {field} ---------------------------------------------------------

function resolveLocal(site, expr) {
  const scope = site.scope;
  const decl = expr.match(DECLARATION);
  if (decl) {
    // Registered by the declaration pass; the site binds to the field it
    // declares on its own scope.
    const [, name] = decl;
    return {
      kind: "local",
      target: scope,
      targetPath: scope.path,
      field: name,
      declares: true,
      default: scope.locals.get(name).default,
    };
  }
  if (!IDENT.test(expr)) fail(site, `malformed reference '${expr}'`);
  if (!(expr in scope.attrs) && !scope.locals.has(expr)) {
    fail(
      site,
      `bare name '${expr}' is not a local field of scope '${scope.path}' ` +
        `(neither a mount parameter nor a declared {name = default} local); ` +
        `bare names do not search outward — use {name.field}, {^name.field}, or {app...}`
    );
  }
  return { kind: "local", target: scope, targetPath: scope.path, field: expr };
}

// --- source: source="queryName(args)" ---------------------------------------

// A declared query as a context source, per RESOLVED (named queries are
// declared, read-only sources): bare name or call form, arity checked
// against the declared params at load, arguments literals or references.
function resolveSource(site, inner, root) {
  const m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?$/s);
  if (!m) fail(site, `malformed source expression '${inner}'`);
  const [, name, argText] = m;
  const query = root.data?.queries?.get(name);
  if (!query) {
    const known = [...(root.data?.queries?.keys() ?? [])];
    fail(
      site,
      `unknown query '${name}' — ` +
        (known.length ? `declared queries: ${known.join(", ")}` : `this app declares no <query> elements`)
    );
  }
  const args = argText === undefined ? [] : splitArgs(argText).map((arg) => {
    if (LITERAL.test(arg)) return { kind: "literal", value: arg };
    const sub = { ...site, raw: `{${arg}}`, form: null, binding: null, isSource: false };
    resolveSite(sub, root);
    return { kind: "ref", form: sub.form, binding: sub.binding };
  });
  // The call-site arity counts only the non-@ params: '@user' is filled
  // server-side from the token, per RESOLVED (identity-bound query
  // parameters) — a caller neither passes it nor can.
  const callParams = query.params.filter((p) => !p.startsWith("@"));
  if (args.length !== callParams.length) {
    const reserved = query.params.length !== callParams.length
      ? ` ('@user' is filled server-side from the token, never by the caller)`
      : "";
    fail(
      site,
      `query '${name}' takes ${callParams.length} call-site parameter(s) ` +
        `(${callParams.join(", ") || "none"})${reserved} — got ${args.length}`
    );
  }
  return { kind: "source", name, query, args };
}

// --- bound: {.field} --------------------------------------------------------

function resolveBound(site, expr, root) {
  const field = expr.slice(1);
  if (!field) fail(site, `malformed bound reference '${expr}'`);
  for (let n = site.owner; n; n = n.parent) {
    if (n.attrs.source) {
      // A query-sourced context: read-only by grammar, per RESOLVED
      // (named queries are declared, read-only sources).
      if (site.isInput) {
        fail(
          site,
          `input binding '.${field}' under the query-sourced context '${n.path}' — ` +
            `query sources are read-only; writes belong to table contexts`
        );
      }
      return {
        kind: "bound",
        target: n,
        targetPath: n.path,
        table: null,
        query: n.attrs.source,
        field,
      };
    }
    if (n.attrs.table) {
      // Edge classification is by graph declaration, at load, period —
      // per RESOLVED (a set field is a domain-bearing edge reference),
      // Ruling 3: a name matching a declared graph child of the context's
      // table is an edge reference, never reclassified. A collision with
      // an actual column of the same name is a startup error (only the
      // schema knows columns).
      const edge = root.data?.children?.get(n.attrs.table)?.get(field);
      if (edge && !site.isFilter) {
        return resolveEdge(site, n, field, edge, root);
      }
      const binding = { kind: "bound", target: n, targetPath: n.path, table: n.attrs.table, field };
      if (site.isFilter) resolveFilter(site, binding, root);
      return binding;
    }
  }
  fail(
    site,
    `bound field '${expr}' has no data context: no enclosing component declares table= or source=`
  );
}

// filter= — the domain syntax on a column of the binding's own rows, per
// RESOLVED (filter= is the domain syntax on a column): items are literals
// or absolute references (a reference value makes the filter dynamic); no
// bare-truthiness form.
function resolveFilter(site, binding, root) {
  if (site.domain === null || site.domain === undefined || site.domain === "") {
    fail(
      site,
      `filter= takes the domain syntax — filter=".${binding.field}: value, value"; ` +
        `there is no bare-truthiness form`
    );
  }
  site.filterItems = splitArgs(site.domain).map((item) => {
    // Domain-grammar literals: bare words are strings (like visible=),
    // quoted strings / numbers / booleans parse as themselves.
    if (LITERAL.test(item)) return { kind: "literal", parsed: JSON.parse(item) };
    if (item === "app" || item.startsWith("app.")) {
      const sub = { ...site, raw: `{${item}}`, form: null, binding: null, isFilter: false };
      resolveSite(sub, root);
      return { kind: "ref", binding: sub.binding };
    }
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(item)) {
      return { kind: "literal", parsed: item };
    }
    fail(
      site,
      `filter item '${item}' — filter values are literals or absolute {app...} ` +
        `references, per RESOLVED (filter= is the domain syntax on a column)`
    );
  });
}

// An edge reference is multi-valued and its domain is mandatory: the
// domain carries the stored/display contract, and on an edge the arrow
// form is the only legal item — the stored value is not the author's
// choice (it must be the join FK's referenced column, checked at
// startup; the FORM is checked here). Literals cannot be membership rows.
function resolveEdge(site, contextNode, edgeName, edgeDecl, root) {
  const table = contextNode.attrs.table;
  if (site.domain === null || site.domain === undefined || site.domain === "") {
    fail(
      site,
      `'.${edgeName}' is an edge reference (declared graph child of '${table}') and ` +
        `requires a domain — {.${edgeName}: ${edgeName}.<key>->${edgeName}.<label>}`
    );
  }
  const items = splitArgs(site.domain);
  const ARROW = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)->([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;
  if (items.length !== 1) {
    fail(
      site,
      `an edge domain is a single ${edgeName}.<key>->${edgeName}.<label> item — a ` +
        `literal cannot be a membership row, and mixed domains are column-domain features`
    );
  }
  const m = items[0].match(ARROW);
  if (!m) {
    fail(
      site,
      `the arrow form is mandatory on an edge reference — the stored value is not the ` +
        `author's choice ('.${edgeName}' got '${items[0]}'; want ` +
        `${edgeName}.<key>->${edgeName}.<label>)`
    );
  }
  const [, storedTable, stored, labelTable, label] = m;
  if (storedTable !== edgeName || labelTable !== edgeName) {
    fail(
      site,
      `the edge domain's table must be the edge's own table '${edgeName}' — got ` +
        `'${storedTable}.${stored}->${labelTable}.${label}'`
    );
  }
  root.edgeRefs.set(`${table}->${edgeName}`, site);
  return {
    kind: "edge",
    target: contextNode,
    targetPath: contextNode.path,
    table,
    edge: edgeName,
    field: edgeName,
    stored,
    label,
    join: edgeDecl.join ?? null,
  };
}

// --- named: {name.field} ----------------------------------------------------

function resolveNamed(site, expr, root) {
  const segs = expr.split(".");
  const name = segs[0];
  const field = segs.slice(1).join(".");
  let target;

  if (site.scope.isRoot) {
    // Written at app scope: search the whole tree; the name must be
    // unambiguous app-wide.
    const candidates = root.appWideNames.get(name) || [];
    if (candidates.length === 0) {
      fail(site, `named reference '${name}' does not match any component in the app`);
    }
    if (candidates.length > 1) {
      fail(
        site,
        `named reference '${name}' is ambiguous app-wide; candidates: ` +
          candidates.map((c) => c.path).join(", ") +
          ` — use an absolute {app...} path to pick one`
      );
    }
    target = candidates[0];
  } else {
    // Written inside a composite definition: resolve within that
    // definition's scope only, so every mounted instance binds to its own
    // interior. No fallback outward.
    const matches = site.scope.names.get(name) || [];
    if (matches.length === 0) {
      fail(
        site,
        `named reference '${name}' does not match any component in the ` +
          `definition scope of '${site.scope.type}'`
      );
    }
    // Uniqueness within a definition is enforced at build time.
    target = matches[0];
  }
  return { kind: "named", target, targetPath: target.path, field };
}

// --- upward: {^name.field} --------------------------------------------------

function resolveUpward(site, expr) {
  const m = expr.match(/^\^([A-Za-z_][A-Za-z0-9_]*)(?:\.(.+))?$/);
  if (!m) fail(site, `malformed upward reference '${expr}'`);
  const [, name, field = ""] = m;
  for (let n = site.owner.parent; n && !n.isRoot; n = n.parent) {
    if (n.name === name) {
      return { kind: "upward", target: n, targetPath: n.path, field };
    }
  }
  fail(site, `no enclosing ancestor named '${name}'`);
}

// --- absolute: {app.x.y} ----------------------------------------------------

function resolveAbsolute(site, expr, root) {
  const segs = expr.split(".");
  // app.identity.* is the reserved framework region — the auth machinery
  // writes it, anything may read it, and no component may claim the name.
  // app.sync.* is its Phase 10.2 parallel: the derived view of the head
  // parked conflict, written only by the sync machinery.
  if (segs[1] === "identity" || segs[1] === "sync") {
    return { kind: "absolute", target: root, targetPath: "app", field: segs.slice(1).join(".") };
  }
  let cur = root; // segs[0] === 'app'
  let i = 1;
  while (i < segs.length) {
    const child = cur.children.find((c) => c.name === segs[i]);
    if (!child) break;
    cur = child;
    i += 1;
  }
  const field = segs.slice(i).join(".");
  if (cur === root && field) {
    // At the root we can validate: the field must be an <app> attribute or
    // an app-scope declared local, per RESOLVED (absolute references reach
    // app-scope locals). Deeper fields stay unvalidated until primitives
    // carry manifests.
    if (!(segs[i] in root.attrs) && !root.locals.has(segs[i])) {
      fail(
        site,
        `absolute reference '${expr}' does not resolve: the root has no child ` +
          `component, app attribute, or app-scope declared local named '${segs[i]}'`
      );
    }
  }
  return { kind: "absolute", target: cur, targetPath: cur.path, field };
}

// --- function: {fn(args)} ---------------------------------------------------

const LITERAL = /^("[^"]*"|-?\d+(\.\d+)?|true|false)$/;

function resolveFunction(site, expr, root) {
  const m = expr.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/s);
  if (!m) fail(site, `malformed function call '${expr}'`);
  const [, name, argText] = m;
  if (!FRAMEWORK_FUNCTION_NAMES.has(name)) {
    fail(
      site,
      `unknown function '${name}' — known framework functions: ` +
        `${[...FRAMEWORK_FUNCTION_NAMES].join(", ")} (app-defined <functions> are a later phase)`
    );
  }
  const args = splitArgs(argText).map((arg, idx) => {
    if (LITERAL.test(arg)) return { kind: "literal", value: arg };
    // A reference argument resolves with the same rules, at the same site.
    // (requireFunction applies to the call itself, not its arguments.)
    const sub = { ...site, raw: `{${arg}}`, form: null, binding: null, requireFunction: false };
    // The assignment targets of apskel.field.set (the odd-position pair
    // slots) are writes, not reads.
    sub.forbidIdentity = name === "apskel.field.set" && idx % 2 === 0;
    resolveSite(sub, root);
    return { kind: "ref", form: sub.form, binding: sub.binding };
  });
  if (name === "apskel.field.set") {
    // (target, value) pairs, per RESOLVED (apskel.field.set takes pairs):
    // even arity, every odd-position argument a write-target reference.
    if (args.length < 2 || args.length % 2 !== 0) {
      fail(
        site,
        `apskel.field.set takes (targetReference, value) pairs — got ` +
          `${args.length} argument(s)`
      );
    }
    for (let i = 0; i < args.length; i += 2) {
      if (args[i].kind !== "ref") {
        fail(
          site,
          `apskel.field.set argument ${i + 1} must be a write target reference, ` +
            `not a literal`
        );
      }
    }
  }
  if (name === "apskel.nav.go" && args.length !== 1) {
    fail(site, `apskel.nav.go takes exactly one argument (the path)`);
  }
  if (name.startsWith("apskel.sync.") && args.length !== 0) {
    fail(
      site,
      `${name} takes no arguments — resolution binds to the conflict the ` +
        `calling tab's app.sync.* region shows at click time`
    );
  }
  if (name === "apskel.data.create") {
    const isStringLit = (a) => a.kind === "literal" && a.value.startsWith('"');
    if (args.length < 3 || (args.length - 1) % 2 !== 0 || !isStringLit(args[0])) {
      fail(
        site,
        `apskel.data.create takes ("table", "column", value, ...) — the table and ` +
          `column names are string literals, in pairs`
      );
    }
    for (let i = 1; i < args.length; i += 2) {
      if (!isStringLit(args[i])) {
        fail(site, `apskel.data.create argument ${i + 1} must be a "column" string literal`);
      }
    }
  }
  if (name === "apskel.data.remove") {
    if (args.length !== 2 || args[0].kind !== "literal" || !args[0].value.startsWith('"')) {
      fail(site, `apskel.data.remove takes ("table", idReference)`);
    }
  }
  return { kind: "function", name, args };
}

function splitArgs(text) {
  const args = [];
  let depth = 0;
  let inQuote = false;
  let cur = "";
  for (const ch of text) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) {
        args.push(cur.trim());
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}
