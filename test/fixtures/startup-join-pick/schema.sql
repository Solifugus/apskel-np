-- Same two-candidate shape as startup-join-two, but join="j3_map_a" on
-- the child graph node picks one: the server starts normally.
CREATE TABLE IF NOT EXISTS j3_articles (
    id integer PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS j3_tags (
    id   integer PRIMARY KEY,
    name text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS j3_map_a (
    article_id integer REFERENCES j3_articles(id),
    tag_id     integer REFERENCES j3_tags(id),
    PRIMARY KEY (article_id, tag_id)
);
CREATE TABLE IF NOT EXISTS j3_map_b (
    article_id integer REFERENCES j3_articles(id),
    tag_id     integer REFERENCES j3_tags(id),
    PRIMARY KEY (article_id, tag_id)
);
INSERT INTO j3_articles (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO j3_tags (id, name) VALUES (1, 'alpha'), (2, 'beta') ON CONFLICT (id) DO NOTHING;
