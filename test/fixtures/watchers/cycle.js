// Genuine cycle: chaseA increments what chaseB watches, chaseB increments
// what chaseA watches — values change forever. Must end in a bounded-depth
// ApskelCascadeError carrying a readable cascade trace, never a hang.
//
// Aborted-cascade semantics: the deferred-effect queue is discarded whole
// (chaseA enqueues an effect every firing; none may be delivered), but store
// writes already applied are NOT rolled back — no transactionality.
//
// The bound is set explicitly (10 firings per watcher) so the fixture's
// expected counts do not depend on the engine's default.

import { createStore } from "../../../runtime/store.js";
import { WatcherEngine } from "../../../runtime/watchers.js";

export const name = "genuine cycle — bounded-depth error with cascade trace";

export function run() {
  const store = createStore();
  const engine = new WatcherEngine(store, { maxFiringsPerWatcher: 10 });
  const counts = { chaseA: 0, chaseB: 0 };
  const delivered = [];
  engine.onEffect((path, value) => delivered.push([path, value]));

  engine.watch({
    name: "chaseA",
    fields: ["app.a"],
    run: (ctx) => {
      counts.chaseA += 1;
      ctx.enqueueEffect("app.b", ctx.get("app.b") ?? 0);
      ctx.set("app.b", (ctx.get("app.b") ?? 0) + 1);
    },
  });
  engine.watch({
    name: "chaseB",
    fields: ["app.b"],
    run: (ctx) => {
      counts.chaseB += 1;
      ctx.set("app.a", (ctx.get("app.a") ?? 0) + 1);
    },
  });

  let error = null;
  try {
    store.set("app.a", 1, "user");
  } catch (e) {
    error = e;
  }

  return {
    counts,
    errorName: error?.name ?? null,
    message: error?.message ?? "",
    traceLength: Array.isArray(error?.trace) ? error.trace.length : null,
    delivered, // must be empty: aborted cascade sends nothing
    a: store.get("app.a"), // writes already applied stay applied
    b: store.get("app.b"),
  };
}
