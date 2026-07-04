// runtime/loader.js — loader (Phases 1 and 3).
//
// Parses app.xml, expands composite mounts recursively (a fresh instance per
// mount), and builds the instantiated component tree in memory. Every node
// carries a parent pointer, name, type, path, and naming scope. Reference
// sites ({...} in text and attribute values) are collected here; binding them
// is pathResolver.js's job.
//
// Phase 3 additions:
//   * Component type resolution: app components/ -> framework components/ ->
//     primitives (components/primitives/<type>/manifest.json, app dir first).
//     An unknown type is a load-time error — Phase 1's any-unknown-type-is-
//     a-leaf permissiveness ended when primitives became real.
//   * Ordered content segments per node (text / ref / child) for rendering.
//     A {name = default} declaration site produces no content segment.
//   * field= on an input primitive is a reference expression WITHOUT braces,
//     per the design examples (<input field=".title"/>).
//
// <data> and <server> sections, and <watchers>/<functions>/<style> blocks
// inside composites, are ignored until their phases.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";

export class ApskelLoadError extends Error {
  constructor(message, site = {}) {
    const where = site.file ? ` [${site.file}${site.line ? ":" + site.line : ""}]` : "";
    const ref = site.ref ? ` (reference site: ${site.ref})` : "";
    super(`${message}${where}${ref}`);
    this.name = "ApskelLoadError";
    this.site = site;
  }
}

// Section tags inside a composite definition that belong to later phases.
const DEFERRED_SECTION_TAGS = new Set(["watchers", "functions", "style"]);

// The closed conflict-policy menu, per RESOLVED (conflict declaration
// surface). Declared on the data-context element (the one with table=).
const CONFLICT_MENU = new Set(["offline-readonly", "detect", "lww"]);

const REF_PATTERN = /\{[^{}]+\}/g;

// Mirrors pathResolver's DECLARATION shape ({name = default}); duplicated to
// keep the modules cycle-free.
const DECLARATION_TEST = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

const DEFAULT_FRAMEWORK_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "components"
);

// ---------------------------------------------------------------------------
// Raw XML parsing (saxes) — produces a plain element tree with line numbers.

function parseXmlFile(file) {
  const xml = fs.readFileSync(file, "utf8");
  const parser = new SaxesParser({ fileName: file });
  const virtualRoot = { tag: null, attrs: {}, children: [] };
  const stack = [virtualRoot];
  let parseError = null;

  parser.on("error", (e) => {
    if (!parseError) parseError = e;
  });
  parser.on("opentag", (tag) => {
    const el = {
      tag: tag.name,
      attrs: { ...tag.attributes },
      // parser.line is the line of the tag's closing '>'; identical to the
      // opening line for single-line tags.
      line: parser.line,
      file,
      children: [],
    };
    stack[stack.length - 1].children.push(el);
    stack.push(el);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", (text) => {
    const parent = stack[stack.length - 1];
    const last = parent.children[parent.children.length - 1];
    if (last && last.text !== undefined) {
      // saxes may deliver one text run in chunks; merge them. The merged
      // run keeps the first chunk's start line.
      last.text += text;
      return;
    }
    const newlines = (text.match(/\n/g) || []).length;
    parent.children.push({
      text,
      file,
      // parser.line is the next character after this chunk; subtract the
      // chunk's newlines to recover the line the chunk starts on.
      startLine: parser.line - newlines,
    });
  });

  parser.write(xml).close();
  if (parseError) {
    throw new ApskelLoadError(`XML parse error: ${parseError.message}`, { file });
  }
  const rootEl = virtualRoot.children.find((c) => c.tag);
  if (!rootEl) throw new ApskelLoadError("no root element found", { file });
  return rootEl;
}

// ---------------------------------------------------------------------------
// Instantiated component tree.

