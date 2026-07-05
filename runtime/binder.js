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

export function mountApp(root, { store, engine, document, primitives, rootEl, functions = {} }) {
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

    // visible= — a display-none wrapper: instances, state, and watchers
    // all survive hiding. Creation/destruction is collections' business.
    if (node.visible) {
      const update = (value) => {
        el.style.display = isVisible(node.visible, value) ? "" : "none";
      };
      update(store.get(node.visible.storePath));
      engine.watch({
        name: `visible:${node.path}`,
        fields: [node.visible.storePath],
        run: (c) => update(c.value),
      });
    }

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
      if (node.optionsPath) {
        // The option list is runtime state at the widget's own path. The
        // field is re-pushed after every options write so the primitive
        // can stay stateless: rebuild the inputs, then re-check them from
        // the store's value — never from anything the primitive kept.
        module.write(ctx, "options", store.get(node.optionsPath));
        if (node.fieldPath) module.write(ctx, "field", store.get(node.fieldPath));
        engine.watch({
          name: `options:${node.path}`,
          fields: [node.optionsPath],
          run: (c) => {
            module.write(ctx, "options", c.value);
            if (node.fieldPath) module.write(ctx, "field", store.get(node.fieldPath));
          },
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
    if (slot === "action" && node.action) {
      // field.set is a runtime primitive, not a network call: its first
      // argument is a write target — assigned, never evaluated.
      if (node.action.name === "apskel.field.set") {
        const [target, source] = node.action.args;
        store.set(target.storePath, evaluateArgs([source], store)[0], "user");
        return;
      }
      const fn = functions[node.action.name];
      if (!fn) {
        console.debug(`[apskel] no implementation for '${node.action.name}' (${node.path})`);
        return;
      }
      Promise.resolve(fn(...evaluateArgs(node.action.args, store))).catch((e) =>
        console.error(`[apskel] action ${node.action.name} failed:`, e)
      );
      return;
    }
    console.debug(`[apskel] unconsumed input '${slot}' from ${node.path}:`, value);
  }

  function display(value) {
    return value == null ? "" : String(value);
  }
}

// Argument values at press time: literals pass through, refs read the store
// through their load-time storePath. Exported for the Node harness.
export function evaluateArgs(args, store) {
  return args.map((a) => (a.kind === "literal" ? a.value : store.get(a.storePath)));
}

// visible= membership: bare form is truthy; a domain is a String-compared
// value set. Exported for the Node harness.
export function isVisible(visible, value) {
  if (!visible.domain) return !!value;
  return visible.domain.some((d) => String(value) === d);
}
