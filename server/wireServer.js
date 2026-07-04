// server/wireServer.js — Phase 4 server side of the Wire.
//
// One envelope shape, dispatched by type; each handler does the best it can
// with what it receives. Accepted bound-field writes go to PostgreSQL and
// broadcast over SSE to ALL clients — including the originator — tagged
// with sourceClient so clients can recognize their own echo.
//
// Table/column identifiers are validated against the allowlist derived from
// the app's own resolved bindings — never taken raw from the client. A
// malformed or unknown message gets a coherent 4xx; the server survives.
//
// Phase 7.2: the permission rules from the app's data graph are enforced
// here — the client honors outcomes, the server is the only enforcement
// point, per RESOLVED (enforcement is server-side at every Wire door).
// Reads check the read rule, writes the write rule; `owner` runs the graph
// walk as one parameterized query; broadcasts are delivered per-connection
// by the read rule, per RESOLVED (broadcasts obey read rules). Apps
// without identity stay tokenless and unfiltered — Phase 4 exactly.

import express from "express";

// Fixed, non-overridable rules for the framework identity tables, per
// RESOLVED (framework identity tables are Wire-locked). A users row's
// owner is itself; devices/user_devices have no owner walk, so their
// read="owner" denies everyone via the unowned-denies floor.
const IDENTITY_TABLES = new Set(["users", "devices", "user_devices"]);
const IDENTITY_RULES = { read: "owner", write: "none" };

// The fixed readable column set on users — the app's bindings cannot
// widen it (never password_hash).
const IDENTITY_READABLE = new Map([
  ["users.email", { table: "users", field: "email" }],
  ["users.display_name", { table: "users", field: "display_name" }],
]);

const DEFAULT_RULES = { read: "users", write: "users" }; // pre-7.2 behavior

