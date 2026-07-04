// runtime/frameworkFunctions.js — the framework function registry (Phase 5).
//
// One module, two consumers. The resolver imports the NAMES to validate
// {fn(args)} and action= references at load time — an unknown function is a
// load-time error naming the site, per RESOLVED (action grammar). The
// browser boot imports the FACTORY to build the implementations, with the
// transport injected (no fetch, no localStorage here), so the same module
// runs unmodified in the browser and in pure-Node tests.
//
// App-defined <functions> are a later phase; this registry is the whole
// v0.1 function surface.

export const FRAMEWORK_FUNCTION_NAMES = new Set([
  "apskel.auth.registerUser",
  "apskel.auth.loginUser",
  // Runtime primitives, not network calls: field.set is implemented by the
  // binder (its first argument is a write target, never evaluated);
  // nav.go is supplied by the boot once the router exists.
  "apskel.field.set",
  "apskel.nav.go",
]);

// deps:
//   call(envelope)   POST one wire envelope, resolve to the parsed response
//   store            the central store — the identity region is written
//                    here with origin 'system'
//   credentials()    -> {deviceId, deviceSecret}, generating and persisting
//                    the device credential on first use
//   onToken(token)   hands the fresh access token to the wire send path
export function createFrameworkFunctions({ call, store, credentials, onToken }) {
  async function authenticate(type, fields) {
    const { deviceId, deviceSecret } = credentials();
    let resp;
    try {
      resp = await call({ type, ...fields, deviceId, deviceSecret });
    } catch (e) {
      resp = { ok: false, error: `cannot reach the server (${e.message})` };
    }
    applyIdentity(store, resp, onToken);
    return resp;
  }
  return {
    "apskel.auth.registerUser": (email, password, displayName = "") =>
      authenticate("apskel.auth.register", { email, password, displayName }),
    "apskel.auth.loginUser": (email, password) =>
      authenticate("apskel.auth.login", { email, password }),
  };
}

// The one door that writes app.identity.* — shared by the auth functions
// above and the boot's silent re-mint. Same discipline as the 'server'
// origin: app code has no business writing this region.
export function applyIdentity(store, resp, onToken) {
  if (resp && resp.ok) {
    store.set("app.identity.userId", resp.userId, "system");
    store.set("app.identity.email", resp.email, "system");
    store.set("app.identity.displayName", resp.displayName ?? "", "system");
    store.set("app.identity.status", "authenticated", "system");
    store.set("app.identity.error", "", "system");
    if (onToken) onToken(resp.token);
  } else {
    store.set("app.identity.status", "anonymous", "system");
    store.set("app.identity.error", resp?.error ?? "authentication failed", "system");
  }
}
