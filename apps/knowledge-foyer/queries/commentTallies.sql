-- Per-comment pro/con tallies for one edition ($1). tables= names
-- comment_marks, so a mark broadcast re-fetches this list and the counts
-- move live, per RESOLVED (the KF v1.0 shape).
SELECT c.id,
       count(m.id) FILTER (WHERE m.kind = 'pro') AS pro_count,
       count(m.id) FILTER (WHERE m.kind = 'con') AS con_count
FROM comments c
LEFT JOIN comment_marks m ON m.comment_id = c.id
WHERE c.edition_id = $1
GROUP BY c.id
