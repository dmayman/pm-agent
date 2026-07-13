// Tests for the distiller response parser, the digest clamp, and title resolution.
// Run with `node --test` (Node >= 22.5, no deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSessionAnalysis, digestLines } from "./observe.js";

test("new multi-goal shape → goals array used as-is", () => {
  const text = JSON.stringify({
    goals: [
      { text: "Ship the zone model", initiative: "Zone model", isNew: true },
      { text: "Deterministic dup cleanup", initiative: "Dup cleanup", isNew: true },
    ],
    events: [{ type: "decided", summary: "Framed three workstreams", thread: "Zone model" }],
  });
  const { goals, events } = extractSessionAnalysis(text);
  assert.equal(goals.length, 2);
  assert.equal(goals[0].text, "Ship the zone model");
  assert.equal(goals[1].initiative, "Dup cleanup");
  assert.equal(events.length, 1);
});

test("legacy singular-goal object → wrapped as one-element array", () => {
  const text = JSON.stringify({
    goal: { text: "Refine the coach behavior", initiative: "Coach exec layer", isNew: false },
    events: [{ type: "built", summary: "Wired the loop" }],
  });
  const { goals, events } = extractSessionAnalysis(text);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].text, "Refine the coach behavior");
  assert.equal(goals[0].initiative, "Coach exec layer");
  assert.equal(events.length, 1);
});

test("bare array → events only, empty goals", () => {
  const text = JSON.stringify([
    { type: "tested", summary: "Ran the suite", thread: "CI" },
    { type: "note", summary: "Flaky test observed" },
  ]);
  const { goals, events } = extractSessionAnalysis(text);
  assert.deepEqual(goals, []);
  assert.equal(events.length, 2);
});

test("goals array filters junk but keeps goal-unchanged (text:null) entries", () => {
  const text = JSON.stringify({
    goals: [
      { text: "Real goal", initiative: "X" },
      { initiative: "Y" }, // no text but has an initiative — KEPT (goal unchanged)
      { text: null, initiative: "Z", focus: "verifying" }, // explicit null — KEPT
      null, // dropped
      "just a string", // dropped
      { text: "" }, // neither text nor initiative — dropped
      { shift: "nothing useful" }, // dropped
    ],
    events: [],
  });
  const { goals } = extractSessionAnalysis(text);
  assert.equal(goals.length, 3);
  assert.equal(goals[0].text, "Real goal");
  assert.equal(goals[1].initiative, "Y");
  assert.equal(goals[2].initiative, "Z");
});

test("new contract fields (focus, why, completed, text:null) pass through untouched", () => {
  const text = JSON.stringify({
    goals: [
      {
        initiative: "Muscle recovery signal",
        isNew: false,
        text: null, // goal unchanged — the common case
        focus: "verifying whether the tier 2 muscle taxonomy serves practical value",
        why: "the coach needs a per-muscle readiness signal to plan sessions",
        framing: null,
        completed: false,
      },
      {
        initiative: "Ship the zone model",
        isNew: true,
        text: "Ship the zone model",
        focus: "wiring the projection",
        why: null,
        completed: true,
      },
    ],
    events: [],
  });
  const { goals } = extractSessionAnalysis(text);
  assert.equal(goals.length, 2);
  assert.equal(goals[0].text, null);
  assert.equal(goals[0].focus, "verifying whether the tier 2 muscle taxonomy serves practical value");
  assert.match(goals[0].why, /readiness signal/);
  assert.equal(goals[0].completed, false);
  assert.equal(goals[1].completed, true);
  assert.equal(goals[1].text, "Ship the zone model");
});

test("object with events but no goals key → empty goals", () => {
  const text = JSON.stringify({ events: [{ type: "note", summary: "hi" }] });
  const { goals, events } = extractSessionAnalysis(text);
  assert.deepEqual(goals, []);
  assert.equal(events.length, 1);
});

test("malformed / non-JSON input never throws → empty result", () => {
  for (const bad of ["", "not json at all", "{ goals: [", "```json\n{bad}\n```", null, undefined]) {
    const r = extractSessionAnalysis(bad);
    assert.ok(Array.isArray(r.goals), `goals array for input ${JSON.stringify(bad)}`);
    assert.ok(Array.isArray(r.events), `events array for input ${JSON.stringify(bad)}`);
  }
});

