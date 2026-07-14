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
  const collections = new Map(); // collection path -> controller
  mountContent(root, rootEl);
  return { root, collections };

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
    // The node's XML name is the theme's semantic hook ("one app-level
    // theme (semantic tokens/classes)") — the name the developer wrote
    // is the class the theme targets. Load-time, stateless, no new axis.
    if (node.name) el.classList.add(`apskel-name-${node.name}`);
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
        // A literal domain's options are bundle-baked: seeded silently at
        // first mount (collection instances included), no fetch, per
        // RESOLVED (a select is a domain-bearing column reference).
        if (node.staticOptions && store.get(node.optionsPath) === undefined) {
          store.seed(node.optionsPath, node.staticOptions);
        }
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

    if (node.isCollection) {
      // Repetition is what it means to bind to a collection: the node's
      // CONTENT is a template, stamped once per row with a PK-keyed
      // instance path — instantiation, not resolution. The sync layer
      // (wireClient.attachCollectionSync) drives this controller from
      // apskel.data.select and the broadcast stream.
      collections.set(node.path, makeCollectionController(node, host));
      return;
    }

    mountContent(node, host);
  }

  function makeCollectionController(node, host) {
    const instances = new Map(); // String(id) -> {el}
    return {
      has: (id) => instances.has(String(id)),
      ids: () => [...instances.keys()],
      // beforeId: DOM position (order= maintenance); null appends.
      instantiate(id, values, beforeId = null) {
        const key = String(id);
        if (instances.has(key)) return;
        const inst = remapInstance(node, node.path, id);
        // Row values seed silently BEFORE mount — the one place silent
        // seeding is correct; per-instance declared locals likewise.
        for (const [col, v] of Object.entries(values)) {
          if (col !== "id") store.seed(`${inst.path}.${col}`, v);
        }
        store.seed(`${inst.path}.id`, values.id ?? id);
        store.seedDeclaredLocals(inst);
        const wrap = document.createElement("div");
        wrap.className = "apskel apskel-row";
        wrap.dataset.path = inst.path;
        const before = beforeId !== null ? instances.get(String(beforeId))?.el : null;
        host.insertBefore(wrap, before ?? null);
        mountContent(inst, wrap);
        instances.set(key, { el: wrap });
      },
      destroy(id) {
        const key = String(id);
        const inst = instances.get(key);
        if (!inst) return;
        inst.el.remove();
        instances.delete(key);
        const marker = `${node.path}[${id}]`;
        engine.unwatch((w) => w.name.includes(marker));
      },
      clear() {
        for (const key of [...instances.keys()]) this.destroy(key);
      },
    };
  }

  function handleInput(node, slot, value) {
    if (slot === "field" && node.fieldPath) {
      store.set(node.fieldPath, value, "user");
      return;
    }
    if (slot === "action" && node.action) {
      // field.set is a runtime primitive, not a network call: the odd-
      // position arguments are write targets — assigned, never evaluated.
      // All pairs apply inside one cascade, per RESOLVED (apskel.field.set
      // takes pairs), so the URL reverse-match never sees a half-assigned
      // selection.
      if (node.action.name === "apskel.field.set") {
        const apply = () => {
          const a = node.action.args;
          for (let i = 0; i + 1 < a.length; i += 2) {
            store.set(a[i].storePath, evaluateArgs([a[i + 1]], store)[0], "user");
          }
        };
        if (engine?.batch) engine.batch(apply);
        else apply();
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

// Stamp one instance of a collection template: a deep, Map-aware clone in
// which every string rooted at the collection's path gains the PK key —
// app.board.body -> app.board[7].body. External paths (app.view, absolute
// refs) don't start with the prefix and pass through untouched, so a
// template's reach outside itself survives instantiation. Exported for
// the Node harness.
export function remapInstance(json, basePath, id) {
  const prefix = basePath + ".";
  const replacement = `${basePath}[${id}].`;
  const walk = (v) => {
    if (typeof v === "string") {
      if (v === basePath) return `${basePath}[${id}]`;
      if (v.startsWith(prefix)) return replacement + v.slice(prefix.length);
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Map) return new Map([...v].map(([k, val]) => [k, walk(val)]));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(json);
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
