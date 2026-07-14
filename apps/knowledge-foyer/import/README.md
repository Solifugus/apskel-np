# The one-time content import (2026-07-13)

Knowledge Foyer is the system of record for the Mars colony articles as
of this import: the canonical text lives in the `article_editions`
table, and revisions happen through the app as new editions. The files
these scripts read from are historical artifacts now.

- `clean-articles.js` — the editorial pass applied to copies of
  `~/development/Mars-Colony/*.md` before import: dropped the file
  numbering ("doc 00", "Cycle Document 2 of 5") so articles name each
  other by title. Exact-match replacements; reports any miss.
- `seed-colonization.js` — wiped the test data and imported the ten
  design documents (cleaned copies) plus the fifteen story chapters
  from `~/Documents/colonization/`, tagged, with one exposition.

**Do not re-run against a database whose articles have been edited in
the app** — the wipe would destroy edition history that exists nowhere
else. Back up with `pg_dump` before any rebuild instead.
