-- The /article/:id record context: any published edition, by id (the
-- record selection arrives as the framework's query wrap — WHERE q.id).
-- Drafts are invisible here by the same row condition that makes
-- read="public" honest.
SELECT e.id, e.title, e.body, e.published_at
FROM article_editions e
WHERE e.status = 'published'
