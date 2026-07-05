-- No join table and no FK between the endpoints: the set field's edge
-- resolves to nothing at startup.
CREATE TABLE IF NOT EXISTS jn_articles (
    id integer PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS jn_tags (
    id   integer PRIMARY KEY,
    name text NOT NULL DEFAULT ''
);
