-- The exposition shelf ($1 = exposition id): latest published editions of
-- articles satisfying every rule — 'has' rules demand the tag, 'lacks'
-- rules forbid it. The rule builder is ordinary app UI writing
-- exposition_tag_rules rows; this SQL is the consumer, per RESOLVED
-- (collection sources: what stays out of v0.1).
SELECT DISTINCT ON (e.article_id) e.id, e.title
FROM article_editions e
JOIN articles a ON a.id = e.article_id
WHERE e.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM exposition_tag_rules r
    WHERE r.exposition_id = $1 AND r.rule = 'has'
      AND NOT EXISTS (
        SELECT 1 FROM article_tags t
        WHERE t.article_id = a.id AND t.tag_id = r.tag_id))
  AND NOT EXISTS (
    SELECT 1 FROM exposition_tag_rules r
    WHERE r.exposition_id = $1 AND r.rule = 'lacks'
      AND EXISTS (
        SELECT 1 FROM article_tags t
        WHERE t.article_id = a.id AND t.tag_id = r.tag_id))
ORDER BY e.article_id, e.published_at DESC
