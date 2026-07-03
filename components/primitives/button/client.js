// button primitive — renders its mount-site content as the label and
// reports presses via ctx.input('action', <action name>). Nothing consumes
// actions until the event system lands in a later phase; the binder logs
// unconsumed inputs.

export function create(ctx, el) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "apskel-button-control";
  button.addEventListener("click", () => ctx.input("action", ctx.attrs.action || "press"));
  el.appendChild(button);
  ctx.dom.button = button;
  // The binder appends the node's content (the label text) into contentHost.
  ctx.contentHost = button;
}

export function write(ctx, field, value) {
  // button has no fields
}

export function destroy(ctx) {}
