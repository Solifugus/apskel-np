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

import express from "express";

export function attachWire(app, { db, bound, log = console, auth = null }) {
  const allowlist = new Map(bound.map((b) => [`${b.table}.${b.field}`, b]));
  const sseClients = new Set();

  app.use(express.json());

  const handlers = {
    // Auth wire types (register/login/token) when the app uses identity.
    ...(auth ? auth.handlers : {}),

    "apskel.data.set": async (envelope, req, res) => {
      const b = guardData(envelope, req, res);
      if (!b) return;
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
        broadcast({
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
      broadcast({
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
      const b = guardData(envelope, req, res);
      if (!b) return;
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

  // Shared guard for the data types: token (when identity is attached, per
  // RESOLVED (token transport) — apps without auth stay tokenless as in
  // Phase 4), allowlist, and a concrete row id. Returns the binding or
  // null after answering.
  function guardData(envelope, req, res) {
    if (auth && !auth.identity(req)) {
      res.status(401).json({ ok: false, error: "authentication required" });
      return null;
    }
    const { table, id, field } = envelope;
    const b = allowlist.get(`${table}.${field}`);
    if (!b) {
      res.status(400).json({ ok: false, error: `no bound field '${table}.${field}' in this app` });
      return null;
    }
    if (id === undefined || id === null) {
      res.status(400).json({ ok: false, error: "missing id" });
      return null;
    }
    return b;
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

  app.get("/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
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

  function broadcast(envelope) {
    const frame = `data: ${JSON.stringify(envelope)}\n\n`;
    for (const client of sseClients) client.write(frame);
  }

  return { broadcast, sseClients };
}

function quoteIdent(ident) {
  // Belt and braces: identifiers are already allowlisted, but never let a
  // non-identifier near the SQL text.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) throw new Error(`bad identifier '${ident}'`);
  return `"${ident}"`;
}
