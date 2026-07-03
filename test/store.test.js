// test/store.test.js — Phase 2 harness: central store + watcher engine.
//
//   node test/store.test.js
//
// Runs the scenario fixtures in test/fixtures/watchers/ and asserts the
// expected outcomes recorded in test/fixtures/README.md.

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
console.log("diamond dependency");
{
  const { run } = await import("./fixtures/watchers/diamond.js");
  const r = run();
  check(
    "first settle fires AtoB, AtoC, then sumD exactly once",
    eq(r.afterFirstSettle, ["AtoB", "AtoC", "sumD"]),
    JSON.stringify(r.afterFirstSettle)
  );
  check(
    "second settle fires sumD exactly once more (once per settle)",
    r.firings.filter((f) => f === "sumD").length === 2,
    JSON.stringify(r.firings)
  );
  check("sumD saw the final B and C of the second settle (d = 40 + 21)", r.d === 61, `d=${r.d}`);
}

// ---------------------------------------------------------------------------
console.log("\nsame-value write");
{
  const { run } = await import("./fixtures/watchers/same-value.js");
  const r = run();
  check("cascade terminated after exactly one firing", r.firedAfterCascade === 1);
  check(
    "watcher snapshot carried value 5, oldValue undefined, origin 'user'",
    r.seen && r.seen.value === 5 && r.seen.oldValue === undefined && r.seen.origin === "user",
    JSON.stringify(r.seen)
  );
  check("second external same-value write fired nothing", r.firedTotal === 1);
  check("value intact", r.x === 5);
}

// ---------------------------------------------------------------------------
console.log("\ngenuine cycle");
{
  const { run } = await import("./fixtures/watchers/cycle.js");
  const r = run();
  check("cascade aborted with ApskelCascadeError (no hang)", r.errorName === "ApskelCascadeError");
  check(
    "each watcher fired exactly the bound (10) before the abort",
    r.counts.chaseA === 10 && r.counts.chaseB === 10,
    JSON.stringify(r.counts)
  );
  check(
    "error message names the runaway watcher and says cycle",
    r.message.includes("cycle detected") && r.message.includes("chase"),
    r.message.split("\n")[0]
  );
  check(
    "message carries a readable cascade trace (watcher, path, old -> new, origin)",
    r.message.includes("Cascade trace:") &&
      r.message.includes("<- app.") &&
      r.message.includes("->") &&
      r.message.includes("(origin"),
    r.message
  );
  check("error.trace holds the full firing history (20 entries)", r.traceLength === 20);
}

// ---------------------------------------------------------------------------
console.log("\ndeferred-effect queue");
{
  const { run } = await import("./fixtures/watchers/deferred-effects.js");
  const r = run();
  check("no effect delivered mid-cascade", r.deliveredDuringCascade === 0);
  check(
    "after settle: coalesced per field to last value, first-enqueue field order",
    eq(r.delivered, [["app.a", 30], ["app.mid", 4]]),
    JSON.stringify(r.delivered)
  );
}

// ---------------------------------------------------------------------------
console.log("\ndeclared-local initialization");
{
  const { run } = await import("./fixtures/watchers/declared-locals.js");
  const r = run();
  check("seeding fired no watchers", r.fired === 0, `fired=${r.fired}`);
  check('app.draft seeded to "" (string)', r.draft === "");
  check("app.count seeded to 7 (number, not string)", r.count === 7 && typeof r.count === "number");
  check("app.active seeded to true (boolean)", r.active === true);
  check(
    "per-instance locals seeded at distinct paths",
    r.noteOne === "hi" && r.noteTwo === "hi",
    JSON.stringify({ noteOne: r.noteOne, noteTwo: r.noteTwo })
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
