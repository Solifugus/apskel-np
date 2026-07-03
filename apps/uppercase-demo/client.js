// apps/uppercase-demo/client.js — app client functions (browser module).
//
// Phase 3: watchers register programmatically through the runtime handle;
// declarative <watchers> lands with the function system in a later phase.

export function setup({ engine }) {
  engine.watch({
    name: "uppercase",
    fields: ["app.typed"],
    run: (ctx) => ctx.set("app.shout", String(ctx.value ?? "").toUpperCase()),
  });
}
