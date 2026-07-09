-- server/sync.sql — the offline queue's server-side core (design
-- session 7, Q4). Applied after identity.sql, only when the app uses
-- auth: offline writes require the identity machinery, so the table's
-- existence and its retention anchor are the same condition.
--
-- sync_receipts is an insert idempotency record, NOT a general log: a
-- row per flushed insert, committed in the insert's own statement. It
-- never contains client-side resolutions (the server cannot even see a
-- take-theirs), never write payloads, never the idempotent verbs.
--
-- The key is the triple (db, device_id, seq): db carries app+identity,
-- device_id disambiguates devices under one identity (from the token,
-- never the envelope), seq is the device-database's autoincrement —
-- monotonic and never reused, which is what makes the dequeuedThrough
-- watermark prune safe. The devices FK is a correctness anchor and the
-- trigger a future revocation session would cash; the v0.1 cleanup is
-- the watermark, because no revocation event exists yet.

CREATE TABLE IF NOT EXISTS sync_receipts (
    db          text        NOT NULL,
    device_id   uuid        NOT NULL REFERENCES devices(id),
    seq         bigint      NOT NULL,
    assigned_id bigint      NOT NULL,
    table_name  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (db, device_id, seq)
);
