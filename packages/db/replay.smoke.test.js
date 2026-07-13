// Structural smoke test for `observe --replay`. Proves the wiring runs end-to-end and WRITES
// initiatives into a target DB — WITHOUT the real model and WITHOUT touching ~/.pm-agent. The
// Haiku call is stubbed by putting a fake `claude` executable on PATH that echoes a canned
// distiller response. Everything lives under a fresh system-temp dir. Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Put a fake `claude` on PATH that ignores args and prints the --output-format json envelope
// whose `result` is the given distiller response. Deterministic; no real model, no network.
function installFakeClaude(tmp, modelJson) {
  const binDir = path.join(tmp, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = path.join(binDir, "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
      JSON.stringify({ result: modelJson, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
    )});\n`
  );
  chmodSync(fakeClaude, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
}

test("observe --replay seeds multiple initiatives into a target DB (model stubbed)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pm-replay-smoke-"));
  // Never let anything fall back to the real ledger home.
  process.env.PM_AGENT_HOME = path.join(tmp, "home");

  // Fake `claude`: ignore args, print the --output-format json envelope whose `result` is a
  // multi-goal distiller response (current contract: focus/why/completed alongside text).
  // Same output for every call → deterministic.
  const model = JSON.stringify({
    goals: [
      {
        text: "Ship the zone model",
        initiative: "Zone model",
        isNew: true,
        framing: "build the zone model",
        focus: "sketching the projection shape",
        why: "the coach needs zones to plan sessions",
        completed: false,
      },
      { text: "Deterministic duplicate-plan cleanup", initiative: "Dup cleanup", isNew: true, focus: null },
    ],
    events: [{ type: "decided", summary: "Framed two workstreams", thread: "Zone model" }],
  });
  installFakeClaude(tmp, model);

  const S = await import("./store.js");
  const { replay } = await import("./observe.js");

  const slug = "acme/widget";
  const sourcePath = path.join(tmp, "source.db");
  const targetPath = path.join(tmp, "target.db");

  // Source: a repos row + two fabricated session_log rows (digests must clear MIN_DIGEST_CHARS).
  const source = S.openDbAt(sourcePath);
  const now = new Date().toISOString();
  source.prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)").run(slug, tmp, now);
  const srcRepoId = source.prepare("SELECT id FROM repos WHERE slug = ?").get(slug).id;
  const bigDigest = "USER: " + "let's plan the roadmap for the coach. ".repeat(20);
  const ins = source.prepare(
    "INSERT INTO session_log (repo_id, session_id, turn, cursor_start, digest, char_count, created_at) VALUES (?,?,?,?,?,?,?)"
  );
  ins.run(srcRepoId, "sess-aaaa", 10, 0, bigDigest, bigDigest.length, "2026-07-01T00:00:00.000Z");
  ins.run(srcRepoId, "sess-bbbb", 20, 10, bigDigest, bigDigest.length, "2026-07-02T00:00:00.000Z");

  // Target: only a seeded repos row (root points at a nonexistent path on purpose → replay
  // must fall back to process.cwd() for the spawn cwd without crashing).
  const target = S.openDbAt(targetPath);
  target
    .prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)")
    .run(slug, path.join(tmp, "does-not-exist"), now);

  await replay({ source: sourcePath, target: targetPath, repo: slug });

  // Verify the target now holds the spawned initiatives, their goals, an event, and snapshots.
  const verify = S.openDbAt(targetPath, { readonly: true });
  const repoId = verify.prepare("SELECT id FROM repos WHERE slug = ?").get(slug).id;
  const threads = verify.prepare("SELECT title, goal, goal_source, focus FROM threads WHERE repo_id = ?").all(repoId);
  const titles = threads.map((t) => t.title).sort();
  assert.deepEqual(titles, ["Dup cleanup", "Zone model"]);
  for (const t of threads) {
    assert.ok(t.goal, `initiative ${t.title} has a goal`);
    assert.equal(t.goal_source, "observer");
  }
  const zone = threads.find((t) => t.title === "Zone model");
  assert.equal(zone.focus, "sketching the projection shape", "focus written from the distiller output");
  const events = verify.prepare("SELECT COUNT(*) AS n FROM events WHERE repo_id = ?").get(repoId).n;
  assert.ok(events >= 1, "at least one event logged");
  const snaps = verify
    .prepare("SELECT COUNT(*) AS n FROM initiative_snapshots WHERE repo_id = ? AND focus IS NOT NULL")
    .get(repoId).n;
  assert.ok(snaps >= 1, "snapshots carry the focus column");

  // Replay mirrors the raw-ledger rows into the target and records the distill outcome.
  const logRows = verify
    .prepare("SELECT session_id, turn, distilled_at, distill_error FROM session_log WHERE repo_id = ? ORDER BY turn")
    .all(repoId);
  assert.equal(logRows.length, 2, "both replayed turns mirrored into the target session_log");
  for (const r of logRows) {
    assert.ok(r.distilled_at, `turn ${r.turn} marked distilled`);
    assert.equal(r.distill_error, null);
  }

  rmSync(tmp, { recursive: true, force: true });
});

test("applyCapture guards same-title collapse: two goals, one title → keep first, warn, drop second", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pm-guard-smoke-"));
  process.env.PM_AGENT_HOME = path.join(tmp, "home");
  installFakeClaude(tmp, JSON.stringify({ goals: [], events: [] }));

  const S = await import("./store.js");
  const { applyCapture } = await import("./observe.js");

  const slug = "acme/collide";
  const dbPath = path.join(tmp, "target.db");
  const db = S.openDbAt(dbPath);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)").run(slug, tmp, now);
  const repo = db.prepare("SELECT * FROM repos WHERE slug = ?").get(slug);
  // An existing umbrella initiative both goals would (wrongly) resolve to.
  db.prepare("INSERT INTO threads (repo_id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)").run(
    repo.id, "Plan Model & Execution", now, now
  );

  // Capture stderr to prove the guard warned.
  const origWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  try {
    await applyCapture(db, repo, {
      goals: [
        { text: "Reviewable set_plan diffs", initiative: "Plan Model & Execution", isNew: true },
        { text: "Deterministic duplicate-row cleanup", initiative: "Plan Model & Execution", isNew: true },
      ],
      events: [],
      sessionId: "sess-guard",
      turn: 1,
    });
  } finally {
    process.stderr.write = origWrite;
  }

  assert.match(stderr, /two goals in one turn resolved to the same initiative/);
  const threads = db.prepare("SELECT title, goal FROM threads WHERE repo_id = ?").all(repo.id);
  assert.equal(threads.length, 1, "no duplicate thread created");
  // First goal kept; second did NOT overwrite it.
  assert.equal(threads[0].goal, "Reviewable set_plan diffs");

  rmSync(tmp, { recursive: true, force: true });
});

test("applyCapture: goal null = unchanged, focus swings, why fills, completed flips active→done (only active)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pm-focus-smoke-"));
  process.env.PM_AGENT_HOME = path.join(tmp, "home");
  installFakeClaude(tmp, JSON.stringify({ goals: [], events: [] })); // synthesis stub only

  const S = await import("./store.js");
  const { applyCapture } = await import("./observe.js");

  const slug = "acme/focus";
  const db = S.openDbAt(path.join(tmp, "t.db"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)").run(slug, tmp, now);
  const repo = db.prepare("SELECT * FROM repos WHERE slug = ?").get(slug);

  // Birth: a new goal seeds goal + focus + why.
  await applyCapture(db, repo, {
    goals: [
      {
        initiative: "Muscle recovery signal",
        isNew: true,
        text: "give the coach a per-muscle recovery readiness signal",
        focus: "sketching the recovery model",
        why: "the coach can't plan sessions without knowing what's recovered",
        framing: "let's give the coach a recovery readiness signal",
      },
    ],
    events: [],
    sessionId: "sess-f",
    turn: 1,
  });
  let t = db.prepare("SELECT * FROM threads WHERE repo_id = ?").get(repo.id);
  assert.equal(t.goal, "give the coach a per-muscle recovery readiness signal");
  assert.equal(t.focus, "sketching the recovery model");
  assert.match(t.why, /plan sessions/);
  assert.equal(t.status, "active");

  // Later turn: attention swings to a verification tactic. text:null → goal HELD; focus swings.
  await applyCapture(db, repo, {
    goals: [
      {
        initiative: "muscle recovery signal.", // normalized title match — must not fork
        isNew: false,
        text: null,
        focus: "verifying whether the tier 2 muscle taxonomy serves practical value",
        why: "a later observer why that must NOT overwrite the already-filled one",
      },
    ],
    events: [],
    sessionId: "sess-f",
    turn: 2,
  });
  const count = db.prepare("SELECT COUNT(*) n FROM threads WHERE repo_id = ?").get(repo.id).n;
  assert.equal(count, 1, "normalized title did not fork a duplicate initiative");
  t = db.prepare("SELECT * FROM threads WHERE repo_id = ?").get(repo.id);
  assert.equal(t.goal, "give the coach a per-muscle recovery readiness signal", "goal held steady");
  assert.match(t.focus, /tier 2 muscle taxonomy/, "focus swung with the tactic");
  assert.match(t.why, /plan sessions/, "an already-filled why is not rewritten by the observer");

  // Snapshot rows carry the swinging focus.
  const snapFocus = db
    .prepare("SELECT focus FROM initiative_snapshots WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
    .get(t.id).focus;
  assert.match(snapFocus, /tier 2 muscle taxonomy/);

  // completed:true flips an ACTIVE thread to done…
  await applyCapture(db, repo, {
    goals: [{ initiative: "Muscle recovery signal", isNew: false, text: null, completed: true }],
    events: [],
    sessionId: "sess-f",
    turn: 3,
  });
  t = db.prepare("SELECT * FROM threads WHERE repo_id = ?").get(repo.id);
  assert.equal(t.status, "done");

  // …but never a non-active one (user reopened as blocked → stays blocked).
  db.prepare("UPDATE threads SET status = 'blocked' WHERE id = ?").run(t.id);
  await applyCapture(db, repo, {
    goals: [{ initiative: "Muscle recovery signal", isNew: false, text: null, completed: true }],
    events: [],
    sessionId: "sess-f",
    turn: 4,
  });
  t = db.prepare("SELECT * FROM threads WHERE repo_id = ?").get(repo.id);
  assert.equal(t.status, "blocked", "completed never overrides a non-active status");

  rmSync(tmp, { recursive: true, force: true });
});

test("applyCapture: agent-seeded goal and why survive observer updates; focus still swings", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pm-trust-smoke-"));
  process.env.PM_AGENT_HOME = path.join(tmp, "home");
  installFakeClaude(tmp, JSON.stringify({ goals: [], events: [] }));

  const S = await import("./store.js");
  const { applyCapture } = await import("./observe.js");

  const db = S.openDbAt(path.join(tmp, "t.db"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)").run("acme/trust", tmp, now);
  const repo = db.prepare("SELECT * FROM repos WHERE slug = 'acme/trust'").get();
  const tid = S.resolveThread(db, repo.id, "Coach exec layer");
  S.setThreadGoal(db, tid, { goal: "agent's durable goal", source: "agent" });
  S.setThreadWhy(db, tid, { why: "agent's why", source: "agent" });

  await applyCapture(db, repo, {
    goals: [
      {
        initiative: "Coach exec layer",
        isNew: false,
        text: "observer tries to reframe the goal",
        focus: "poking at the loop",
        why: "observer's why",
      },
    ],
    events: [],
    sessionId: "s",
    turn: 1,
  });
  const t = S.getThread(db, tid);
  assert.equal(t.goal, "agent's durable goal", "agent goal never clobbered");
  assert.equal(t.why, "agent's why", "agent why never clobbered");
  assert.equal(t.focus, "poking at the loop", "focus has no trust guard — it swings");

  rmSync(tmp, { recursive: true, force: true });
});

test("autoCompleteThreads: all linked issues closed + no open branch → done; zero-issue threads untouched", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pm-autodone-smoke-"));
  process.env.PM_AGENT_HOME = path.join(tmp, "home");

  const S = await import("./store.js");
  const { autoCompleteThreads } = await import("./work.js");

  const db = S.openDbAt(path.join(tmp, "t.db"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)").run("acme/done", tmp, now);
  const repo = db.prepare("SELECT * FROM repos WHERE slug = 'acme/done'").get();

  const closedAll = S.resolveThread(db, repo.id, "All closed"); // → done
  const halfOpen = S.resolveThread(db, repo.id, "Half open"); // stays active (an issue still open)
  const branchy = S.resolveThread(db, repo.id, "Branchy"); // stays active (open branch)
  const noIssues = S.resolveThread(db, repo.id, "Pure conversation"); // stays active (zero issues)

  S.upsertIssue(db, repo.id, { number: 1, title: "a", state: "CLOSED" });
  S.linkIssueToThread(db, repo.id, 1, closedAll);
  S.upsertIssue(db, repo.id, { number: 2, title: "b", state: "CLOSED" });
  S.linkIssueToThread(db, repo.id, 2, halfOpen);
  S.upsertIssue(db, repo.id, { number: 3, title: "c", state: "OPEN" });
  S.linkIssueToThread(db, repo.id, 3, halfOpen);
  S.upsertIssue(db, repo.id, { number: 4, title: "d", state: "CLOSED" });
  S.linkIssueToThread(db, repo.id, 4, branchy);
  S.setIssueFields(db, repo.id, 4, { branch: "feat/4-still-going" });

  const flipped = autoCompleteThreads(db, repo);
  assert.deepEqual([...flipped], [closedAll]);
  const statuses = Object.fromEntries(
    db.prepare("SELECT id, status FROM threads WHERE repo_id = ?").all(repo.id).map((t) => [t.id, t.status])
  );
  assert.equal(statuses[closedAll], "done");
  assert.equal(statuses[halfOpen], "active");
  assert.equal(statuses[branchy], "active");
  assert.equal(statuses[noIssues], "active", "zero linked issues is never lifecycle's call");

  rmSync(tmp, { recursive: true, force: true });
});
