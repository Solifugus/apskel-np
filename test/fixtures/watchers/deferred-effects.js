// Deferred-effect queue: effects enqueued mid-cascade run only after the
// cascade settles, coalesced per field to the last value. This is the
// cascade-then-send seam Phase 4's Wire client will consume — testable here
// with no network: the "send" is a recording handler.
//
// Uniform effect timing: effects enqueued during a cascade frame deliver at
// settle; an effect enqueued with no frame in flight delivers immediately.

import { createStore } from "../../../runtime/store.js";
import { WatcherEngine } from "../../../runtime/watchers.js";

export const name = "deferred effects — after settle, coalesced per field";

export function run() {
  const store = createStore();
  const engine = new WatcherEngine(store);
  const delivered = [];
  engine.onEffect((path, value) => delivered.push([path, value]));

  let deliveredDuringCascade = -1;

  engine.watch({
    name: "first",
    fields: ["app.a"],
    run: (ctx) => {
      ctx.enqueueEffect("app.a", ctx.value);
      ctx.set("app.mid", ctx.value + 1); // cascades to 'second' below
      ctx.enqueueEffect("app.a", ctx.value * 10); // same field: last value wins
    },
  });
  engine.watch({
    name: "second",
    fields: ["app.mid"],
    run: (ctx) => {
      ctx.enqueueEffect("app.mid", ctx.value);
      deliveredDuringCascade = delivered.length; // observed mid-cascade: must be 0
    },
  });

  store.set("app.a", 3, "user");
  const deliveredAtSettle = delivered.length; // the two coalesced effects

  engine.enqueueEffect("app.solo", 42); // no frame in flight: immediate
  const deliveredAfterSolo = delivered.length;

  return { deliveredDuringCascade, deliveredAtSettle, deliveredAfterSolo, delivered };
}
