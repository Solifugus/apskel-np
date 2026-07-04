// runtime/router.js — routing is state synchronization with the URL bar,
// per RESOLVED (routes). No second navigation system: a URL applies its
// route's <set> assignments into the store; state changes reverse-match
// routes in declaration order and push the winning path. The value-change
// guard plus the path comparison are the loop-breakers.
//
// location/history are injected, so this module runs identically in the
// browser and in the Node harness. No imports — served unmodified.

export function createRouter({ routes, store, location, history }) {
  const compiled = routes.map((r) => ({ ...r, segs: r.path.split("/").filter(Boolean) }));

  // Digit-only params arrive as numbers (row ids), everything else as text.
  const coerce = (s) => (/^\d+$/.test(s) ? Number(s) : decodeURIComponent(s));

  function match(pathname) {
    const segs = pathname.split("/").filter(Boolean);
    for (const r of compiled) {
      if (r.segs.length !== segs.length) continue;
      const params = {};
      let ok = true;
      r.segs.forEach((rs, i) => {
        if (rs.startsWith(":")) params[rs.slice(1)] = coerce(segs[i]);
        else if (rs !== segs[i]) ok = false;
      });
      if (ok) return { route: r, params };
    }
    return null;
  }

  function buildPath(route, values) {
    const segs = route.segs.map((s) =>
      s.startsWith(":") ? encodeURIComponent(String(values[s.slice(1)])) : s
    );
    return "/" + segs.join("/");
  }

  // URL -> state. Boot passes silent (route state is initial state — no
  // watcher fires); navigation and popstate apply as ordinary changes.
  // An unmatched URL falls back to the first declared route, correcting
  // the URL via replaceState.
  function apply(pathname, { silent = false } = {}) {
    let m = match(pathname);
    if (!m && compiled.length > 0) {
      m = { route: compiled[0], params: {} };
      if (compiled[0].params.length === 0) {
        history.replaceState(null, "", buildPath(compiled[0], {}));
      }
    }
    if (!m) return null;
    for (const s of m.route.sets) {
      const value = s.param !== undefined ? m.params[s.param] : s.value;
      if (silent) store.seed(s.storePath, value);
      else store.set(s.storePath, value, "system");
    }
    return m;
  }

  // state -> URL. First route whose value= assignments equal current state
  // wins; param= fields must be non-empty and substitute into the path.
  function pathFromState() {
    for (const r of compiled) {
      const values = {};
      let ok = true;
      for (const s of r.sets) {
        const current = store.get(s.storePath);
        if (s.value !== undefined) {
          if (String(current) !== String(s.value)) {
            ok = false;
            break;
          }
        } else {
          if (current === undefined || current === null || current === "") {
            ok = false;
            break;
          }
          values[s.param] = current;
        }
      }
      if (ok) return buildPath(r, values);
    }
    return null;
  }

  function syncUrl() {
    const path = pathFromState();
    if (path && path !== location.pathname) history.pushState(null, "", path);
  }

  // apskel.nav.go: exactly as typing the URL, then the URL is pushed.
  function navigate(path) {
    if (path !== location.pathname) history.pushState(null, "", path);
    apply(path);
  }

  // Every store path any route assigns — what the boot's outward-sync
  // watcher subscribes to.
  const targets = [...new Set(compiled.flatMap((r) => r.sets.map((s) => s.storePath)))];

  return { apply, syncUrl, navigate, match, pathFromState, targets };
}