export function attachWire(app, { db, bound, log = console, auth = null, permissions = [] }) {
  const allowlist = new Map(bound.map((b) => [`${b.table}.${b.field}`, b]));
  const permByTable = new Map(permissions.map((p) => [p.table, p]));
  const sseClients = new Set(); // {res, userId}

  app.use(express.json());

  function rulesFor(table) {
    if (IDENTITY_TABLES.has(table)) return IDENTITY_RULES;
    return permByTable.get(table) ?? DEFAULT_RULES;
  }

  // The graph walk, per RESOLVED (owner is a graph walk): one parameterized
  // query joining up the startup-resolved hop columns; the last hop's
  // column IS the owner id. NULL anywhere (or no chain at all) means
  // unowned, and unowned denies.
  async function ownerOf(table, id) {
    if (table === "users") return id;
    const hops = permByTable.get(table)?.hops ?? [];
    if (hops.length === 0 || hops[hops.length - 1].parent !== "users") return null;
    const last = hops[hops.length - 1];
    let sql = `SELECT t${hops.length - 1}.${quoteIdent(last.column)} AS owner FROM ${quoteIdent(table)} t0`;
    for (let i = 0; i < hops.length - 1; i++) {
      sql += ` JOIN ${quoteIdent(hops[i].parent)} t${i + 1}` +
        ` ON t${i}.${quoteIdent(hops[i].column)} = t${i + 1}.id`;
    }
    sql += ` WHERE t0.id = $1`;
    const result = await db.query(sql, [id]);
    return result.rows.length > 0 ? result.rows[0].owner : null;
  }

  const handlers = {
    // Auth wire types (register/login/token) when the app uses identity.
    ...(auth ? auth.handlers : {}),

    "apskel.data.set": async (envelope, req, res) => {
      const g = await guardData(envelope, req, res, "write");
      if (!g) return;
      const b = g.b;
      const { table, id, field, value, sourceClient } = envelope;

      if (b.conflict === "detect") {
        // Optimistic concurrency, per RESOLVED (conflict detection
        // mechanism): the UPDATE is guarded on the revision the write was
        // based on, and increments it. A mismatch is a coherent 409 with
        // the current revision — v0.1 wires the mechanism, not the prompt.
        if (typeof envelope.baseRevision !== "number") {
          return res
            .status(400)
            .json({ ok: false, error: `baseRevision required (conflict=detect on ${table})` });
        }
        const result = await db.query(
          `UPDATE ${quoteIdent(table)} SET ${quoteIdent(field)} = $1, ` +
            `revision = revision + 1 WHERE id = $2 AND revision = $3 RETURNING revision`,
          [value, id, envelope.baseRevision]
        );
        if (result.rowCount === 0) {
          const current = await db.query(
            `SELECT revision FROM ${quoteIdent(table)} WHERE id = $1`,
            [id]
          );
          if (current.rows.length === 0) {
            return res.status(404).json({ ok: false, error: `no ${table} row with id ${id}` });
          }
          return res.status(409).json({
            ok: false,
            error: `revision mismatch on ${table} row ${id}`,
            currentRevision: current.rows[0].revision,
          });
        }
        await broadcastAccepted(g, {
          type: "apskel.data.changed",
          path: b.path,
          table,
          id,
          field,
          value,
          revision: result.rows[0].revision,
          sourceClient: sourceClient ?? null,
        });
        return res.json({ ok: true, revision: result.rows[0].revision });
      }

      const result = await db.query(
        `UPDATE ${quoteIdent(table)} SET ${quoteIdent(field)} = $1 WHERE id = $2`,
        [value, id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ ok: false, error: `no ${table} row with id ${id}` });
      }
      await broadcastAccepted(g, {
        type: "apskel.data.changed",
        path: b.path,
        table,
        id,
        field,
        value,
        sourceClient: sourceClient ?? null,
      });
      res.json({ ok: true });
    },

    // The read counterpart, per RESOLVED (reads through the Wire): same
    // allowlist, value plus current revision for detect contexts.
    "apskel.data.get": async (envelope, req, res) => {
      const g = await guardData(envelope, req, res, "read");
      if (!g) return;
      const b = g.b;
      const { table, id, field } = envelope;
      const columns =
        b.conflict === "detect" ? `${quoteIdent(field)} AS value, revision` : `${quoteIdent(field)} AS value`;
      const result = await db.query(`SELECT ${columns} FROM ${quoteIdent(table)} WHERE id = $1`, [
        id,
      ]);
      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, error: `no ${table} row with id ${id}` });
      }
      const body = { ok: true, value: result.rows[0].value };
      if (b.conflict === "detect") body.revision = result.rows[0].revision;
      res.json(body);
    },
  };

  // Shared guard for the data types. Without identity attached the app is
  // tokenless end to end (Phase 4 exactly). With identity: the table's
  // rule for this direction decides — none is 403 outright, public needs
  // no token, users/owner need identity (401 without), owner additionally
  // runs the graph walk (403 on mismatch or unowned). Allowlist and id
  // checks sit between, so unknown fields stay 400. Returns {b, identity,
  // ownerUserId} or null after answering.
  async function guardData(envelope, req, res, mode) {
    const { table, id, field } = envelope;

    if (!auth) {
      const b = allowlist.get(`${table}.${field}`);
      if (!b) {
        res.status(400).json({ ok: false, error: `no bound field '${table}.${field}' in this app` });
        return null;
      }
      if (id === undefined || id === null) {
        res.status(400).json({ ok: false, error: "missing id" });
        return null;
      }
      return { b, identity: null, ownerUserId: null };
    }

    const rules = rulesFor(table);
    const rule = mode === "read" ? rules.read : rules.write;
    if (rule === "none") {
      res.status(403).json({ ok: false, error: `${mode} on ${table} is not allowed over the wire` });
      return null;
    }
    let identity = null;
    if (rule !== "public") {
      identity = auth.identity(req);
      if (!identity) {
        res.status(401).json({ ok: false, error: "authentication required" });
        return null;
      }
    }
    const b =
      allowlist.get(`${table}.${field}`) ??
      (mode === "read" ? IDENTITY_READABLE.get(`${table}.${field}`) : undefined);
    if (!b) {
      res.status(400).json({ ok: false, error: `no bound field '${table}.${field}' in this app` });
      return null;
    }
    if (id === undefined || id === null) {
      res.status(400).json({ ok: false, error: "missing id" });
      return null;
    }
    let ownerUserId = null;
    if (rule === "owner") {
      ownerUserId = await ownerOf(table, id);
      if (ownerUserId === null || String(ownerUserId) !== String(identity.userId)) {
        res.status(403).json({ ok: false, error: `${mode} on ${table} requires owner` });
        return null;
      }
    }
    return { b, identity, ownerUserId };
  }

  // An accepted write broadcasts scoped by the table's READ rule — who may
  // read decides who may watch. The owner id is computed at most once per
  // write: reused from the guard when the write rule already walked it.
  async function broadcastAccepted(g, envelope) {
    let scope = null;
    if (auth) {
      const rules = rulesFor(envelope.table);
      scope = { read: rules.read, ownerUserId: null };
      if (rules.read === "owner") {
        scope.ownerUserId = g.ownerUserId ?? (await ownerOf(envelope.table, envelope.id));
      }
    }
    broadcast(envelope, scope);
  }

  app.post("/wire", async (req, res) => {
    const envelope = req.body;
    if (!envelope || typeof envelope.type !== "string") {
      return res.status(400).json({ ok: false, error: "wire message needs a type" });
    }
    const handler = handlers[envelope.type];
    if (!handler) {
      return res.status(400).json({ ok: false, error: `unknown wire type '${envelope.type}'` });
    }
    try {
      await handler(envelope, req, res);
    } catch (e) {
      log.error("[apskel] wire handler failed:", e.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "internal error" });
    }
  });

  // EventSource cannot set headers, so the token rides the query string;
  // identity is verified at connect and stamped on the connection, per
  // RESOLVED (broadcasts obey read rules) — including its recorded
  // tradeoff: connect-time identity persists until reconnect.
  app.get("/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.write(": connected\n\n");
    const ident = auth ? auth.verifyToken(req.query?.token) : null;
    const client = { res, userId: ident ? ident.userId : null };
    sseClients.add(client);
    req.on("close", () => sseClients.delete(client));
  });

  // Body-parse failures (malformed JSON) and anything else uncaught get a
  // coherent answer; the server keeps running.
  app.use((err, req, res, next) => {
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
      return res.status(400).json({ ok: false, error: "malformed JSON" });
    }
    log.error("[apskel] server error:", err?.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "internal error" });
  });

  function broadcast(envelope, scope = null) {
    const frame = `data: ${JSON.stringify(envelope)}\n\n`;
    for (const client of sseClients) {
      if (scope) {
        if (scope.read === "users" && client.userId == null) continue;
        if (
          scope.read === "owner" &&
          (scope.ownerUserId == null ||
            client.userId == null ||
            String(client.userId) !== String(scope.ownerUserId))
        ) {
          continue;
        }
      }
      client.res.write(frame);
    }
  }

  return { broadcast, sseClients };
}

