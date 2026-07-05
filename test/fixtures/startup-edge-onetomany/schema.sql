-- om_tags has a DIRECT FK to om_articles (one-to-many) and no join table
-- exists: membership requires a join edge, so the set field is a startup
-- error.
CREATE TABLE IF NOT EXISTS om_articles (
    id integer PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS om_tags (
    id         integer PRIMARY KEY,
    article_id integer REFERENCES om_articles(id),
    name       text NOT NULL DEFAULT ''
);
