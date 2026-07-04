-- Notes Demo schema, applied by tools/run.js at startup.
-- record="1" in app.xml is the Phase 4 row-selection stopgap (real record
-- selection is a Phase 7 design session), so the seed row must exist.

CREATE TABLE IF NOT EXISTS notes (
    id     integer PRIMARY KEY,
    title  text NOT NULL DEFAULT '',
    body   text NOT NULL DEFAULT ''
);

INSERT INTO notes (id, title, body) VALUES (1, '', '')
ON CONFLICT (id) DO NOTHING;
