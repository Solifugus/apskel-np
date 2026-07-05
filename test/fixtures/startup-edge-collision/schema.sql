-- The collision: ec_articles carries a COLUMN named ec_tags alongside the
-- declared ec_tags graph child. Edge classification is by declaration at
-- load; the collision is a startup error naming both.
CREATE TABLE IF NOT EXISTS ec_articles (
    id      integer PRIMARY KEY,
    ec_tags text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ec_tags (
    id   integer PRIMARY KEY,
    name text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ec_article_tags (
    article_id integer REFERENCES ec_articles(id),
    tag_id     integer REFERENCES ec_tags(id),
    PRIMARY KEY (article_id, tag_id)
);
