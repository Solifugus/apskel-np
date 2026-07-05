SELECT e.id, e.title
FROM article_editions e
JOIN articles a ON a.id = e.article_id
JOIN article_tags at ON at.article_id = a.id
JOIN tags t ON t.id = at.tag_id
WHERE t.name = $1
