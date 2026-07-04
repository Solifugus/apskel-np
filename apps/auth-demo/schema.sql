-- Auth demo: one journal row the editor binds to (record="1", the Phase 4
-- row-selection stopgap). Identity tables come from server/identity.sql,
-- applied by run.js because this app calls apskel.auth.*.

CREATE TABLE IF NOT EXISTS journal (
    id    integer PRIMARY KEY,
    entry text NOT NULL DEFAULT ''
);

INSERT INTO journal (id, entry) VALUES (1, '')
ON CONFLICT (id) DO NOTHING;
