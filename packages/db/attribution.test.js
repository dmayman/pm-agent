// Tests for the branch/PR → initiative attribution (#39): the thread_refs association, its
// deterministic merged-flag derivation, the goal-first done-signal in autoCompleteThreads, the
// lifecycle rollup counts, and the loose-ends noise filter. No model, no network — pure ledger.
// Run with `node --test` (Node >= 22.5, no deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function freshDb(slug = "acme/attr") {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pm-attr-"));
  process.env.PM_AGENT_HOME = path.join(tmp, "home");
  const S = await import("./store.js");
  const db = S.openDbAt(path.join(tmp, "t.db"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)").run(slug, tmp, now);
  const repo = db.prepare("SELECT * FROM repos WHERE slug = ?").get(slug);
  return { S, db, repo, tmp };
}

test("linkRefToThread + refsForThread: idempotent, kind-validated, blanks ignored", async () => {
  const { S, db, repo, tmp } = await freshDb();
  const tid = S.resolveThread(db, repo.id, "Fly region fix");
  S.linkRefToThread(db, repo.id, tid, "branch", "fix/fly-region-sjc");
  S.linkRefToThread(db, repo.id, tid, "branch", "fix/fly-region-sjc"); // dup → no-op
  S.linkRefToThread(db, repo.id, tid, "pr", 87);
  S.linkRefToThread(db, repo.id, tid, "branch", "   "); // blank → ignored
  S.linkRefToThread(db, repo.id, tid, "issue", 5); // bad kind → ignored
  const refs = S.refsForThread(db, tid);
  assert.deepEqual(
    refs.map((r) => `${r.kind}:${r.value}`).sort(),
    ["branch:fix/fly-region-sjc", "pr:87"]
  );
  assert.ok(refs.every((r) => r.merged === 0));
  rmSync(tmp, { recursive: true, force: true });
});

test("refreshThreadRefs: backfills from event refs and derives merged from merged-type events", async () => {
  const { S, db, repo, tmp } = await freshDb();
  const { refreshThreadRefs } = await import("./work.js");
  const tid = S.resolveThread(db, repo.id, "Calendar timezone fix");

  // Observer-style events carrying branch/pr refs but NO issue number.
  S.logEvent(db, repo.id, { threadId: tid, type: "built", summary: "wired tz", refs: { branch: "fix/tz" }, source: "observer" });
  S.logEvent(db, repo.id, { threadId: tid, type: "decided", summary: "picked pr path", refs: { pr: 88 }, source: "observer" });
  // A merged-type event (as derived ingest would write) — on ANY thread — proves pr 88 landed.
  S.logEvent(db, repo.id, { threadId: null, type: "merged", summary: "Merge tz work", refs: { pr: 88, branch: "fix/tz" }, source: "derived", dedupeKey: "pr:88" });

  const changed = refreshThreadRefs(db, repo);
  const refs = S.refsForThread(db, tid);
  const byKey = Object.fromEntries(refs.map((r) => [`${r.kind}:${r.value}`, r.merged]));
  assert.equal(byKey["branch:fix/tz"], 1, "branch marked merged via matching merged event");
  assert.equal(byKey["pr:88"], 1, "pr marked merged via matching merged event");
  assert.ok(changed.has(tid), "returns the thread whose refs flipped merged");

  // Idempotent: a second pass reports no further changes.
  assert.equal(refreshThreadRefs(db, repo).size, 0);
  rmSync(tmp, { recursive: true, force: true });
});

test("refreshThreadRefs: an unmerged branch stays open (no merged event)", async () => {
  const { S, db, repo, tmp } = await freshDb();
  const { refreshThreadRefs } = await import("./work.js");
  const tid = S.resolveThread(db, repo.id, "Migration hardening");
  S.logEvent(db, repo.id, { threadId: tid, type: "built", summary: "per-branch neon", refs: { branch: "chore/neon-83" }, source: "observer" });
  refreshThreadRefs(db, repo);
  assert.equal(S.refsForThread(db, tid)[0].merged, 0, "no merged event → stays open");
  rmSync(tmp, { recursive: true, force: true });
});

