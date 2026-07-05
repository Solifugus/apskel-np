-- The domain stores sc_tags.name, but the join FK references sc_tags.id:
-- the stored value is not the author's choice — startup error naming the
-- site and both columns.
CREATE TABLE IF NOT EXISTS sc_articles (
    id integer PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS sc_tags (
    id   integer PRIMARY KEY,
    name text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sc_article_tags (
    article_id integer REFERENCES sc_articles(id),
    tag_id     integer REFERENCES sc_tags(id),
    PRIMARY KEY (article_id, tag_id)
);
