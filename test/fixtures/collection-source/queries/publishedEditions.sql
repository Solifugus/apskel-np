SELECT e.id, e.title, e.created_at
FROM article_editions e
JOIN articles a ON a.id = e.article_id
