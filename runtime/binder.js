// runtime/binder.js — Phase 3 binder (browser-side; no Node imports).
//
// Walks the hydrated tree: creates a wrapper element per instance, calls
// create() on primitives, pushes current store values in through write(),
// keeps them updated via engine watchers, and routes ctx.input back into
// store.set(..., 'user'). Text-interpolation ({ref} in content) is
// binder-owned DOM text nodes — primitives handle only their own field
// slots and never see reference sites.
//
// The ctx object carries the instance's identity and structural DOM handles
// (ctx.dom). It never holds field values — the store owns every value.

export function mountApp(root, { store, engine, document, primitives, rootEl }) {
  mountContent(root, rootEl);
  return root;

  function mountContent(node, hostEl) {
    const childrenByName = new Map(node.children.map((c) => [c.name, c]));
    for (const seg of node.content) {
      if (seg.kind === "text") {
        hostEl.appendChild(document.createTextNode(seg.text));
      } else if (seg.kind === "ref") {
        const textNode = document.createTextNode(display(store.get(seg.storePath)));
        hostEl.appendChild(textNode);
        if (seg.storePath) {
          engine.watch({
            name: `text:${seg.storePath}`,
            fields: [seg.storePath],
            run: (c) => {
              textNode.textContent = display(c.value);
            },
          });
        }
      } else {
        mountNode(childrenByName.get(seg.name), hostEl);
      }
    }
  }

  function mountNode(node, parentEl) {
    const el = document.createElement("div");
    el.className = `apskel apskel-${node.type}`;
    el.dataset.path = node.path;
    parentEl.appendChild(el);

    let host = el;
    if (node.isPrimitive) {
      const module = primitives[node.type];
      const ctx = {
        path: node.path,
        attrs: node.attrs,
        manifest: node.manifest,
        dom: {}, // structural DOM handles only — never values
        input: (slot, value) => handleInput(node, slot, value),
      };
      module.create(ctx, el);
      if (ctx.contentHost) host = ctx.contentHost;
      if (node.fieldPath) {
        module.write(ctx, "field", store.get(node.fieldPath)); // initial push
        engine.watch({
          name: `bind:${node.path}`,
          fields: [node.fieldPath],
          run: (c) => module.write(ctx, "field", c.value),
        });
      }
    }

    mountContent(node, host);
  }

  function handleInput(node, slot, value) {
    if (slot === "field" && node.fieldPath) {
      store.set(node.fieldPath, value, "user");
      return;
    }
    // No consumer yet (e.g. button actions until the event system lands).
    console.debug(`[apskel] unconsumed input '${slot}' from ${node.path}:`, value);
  }

  function display(value) {
    return value == null ? "" : String(value);
  }
}
