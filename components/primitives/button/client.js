// button primitive — renders its mount-site content as the label and
// reports presses via ctx.input('action'). The binder invokes the bound
// function call (action= resolved at load); a button without an action is
// an unconsumed input, logged.

export function create(ctx, el) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "apskel-button-control";
  button.addEventListener("click", () => ctx.input("action", "press"));
  el.appendChild(button);
  ctx.dom.button = button;
  // The binder appends the node's content (the label text) into contentHost.
  ctx.contentHost = button;
}

export function write(ctx, field, value) {
  // button has no fields
}

export function destroy(ctx) {}
