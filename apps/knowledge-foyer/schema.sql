-- Knowledge Foyer v0.1 slice: one article, one draft edition (row 1 — the
-- record= stopgap until Phase 7 designs record selection). The revision
-- column is the conflict=detect token, per RESOLVED (conflict detection
-- mechanism). Identity tables come from server/identity.sql, applied first
-- by run.js, so created_by can reference users.

CREATE TABLE IF NOT EXISTS articles (
    id         integer PRIMARY KEY,
    created_by integer REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS article_editions (
    id         integer PRIMARY KEY,
    article_id integer NOT NULL REFERENCES articles(id),
    title      text NOT NULL DEFAULT '',
    body       text NOT NULL DEFAULT '',
    revision   integer NOT NULL DEFAULT 0
);

INSERT INTO articles (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO article_editions (id, article_id) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;
INSERT INTO article_editions (id, article_id) VALUES (2, 1) ON CONFLICT (id) DO NOTHING;