export function loadApp(appXmlPath, options = {}) {
  const appFile = path.resolve(appXmlPath);
  const appDir = path.dirname(appFile);
  const frameworkDir = options.frameworkDir ?? DEFAULT_FRAMEWORK_DIR;
  const rawRoot = parseXmlFile(appFile);
  if (rawRoot.tag !== "app") {
    throw new ApskelLoadError(`root element must be <app>, found <${rawRoot.tag}>`, {
      file: appFile,
      line: rawRoot.line,
    });
  }

  const root = {
    name: "app",
    type: "app",
    isRoot: true,
    isComposite: false,
    isPrimitive: false,
    parent: null,
    path: "app",
    attrs: { ...rawRoot.attrs },
    file: appFile,
    line: rawRoot.line,
    children: [],
    content: [],
    refSites: [],
    // Names declared in this scope. Composite-definition scopes must be
    // unique per name; the app scope may hold duplicates (ambiguity is then
    // a reference-time error, per the design doc) as long as sibling paths
    // stay unique.
    names: new Map(),
    // Local fields declared by defaulted references ({name = default}) in
    // this scope. Filled by the resolver's declaration pass.
    locals: new Map(),
  };

  const ctx = {
    // App-local components first, then the shared framework directory —
    // the design doc's resolution order.
    componentDirs: [path.join(appDir, "components"), frameworkDir],
    compositeCache: new Map(), // type -> parsed <component> raw element
    manifestCache: new Map(), // manifest file -> parsed manifest
    allRefs: [],
    appWideNames: new Map(), // name -> [instance nodes], across the whole tree
  };

  const client = rawRoot.children.find((c) => c.tag === "client");
  if (!client) {
    throw new ApskelLoadError("missing <client> section", { file: appFile, line: rawRoot.line });
  }
  root.clientAttrs = { ...client.attrs };

  for (const child of client.children) {
    if (child.tag) buildInstance(child, root, root, ctx, []);
    else extractTextRefs(child, root, root, ctx);
  }

  const routesEl = rawRoot.children.find((c) => c.tag === "routes");
  root.routes = routesEl ? buildRoutes(routesEl, root, ctx) : [];

  root.allRefs = ctx.allRefs;
  root.appWideNames = ctx.appWideNames;
  return root;
}

// <routes> at app level: each <route path> carries <set> children — no
// assignment mini-language, every assignment its own load-validated
// element, per RESOLVED (routes). field= is a brace-less reference bound
// like any other; param= must name a :param in the route's own pattern.
function buildRoutes(routesEl, root, ctx) {
  const routes = [];
  for (const routeEl of routesEl.children) {
    if (!routeEl.tag) continue;
    const at = { file: routeEl.file, line: routeEl.line };
    if (routeEl.tag !== "route") {
      throw new ApskelLoadError(`<routes> may contain only <route>, found <${routeEl.tag}>`, at);
    }
    const pattern = routeEl.attrs.path;
    if (!pattern || !pattern.startsWith("/")) {
      throw new ApskelLoadError(`<route> needs a path attribute starting with '/'`, at);
    }
    const params = pattern
      .split("/")
      .filter((s) => s.startsWith(":"))
      .map((s) => s.slice(1));
    const sets = [];
    for (const setEl of routeEl.children) {
      if (!setEl.tag) continue;
      const setAt = { file: setEl.file, line: setEl.line };
      if (setEl.tag !== "set") {
        throw new ApskelLoadError(`<route> may contain only <set>, found <${setEl.tag}>`, setAt);
      }
      const { field, value, param } = setEl.attrs;
      if (!field || /[{}]/.test(field)) {
        throw new ApskelLoadError(
          `<set> needs field= as a bare reference expression without braces`,
          setAt
        );
      }
      if ((value === undefined) === (param === undefined)) {
        throw new ApskelLoadError(`<set> needs exactly one of value= or param=`, setAt);
      }
      if (param !== undefined && !params.includes(param)) {
        throw new ApskelLoadError(
          `<set> references param ':${param}' but the route pattern '${pattern}' does not declare it`,
          setAt
        );
      }
      const site = addRefSite(`{${field}}`, setEl.file, setEl.line, root, root, ctx);
      site.forbidIdentity = true; // routes may not write the identity region
      sets.push({ site, value, param });
    }
    routes.push({ path: pattern, params, sets, file: routeEl.file, line: routeEl.line });
  }
  return routes;
}

function findCompositeFile(type, ctx) {
  for (const dir of ctx.componentDirs) {
    const file = path.join(dir, type + ".xml");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function findPrimitive(type, ctx) {
  for (const dir of ctx.componentDirs) {
    const primitiveDir = path.join(dir, "primitives", type);
    const manifestFile = path.join(primitiveDir, "manifest.json");
    if (!fs.existsSync(manifestFile)) continue;
    let manifest = ctx.manifestCache.get(manifestFile);
    if (!manifest) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      } catch (e) {
        throw new ApskelLoadError(`invalid manifest for primitive '${type}': ${e.message}`, {
          file: manifestFile,
        });
      }
      ctx.manifestCache.set(manifestFile, manifest);
    }
    return { dir: primitiveDir, manifest, manifestFile };
  }
  return null;
}

