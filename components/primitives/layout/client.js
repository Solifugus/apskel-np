// layout primitive — flex container. Structural mechanics only; appearance
// belongs to the app theme.

export function create(ctx, el) {
  el.classList.add(`apskel-orient-${ctx.attrs.orient || "vertical"}`);
  if (ctx.attrs.space) el.classList.add(`apskel-space-${ctx.attrs.space}`);
}

export function write(ctx, field, value) {
  // layout has no fields
}

export function destroy(ctx) {}