test("autoCompleteThreads: zero-issue thread flips only when all refs merged AND quiet", async () => {
  const { S, db, repo, tmp } = await freshDb();
  const { autoCompleteThreads, refreshThreadRefs } = await import("./work.js");

  const merged = S.resolveThread(db, repo.id, "Fully landed goal");
  const mixed = S.resolveThread(db, repo.id, "Half landed goal");
  const openOnly = S.resolveThread(db, repo.id, "Still open goal");

  const oldTs = "2026-01-01T00:00:00.000Z"; // long-quiet
  // merged: one branch, landed.
  S.logEvent(db, repo.id, { threadId: merged, type: "built", summary: "did it", refs: { branch: "feat/done" }, source: "observer", ts: oldTs });
  S.logEvent(db, repo.id, { threadId: null, type: "merged", summary: "merge", refs: { branch: "feat/done" }, source: "derived", dedupeKey: "b1" });
  // mixed: one landed + one still-open branch → must NOT flip.
  S.logEvent(db, repo.id, { threadId: mixed, type: "built", summary: "a", refs: { branch: "feat/a" }, source: "observer", ts: oldTs });
  S.logEvent(db, repo.id, { threadId: mixed, type: "built", summary: "b", refs: { branch: "feat/b-open" }, source: "observer", ts: oldTs });
  S.logEvent(db, repo.id, { threadId: null, type: "merged", summary: "merge a", refs: { branch: "feat/a" }, source: "derived", dedupeKey: "b2" });
  // openOnly: unmerged branch → must NOT flip.
  S.logEvent(db, repo.id, { threadId: openOnly, type: "built", summary: "c", refs: { branch: "feat/c-open" }, source: "observer", ts: oldTs });

  refreshThreadRefs(db, repo);
  const flipped = autoCompleteThreads(db, repo);
  assert.deepEqual([...flipped], [merged], "only the fully-merged, quiet, zero-issue thread flips");
  const statuses = Object.fromEntries(
    db.prepare("SELECT id, status FROM threads WHERE repo_id = ?").all(repo.id).map((t) => [t.id, t.status])
  );
  assert.equal(statuses[merged], "done");
  assert.equal(statuses[mixed], "active");
  assert.equal(statuses[openOnly], "active");
  rmSync(tmp, { recursive: true, force: true });
});

test("autoCompleteThreads: a RECENT fully-merged zero-issue thread is NOT auto-closed (quiet gate)", async () => {
  const { S, db, repo, tmp } = await freshDb();
  const { autoCompleteThreads, refreshThreadRefs } = await import("./work.js");
  const tid = S.resolveThread(db, repo.id, "Just landed, still live");
  const recent = new Date().toISOString();
  S.logEvent(db, repo.id, { threadId: tid, type: "built", summary: "landed", refs: { branch: "feat/fresh" }, source: "observer", ts: recent });
  S.logEvent(db, repo.id, { threadId: null, type: "merged", summary: "merge", refs: { branch: "feat/fresh" }, source: "derived", dedupeKey: "b" });
  refreshThreadRefs(db, repo);
  assert.equal(autoCompleteThreads(db, repo).size, 0, "recent activity blocks the flip");
  // But an explicit tiny quiet window lets it through — proves the gate, not the merge, held it.
  assert.deepEqual([...autoCompleteThreads(db, repo, { quietDays: 0 })], [tid]);
  rmSync(tmp, { recursive: true, force: true });
});

test("threadWorkStatus: surfaces branch/PR refs with open/merged counts for a zero-issue thread", async () => {
  const { S, db, repo, tmp } = await freshDb();
  const { threadWorkStatus, refreshThreadRefs } = await import("./work.js");
  const tid = S.resolveThread(db, repo.id, "Operator tools");
  S.logEvent(db, repo.id, { threadId: tid, type: "built", summary: "x", refs: { branch: "feat/landed" }, source: "observer" });
  S.logEvent(db, repo.id, { threadId: tid, type: "built", summary: "y", refs: { branch: "feat/open" }, source: "observer" });
  S.logEvent(db, repo.id, { threadId: null, type: "merged", summary: "m", refs: { branch: "feat/landed" }, source: "derived", dedupeKey: "b" });
  refreshThreadRefs(db, repo);
  const w = threadWorkStatus(db, tid);
  assert.equal(w.total, 0, "no linked issues");
  assert.equal(w.mergedRefs, 1);
  assert.equal(w.openRefs, 1);
  assert.equal(w.refs.length, 2);
  rmSync(tmp, { recursive: true, force: true });
});

test("listLooseEnds: hides deferrals on DONE threads, keeps active-thread and unthreaded ones", async () => {
  const { S, db, repo, tmp } = await freshDb();
  const doneT = S.resolveThread(db, repo.id, "Finished stream");
  const liveT = S.resolveThread(db, repo.id, "Live stream");
  S.updateThread(db, doneT, { status: "done" });
  S.logEvent(db, repo.id, { threadId: doneT, type: "deferred", summary: "punt on a done stream", source: "observer" });
  S.logEvent(db, repo.id, { threadId: liveT, type: "deferred", summary: "punt on a live stream", source: "observer" });
  S.logEvent(db, repo.id, { threadId: null, type: "deferred", summary: "unthreaded punt", source: "observer" });
  const loose = S.listLooseEnds(db, repo.id).map((e) => e.summary).sort();
  assert.deepEqual(loose, ["punt on a live stream", "unthreaded punt"], "done-thread deferral filtered out");
  rmSync(tmp, { recursive: true, force: true });
});