function buildInstance(rawEl, parent, scope, ctx, expansionStack) {
  const at = { file: rawEl.file, line: rawEl.line };

  if (rawEl.tag === "app") {
    throw new ApskelLoadError(
      "'app' is a reserved root name and may not be used as a component instance name",
      at
    );
  }
  if (parent.isRoot && rawEl.tag === "identity") {
    throw new ApskelLoadError(
      "'identity' is a reserved top-level name — app.identity.* is the framework " +
        "identity region, per RESOLVED (identity store region)",
      at
    );
  }
  const type = rawEl.attrs.type;
  if (!type) {
    throw new ApskelLoadError(`component instance <${rawEl.tag}> has no type attribute`, at);
  }
  if (parent.children.some((c) => c.name === rawEl.tag)) {
    throw new ApskelLoadError(
      `duplicate sibling component name '${rawEl.tag}' under '${parent.path}' — ` +
        `instance paths must be unique`,
      at
    );
  }

  const node = {
    name: rawEl.tag,
    type,
    isRoot: false,
    isComposite: false,
    isPrimitive: false,
    parent,
    path: parent.path + "." + rawEl.tag,
    attrs: {},
    file: rawEl.file,
    line: rawEl.line,
    scope, // the naming scope this instance was written in
    children: [],
    content: [],
    refSites: [],
    names: new Map(),
    locals: new Map(),
  };
  for (const [k, v] of Object.entries(rawEl.attrs)) {
    if (k !== "type") node.attrs[k] = v;
  }

  if (node.attrs.conflict !== undefined) {
    if (!node.attrs.table) {
      throw new ApskelLoadError(
        `conflict= on <${node.name}> without table= — the conflict policy is a ` +
          `property of a data context`,
        at
      );
    }
    if (!CONFLICT_MENU.has(node.attrs.conflict)) {
      throw new ApskelLoadError(
        `unknown conflict policy '${node.attrs.conflict}' on <${node.name}> — ` +
          `the closed menu is: ${[...CONFLICT_MENU].join(", ")}`,
        at
      );
    }
  }

  // Register the name in its scope. Names inside a composite definition must
  // be unique within that definition; duplicates at app scope are legal until
  // an ambiguous reference targets them.
  const existing = scope.names.get(node.name) || [];
  if (existing.length > 0 && !scope.isRoot) {
    throw new ApskelLoadError(
      `duplicate component name '${node.name}' within the definition scope of ` +
        `'${scope.type}' (already used at ${existing[0].file}:${existing[0].line})`,
      at
    );
  }
  existing.push(node);
  scope.names.set(node.name, existing);

  const appWide = ctx.appWideNames.get(node.name) || [];
  appWide.push(node);
  ctx.appWideNames.set(node.name, appWide);

  parent.children.push(node);
  parent.content.push({ kind: "child", name: node.name });

  // Resolve the type: composite XML, else primitive manifest, else error.
  const compositeFile = findCompositeFile(type, ctx);
  let primitive = null;
  if (!compositeFile) {
    primitive = findPrimitive(type, ctx);
    if (!primitive) {
      throw new ApskelLoadError(
        `unknown component type '${type}' for instance <${node.name}>: no composite ` +
          `XML and no primitive manifest found under ${ctx.componentDirs.join(", ")}`,
        at
      );
    }
    if (primitive.manifest.type !== type) {
      throw new ApskelLoadError(
        `primitive manifest declares type '${primitive.manifest.type}' but lives in ` +
          `'${type}/'`,
        { file: primitive.manifestFile }
      );
    }
    node.isPrimitive = true;
    node.manifest = primitive.manifest;
    node.primitiveDir = primitive.dir;
  }

  // References in attribute values are written at the mount site, so they
  // resolve in the writing scope. On an input primitive, field= takes a
  // bare reference expression without braces.
  for (const [key, value] of Object.entries(node.attrs)) {
    if (node.isPrimitive && node.manifest.input && key === "field") {
      if (/[{}]/.test(value)) {
        throw new ApskelLoadError(
          `field attribute of <${node.name}> takes a bare reference expression ` +
            `without braces (field="${value}")`,
          at
        );
      }
      node.fieldSite = addRefSite(`{${value}}`, rawEl.file, rawEl.line, node, scope, ctx);
      continue;
    }
    // visible= on any instance: a brace-less reference; the domain syntax
    // ("app.view: editor, article") rides through the resolver's existing
    // domain split, per RESOLVED (visible=).
    if (key === "visible") {
      if (/[{}]/.test(value)) {
        throw new ApskelLoadError(
          `visible attribute of <${node.name}> takes a bare reference expression ` +
            `without braces (visible="${value}")`,
          at
        );
      }
      node.visibleSite = addRefSite(`{${value}}`, rawEl.file, rawEl.line, node, scope, ctx);
      continue;
    }
    // record= on a data context: an integer literal is a fixed row; anything
    // else is a brace-less reference whose VALUE varies at runtime, per
    // RESOLVED (record selection).
    if (key === "record" && node.attrs.table && !/^\d+$/.test(value)) {
      if (/[{}]/.test(value)) {
        throw new ApskelLoadError(
          `record attribute of <${node.name}> takes a bare reference expression ` +
            `without braces (record="${value}")`,
          at
        );
      }
      node.recordSite = addRefSite(`{${value}}`, rawEl.file, rawEl.line, node, scope, ctx);
      continue;
    }
    // action= mirrors field=: a brace-less reference expression, which the
    // resolver additionally requires to be a function call.
    if (node.isPrimitive && node.manifest.action && key === "action") {
      if (/[{}]/.test(value)) {
        throw new ApskelLoadError(
          `action attribute of <${node.name}> takes a bare reference expression ` +
            `without braces (action="${value}")`,
          at
        );
      }
      node.actionSite = addRefSite(`{${value}}`, rawEl.file, rawEl.line, node, scope, ctx);
      node.actionSite.requireFunction = true;
      continue;
    }
    extractValueRefs(value, rawEl.file, rawEl.line, node, scope, ctx);
  }

  if (compositeFile) {
    node.isComposite = true;
    node.definitionFile = compositeFile;

    if (expansionStack.includes(type)) {
      throw new ApskelLoadError(
        `composite expansion cycle: ${[...expansionStack, type].join(" -> ")}`,
        at
      );
    }
    let defRoot = ctx.compositeCache.get(type);
    if (!defRoot) {
      defRoot = parseXmlFile(compositeFile);
      if (defRoot.tag !== "component") {
        throw new ApskelLoadError(
          `composite file must have a <component> root, found <${defRoot.tag}>`,
          { file: compositeFile, line: defRoot.line }
        );
      }
      if (defRoot.attrs.name !== type) {
        throw new ApskelLoadError(
          `composite declares name='${defRoot.attrs.name}' but its file is '${type}.xml'`,
          { file: compositeFile, line: defRoot.line }
        );
      }
      ctx.compositeCache.set(type, defRoot);
    }

    // Stamp a fresh instance of the definition under this mount. The mount
    // instance is the naming scope for everything stamped from the file.
    for (const child of defRoot.children) {
      if (child.tag && DEFERRED_SECTION_TAGS.has(child.tag)) continue;
      if (child.tag) buildInstance(child, node, node, ctx, [...expansionStack, type]);
      else extractTextRefs(child, node, node, ctx);
    }
  }

  // Content written at the mount site stays in the writing scope.
  for (const child of rawEl.children) {
    if (child.tag) buildInstance(child, node, scope, ctx, expansionStack);
    else extractTextRefs(child, node, scope, ctx);
  }

  return node;
}

