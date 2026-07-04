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
      // With identity attached, data writes require a valid access token —
      // Authorization: Bearer, per RESOLVED (token transport). Apps without
      // auth (no apskel.auth.* call anywhere) stay tokenless, as in Phase 4.
      if (auth && !auth.identity(req)) {
        return res.status(401).json({ ok: false, error: "authentication required" });
      }
      const { table, id, field, value, sourceClient } = envelope;
      const b = allowlist.get(`${table}.${field}`);
      if (!b) {
        return res
          .status(400)
          .json({ ok: false, error: `no bound field '${table}.${field}' in this app` });
      }
      if (id === undefined || id === null) {
        return res.status(400).json({ ok: false, error: "missing id" });
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
  };

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
