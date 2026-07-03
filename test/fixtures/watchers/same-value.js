// Same-value write: a watcher body writes a watched field with its current
// value. The value-change guard means no new firing — the cascade terminates
// after the single firing caused by the external change. A second external
// write of the same value fires nothing at all.

import { createStore } from "../../../runtime/store.js";
import { WatcherEngine } from "../../../runtime/watchers.js";

export const name = "same-value write — guard stops the cascade";

export function run() {
  const store = createStore();
  const engine = new WatcherEngine(store);
  let fired = 0;
  let seen = null;

  engine.watch({
    name: "echo",
    fields: ["app.x"],
    run: (ctx) => {
      fired += 1;
      seen = { value: ctx.value, oldValue: ctx.oldValue, origin: ctx.origin };
      ctx.set("app.x", ctx.value); // same value: must not re-fire
    },
  });

  store.set("app.x", 5, "user");
  const firedAfterCascade = fired;

  store.set("app.x", 5, "server"); // same value from outside: no firing at all

  return { firedAfterCascade, firedTotal: fired, seen, x: store.get("app.x") };
}
