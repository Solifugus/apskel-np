-- server/identity.sql — the Phase 5 identity core, applied by run.js when
-- the app uses auth (any apskel.auth.* call in its resolved tree).
--
-- Deliberately NO sessions table: identity is a device-held credential and
-- access tokens are stateless HMAC — its absence is a test, per the plan.

CREATE TABLE IF NOT EXISTS users (
    id            serial PRIMARY KEY,
    email         text NOT NULL UNIQUE,
    display_name  text NOT NULL DEFAULT '',
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
    id              uuid PRIMARY KEY,
    credential_hash text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen       timestamptz NOT NULL DEFAULT now()
);

-- A device may host multiple users; a user may have multiple devices.
CREATE TABLE IF NOT EXISTS user_devices (
    user_id   integer NOT NULL REFERENCES users(id),
    device_id uuid NOT NULL REFERENCES devices(id),
    linked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, device_id)
);
