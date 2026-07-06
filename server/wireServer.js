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

import fs from "node:fs";
import path from "node:path";
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

export function attachWire(
  app,
  {
    db,
    bound,
    log = console,
    auth = null,
    permissions = [],
    setFields = [],
    collections = [],
    queries = [],
    queryBound = [],
    insertStamps = new Map(),
    insertTargets = [],
    selectOptions = [],
  }
) {
  const allowlist = new Map(bound.map((b) => [`${b.table}.${b.field}`, b]));
  const permByTable = new Map(permissions.map((p) => [p.table, p]));
  const collectionsByPath = new Map(collections.map((c) => [c.path, c]));
  const queriesByName = new Map(queries.map((q) => [q.name, q]));
  const queryBoundByKey = new Map(queryBound.map((b) => [`${b.query}.${b.field}`, b]));
  // Insertable tables and their column allowlists come from the app's own
  // table-sourced collections plus the tables its create actions name, per
  // RESOLVED (row creation and deletion) and RESOLVED (create actions
  // declare insert targets). Deletion stays collection-scoped: create
  // actions declare INSERT targets, nothing wider.
  const insertColumns = new Map();
  const deletableTables = new Set();
  for (const c of collections) {
    if (!c.table) continue;
    deletableTables.add(c.table);
    const cols = insertColumns.get(c.table) ?? new Set();
    for (const col of c.columns) cols.add(col);
    insertColumns.set(c.table, cols);
  }
  for (const t of insertTargets) {
    const cols = insertColumns.get(t.table) ?? new Set();
    for (const col of t.columns) cols.add(col);
    insertColumns.set(t.table, cols);
  }
  // Set fields by parent:edge, per RESOLVED (membership writes are
  // whole-set replaces); their options descriptors — unioned with the
  // select-declared arrow sources, per RESOLVED (a select is a domain-
  // bearing column reference) — form the options allowlist: arbitrary
  // column pairs never reach SQL.
  const setByKey = new Map(setFields.map((s) => [`${s.table}:${s.edge}`, s]));
  const optionsAllow = new Map(
    [...setFields, ...selectOptions].map((s) => [
      `${s.options.table}:${s.options.value}:${s.options.label}`,
      s.options,
    ])
  );
  const sseClients = new Set(); // {res, userId}

  app.use(express.json());

  function rulesFor(table) {
    if (IDENTITY_TABLES.has(table)) return IDENTITY_RULES;
    return permByTable.get(table) ?? DEFAULT_RULES;
  }

  // Assemble a query's full positional parameter array, per RESOLVED
  // (identity-bound query parameters): the wire supplies values for the
  // non-@ params in declared order; '@user' slots fill from the verified
  // token — never from the wire. A query declaring '@user' requires
  // identity regardless of its read rule. Returns the array, or null
  // after answering.
  function queryParams(q, given, req, res) {
    const callCount = q.params.filter((p) => !p.startsWith("@")).length;
    if (given.length !== callCount) {
      res
        .status(400)
        .json({ ok: false, error: `query '${q.name}' takes ${callCount} call-site parameter(s)` });
      return null;
    }
    let userId = null;
    if (q.params.includes("@user")) {
      const identity = auth ? auth.identity(req) : null;
      if (!identity) {
        res.status(401).json({ ok: false, error: "authentication required" });
        return null;
      }
      userId = identity.userId;
    }
    let next = 0;
    return q.params.map((p) => (p === "@user" ? userId : given[next++]));
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
        let result;
        try {
          result = await db.query(
            `UPDATE ${quoteIdent(table)} SET ${quoteIdent(field)} = $1, ` +
              `revision = revision + 1 WHERE id = $2 AND revision = $3 RETURNING revision`,
            [value, id, envelope.baseRevision]
          );
        } catch (e) {
          // A database rejection (an app trigger, a constraint) is a
          // coherent 400 carrying the database's message — never a 500,
          // exactly as insert already answers. Per RESOLVED (published
          // editions are immutable at the schema).
          return res.status(400).json({ ok: false, error: `write rejected: ${e.message}` });
        }
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

      let result;
      try {
        result = await db.query(
          `UPDATE ${quoteIdent(table)} SET ${quoteIdent(field)} = $1 WHERE id = $2`,
          [value, id]
        );
      } catch (e) {
        return res.status(400).json({ ok: false, error: `write rejected: ${e.message}` });
      }
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

    // Membership, per RESOLVED (membership writes are whole-set replaces):
    // the desired set replaces the current one atomically — a single CTE
    // statement (one implicit transaction even on a shared connection):
    // DELETE the missing, INSERT the new, ON CONFLICT DO NOTHING. An
    // invalid member (FK violation) rolls the whole diff back. Members are
    // canonically sorted by stored key everywhere. Permissions ride the
    // PARENT row.
    "apskel.data.setMembers": async (envelope, req, res) => {
      const g = await guardMembers(envelope, req, res, "write");
      if (!g) return;
      const s = g.entry;
      if (!Array.isArray(envelope.members)) {
        return res.status(400).json({ ok: false, error: "setMembers needs a members array" });
      }
      const members = sortMembers(envelope.members);
      try {
        await db.query(
          `WITH del AS (DELETE FROM ${quoteIdent(s.joinTable)} ` +
            `WHERE ${quoteIdent(s.parentColumn)} = $1 ` +
            `AND NOT (${quoteIdent(s.childColumn)} = ANY($2::${s.memberType}[]))) ` +
            `INSERT INTO ${quoteIdent(s.joinTable)} ` +
            `(${quoteIdent(s.parentColumn)}, ${quoteIdent(s.childColumn)}) ` +
            `SELECT $1, m FROM unnest($2::${s.memberType}[]) AS m ` +
            `ON CONFLICT DO NOTHING`,
          [envelope.id, members]
        );
      } catch (e) {
        return res
          .status(400)
          .json({ ok: false, error: `membership rejected: ${e.message}` });
      }
      await broadcastAccepted(g, {
        type: "apskel.data.membersChanged",
        path: s.path,
        table: s.table,
        id: envelope.id,
        edge: s.edge,
        members,
        sourceClient: envelope.sourceClient ?? null,
      });
      res.json({ ok: true, members });
    },

    "apskel.data.getMembers": async (envelope, req, res) => {
      const g = await guardMembers(envelope, req, res, "read");
      if (!g) return;
      const s = g.entry;
      const result = await db.query(
        `SELECT ${quoteIdent(s.childColumn)} AS member FROM ${quoteIdent(s.joinTable)} ` +
          `WHERE ${quoteIdent(s.parentColumn)} = $1 ORDER BY ${quoteIdent(s.childColumn)}`,
        [envelope.id]
      );
      res.json({ ok: true, members: result.rows.map((r) => r.member) });
    },

    // The option list, per RESOLVED (options are runtime state at the
    // widget's own path): (value, label) pairs ordered by label, governed
    // by the options table's own read rule. The descriptor must match one
    // declared at load.
    "apskel.data.options": async (envelope, req, res) => {
      const { table, value, label } = envelope;
      const opt = optionsAllow.get(`${table}:${value}:${label}`);
      if (!opt) {
        return res
          .status(400)
          .json({ ok: false, error: `no options source '${table}.${value}->${table}.${label}' in this app` });
      }
      if (auth) {
        const rule = rulesFor(table).read;
        if (rule === "owner") {
          return res.status(403).json({
            ok: false,
            error: `options on ${table} requires per-row read (read="owner") — not a listable source`,
          });
        }
        if (rule !== "public" && !auth.identity(req)) {
          return res.status(401).json({ ok: false, error: "authentication required" });
        }
      }
      const result = await db.query(
        `SELECT ${quoteIdent(value)} AS value, ${quoteIdent(label)} AS label ` +
          `FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(label)}`
      );
      res.json({ ok: true, options: result.rows });
    },

    // The collection read, per RESOLVED (apskel.data.select and collection
    // freshness): the client names its own resolved collection by path —
    // nothing else about the SQL comes from the wire. Filter reference
    // values and query params arrive positionally; everything else is the
    // load-resolved spec. Returns id plus the template's bound columns.
    "apskel.data.select": async (envelope, req, res) => {
      const c = collectionsByPath.get(envelope.path);
      if (!c) {
        return res
          .status(400)
          .json({ ok: false, error: `no collection at path '${envelope.path}' in this app` });
      }
      if (auth) {
        const rule = c.query ? queriesByName.get(c.query.name).read : rulesFor(c.table).read;
        if (rule === "owner") {
          // A list is not a row: owner-read tables have no listable form.
          return res
            .status(403)
            .json({ ok: false, error: `select on ${c.table} requires per-row read` });
        }
        if (rule !== "public" && !auth.identity(req)) {
          return res.status(401).json({ ok: false, error: "authentication required" });
        }
      }
      const cols = ["id", ...c.columns.filter((x) => x !== "id")];
      const params = [];
      let sql;
      if (c.query) {
        const q = queriesByName.get(c.query.name);
        const given = Array.isArray(envelope.params) ? envelope.params : [];
        const full = queryParams(q, given, req, res);
        if (!full) return;
        params.push(...full);
        sql = `SELECT ${cols.map(quoteIdent).join(", ")} FROM (${q.sql}) q`;
      } else {
        sql = `SELECT ${cols.map(quoteIdent).join(", ")} FROM ${quoteIdent(c.table)}`;
        if (c.filter) {
          const values = [];
          let refIndex = 0;
          const given = Array.isArray(envelope.filterValues) ? envelope.filterValues : [];
          for (const item of c.filter.items) {
            values.push(item.kind === "literal" ? item.value : given[refIndex++]);
          }
          params.push(values);
          sql += ` WHERE ${quoteIdent(c.filter.column)} = ANY($${params.length})`;
        }
      }
      if (c.order) sql += ` ORDER BY ${quoteIdent(c.order.column)} ${c.order.dir === "desc" ? "DESC" : "ASC"}`;
      if (c.limit !== null && c.limit !== undefined) sql += ` LIMIT ${c.limit}`;
      const result = await db.query(sql, params);
      res.json({ ok: true, rows: result.rows });
    },

    // Row creation, per RESOLVED (row creation and deletion): table and
    // columns allowlisted to the app's own collection-bound surface; the
    // write rule gates; ownership is stamped server-side at birth — a
    // client-supplied value for the stamp column is overwritten, never
    // trusted.
    "apskel.data.insert": async (envelope, req, res) => {
      const { table, sourceClient } = envelope;
      const allowed = insertColumns.get(table);
      if (!allowed) {
        return res
          .status(400)
          .json({ ok: false, error: `table '${table}' is not an insert target in this app` });
      }
      const values = envelope.values && typeof envelope.values === "object" ? envelope.values : {};
      const stamp = insertStamps.get(table) ?? null;
      // A client-supplied value for the stamp column is overwritten, never
      // trusted — stripped before the allowlist even looks at it.
      if (stamp) delete values[stamp];
      for (const col of Object.keys(values)) {
        if (!allowed.has(col)) {
          return res
            .status(400)
            .json({ ok: false, error: `column '${col}' is not bound on '${table}'` });
        }
      }
      let identity = null;
      if (auth) {
        const rule = rulesFor(table).write;
        if (rule === "none") {
          return res
            .status(403)
            .json({ ok: false, error: `write on ${table} is not allowed over the wire` });
        }
        identity = auth.identity(req);
        if (!identity) {
          return res.status(401).json({ ok: false, error: "authentication required" });
        }
        if (stamp) {
          values[stamp] = identity.userId; // ownership at birth
        } else if (rule === "owner") {
          // No direct FK to stamp: ownership arrives through the walk,
          // per RESOLVED (ownership at birth may arrive through the
          // walk) — the insert must carry the walk's first hop column,
          // and the REFERENCED parent row must already be the caller's.
          // A missing or unowned parent denies: the unowned-denies floor
          // at birth.
          const hop = (permByTable.get(table)?.hops ?? [])[0];
          const parentId = hop ? values[hop.column] : undefined;
          const owner = parentId == null ? null : await ownerOf(hop.parent, parentId);
          if (owner == null || String(owner) !== String(identity.userId)) {
            return res.status(403).json({
              ok: false,
              error: `insert on ${table} requires owner — the new row must belong to you at birth`,
            });
          }
        }
      }
      const cols = Object.keys(values);
      const sql =
        `INSERT INTO ${quoteIdent(table)} ` +
        (cols.length
          ? `(${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`
          : `DEFAULT VALUES`) +
        ` RETURNING id`;
      let result;
      try {
        result = await db.query(sql, Object.values(values));
      } catch (e) {
        return res.status(400).json({ ok: false, error: `insert rejected: ${e.message}` });
      }
      const id = result.rows[0]?.id;
      const g = { ownerUserId: identity?.userId ?? null };
      await broadcastAccepted(g, {
        type: "apskel.data.inserted",
        table,
        id,
        values,
        sourceClient: sourceClient ?? null,
      });
      res.json({ ok: true, id, values });
    },

    // Row deletion: the write rule plus the owner walk, exactly like a
    // field write.
    "apskel.data.delete": async (envelope, req, res) => {
      const { table, id, sourceClient } = envelope;
      if (!deletableTables.has(table)) {
        return res
          .status(400)
          .json({ ok: false, error: `no collection-bound table '${table}' in this app` });
      }
      if (id === undefined || id === null) {
        return res.status(400).json({ ok: false, error: "missing id" });
      }
      let g = { ownerUserId: null };
      if (auth) {
        const rules = rulesFor(table);
        if (rules.write === "none") {
          return res
            .status(403)
            .json({ ok: false, error: `write on ${table} is not allowed over the wire` });
        }
        const identity = auth.identity(req);
        if (!identity) {
          return res.status(401).json({ ok: false, error: "authentication required" });
        }
        if (rules.write === "owner") {
          const owner = await ownerOf(table, id);
          if (owner === null || String(owner) !== String(identity.userId)) {
            return res.status(403).json({ ok: false, error: `write on ${table} requires owner` });
          }
          g.ownerUserId = owner;
        }
      }
      let result;
      try {
        result = await db.query(`DELETE FROM ${quoteIdent(table)} WHERE id = $1`, [id]);
      } catch (e) {
        return res.status(400).json({ ok: false, error: `delete rejected: ${e.message}` });
      }
      if (result.rowCount === 0) {
        return res.status(404).json({ ok: false, error: `no ${table} row with id ${id}` });
      }
      await broadcastAccepted(g, {
        type: "apskel.data.deleted",
        table,
        id,
        sourceClient: sourceClient ?? null,
      });
      res.json({ ok: true });
    },

    // The read counterpart, per RESOLVED (reads through the Wire): same
    // allowlist, value plus current revision for detect contexts. A
    // query-context read arrives with query= instead of table= and goes
    // through the query wrap, gated by the query's own read rule.
    "apskel.data.get": async (envelope, req, res) => {
      if (envelope.query) {
        const b = queryBoundByKey.get(`${envelope.query}.${envelope.field}`);
        const q = queriesByName.get(envelope.query);
        if (!b || !q) {
          return res.status(400).json({
            ok: false,
            error: `no query-bound field '${envelope.query}.${envelope.field}' in this app`,
          });
        }
        if (auth && q.read !== "public" && !auth.identity(req)) {
          return res.status(401).json({ ok: false, error: "authentication required" });
        }
        if (envelope.id === undefined || envelope.id === null) {
          return res.status(400).json({ ok: false, error: "missing id" });
        }
        const given = Array.isArray(envelope.params) ? envelope.params : [];
        const full = queryParams(q, given, req, res);
        if (!full) return;
        const result = await db.query(
          `SELECT ${quoteIdent(envelope.field)} AS value FROM (${q.sql}) q ` +
            `WHERE q.id = $${full.length + 1}`,
          [...full, envelope.id]
        );
        if (result.rows.length === 0) {
          return res
            .status(404)
            .json({ ok: false, error: `no ${envelope.query} row with id ${envelope.id}` });
        }
        return res.json({ ok: true, value: result.rows[0].value });
      }
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

  // The membership guard: same access ladder as guardData, but the
  // allowlist is the set-field registry and the rules are the PARENT
  // table's, per RESOLVED (membership permissions ride the parent row).
  async function guardMembers(envelope, req, res, mode) {
    const { table, id, edge } = envelope;
    const entry = setByKey.get(`${table}:${edge}`);
    if (!entry) {
      res.status(400).json({ ok: false, error: `no set field '${table}.${edge}' in this app` });
      return null;
    }
    if (id === undefined || id === null) {
      res.status(400).json({ ok: false, error: "missing id" });
      return null;
    }
    if (!auth) return { entry, identity: null, ownerUserId: null };
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
    let ownerUserId = null;
    if (rule === "owner") {
      ownerUserId = await ownerOf(table, id);
      if (ownerUserId === null || String(ownerUserId) !== String(identity.userId)) {
        res.status(403).json({ ok: false, error: `${mode} on ${table} requires owner` });
        return null;
      }
    }
    return { entry, identity, ownerUserId };
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
    // Hop columns resolve only for tables whose read or write rule is
    // owner, per the hop-narrowing sentence in RESOLVED (owner is a graph
    // walk) — a non-owner node's ancestor path may legitimately cross a
    // join edge, where no child->parent FK exists.
    if (p.read !== "owner" && p.write !== "owner") continue;
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

// Canonical member order is by stored key, per RESOLVED (membership
// writes are whole-set replaces) — combined with the store's ordered-
// element array equality, set equality falls out of one equality rule.
function sortMembers(members) {
  return [...members].sort((a, b) => (a > b) - (a < b));
}

// Startup resolution of set-field edges against the live schema, per
// RESOLVED (the graph has two edge kinds). For each edge: the declared
// child name must not collide with an actual column on the parent; a join
// table (exactly one FK to each endpoint) must exist — a direct
// child->parent FK instead is the one-to-many rejection; multiple
// candidates need join= on the child graph node; and the domain's stored
// column must equal the column the join FK references. Mutates each entry
// in place, adding joinTable/parentColumn/childColumn/memberType.
// dataNodes is the Map of every declared graph node tag -> {file, line},
// for the join-table-declared-as-node check.
export async function resolveSetFieldEdges(db, setFields, dataNodes = new Map()) {
  const done = new Map();
  for (const s of setFields) {
    const key = `${s.table}:${s.edge}`;
    if (!done.has(key)) done.set(key, await resolveOneEdge(db, s, dataNodes));
    Object.assign(s, done.get(key));
  }
  return setFields;
}

async function resolveOneEdge(db, s, dataNodes) {
  const at = s.site ? ` [${s.site.file}:${s.site.line}] (reference site: ${s.site.ref})` : "";

  const collision = await db.query(
    `SELECT column_name FROM information_schema.columns ` +
      `WHERE table_name = $1 AND column_name = $2`,
    [s.table, s.edge]
  );
  if (collision.rows.length > 0) {
    throw new Error(
      `column '${s.table}.${s.edge}' collides with the declared graph edge ` +
        `'${s.table}->${s.edge}' — edge classification is by declaration at load, so ` +
        `rename the column or the edge${at}`
    );
  }

  const refsParent = await fksReferencing(db, s.table);
  const refsChild = await fksReferencing(db, s.edge);
  const parentSides = new Map(); // joining table -> {col}
  for (const r of refsParent) parentSides.set(r.child_table, r);
  const candidates = [
    ...new Set(refsChild.map((r) => r.child_table).filter((t) => parentSides.has(t))),
  ].filter((t) => t !== s.table && t !== s.edge);

  if (candidates.length === 0) {
    if (refsParent.some((r) => r.child_table === s.edge)) {
      throw new Error(
        `the edge ${s.table}->${s.edge} is one-to-many (${s.edge} has a direct FK to ` +
          `${s.table}) — a set field requires a join edge; membership is a join-table ` +
          `relationship${at}`
      );
    }
    throw new Error(
      `no join table between ${s.table} and ${s.edge} — a set field requires a table ` +
        `with one FK to each endpoint${at}`
    );
  }
  let joinTable;
  if (candidates.length > 1) {
    if (!s.join) {
      throw new Error(
        `ambiguous join tables between ${s.table} and ${s.edge}: ` +
          `${candidates.join(", ")} — disambiguate with join= on the <${s.edge}> graph node${at}`
      );
    }
    if (!candidates.includes(s.join)) {
      throw new Error(
        `join='${s.join}' is not a join table between ${s.table} and ${s.edge} ` +
          `(candidates: ${candidates.join(", ")})${at}`
      );
    }
    joinTable = s.join;
  } else {
    joinTable = candidates[0];
    if (s.join && s.join !== joinTable) {
      throw new Error(
        `join='${s.join}' is not a join table between ${s.table} and ${s.edge} ` +
          `(candidate: ${joinTable})${at}`
      );
    }
  }

  const node = dataNodes.get?.(joinTable);
  if (node) {
    throw new Error(
      `join table '${joinTable}' is declared as a graph node (${node.file}:${node.line}) — ` +
        `join tables are introspected machinery, never graph nodes${at}`
    );
  }

  const parentFks = refsParent.filter((r) => r.child_table === joinTable);
  const childFks = refsChild.filter((r) => r.child_table === joinTable);
  if (parentFks.length !== 1 || childFks.length !== 1) {
    throw new Error(
      `join table '${joinTable}' must have exactly one FK to each of ${s.table} and ` +
        `${s.edge} (found ${parentFks.length} and ${childFks.length})${at}`
    );
  }
  if (childFks[0].ref_col !== s.stored) {
    throw new Error(
      `the domain stores ${s.edge}.${s.stored}, but the join FK ` +
        `${joinTable}.${childFks[0].col} references ${s.edge}.${childFks[0].ref_col} — ` +
        `the stored value is not the author's choice${at}`
    );
  }

  const typeRow = await db.query(
    `SELECT udt_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [joinTable, childFks[0].col]
  );
  const memberType = typeRow.rows[0]?.udt_name ?? "int4";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(memberType)) {
    throw new Error(`unusable member column type '${memberType}' on ${joinTable}`);
  }
  return {
    joinTable,
    parentColumn: parentFks[0].col,
    childColumn: childFks[0].col,
    memberType,
  };
}

// Startup probe of every select-declared arrow options source, per
// RESOLVED (a select is a domain-bearing column reference): the table
// and both columns must exist against the live schema — a LIMIT-0
// SELECT, failing with an error naming the site, exactly like queries.
// (Edge-declared options are proven by the join introspection instead.)
export async function resolveSelectOptions(db, selectOptions) {
  for (const s of selectOptions) {
    const { table, value, label } = s.options;
    try {
      await db.query(
        `SELECT ${quoteIdent(value)}, ${quoteIdent(label)} FROM ${quoteIdent(table)} LIMIT 0`
      );
    } catch (e) {
      throw new Error(
        `select options source ${table}.${value}->${table}.${label} ` +
          `(${s.site.file}:${s.site.line}, ${s.site.ref}) does not run against the ` +
          `live schema: ${e.message}`
      );
    }
  }
}

// Startup resolution of declared queries, per RESOLVED (named queries are
// declared, read-only sources): the SQL body lives in queries/<name>.sql
// — one SELECT statement — and a LIMIT-0 execution proves it runs against
// the live schema and exposes an id column plus every column the app
// binds against it. Mutates each query entry, adding .sql and .fields.
export async function resolveQueries(db, queries, { appDir, collections = [], queryBound = [] }) {
  for (const q of queries) {
    const file = path.join(appDir, "queries", `${q.name}.sql`);
    if (!fs.existsSync(file)) {
      throw new Error(`query '${q.name}' has no SQL body — expected ${file}`);
    }
    const sql = fs.readFileSync(file, "utf8").trim().replace(/;\s*$/, "");
    // The single-SELECT check reads past `--` line comments (documented
    // SQL is encouraged); the executed body keeps them.
    const meat = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (!/^select\b/i.test(meat) || meat.includes(";")) {
      throw new Error(`query '${q.name}' must be a single SELECT statement (${file})`);
    }
    q.sql = sql;
    let probe;
    try {
      probe = await db.query(
        `SELECT * FROM (${sql}) q LIMIT 0`,
        q.params.map(() => null)
      );
    } catch (e) {
      throw new Error(`query '${q.name}' failed its LIMIT-0 startup check: ${e.message} (${file})`);
    }
    q.fields = (probe.fields ?? []).map((f) => f.name);
    if (!q.fields.includes("id")) {
      throw new Error(
        `query '${q.name}' exposes no 'id' column — queries must be row-addressable ` +
          `(columns: ${q.fields.join(", ") || "none"})`
      );
    }
  }
  const byName = new Map(queries.map((q) => [q.name, q]));
  for (const c of collections) {
    if (!c.query) continue;
    const q = byName.get(c.query.name);
    const missing = c.columns.filter((col) => !q.fields.includes(col));
    if (missing.length) {
      throw new Error(
        `the collection at ${c.path} binds column(s) ${missing.join(", ")} that query ` +
          `'${q.name}' does not expose (columns: ${q.fields.join(", ")})`
      );
    }
    if (c.order && !q.fields.includes(c.order.column)) {
      throw new Error(
        `order column '${c.order.column}' on ${c.path} is not exposed by query '${q.name}'`
      );
    }
  }
  for (const b of queryBound) {
    const q = byName.get(b.query);
    if (q && !q.fields.includes(b.field)) {
      throw new Error(
        `'${b.storePath}' binds column '${b.field}' that query '${b.query}' does not expose`
      );
    }
  }
  return queries;
}

// Startup resolution of table-sourced collections: filter/order columns
// must exist, and each insertable table resolves its ownership stamp —
// the direct FK to users the server fills at birth, per RESOLVED (row
// creation and deletion). A write="owner" table with no such FK rejects
// inserts here: the row would be born unowned and dead.
export async function resolveCollections(db, { collections, permissions = [], insertTargets = [] }) {
  const permBy = new Map(permissions.map((p) => [p.table, p]));
  const stamps = new Map();
  let userFks = null;

  // Per-table insertable columns — collection-bound plus create-declared,
  // per RESOLVED (create actions declare insert targets).
  const tableCols = new Map();
  const addCols = (table, cols) => {
    const s = tableCols.get(table) ?? new Set();
    for (const c of cols) s.add(c);
    tableCols.set(table, s);
  };

  for (const c of collections) {
    if (!c.table) continue;
    for (const col of [c.filter?.column, c.order?.column].filter(Boolean)) {
      const r = await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [c.table, col]
      );
      if (r.rows.length === 0) {
        throw new Error(`column '${c.table}.${col}' (filter/order on ${c.path}) does not exist`);
      }
    }
    addCols(c.table, c.columns);
  }
  for (const t of insertTargets) {
    for (const col of t.columns) {
      const r = await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [t.table, col]
      );
      if (r.rows.length === 0) {
        throw new Error(
          `column '${t.table}.${col}' named by the create action at ` +
            `${t.site.file}:${t.site.line} does not exist`
        );
      }
    }
    addCols(t.table, t.columns);
  }

  // The ownership stamp (the direct users FK the server fills at birth),
  // and the born-unowned-and-dead floor in its refined form, per RESOLVED
  // (ownership at birth may arrive through the walk): a write="owner"
  // insert target is rejected only when its insertable columns could
  // never establish ownership — no direct users FK to stamp AND the owner
  // walk's first hop column absent from the allowlist.
  for (const [table, cols] of tableCols) {
    if (userFks === null) userFks = await fksReferencing(db, "users").catch(() => []);
    const candidates = [
      ...new Set(userFks.filter((f) => f.child_table === table).map((f) => f.col)),
    ];
    if (candidates.length > 1) {
      throw new Error(
        `table '${table}' has multiple FKs to users (${candidates.join(", ")}) — ` +
          `the insert ownership stamp is ambiguous`
      );
    }
    const stamp = candidates[0] ?? null;
    if (!stamp && permBy.get(table)?.write === "owner") {
      const hop = permBy.get(table)?.hops?.[0];
      if (!hop || !cols.has(hop.column)) {
        throw new Error(
          `table '${table}' declares write="owner" but has no direct FK to users, and ` +
            (hop
              ? `its insertable columns (${[...cols].join(", ") || "none"}) do not include ` +
                `the owner walk's first hop '${hop.column}'`
              : `no owner walk exists to carry ownership`) +
            ` — inserted rows would be born unowned and dead by the unowned-denies floor`
        );
      }
    }
    stamps.set(table, stamp);
  }
  return stamps;
}

async function fksReferencing(db, table) {
  const result = await db.query(
    `SELECT tc.table_name AS child_table, kcu.column_name AS col, ccu.column_name AS ref_col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = $1`,
    [table]
  );
  return result.rows;
}

function quoteIdent(ident) {
  // Belt and braces: identifiers are already allowlisted, but never let a
  // non-identifier near the SQL text.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) throw new Error(`bad identifier '${ident}'`);
  return `"${ident}"`;
}
