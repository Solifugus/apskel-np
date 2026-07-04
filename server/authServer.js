// server/authServer.js — Phase 5 identity: device credential, stateless
// tokens, register/login/token wire handlers.
//
// Everything cryptographic is node:crypto — no new dependency. Passwords
// are scrypt with a per-user salt; the device secret is stored only as a
// hash; access tokens are HMAC-signed payloads verified by recomputation,
// so there is no token table and no sessions table, by construction (per
// RESOLVED (device credential mechanics)).

import crypto from "node:crypto";

const TOKEN_TTL_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- passwords (scrypt, per-user salt) --------------------------------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored ?? "").split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// --- the device secret is never stored, only its hash -----------------------

export function hashDeviceSecret(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

// --- auth: token mint/verify + wire handlers ---------------------------------

export function createAuth({
  db,
  hmacKey = crypto.randomBytes(32),
  tokenTtlMs = TOKEN_TTL_MS,
  now = Date.now,
} = {}) {
  const b64url = (buf) => Buffer.from(buf).toString("base64url");

  function sign(payload) {
    return crypto.createHmac("sha256", hmacKey).update(payload).digest("base64url");
  }

  function mintToken(userId, deviceId) {
    const payload = b64url(JSON.stringify({ u: userId, d: deviceId, exp: now() + tokenTtlMs }));
    return `${payload}.${sign(payload)}`;
  }

  // -> {userId, deviceId} or null. Verification is recomputation — no state.
  function verifyToken(token) {
    if (typeof token !== "string") return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof claims.exp !== "number" || claims.exp <= now()) return null;
    return { userId: claims.u, deviceId: claims.d };
  }

  // The identity behind a request, from its Authorization: Bearer header.
  function identity(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? verifyToken(header.slice(7)) : null;
  }

  // Register the device or verify it is the one we know: the secret's hash
  // must match. Returns {ok} or {ok: false, error}.
  async function ensureDevice(deviceId, deviceSecret) {
    if (!UUID.test(deviceId ?? "") || typeof deviceSecret !== "string" || !deviceSecret) {
      return { ok: false, error: "device credential required" };
    }
    const found = await db.query("SELECT credential_hash FROM devices WHERE id = $1", [deviceId]);
    if (found.rows.length === 0) {
      await db.query(
        "INSERT INTO devices (id, credential_hash) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [deviceId, hashDeviceSecret(deviceSecret)]
      );
      return { ok: true };
    }
    if (found.rows[0].credential_hash !== hashDeviceSecret(deviceSecret)) {
      return { ok: false, error: "device credential mismatch" };
    }
    await db.query("UPDATE devices SET last_seen = now() WHERE id = $1", [deviceId]);
    return { ok: true };
  }

  async function linkUserDevice(userId, deviceId) {
    // linked_at refreshes on re-login so the token mint's "most recently
    // linked user" (the v0.1 shared-device stopgap) tracks reality.
    await db.query(
      "INSERT INTO user_devices (user_id, device_id) VALUES ($1, $2) " +
        "ON CONFLICT (user_id, device_id) DO UPDATE SET linked_at = now()",
      [userId, deviceId]
    );
  }

  function grant(res, { userId, email, displayName, deviceId }) {
    res.json({ ok: true, userId, email, displayName, token: mintToken(userId, deviceId) });
  }

  const handlers = {
    "apskel.auth.register": async (envelope, req, res) => {
      const email = normalizeEmail(envelope.email);
      const { password, deviceId, deviceSecret } = envelope;
      const displayName = typeof envelope.displayName === "string" ? envelope.displayName : "";
      if (!email || typeof password !== "string" || password === "") {
        return res.status(400).json({ ok: false, error: "email and password are required" });
      }
      const device = await ensureDevice(deviceId, deviceSecret);
      if (!device.ok) return res.status(401).json({ ok: false, error: device.error });
      let created;
      try {
        created = await db.query(
          "INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
          [email, displayName, hashPassword(password)]
        );
      } catch (e) {
        if (e.code === "23505") {
          return res.status(409).json({ ok: false, error: "email already registered" });
        }
        throw e;
      }
      const userId = created.rows[0].id;
      await linkUserDevice(userId, deviceId);
      grant(res, { userId, email, displayName, deviceId });
    },

    "apskel.auth.login": async (envelope, req, res) => {
      const email = normalizeEmail(envelope.email);
      const { password, deviceId, deviceSecret } = envelope;
      const found = await db.query(
        "SELECT id, email, display_name, password_hash FROM users WHERE email = $1",
        [email]
      );
      const user = found.rows[0];
      // One body for unknown email and wrong password: no account enumeration.
      if (!user || !verifyPassword(password ?? "", user.password_hash)) {
        return res.status(401).json({ ok: false, error: "invalid email or password" });
      }
      const device = await ensureDevice(deviceId, deviceSecret);
      if (!device.ok) return res.status(401).json({ ok: false, error: device.error });
      await linkUserDevice(user.id, deviceId);
      grant(res, {
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        deviceId,
      });
    },

    // The silent re-mint: the durable device secret alone identifies the
    // user across full browser restarts — no password, no session.
    "apskel.auth.token": async (envelope, req, res) => {
      const { deviceId, deviceSecret } = envelope;
      if (!UUID.test(deviceId ?? "")) {
        return res.status(401).json({ ok: false, error: "unknown device" });
      }
      const found = await db.query("SELECT credential_hash FROM devices WHERE id = $1", [
        deviceId,
      ]);
      if (
        found.rows.length === 0 ||
        found.rows[0].credential_hash !== hashDeviceSecret(deviceSecret ?? "")
      ) {
        return res.status(401).json({ ok: false, error: "unknown device" });
      }
      const linked = await db.query(
        "SELECT u.id, u.email, u.display_name FROM user_devices ud " +
          "JOIN users u ON u.id = ud.user_id WHERE ud.device_id = $1 " +
          "ORDER BY ud.linked_at DESC LIMIT 1",
        [deviceId]
      );
      const user = linked.rows[0];
      if (!user) {
        return res.status(401).json({ ok: false, error: "device is not linked to a user" });
      }
      grant(res, {
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        deviceId,
      });
    },
  };

  return { handlers, identity, mintToken, verifyToken };
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}