test("goals present but events missing → events defaults to empty array", () => {
  const text = JSON.stringify({ goals: [{ text: "G", initiative: "I" }] });
  const { goals, events } = extractSessionAnalysis(text);
  assert.equal(goals.length, 1);
  assert.deepEqual(events, []);
});

test("prose wrapping a JSON object is tolerated (tolerant slicing)", () => {
  const text = 'Here you go:\n{"goals":[{"text":"G","initiative":"I"}],"events":[]}\nHope that helps!';
  const { goals } = extractSessionAnalysis(text);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].text, "G");
});

// ---------------------------------------------------------------------------
// digestLines — head+tail clamp keeps the opening user message on long turns
// ---------------------------------------------------------------------------

const jsonlText = (role, text) =>
  JSON.stringify({ message: { role, content: [{ type: "text", text }] } });

test("digestLines over the clamp keeps head + tail with a truncation marker", () => {
  const opening = "build a per-muscle recovery readiness signal for the coach";
  const lines = [jsonlText("user", opening)];
  // ~16 assistant messages of ~700 chars → digest well over the 8000-char clamp.
  for (let i = 0; i < 16; i++) lines.push(jsonlText("assistant", `chunk ${i} ` + "x".repeat(690)));
  lines.push(jsonlText("assistant", "FINAL-TAIL-MARKER the last thing said"));

  const digest = digestLines(lines);
  assert.ok(digest.startsWith(`USER: ${opening}`), "opening user message survives at the head");
  assert.ok(digest.includes("…[truncated]…"), "elision is marked");
  assert.ok(digest.includes("FINAL-TAIL-MARKER"), "tail survives");
  // head(2000) + marker + tail(6000)
  assert.ok(digest.length <= 8000 + "\n…[truncated]…\n".length, `clamped (got ${digest.length})`);
});

test("digestLines under the clamp is untouched; raw mode never truncates", () => {
  const lines = [jsonlText("user", "short question"), jsonlText("assistant", "short answer")];
  const digest = digestLines(lines);
  assert.equal(digest, "USER: short question\nCLAUDE: short answer");

  const long = [jsonlText("user", "y".repeat(20000))];
  const raw = digestLines(long, { raw: true });
  assert.ok(!raw.includes("…[truncated]…"));
  assert.ok(raw.length > 8000, "raw keeps everything");
});

// ---------------------------------------------------------------------------
// resolveThread — normalized title matching (case/whitespace/trailing punctuation)
// ---------------------------------------------------------------------------

test("resolveThread matches titles case/whitespace/punctuation-insensitively", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pm-title-norm-"));
  const S = await import("./store.js");
  const db = S.openDbAt(path.join(tmp, "t.db"));
  db.prepare("INSERT INTO repos (slug, root, created_at) VALUES (?, ?, ?)").run(
    "acme/norm",
    tmp,
    new Date().toISOString()
  );
  const repoId = db.prepare("SELECT id FROM repos WHERE slug = 'acme/norm'").get().id;

  const id1 = S.resolveThread(db, repoId, "Auth Hardening");
  assert.equal(S.resolveThread(db, repoId, "auth hardening"), id1, "case folds");
  assert.equal(S.resolveThread(db, repoId, "  Auth   hardening. "), id1, "whitespace + trailing punctuation fold");
  assert.equal(S.resolveThread(db, repoId, "AUTH HARDENING!"), id1);

  // The stored title keeps its exact original form.
  assert.equal(S.getThread(db, id1).title, "Auth Hardening");

  // A genuinely different title still forks a new initiative.
  const id2 = S.resolveThread(db, repoId, "Auth Hardening v2");
  assert.notEqual(id2, id1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM threads WHERE repo_id = ?").get(repoId).n, 2);

  rmSync(tmp, { recursive: true, force: true });
});

test("normalizeTitle folds case/whitespace and strips trailing punctuation only", async () => {
  const S = await import("./store.js");
  assert.equal(S.normalizeTitle("  Auth   Hardening!! "), "auth hardening");
  assert.equal(S.normalizeTitle("Fix v2.1 rollout…"), "fix v2.1 rollout");
  // Interior punctuation is preserved — only the trailing run is stripped.
  assert.equal(S.normalizeTitle("plan: model & execution"), "plan: model & execution");
});