// ---------------------------------------------------------------------------
// Reference-site and content-segment extraction. Sites are collected here
// and bound by pathResolver.js; a binding is stored on the site itself.
// Content segments preserve mixed-content order for rendering; declaration
// sites declare, they do not display, so they emit no segment.

function extractTextRefs(rawText, owner, scope, ctx) {
  const { text, startLine, file } = rawText;
  REF_PATTERN.lastIndex = 0;
  const parts = [];
  let last = 0;
  let m;
  while ((m = REF_PATTERN.exec(text))) {
    if (m.index > last) parts.push({ kind: "lit", text: text.slice(last, m.index) });
    const before = text.slice(0, m.index);
    const line = startLine + (before.match(/\n/g) || []).length;
    const inner = m[0].slice(1, -1).trim();
    parts.push({ kind: "site", raw: m[0], line, isDecl: DECLARATION_TEST.test(inner) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "lit", text: text.slice(last) });

  parts.forEach((part, i) => {
    if (part.kind === "site") {
      const site = addRefSite(part.raw, file, part.line, owner, scope, ctx);
      if (!part.isDecl) owner.content.push({ kind: "ref", site });
      return;
    }
    // Collapse whitespace; trim edges that touch a run boundary or a
    // declaration site (which renders nothing). A single space between two
    // displayed segments is meaningful and kept.
    let t = part.text.replace(/\s+/g, " ");
    const prev = parts[i - 1];
    const next = parts[i + 1];
    if (!prev || (prev.kind === "site" && prev.isDecl)) t = t.replace(/^ /, "");
    if (!next || (next.kind === "site" && next.isDecl)) t = t.replace(/ $/, "");
    if (t !== "") owner.content.push({ kind: "text", text: t });
  });
}

function extractValueRefs(value, file, line, owner, scope, ctx) {
  REF_PATTERN.lastIndex = 0;
  let m;
  while ((m = REF_PATTERN.exec(value))) {
    addRefSite(m[0], file, line, owner, scope, ctx);
  }
}

function addRefSite(raw, file, line, owner, scope, ctx) {
  const site = { raw, file, line, owner, scope, form: null, binding: null };
  owner.refSites.push(site);
  ctx.allRefs.push(site);
  return site;
}
