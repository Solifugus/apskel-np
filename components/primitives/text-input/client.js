// text-input primitive — a two-way valve between the store and one <input>.
// It holds no field state: the store pushes values in through write(), the
// DOM reports keystrokes out through ctx.input(). ctx.dom holds structural
// DOM handles only — never values.

export function create(ctx, el) {
  const input = document.createElement("input");
  input.type = ctx.attrs.kind === "password" ? "password" : "text";
  input.className = "apskel-text-input-control";
  if (ctx.attrs.placeholder) input.placeholder = ctx.attrs.placeholder;
  if (ctx.attrs.readonly !== undefined) input.readOnly = true;
  input.addEventListener("input", () => ctx.input("field", input.value));
  el.appendChild(input);
  ctx.dom.input = input;
}

export function write(ctx, field, value) {
  const text = value == null ? "" : String(value);
  // Write-through guard: identical value means no DOM churn (and no cursor
  // jump when our own keystroke echoes back through the store).
  if (ctx.dom.input.value !== text) ctx.dom.input.value = text;
}

export function destroy(ctx) {}
