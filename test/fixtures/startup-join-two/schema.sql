-- Two tables each FK both endpoints: ambiguous join edge, startup error
-- naming both candidates.
CREATE TABLE IF NOT EXISTS j2_articles (
    id integer PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS j2_tags (
    id   integer PRIMARY KEY,
    name text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS j2_map_a (
    article_id integer REFERENCES j2_articles(id),
    tag_id     integer REFERENCES j2_tags(id),
    PRIMARY KEY (article_id, tag_id)
);
CREATE TABLE IF NOT EXISTS j2_map_b (
    article_id integer REFERENCES j2_articles(id),
    tag_id     integer REFERENCES j2_tags(id),
    PRIMARY KEY (article_id, tag_id)
);
