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
    r.userSeen &&
      r.userSeen.value === 5 &&
      r.userSeen.oldValue === undefined &&
      r.userSeen.origin === "user",
    JSON.stringify(r.userSeen)
  );
  check("same-value write from the Wire receive path fired nothing", r.firedAfterServerEcho === 1);
  check(
    "changed value from the Wire fired once with origin 'server'",
    r.firedTotal === 2 &&
      r.serverSeen.origin === "server" &&
      r.serverSeen.value === 9 &&
      r.serverSeen.oldValue === 5,
    JSON.stringify(r.serverSeen)
  );
  check(
    "app code claiming origin 'server' via set() is rejected",
    r.forgedName === "ApskelStoreError" && r.forgedMessage.includes("reserved to the Wire"),
    r.forgedMessage
  );
  check("the forged write applied nothing", r.x === 9);
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
  check(
    "aborted cascade discarded its whole deferred-effect queue",
    r.delivered.length === 0,
    JSON.stringify(r.delivered)
  );
  check(
    "store writes already applied were not rolled back (a=11, b=10)",
    r.a === 11 && r.b === 10,
    JSON.stringify({ a: r.a, b: r.b })
  );
}

// ---------------------------------------------------------------------------
console.log("\ndeferred-effect queue");
{
  const { run } = await import("./fixtures/watchers/deferred-effects.js");
  const r = run();
  check("no effect delivered mid-cascade", r.deliveredDuringCascade === 0);
  check(
    "at settle: coalesced per field to last value, first-enqueue field order",
    r.deliveredAtSettle === 2 && eq(r.delivered.slice(0, 2), [["app.a", 30], ["app.mid", 4]]),
    JSON.stringify(r.delivered)
  );
  check(
    "effect enqueued with no frame in flight delivered immediately",
    r.deliveredAfterSolo === 3 && eq(r.delivered[2], ["app.solo", 42]),
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
