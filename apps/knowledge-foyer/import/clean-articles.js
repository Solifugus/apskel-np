// One-time editorial pass over the Mars-Colony article copies: drop the
// file-numbering scheme ("doc 00", "Cycle Document 2 of 5") in favor of
// articles that name each other by title — Knowledge Foyer is becoming
// the system of record, so the text should read as articles, not files.
// Every replacement must match exactly once, or it's reported.
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname) + "/articles";

const EDITS = {
  "00_Energy_Flow.md": [
    ["# Energy Flow",
     "# The Energy Flow"],
    ["### Mars Bootstrap Colony — Foundational Document (underlies all five matter cycles)",
     "### Mars Bootstrap Colony — the one open flow all five matter cycles run on"],
    ["This document is numbered 00 because it is not a sixth cycle",
     "This is not a sixth cycle"],
    ["The Water Cycle document currently restates",
     "The Water Cycle currently restates"],
    ["*End of Energy Flow draft 1. This document now owns",
     "*End of The Energy Flow, draft 1. This article now owns"],
  ],
  "01_Water_Cycle.md": [
    ["### Mars Bootstrap Colony — Cycle Document 1 of 5",
     "### Mars Bootstrap Colony — the cycle that does quadruple duty"],
    ["This is the first of five interwoven cycle documents (Water, Air, Food, Materials, Human). Water is drafted first because",
     "One of five interwoven matter cycles (Water, Air, Food, Materials, Human). Water comes first because"],
    ["belong jointly to another cycle document.*",
     "belong jointly to another cycle.*"],
    ["*(Detailed in the Human Cycle document.)*",
     "*(Detailed in The Human Cycle.)*"],
    ["**Energy accounting lives in doc 00 (Energy Flow).** This document keeps",
     "**Energy accounting lives in The Energy Flow.** This article keeps"],
  ],
  "02_Air_Cycle.md": [
    ["### Mars Bootstrap Colony — Cycle Document 2 of 5",
     "### Mars Bootstrap Colony — the hardest closure problem, and the condensation hub"],
    ["Second of five interwoven matter-cycle documents (Water, Air, Food, Materials, Human), all running on the Energy Flow (doc 00). Air is drafted second because it holds",
     "One of five interwoven matter cycles (Water, Air, Food, Materials, Human), all running on The Energy Flow. Air holds"],
    ["## 10. Energy interfaces (budgeted in doc 00)",
     "## 10. Energy interfaces (budgeted in The Energy Flow)"],
  ],
  "03_Food_Cycle.md": [
    ["### Mars Bootstrap Colony — Cycle Document 3 of 5",
     "### Mars Bootstrap Colony — from de-salted regolith to a menu worth decades"],
    ["Third of five matter-cycle documents (Water, Air, Food, Materials, Human), running on Energy Flow (doc 00). Food is",
     "One of five matter cycles (Water, Air, Food, Materials, Human), running on The Energy Flow. Food is"],
  ],
  "04_Materials_Cycle.md": [
    ["### Mars Bootstrap Colony — Cycle Document 4 of 5",
     "### Mars Bootstrap Colony — where zero-resupply is won or lost"],
    ["Fourth of five matter-cycle documents (Water, Air, Food, Materials, Human), running on Energy Flow (doc 00). Materials is",
     "One of five matter cycles (Water, Air, Food, Materials, Human), running on The Energy Flow. Materials is"],
    ["the exergy cascade (Energy doc) wants",
     "the exergy cascade (The Energy Flow) wants"],
    ["## 10. Energy interfaces (budgeted in doc 00)",
     "## 10. Energy interfaces (budgeted in The Energy Flow)"],
  ],
  "05_Human_Cycle.md": [
    ["### Mars Bootstrap Colony — Cycle Document 5 of 5",
     "### Mars Bootstrap Colony — the cycle that repairs all the others"],
    ["The last of five matter-cycle documents (Water, Air, Food, Materials, Human), running on Energy Flow (doc 00). This is the cycle",
     "One of five matter cycles (Water, Air, Food, Materials, Human), running on The Energy Flow. This is the cycle"],
    ["this document deliberately **names them rather than answers them**",
     "this article deliberately **names them rather than answers them**"],
    ["**The electricity question** (raised in doc 00):",
     "**The electricity question** (raised in The Energy Flow):"],
  ],
  "06_Reconciliation_and_Closure.md": [
    ["# Reconciliation & Closure Report",
     "# Reconciliation & Closure"],
    ["### Mars Bootstrap Colony — Master Document (sits above all six cycle documents)",
     "### Mars Bootstrap Colony — the reconciliation pass across the whole design"],
    ["across the complete set: Energy Flow (00) + Water (01), Air (02), Food (03), Materials (04), Human (05).",
     "across the complete set: The Energy Flow plus the five matter cycles — Water, Air, Food, Materials, Human."],
    ["tags were extracted from the six files",
     "tags were extracted from the six articles"],
    ["energy duplication deferred to doc 00",
     "energy duplication deferred to The Energy Flow"],
    ["## 0b. Reconciliation Pass 2 (after documents 07–09)",
     "## 0b. Reconciliation Pass 2 (after the master documents)"],
    ["now owned by Energy (00). **Fix:** slim Water to *reference* doc 00 and keep",
     "now owned by The Energy Flow. **Fix:** slim Water to *reference* it and keep"],
    ["*End of Reconciliation & Closure Report, pass 1. The six cycle documents plus this master index",
     "*End of Reconciliation & Closure, pass 1. The six cycle articles plus this master index"],
  ],
  "07_Launch_Manifest.md": [
    ["# Launch Manifest & Import-Floor Register",
     "# The Launch Manifest"],
    ["### Mars Bootstrap Colony — Master Document 07 (the bridge from Earth to closure)",
     "### Mars Bootstrap Colony — the import-floor register: the bridge from Earth to closure"],
    ["*Every other document describes how the colony runs once it is there.",
     "*Every other article describes how the colony runs once it is there."],
  ],
  "08_Sizing_Baseline.md": [
    ["# Sizing Baseline",
     "# The Sizing Baseline"],
    ["### Mars Bootstrap Colony — Master Document 08 (commits the keystone numbers)",
     "### Mars Bootstrap Colony — the keystone numbers: population and habitat volume"],
    ["*This document commits the two keystone figures",
     "*This article commits the two keystone figures"],
    ["propagates them into every `[SIZING]` tag across documents 00–07",
     "propagates them into every `[SIZING]` tag across every other article in the set"],
  ],
  "09_Transit_Arrival_Bootstrapping.md": [
    ["### Mars Bootstrap Colony — Document 09 (the riskiest window: Earth → closure)",
     "### Mars Bootstrap Colony — the riskiest window: Earth → closure"],
    ["*Every cycle document describes the colony in steady state.",
     "*Every cycle article describes the colony in steady state."],
  ],
};

// The [HANDOFF] tags name cycles by short name everywhere else — "Energy 00"
// loses its file number. Applied across all files, count reported.
const GLOBAL = [["Energy 00", "Energy"]];

let problems = 0;
for (const [file, edits] of Object.entries(EDITS)) {
  const p = path.join(DIR, file);
  let text = fs.readFileSync(p, "utf8");
  for (const [from, to] of edits) {
    const count = text.split(from).length - 1;
    if (count !== 1) {
      console.log(`MISS (${count}x): ${file}: ${from.slice(0, 60)}`);
      problems++;
      if (count === 0) continue;
    }
    text = text.split(from).join(to);
  }
  let globals = 0;
  for (const [from, to] of GLOBAL) {
    globals += text.split(from).length - 1;
    text = text.split(from).join(to);
  }
  fs.writeFileSync(p, text);
  console.log(`${file}: ${edits.length} edits, ${globals} handoff renames`);
}
process.exit(problems ? 1 : 0);
