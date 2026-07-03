// Diamond dependency: A feeds B and C, both feed D. D fires exactly once
// per settle, however many of its watched fields changed in the cascade.

import { createStore } from "../../../runtime/store.js";
import { WatcherEngine } from "../../../runtime/watchers.js";

export const name = "diamond dependency — D fires once per settle";

export function run() {
  const store = createStore();
  const engine = new WatcherEngine(store);
  const firings = [];

  engine.watch({
    name: "AtoB",
    fields: ["app.a"],
    run: (ctx) => {
      firings.push("AtoB");
      ctx.set("app.b", ctx.value * 2);
    },
  });
  engine.watch({
    name: "AtoC",
    fields: ["app.a"],
    run: (ctx) => {
      firings.push("AtoC");
      ctx.set("app.c", ctx.value + 1);
    },
  });
  engine.watch({
    name: "sumD",
    fields: ["app.b", "app.c"],
    run: (ctx) => {
      firings.push("sumD");
      ctx.set("app.d", ctx.get("app.b") + ctx.get("app.c"));
    },
  });

  store.set("app.a", 10, "user");
  const afterFirstSettle = [...firings];

  store.set("app.a", 20, "user");

  return { afterFirstSettle, firings, d: store.get("app.d") };
}
