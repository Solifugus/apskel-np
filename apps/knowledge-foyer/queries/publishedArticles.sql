-- The landing list: each article's LATEST published edition. The row
-- condition (status = 'published') is exactly what this query's
-- read="public" rule warrants — per RESOLVED (the query is the
-- permission boundary), selecting an unpublished row here would be a
-- leak the author wrote.
SELECT DISTINCT ON (e.article_id) e.id, e.title, e.published_at
FROM article_editions e
WHERE e.status = 'published'
ORDER BY e.article_id, e.published_at DESC
