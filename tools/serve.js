// tools/serve.js — Phase 3 static server (no Wire, no database).
//
//   node tools/serve.js <appDir> [--port 3000]
//
// Loads and resolves the app once at startup (load errors exit 1, naming
// the reference site), then serves the shell, the bundle, the runtime as
// unmodified ESM, primitives (app dir overriding framework), and the app's
// own statics. For an app with bound fields and a schema, use tools/run.js.

import path from "node:path";
import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";
import { serializeApp } from "../runtime/serialize.js";
import { createAppServer, attachShellFallback } from "../server/appServer.js";

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

const app = createAppServer({ appDir, bundleProvider: async () => bundle });
attachShellFallback(app);

app.listen(port, () => {
  console.log(`Apskel serving ${appDir} (static, no Wire)`);
  console.log(`  http://localhost:${port}/`);
  console.log(`  debug handle in devtools: window.__apskel`);
});
