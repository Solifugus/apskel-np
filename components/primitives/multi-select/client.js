// multi-select primitive — the edge-bound set-field widget: a checkbox
// list over the runtime-supplied option list. It holds no field state:
// the store pushes the member array in through write(ctx, "field", ...)
// and the option list through write(ctx, "options", ...); a toggle
// reports the whole desired set out through ctx.input. The binder
// re-pushes the field after every options write, so rebuilding the list
// never needs a remembered value — checked state is always restored from
// the store's push, per RESOLVED (multi-select primitive).

export function create(ctx, el) {
  const list = document.createElement("div");
  list.className = "apskel-multi-select-list";
  el.appendChild(list);
  ctx.dom.list = list;
}

export function write(ctx, field, value) {
  if (field === "options") {
    const options = Array.isArray(value) ? value : [];
    ctx.dom.list.textContent = "";
    for (const opt of options) {
      const label = document.createElement("label");
      label.className = "apskel-multi-select-option";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.value = JSON.stringify(opt.value);
      box.addEventListener("change", () => {
        const members = [...ctx.dom.list.querySelectorAll("input:checked")].map((b) =>
          JSON.parse(b.dataset.value)
        );
        ctx.input("field", members);
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(String(opt.label)));
      ctx.dom.list.appendChild(label);
    }
    return;
  }
  // field push: check exactly the members the store holds.
  const members = new Set((Array.isArray(value) ? value : []).map((m) => JSON.stringify(m)));
  for (const box of ctx.dom.list.querySelectorAll("input[type=checkbox]")) {
    const checked = members.has(box.dataset.value);
    if (box.checked !== checked) box.checked = checked;
  }
}

export function destroy(ctx) {}