// Startup resolution of the owner-walk FK columns against the live schema,
// per RESOLVED (owner is a graph walk): the XML never names columns. Zero
// candidate FKs or an unresolved ambiguity is a startup error naming the
// candidates; via= (recorded by the loader) picks among them. Mutates each
// hop in place, adding .column.
export async function resolvePermissionColumns(db, permissions) {
  const cache = new Map();
  for (const p of permissions) {
    for (const hop of p.hops) {
      const key = `${hop.child}->${hop.parent}:${hop.via ?? ""}`;
      if (!cache.has(key)) cache.set(key, await resolveHopColumn(db, hop));
      hop.column = cache.get(key);
    }
  }
  return permissions;
}

async function resolveHopColumn(db, hop) {
  const result = await db.query(
    `SELECT DISTINCT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = $1 AND ccu.table_name = $2`,
    [hop.child, hop.parent]
  );
  const candidates = result.rows.map((r) => r.column_name);
  if (hop.via) {
    if (!candidates.includes(hop.via)) {
      throw new Error(
        `via='${hop.via}' on ${hop.child} is not a foreign key to ${hop.parent}` +
          (candidates.length ? ` (candidates: ${candidates.join(", ")})` : "")
      );
    }
    return hop.via;
  }
  if (candidates.length === 0) {
    throw new Error(`no foreign key from ${hop.child} to ${hop.parent} — the owner walk needs one`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous foreign keys from ${hop.child} to ${hop.parent}: ${candidates.join(", ")} — ` +
        `disambiguate with via= on the <${hop.child}> graph node`
    );
  }
  return candidates[0];
}

function quoteIdent(ident) {
  // Belt and braces: identifiers are already allowlisted, but never let a
  // non-identifier near the SQL text.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) throw new Error(`bad identifier '${ident}'`);
  return `"${ident}"`;
}
