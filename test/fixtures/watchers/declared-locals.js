// Declared-local initialization: the store seeds every {name = default}
// local from the unevaluated literal default Phase 1 recorded, at the
// declaring scope's path, BEFORE any watcher runs — seeding is silent and
// fires nothing. String/number/boolean literals arrive with their types.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp } from "../../../runtime/loader.js";
import { resolveReferences } from "../../../runtime/pathResolver.js";
import { createStore } from "../../../runtime/store.js";
import { WatcherEngine } from "../../../runtime/watchers.js";

export const name = "declared locals — seeded from defaults before any watcher runs";

export function run() {
  const appXml = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "declared-locals",
    "app.xml"
  );
  const root = resolveReferences(loadApp(appXml));

  const store = createStore();
  const engine = new WatcherEngine(store);
  let fired = 0;
  engine.watch({
    name: "spy",
    fields: ["app.draft", "app.workspace.padOne.note"],
    run: () => {
      fired += 1;
    },
  });

  store.seedDeclaredLocals(root);

  return {
    fired,
    draft: store.get("app.draft"),
    count: store.get("app.count"),
    active: store.get("app.active"),
    noteOne: store.get("app.workspace.padOne.note"),
    noteTwo: store.get("app.workspace.padTwo.note"),
  };
}
