// runtime/loader.js — Phase 1 loader.
//
// Parses app.xml, expands composite mounts recursively (a fresh instance per
// mount), and builds the instantiated component tree in memory. Every node
// carries a parent pointer, name, type, path, and naming scope. Reference
// sites ({...} in text and attribute values) are collected here; binding them
// is pathResolver.js's job.
//
// Phase 1 scope: no DOM, no store, no watchers, no Wire. A type that resolves
// to components/<type>.xml (relative to the app directory) is a composite and
// is expanded; any other type is a leaf node. <data> and <server> sections,
// and <watchers>/<functions>/<style> blocks inside composites, are ignored
// until their phases.

import fs from "node:fs";
import path from "node:path";
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

const REF_PATTERN = /\{[^{}]+\}/g;

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

export function loadApp(appXmlPath) {
  const appFile = path.resolve(appXmlPath);
  const appDir = path.dirname(appFile);
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
    parent: null,
    path: "app",
    attrs: { ...rawRoot.attrs },
    file: appFile,
    line: rawRoot.line,
    children: [],
    refSites: [],
    // Names declared in this scope. Composite-definition scopes must be
    // unique per name; the app scope may hold duplicates (ambiguity is then
    // a reference-time error, per the design doc).
    names: new Map(),
  };

  const ctx = {
    // App-local components first; the shared framework components directory
    // joins this list in a later phase.
    componentDirs: [path.join(appDir, "components")],
    compositeCache: new Map(), // type -> parsed <component> raw element
    allRefs: [],
    appWideNames: new Map(), // name -> [instance nodes], across the whole tree
  };

  const client = rawRoot.children.find((c) => c.tag === "client");
  if (!client) {
    throw new ApskelLoadError("missing <client> section", { file: appFile, line: rawRoot.line });
  }

  for (const child of client.children) {
    if (child.tag) buildInstance(child, root, root, ctx, []);
    else extractTextRefs(child, root, root, ctx);
  }

  root.allRefs = ctx.allRefs;
  root.appWideNames = ctx.appWideNames;
  return root;
}

function findCompositeFile(type, ctx) {
  for (const dir of ctx.componentDirs) {
    const file = path.join(dir, type + ".xml");
    if (fs.existsSync(file)) return file;
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
  const type = rawEl.attrs.type;
  if (!type) {
    throw new ApskelLoadError(`component instance <${rawEl.tag}> has no type attribute`, at);
  }

  const node = {
    name: rawEl.tag,
    type,
    isRoot: false,
    isComposite: false,
    parent,
    path: parent.path + "." + rawEl.tag,
    attrs: {},
    file: rawEl.file,
    line: rawEl.line,
    scope, // the naming scope this instance was written in
    children: [],
    refSites: [],
    names: new Map(),
  };
  for (const [k, v] of Object.entries(rawEl.attrs)) {
    if (k !== "type") node.attrs[k] = v;
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

  // References in attribute values are written at the mount site, so they
  // resolve in the writing scope.
  for (const value of Object.values(node.attrs)) {
    extractValueRefs(value, rawEl.file, rawEl.line, node, scope, ctx);
  }

  const compositeFile = findCompositeFile(type, ctx);
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
// Reference-site extraction. Sites are collected here and bound by
// pathResolver.js; a binding is stored on the site itself.

function extractTextRefs(rawText, owner, scope, ctx) {
  const { text, startLine, file } = rawText;
  REF_PATTERN.lastIndex = 0;
  let m;
  while ((m = REF_PATTERN.exec(text))) {
    const before = text.slice(0, m.index);
    const line = startLine + (before.match(/\n/g) || []).length;
    addRefSite(m[0], file, line, owner, scope, ctx);
  }
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
}
