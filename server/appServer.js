// server/appServer.js — the static/shell half of serving an app, shared by
// tools/serve.js (Wire-less, Phase 3) and tools/run.js (Wire + PostgreSQL,
// Phase 4).

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// bundleProvider is async so run.js can refresh initialData from the
// database on every page load (reload shows the draft as left).
export function createAppServer({ appDir, bundleProvider }) {
  const app = express();
  app.locals.apskelShell = (req, res, next) => sendShell(bundleProvider, res, next);

  app.get("/app.json", async (req, res, next) => {
    try {
      res.json(await bundleProvider());
    } catch (e) {
      next(e);
    }
  });

  app.use("/runtime", express.static(path.join(repoDir, "runtime")));
  app.use("/primitives", express.static(path.join(appDir, "components", "primitives")));
  app.use("/primitives", express.static(path.join(repoDir, "components", "primitives")));
  app.use("/app", express.static(appDir));

  app.get("/", app.locals.apskelShell);

  return app;
}

// Deep links: the shell is served for ANY route-looking GET path, per
// RESOLVED (routes) — registered LAST (after /wire and /events) so it
// never shadows them. Paths with a file extension fall through to 404.
export function attachShellFallback(app) {
  app.get(/.*/, (req, res, next) => {
    if (path.extname(req.path)) return next();
    app.locals.apskelShell(req, res, next);
  });
}

async function sendShell(bundleProvider, res, next) {
  try {
    const bundle = await bundleProvider();
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
  } catch (e) {
    next(e);
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );
}
