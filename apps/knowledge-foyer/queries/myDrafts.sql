-- "My drafts", per RESOLVED (identity-bound query parameters): $1 is the
-- reserved @user param, filled server-side from the verified token —
-- never from the wire, so it cannot name anyone else. This is the only
-- listable form the read="owner" editions table gets.
SELECT e.id, e.title, e.status
FROM article_editions e
JOIN articles a ON a.id = e.article_id
WHERE e.status = 'draft' AND a.created_by = $1
