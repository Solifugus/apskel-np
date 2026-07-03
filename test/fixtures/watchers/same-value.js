// Same-value write: a watcher body writes a watched field with its current
// value. The value-change guard means no new firing — the cascade terminates
// after the single firing caused by the external change. A same-value write
// arriving from the Wire receive path fires nothing either.
//
// Also asserts the origins rule: a genuine server change fires with origin
// 'server' in the watcher context (the echo-suppression hook), and app code
// claiming origin 'server' through ordinary set() is rejected — the origin
// must not be forgeable.

import { createStore } from "../../../runtime/store.js";
import { WatcherEngine } from "../../../runtime/watchers.js";

export const name = "same-value write — guard stops the cascade; server origin unforgeable";

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
  const userSeen = { ...seen };

  store.applyServerWrite("app.x", 5); // same value from the Wire: no firing
  const firedAfterServerEcho = fired;

  store.applyServerWrite("app.x", 9); // changed value from the Wire: fires as 'server'
  const serverSeen = { ...seen };

  let forged = null;
  try {
    store.set("app.x", 6, "server"); // app code may not claim the server origin
  } catch (e) {
    forged = e;
  }

  return {
    firedAfterCascade,
    userSeen,
    firedAfterServerEcho,
    serverSeen,
    firedTotal: fired,
    x: store.get("app.x"),
    forgedName: forged?.name ?? null,
    forgedMessage: forged?.message ?? "",
  };
}
