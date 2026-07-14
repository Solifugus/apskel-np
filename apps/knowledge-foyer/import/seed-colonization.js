// Wipe KF test data and seed the Mars colony content: the technical
// design documents (~/development/Mars-Colony) as the centerpiece, the
// narrative book (~/Documents/colonization) alongside.
// Run: node seed-colonization.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "/home/solifugus/development/apskel-np/node_modules/pg/lib/index.js";

const STORY_SRC = path.join(os.homedir(), "Documents/colonization");
// The cleaned copies (clean-articles.js output) — the one-time editorial
// pass that made these read as articles, not numbered files.
const DESIGN_SRC = path.dirname(new URL(import.meta.url).pathname) + "/articles";
const OWNER = 2; // matthewct@gmail.com

const dbConfig = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? "apskel_development",
  user: process.env.PGUSER ?? "apskel",
};
dbConfig.password = process.env.PGPASSWORD ?? readPgPass(dbConfig);

function readPgPass({ host, port, database, user }) {
  const file = process.env.PGPASSFILE ?? path.join(os.homedir(), ".pgpass");
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [h, p, d, u, ...rest] = line.split(":");
    const match = (pat, val) => pat === "*" || pat === String(val);
    if (match(h, host) && match(p, port) && match(d, database) && match(u, user))
      return rest.join(":");
  }
  return undefined;
}

// --- content -----------------------------------------------------------
// Tag vocabulary: 'design' marks the technical documents (the site's
// centerpiece), 'story' the narrative book; 'cycle' vs its absence
// splits the design set into matter cycles and master documents.

const TAGS = ["colonization", "design", "story", "cycle",
              "energy", "water", "air", "food", "materials", "human"];

const DESIGN = [
  { file: "00_Energy_Flow.md",                  tags: ["colonization", "design", "cycle", "energy"] },
  { file: "01_Water_Cycle.md",                  tags: ["colonization", "design", "cycle", "water"] },
  { file: "02_Air_Cycle.md",                    tags: ["colonization", "design", "cycle", "air"] },
  { file: "03_Food_Cycle.md",                   tags: ["colonization", "design", "cycle", "food"] },
  { file: "04_Materials_Cycle.md",              tags: ["colonization", "design", "cycle", "materials"] },
  { file: "05_Human_Cycle.md",                  tags: ["colonization", "design", "cycle", "human"] },
  { file: "06_Reconciliation_and_Closure.md",   tags: ["colonization", "design"] },
  { file: "07_Launch_Manifest.md",              tags: ["colonization", "design", "materials"] },
  { file: "08_Sizing_Baseline.md",              tags: ["colonization", "design"] },
  { file: "09_Transit_Arrival_Bootstrapping.md",tags: ["colonization", "design"] },
];

const STORY = [
  "01-arrival.md", "02-vision.md", "03-deep-season.md", "04-energy-cycle.md",
  "05-following-current.md", "06-water-cycle.md", "07-the-breach.md",
  "08-air-cycle.md", "09-growing-deep.md", "10-biomaterial-cycle.md",
  "11-the-teaching.md", "12-manufacturing-cycle.md", "13-first-mars-child.md",
  "14-human-cycle.md", "15-foundation.md",
].map(file => ({ file, tags: ["colonization", "story"] }));

const EXPOSITIONS = [
  { id: 1, title: "Colonizing Mars",
    description: "A zero-resupply Mars bootstrap colony, developed in the open: the energy flow, the five matter cycles, and the master documents that reconcile them — plus the companion story that renders the same colony as narrative. These are living drafts; pro/con feedback on the open questions is the point.",
    rules: [["has", "colonization"]] },
];

// --- seed --------------------------------------------------------------

const client = new pg.Client(dbConfig);
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("ALTER TABLE article_editions DISABLE TRIGGER kf_published_immutable");
  for (const t of ["comment_marks", "comments", "exposition_tag_rules",
                   "expositions", "article_tags", "article_editions", "articles", "tags"])
    await client.query(`DELETE FROM ${t}`);
  await client.query("ALTER TABLE article_editions ENABLE TRIGGER kf_published_immutable");

  const tagId = {};
  for (const [i, name] of TAGS.entries()) {
    tagId[name] = i + 1;
    await client.query("INSERT INTO tags (id, name) VALUES ($1, $2)", [i + 1, name]);
  }

  // design docs get the recent publish dates (landing page leads with them)
  const articles = [
    ...STORY.map(a => ({ ...a, src: STORY_SRC })),
    ...DESIGN.map(a => ({ ...a, src: DESIGN_SRC })),
  ];
  const now = Date.now();
  for (const [i, art] of articles.entries()) {
    const id = i + 1;
    const raw = fs.readFileSync(path.join(art.src, art.file), "utf8");
    const lines = raw.split("\n");
    const title = lines[0].replace(/^#\s*/, "").trim();
    const body = lines.slice(1).join("\n").trim();
    const publishedAt = new Date(now - (articles.length - id) * 2 * 86400_000);
    const createdAt = new Date(publishedAt.getTime() - 86400_000);
    await client.query(
      "INSERT INTO articles (id, created_by, created_at) VALUES ($1, $2, $3)",
      [id, OWNER, createdAt]);
    await client.query(
      `INSERT INTO article_editions (id, article_id, title, body, revision, status, published_at)
       VALUES ($1, $1, $2, $3, 0, 'published', $4)`,
      [id, title, body, publishedAt]);
    for (const t of art.tags)
      await client.query(
        "INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2)", [id, tagId[t]]);
  }

  for (const expo of EXPOSITIONS) {
    await client.query(
      "INSERT INTO expositions (id, created_by, title, description) VALUES ($1, $2, $3, $4)",
      [expo.id, OWNER, expo.title, expo.description]);
    for (const [rule, tag] of expo.rules)
      await client.query(
        "INSERT INTO exposition_tag_rules (exposition_id, tag_id, rule) VALUES ($1, $2, $3)",
        [expo.id, tagId[tag], rule]);
  }

  await client.query(
    "SELECT setval('article_editions_id_seq', GREATEST(100, (SELECT MAX(id) FROM article_editions)))");
  await client.query(
    "SELECT setval(pg_get_serial_sequence('expositions','id'), (SELECT MAX(id) FROM expositions))");
  await client.query(
    "SELECT setval(pg_get_serial_sequence('exposition_tag_rules','id'), (SELECT MAX(id) FROM exposition_tag_rules))");

  await client.query("COMMIT");
  console.log(`seeded ${articles.length} articles, ${TAGS.length} tags, ${EXPOSITIONS.length} expositions`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
