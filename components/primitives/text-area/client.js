// text-area primitive — same two-way valve as text-input, multiline.

export function create(ctx, el) {
  const area = document.createElement("textarea");
  area.className = "apskel-text-area-control";
  if (ctx.attrs.placeholder) area.placeholder = ctx.attrs.placeholder;
  if (ctx.attrs.rows) area.rows = Number(ctx.attrs.rows) || 3;
  area.addEventListener("input", () => ctx.input("field", area.value));
  el.appendChild(area);
  ctx.dom.area = area;
}

export function write(ctx, field, value) {
  const text = value == null ? "" : String(value);
  if (ctx.dom.area.value !== text) ctx.dom.area.value = text;
}

export function destroy(ctx) {}
