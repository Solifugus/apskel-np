// select primitive — the single-value option widget, per RESOLVED (a
// select is a domain-bearing column reference). Same statelessness deal
// as multi-select: the store pushes the scalar value in through
// write(ctx, "field", ...) and the option list through write(ctx,
// "options", ...); a change reports the picked stored value out through
// ctx.input. The binder re-pushes the field after every options write,
// so rebuilding the list never needs a remembered value. Option values
// keep their type (a tag id stays an integer) via a JSON round-trip on
// the option element.

export function create(ctx, el) {
  const select = document.createElement("select");
  select.className = "apskel-select-control";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = ctx.attrs.placeholder ?? "";
  select.appendChild(blank);
  select.addEventListener("change", () => {
    const opt = select.selectedOptions[0];
    ctx.input("field", opt && opt.dataset.value !== undefined ? JSON.parse(opt.dataset.value) : null);
  });
  el.appendChild(select);
  ctx.dom.select = select;
}

export function write(ctx, field, value) {
  const select = ctx.dom.select;
  if (field === "options") {
    const options = Array.isArray(value) ? value : [];
    while (select.options.length > 1) select.remove(1); // keep the blank
    for (const opt of options) {
      const o = document.createElement("option");
      o.dataset.value = JSON.stringify(opt.value);
      o.textContent = String(opt.label);
      select.appendChild(o);
    }
    return;
  }
  // field push: select exactly the option whose stored value matches;
  // no match (including null/undefined) falls back to the blank.
  const key = JSON.stringify(value ?? null);
  let index = 0;
  for (let i = 1; i < select.options.length; i++) {
    if (select.options[i].dataset.value === key) {
      index = i;
      break;
    }
  }
  if (select.selectedIndex !== index) select.selectedIndex = index;
}

export function destroy(ctx) {}
