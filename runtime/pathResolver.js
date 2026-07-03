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
//                            scope). No outward search, ever.
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
//   function  {fn(a, b)}     classified and its reference arguments resolved;
//                            function existence is a later phase's concern.
//
// Field existence on components is NOT validated in Phase 1 — primitives
// have no manifests yet. Component targets always are.

import { ApskelLoadError } from "./loader.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function resolveReferences(root) {
  for (const site of root.allRefs) {
    resolveSite(site, root);
  }
  return root;
}

function fail(site, message) {
  throw new ApskelLoadError(message, { file: site.file, line: site.line, ref: site.raw });
}

function resolveSite(site, root) {
  const inner = site.raw.slice(1, -1).trim();
  const { expr, domain } = splitDomain(inner);
  site.domain = domain; // held unparsed; domains are a later phase
  site.form = classify(expr);
  switch (site.form) {
    case "local":
      site.binding = resolveLocal(site, expr);
      break;
    case "bound":
      site.binding = resolveBound(site, expr);
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
  if (/^[A-Za-z_][A-Za-z0-9_.]*\(/.test(expr)) return "function";
  if (expr === "app" || expr.startsWith("app.")) return "absolute";
  if (expr.includes(".")) return "named";
  return "local";
}

// --- local: {field} ---------------------------------------------------------

function resolveLocal(site, expr) {
  if (!IDENT.test(expr)) fail(site, `malformed reference '${expr}'`);
  const scope = site.scope;
  if (!(expr in scope.attrs)) {
    fail(
      site,
      `bare name '${expr}' is not a local field of scope '${scope.path}'; ` +
        `bare names do not search outward — use {name.field}, {^name.field}, or {app...}`
    );
  }
  return { kind: "local", target: scope, targetPath: scope.path, field: expr };
}

// --- bound: {.field} --------------------------------------------------------

function resolveBound(site, expr) {
  const field = expr.slice(1);
  if (!field) fail(site, `malformed bound reference '${expr}'`);
  for (let n = site.owner; n; n = n.parent) {
    if (n.attrs.table) {
      return { kind: "bound", target: n, targetPath: n.path, table: n.attrs.table, field };
    }
  }
  fail(site, `bound field '${expr}' has no data context: no enclosing component declares table=`);
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
    // At the root we can validate: the field must be an <app> attribute.
    // Deeper fields stay unvalidated until primitives carry manifests.
    if (!(segs[i] in root.attrs)) {
      fail(
        site,
        `absolute reference '${expr}' does not resolve: the root has no child ` +
          `component or app attribute named '${segs[i]}'`
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
  const args = splitArgs(argText).map((arg) => {
    if (LITERAL.test(arg)) return { kind: "literal", value: arg };
    // A reference argument resolves with the same rules, at the same site.
    const sub = { ...site, raw: `{${arg}}`, form: null, binding: null };
    resolveSite(sub, root);
    return { kind: "ref", form: sub.form, binding: sub.binding };
  });
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
