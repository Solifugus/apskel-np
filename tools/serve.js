// tools/serve.js — Phase 3 static server (no Wire yet).
//
//   node tools/serve.js <appDir> [--port 3000]
//
// Loads and resolves the app once at startup (load errors exit 1, naming
// the reference site), then serves:
//   /            generated HTML shell
//   /app.json    the serialized resolved tree bundle
//   /runtime/*   the runtime ESM modules, unmodified
//   /primitives/*  primitive client.js + structure.css (app dir overrides
//                  the framework dir, matching the loader's search order)
//   /app/*       the app's own static files (theme css, client.js)

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { serializeApp } from "../runtime/serialize.js";

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const appDirArg = args.find((a) => !a.startsWith("--"));
const portArg = args.indexOf("--port");
const port = portArg !== -1 ? Number(args[portArg + 1]) : 3000;

if (!appDirArg) {
  console.error("usage: node tools/serve.js <appDir> [--port 3000]");
  process.exit(2);
}
const appDir = path.resolve(appDirArg);

let bundle;
try {
  const root = resolveReferences(loadApp(path.join(appDir, "app.xml")));
  bundle = serializeApp(root, {
    title: root.attrs.title ?? "Apskel App",
    style: root.clientAttrs.style ?? null,
    clientFunctions: root.clientAttrs.functions ?? null,
  });
} catch (e) {
  if (e instanceof ApskelLoadError) {
    console.error(`LOAD ERROR: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const app = express();

app.get("/app.json", (req, res) => res.json(bundle));
app.use("/runtime", express.static(path.join(repoDir, "runtime")));
app.use("/primitives", express.static(path.join(appDir, "components", "primitives")));
app.use("/primitives", express.static(path.join(repoDir, "components", "primitives")));
app.use("/app", express.static(appDir));

app.get("/", (req, res) => {
  const cssLinks = [
    ...bundle.primitiveTypes.map(
      (t) => `<link rel="stylesheet" href="/primitives/${t}/structure.css">`
    ),
    ...(bundle.style ? [`<link rel="stylesheet" href="/app/${bundle.style}">`] : []),
  ].join("\n    ");
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(bundle.title)}</title>
    ${cssLinks}
  </head>
  <body>
    <div id="apskel-root"></div>
    <script type="module" src="/runtime/boot.js"></script>
  </body>
</html>
`);
});

app.listen(port, () => {
  console.log(`Apskel serving ${appDir}`);
  console.log(`  http://localhost:${port}/`);
  console.log(`  debug handle in devtools: window.__apskel.store.get('app.typed') etc.`);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
